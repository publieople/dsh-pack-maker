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
import { exportPack, importPack, importPackFile, parsePack } from './core.js';
import { mountPackRoutes } from './routes.js';
import { listMarketItems, resolvePackBuffer } from './market.js';

export const name = 'dsh-pack-maker';
export const inject = ['tools', 'commands'];

const DEFAULT_CONFIG = Object.freeze({
  outputDir: '.dshpacks',
  autoInstall: true,
  overwrite: false,
  marketRegistry: '',
});

function textBlock(text) {
  return [{ type: 'text', text }];
}

function renderExportValue(_args, value) {
  const lines = [
    `Exported DSH profile pack.`,
    `Profile: ${value.profile}`,
    `Archive: ${value.outputPath}`,
    `Size: ${value.bytes} bytes`,
    `Files: ${value.files}`,
  ];
  const warnings = value.compatibility?.warnings;
  if (Array.isArray(warnings) && warnings.length > 0) {
    lines.push('Compatibility warnings:');
    for (const warning of warnings) lines.push(`  - ${warning}`);
  }
  return textBlock(lines.join('\n'));
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

function renderMarketListValue(_args, value) {
  const items = value.items ?? [];
  if (items.length === 0) {
    return textBlock(value.errors?.length > 0
      ? `No integration packs found in the market (remote fetch failed: ${value.errors.join('; ')}).`
      : 'No integration packs found in the market.');
  }
  const lines = [`Integration-pack market (${items.length}):`];
  for (const item of items) {
    lines.push(`- ${item.name}${item.title && item.title !== item.name ? ` (${item.title})` : ''} [${item.source}]${item.version && item.version !== 'unknown' ? ` v${item.version}` : ''}`);
    if (item.description) lines.push(`    ${item.description}`);
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
    check: optionalBoolean(args?.check, 'check') ?? true,
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
        check: { type: 'boolean', description: 'Run a plugin compatibility preflight before writing the pack; incompatible bundles block the export. Default true.' },
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
          compatibility: {
            type: 'object',
            properties: {
              ok: { type: 'boolean' },
              errors: { type: 'array', items: { type: 'string' } },
              warnings: { type: 'array', items: { type: 'string' } },
            },
          },
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
        ...(result.compatibility
          ? {
              compatibility: {
                ok: result.compatibility.ok,
                errors: result.compatibility.errors,
                warnings: result.compatibility.warnings,
              },
            }
          : {}),
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

  ctx.tools.register({
    name: 'list_dsh_pack_market',
    description: 'List the integration-pack market: published packs plus local .dshpack files. Use this when the user wants to browse, search, or see available DSH integration packs.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        query: { type: 'string', description: 'Optional search filter matching pack name, title, description, or author.' },
      },
      required: [],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          items: { type: 'array' },
          errors: { type: 'array', items: { type: 'string' } },
        },
        required: ['items'],
      },
      render: renderMarketListValue,
    },
    async execute(args) {
      const { items, errors } = await listMarketItems({ ...config, workspace: process.cwd() });
      const query = (args?.query ?? '').trim().toLowerCase();
      const filtered = query
        ? items.filter((item) => `${item.name} ${item.title} ${item.description} ${item.author}`.toLowerCase().includes(query))
        : items;
      return {
        items: filtered.map((item) => ({
          name: item.name,
          title: item.title,
          description: item.description,
          source: item.source,
          version: item.version,
          size: item.size,
          path: item.path,
          url: item.url,
        })),
        errors: errors.map((error) => error.message),
      };
    },
  });

  ctx.tools.register({
    name: 'import_dsh_pack_market',
    description: 'Import an integration pack from the market: resolve a local .dshpack path or a published URL, then install it as a new DSH profile.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        source: { type: 'string', description: "'local' to read a file, or 'remote' to download a URL." },
        path: { type: 'string', description: 'Local .dshpack path (required when source=local).' },
        url: { type: 'string', description: 'Remote .dshpack download URL (required when source=remote).' },
        profileName: { type: 'string', description: 'Target profile name. Defaults to the name stored in the pack.' },
        overwrite: { type: 'boolean', description: 'Replace an existing profile (moves the old directory aside). Default false.' },
        autoInstall: { type: 'boolean', description: 'Run pnpm install after restoring files. Default true.' },
      },
      required: [],
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
      const { summarizePack } = await import('./core.js');
      const item = { source: args?.source, path: args?.path, url: args?.url };
      const buffer = await resolvePackBuffer(item);
      const result = await importPack({
        buffer,
        ...(args?.profileName !== undefined ? { profileName: args.profileName } : {}),
        overwrite: args?.overwrite ?? false,
        autoInstall: args?.autoInstall ?? true,
      });
      const summary = await summarizePack(buffer);
      return {
        profile: result.profile,
        dir: result.dir,
        files: summary.fileCount,
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

  ctx.effect(() => ctx.commands.register({
      name: 'pack-market',
      description: 'List the integration-pack market (published packs plus local .dshpack files)',
      input: { hint: '[query]' },
      handler: async (invocation) => {
        const query = invocation.rawInput.trim();
        try {
          const { items } = await listMarketItems({ ...resolved, workspace: process.cwd() });
          const filtered = query
            ? items.filter((item) => `${item.name} ${item.title} ${item.description}`.toLowerCase().includes(query.toLowerCase()))
            : items;
          if (filtered.length === 0) return { kind: 'success', text: 'No integration packs in the market.' };
          const lines = filtered.map((item) =>
            `- ${item.name}${item.title && item.title !== item.name ? ` (${item.title})` : ''} [${item.source}]${item.version && item.version !== 'unknown' ? ` v${item.version}` : ''}`);
          return { kind: 'success', text: `Integration-pack market (${filtered.length}):\n${lines.join('\n')}` };
        } catch (error) {
          return { kind: 'error', text: `Market lookup failed: ${error.message}` };
        }
      },
    }), 'dsh-pack-maker: /pack-market');

  ctx.effect(() => ctx.commands.register({
      name: 'pack-market-import',
      description: 'Import an integration pack from a market file/URL as a DSH profile',
      input: { hint: '<path-or-url> [profileName]' },
      handler: async (invocation) => {
        const args = invocation.rawInput.trim().split(/\s+/).filter(Boolean);
        if (args.length === 0 || args.length > 2) {
          return { kind: 'error', text: 'Usage: /pack-market-import <path-or-url> [profileName]' };
        }
        try {
          const item = /^https?:\/\//.test(args[0])
            ? { source: 'remote', url: args[0] }
            : { source: 'local', path: resolveFromWorkspace(args[0]) };
          const buffer = await resolvePackBuffer(item);
          const result = await importPack({
            buffer,
            ...(args[1] ? { profileName: args[1] } : {}),
            autoInstall: true,
          });
          return {
            kind: 'success',
            text: `Imported ${result.profile} to ${result.dir}${result.install?.ok === false ? ' (pnpm install failed, run `dsh plugin --profile ' + result.profile + ' install` manually)' : ''}.`,
          };
        } catch (error) {
          return { kind: 'error', text: `Market import failed: ${error.message}` };
        }
      },
    }), 'dsh-pack-maker: /pack-market-import');
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
