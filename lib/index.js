/**
 * dsh-pack-maker Cordis plugin.
 *
 * Makes DSH profiles portable — export an existing profile as a .dshpack
 * integration archive and import a pack as a new profile:
 *
 * - export_dsh_pack / import_dsh_pack  -> model-facing tools
 * - /pack-export / /pack-import        -> human slash commands
 * - /dsh-pack/* HTTP routes            -> the web settings-page client
 */

import { readFileSync } from 'node:fs';
import { isAbsolute, resolve as resolvePath } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { exportPack, importPackFile, parsePack } from './core.js';
import { mountPackRoutes } from './routes.js';

export const name = 'dsh-pack-maker';
export const inject = ['tools', 'commands'];

const DEFAULT_CONFIG = Object.freeze({
  outputDir: '.dshpacks',
  autoInstall: true,
  overwrite: false,
});

function textBlock(text) {
  return [{ type: 'text', text }];
}

function renderExportValue(_args, value) {
  return textBlock(
    `Exported DSH profile pack.\n` +
    `Profile: ${value.profile}\n` +
    `Archive: ${value.outputPath}\n` +
    `Size: ${value.bytes} bytes\n` +
    `Files: ${value.files}`
  );
}

function renderImportValue(_args, value) {
  const lines = [
    `Imported DSH profile pack.`,
    `Profile: ${value.profile}`,
    `Directory: ${value.dir}`,
    `Restored files: ${value.files}`,
  ];
  if (value.backupDir) lines.push(`Previous profile moved to: ${value.backupDir}`);
  if (value.install?.ok === true) lines.push('Dependencies installed with pnpm.');
  else if (value.install?.ok === false && value.install?.skipped) {
    lines.push('Automatic dependency install was skipped.');
  } else if (value.install?.ok === false) {
    lines.push(`Dependency install ${value.install.error ? `failed: ${value.install.error}` : `failed with exit code ${value.install.exitCode}`}.`);
    lines.push('Run `dsh plugin --profile ' + value.profile + ' install` manually if needed.');
  }
  return textBlock(lines.join('\n'));
}

function requireString(value, name) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`dsh-pack-maker: ${name} must be a non-empty string`);
  }
  return value;
}

function optionalString(value, name) {
  if (value === undefined) return undefined;
  if (typeof value !== 'string') throw new Error(`dsh-pack-maker: ${name} must be a string`);
  return value;
}

function optionalBoolean(value, name) {
  if (value === undefined) return undefined;
  if (typeof value !== 'boolean') throw new Error(`dsh-pack-maker: ${name} must be a boolean`);
  return value;
}

function parseExportArgs(args) {
  return {
    profile: requireString(args?.profile, 'profile'),
    ...(args?.outputPath !== undefined ? { outputPath: resolveFromWorkspace(requireString(args.outputPath, 'outputPath')) } : {}),
    ...(args?.title !== undefined ? { title: optionalString(args.title, 'title') } : {}),
    ...(args?.description !== undefined ? { description: optionalString(args.description, 'description') } : {}),
    includeLockfile: optionalBoolean(args?.includeLockfile, 'includeLockfile') ?? true,
    includeVendor: optionalBoolean(args?.includeVendor, 'includeVendor') ?? true,
  };
}

function parseImportArgs(args) {
  return {
    packPath: requireString(args?.packPath, 'packPath'),
    ...(args?.profileName !== undefined ? { profileName: requireString(args.profileName, 'profileName') } : {}),
    overwrite: optionalBoolean(args?.overwrite, 'overwrite') ?? false,
    autoInstall: optionalBoolean(args?.autoInstall, 'autoInstall') ?? true,
  };
}

/**
 * Register the two tools and, when a commands service is present, two slash
 * commands.
 */
export function apply(ctx, config = {}) {
  const resolved = { ...DEFAULT_CONFIG, ...config };

  // The web settings page talks to the host over HTTP. webServer only exists
  // in web profiles; on headless/embedded hosts the tools and commands below
  // remain the only surfaces, so this stays optional: the callback mounts the
  // routes on the injected context (whose effect lifecycle Cordis owns) when
  // the service appears.
  ctx.inject(['webServer'], (hostCtx) => {
    hostCtx.effect(() => mountPackRoutes(hostCtx.webServer, resolved), 'dsh-pack-maker: http routes');
  });

  ctx.tools.register({
    name: 'export_dsh_pack',
    description: 'Export an existing DeepSeek Harness profile as a portable .dshpack integration archive. Use this when the user wants to package, share, back up, or migrate a DSH profile.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        profile: { type: 'string', description: 'Name of the DSH profile to export, e.g. web or headless.' },
        outputPath: { type: 'string', description: 'Where to write the .dshpack file. Relative paths are resolved from the current workspace. Defaults to <workspace>/.dshpacks/<profile>.dshpack.' },
        title: { type: 'string', description: 'Optional human-readable title stored in the pack.' },
        description: { type: 'string', description: 'Optional human-readable description stored in the pack.' },
        includeLockfile: { type: 'boolean', description: 'Whether to include pnpm-lock.yaml in the pack. Default true.' },
        includeVendor: { type: 'boolean', description: 'Whether to snapshot non-inbox plugin dependencies into the pack. Default true.' },
      },
      required: ['profile'],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          profile: { type: 'string' },
          outputPath: { type: 'string' },
          bytes: { type: 'integer' },
          files: { type: 'integer' },
        },
        required: ['profile', 'outputPath', 'bytes', 'files'],
      },
      render: renderExportValue,
    },
    async execute(args) {
      const parsed = parseExportArgs(args);
      const result = await exportPack(parsed);
      return {
        profile: result.profile,
        outputPath: result.outputPath,
        bytes: result.bytes,
        files: countPackFiles(result.outputPath),
      };
    },
  });

  ctx.tools.register({
    name: 'import_dsh_pack',
    description: 'Import a .dshpack integration archive and create a new DeepSeek Harness profile from it. Use this when the user has a DSH pack file to install, restore, or migrate.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        packPath: { type: 'string', description: 'Path to the .dshpack file to import.' },
        profileName: { type: 'string', description: 'Profile name to create. Defaults to the name stored in the pack.' },
        overwrite: { type: 'boolean', description: 'If true and the profile already exists, move the old profile aside and replace it. Default false.' },
        autoInstall: { type: 'boolean', description: 'Run pnpm install after restoring files. Default true.' },
      },
      required: ['packPath'],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          profile: { type: 'string' },
          dir: { type: 'string' },
          files: { type: 'integer' },
          backupDir: { type: 'string' },
          install: {
            type: 'object',
            properties: {
              ok: { type: 'boolean' },
              skipped: { type: 'boolean' },
              exitCode: { type: 'integer' },
              error: { type: 'string' },
            },
            required: ['ok'],
          },
        },
        required: ['profile', 'dir', 'files', 'install'],
      },
      render: renderImportValue,
    },
    async execute(args) {
      const parsed = parseImportArgs(args);
      const result = await importPackFile(parsed);
      return {
        profile: result.profile,
        dir: result.dir,
        files: countPackFiles(parsed.packPath),
        ...(result.backupDir ? { backupDir: result.backupDir } : {}),
        install: result.install ?? { ok: false, skipped: true },
      };
    },
  });

  ctx.effect(() => ctx.commands.register({
      name: 'pack-export',
      description: 'Export a DSH profile as a .dshpack integration archive',
      input: { hint: '<profile> [outputPath]' },
      handler: async (invocation) => {
        const args = invocation.rawInput.trim().split(/\s+/).filter(Boolean);
        if (args.length === 0 || args.length > 2) {
          return { kind: 'error', text: 'Usage: /pack-export <profile> [outputPath]' };
        }
        try {
          const result = await exportPack({
            profile: args[0],
            ...(args[1] ? { outputPath: resolveFromWorkspace(args[1]) } : {}),
          });
          return {
            kind: 'success',
            text: `Exported ${result.profile} to ${result.outputPath} (${result.bytes} bytes).`,
          };
        } catch (error) {
          return { kind: 'error', text: `Export failed: ${error.message}` };
        }
      },
    }), 'dsh-pack-maker: /pack-export');

  ctx.effect(() => ctx.commands.register({
      name: 'pack-import',
      description: 'Import a .dshpack integration archive as a DSH profile',
      input: { hint: '<packPath> [profileName]' },
      handler: async (invocation) => {
        const args = invocation.rawInput.trim().split(/\s+/).filter(Boolean);
        if (args.length === 0 || args.length > 2) {
          return { kind: 'error', text: 'Usage: /pack-import <packPath> [profileName]' };
        }
        try {
          const result = await importPackFile({
            packPath: args[0],
            ...(args[1] ? { profileName: args[1] } : {}),
          });
          return {
            kind: 'success',
            text: `Imported ${result.profile} to ${result.dir}${result.install?.ok === false ? ' (pnpm install failed, run `dsh plugin --profile ' + result.profile + ' install` manually)' : ''}.`,
          };
        } catch (error) {
          return { kind: 'error', text: `Import failed: ${error.message}` };
        }
      },
    }), 'dsh-pack-maker: /pack-import');
}

function resolveFromWorkspace(value) {
  return isAbsolute(value) ? value : resolvePath(process.cwd(), value);
}

function countPackFiles(packPath) {
  try {
    const raw = readFileSync(packPath);
    const pack = JSON.parse(gunzipSync(raw).toString('utf8'));
    return Object.keys(pack.files ?? {}).length;
  } catch {
    return 0;
  }
}
