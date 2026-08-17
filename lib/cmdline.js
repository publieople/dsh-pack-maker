/**
 * Command-line entry for dsh-pack-maker: `dsh web pack export/import/...`.
 *
 * The launcher hands everything after `dsh web` to the tree, so this plugin
 * parses its own family through @deepseek-ai/dsh-cmdline's commander adapter.
 * The root command carries a no-op action so a plain `dsh web` boot (empty
 * argument snapshot) keeps running; only when `pack ...` is invoked does an
 * action run, and it requests `appExit` once the operation settles so the web
 * process does not stay alive after a one-shot CLI call.
 */
import { readFileSync } from 'node:fs';
import { Command } from 'commander';
import { parseCmdline } from '@deepseek-ai/dsh-cmdline';
import { exportPack, importPackFile, listProfiles, summarizePack } from './core.js';

export const name = 'dsh-pack-maker/cmdline';
export const inject = ['cmdlineArgs'];

export function apply(ctx) {
  // Only ever claim the argument family when the user actually invoked the
  // `pack` command. The web app owns the rest of `dsh web`'s arguments
  // (--port, --host, --patch, ...): parsing them here would make commander
  // reject them as unknown options and request an exit, killing a normal
  // boot. Empty or foreign arguments are ignored entirely.
  const cmdlineArgs = ctx.get('cmdlineArgs');
  const argv = cmdlineArgs?.get() ?? [];
  if (argv[0] !== 'pack') return;

  const exit = ctx.get('appExit');
  const done = (code) => {
    if (typeof exit === 'function') exit(code);
  };

  const program = new Command('dsh');
  program.description('DeepSeek Harness — dsh-pack-maker integration-pack commands');
  program.action(() => {
    // Plain `dsh web` boot: nothing to do, keep the app running.
  });

  const pack = program
    .command('pack')
    .description('export/import DSH integration packs (.dshpack)');

  pack
    .command('export <profile>')
    .description('export an existing profile as a .dshpack integration pack')
    .option('-o, --out <path>', 'output .dshpack path (default: <cwd>/.dshpacks/<profile>.dshpack)')
    .option('--no-vendor', 'do not snapshot plugin dependencies into the pack')
    .option('--no-lockfile', 'do not include pnpm-lock.yaml')
    .option('-t, --title <title>', 'human-readable pack title')
    .option('-d, --description <text>', 'human-readable pack description')
    .action((profile, options) => {
      exportPack({
        profile,
        ...(options.out !== undefined ? { outputPath: options.out } : {}),
        includeVendor: options.vendor,
        includeLockfile: options.lockfile,
        ...(options.title !== undefined ? { title: options.title } : {}),
        ...(options.description !== undefined ? { description: options.description } : {}),
      })
        .then((result) => {
          console.log(`exported ${result.profile} -> ${result.outputPath} (${result.bytes} bytes)`);
          done(0);
        })
        .catch((error) => {
          console.error(`pack export: ${error instanceof Error ? error.message : error}`);
          done(1);
        });
    });

  pack
    .command('import <packPath>')
    .description('import a .dshpack as a new profile')
    .option('-n, --name <profileName>', 'target profile name (default: the name stored in the pack)')
    .option('--overwrite', 'replace an existing profile (old directory moved to a .bak backup)')
    .option('--no-install', 'do not run pnpm install after restoring files')
    .action((packPath, options) => {
      importPackFile({
        packPath,
        ...(options.name !== undefined ? { profileName: options.name } : {}),
        overwrite: options.overwrite,
        autoInstall: options.install,
      })
        .then((result) => {
          console.log(`imported ${result.profile} -> ${result.dir}`);
          if (result.backupDir !== null) console.log(`previous profile moved to ${result.backupDir}`);
          if (result.install?.ok === true) console.log('dependencies installed with pnpm');
          else if (result.install?.ok === false && !result.install.skipped) {
            console.error(`warning: pnpm install failed (${result.install.error ?? `exit ${result.install.exitCode}`})`);
            done(1);
            return;
          }
          done(0);
        })
        .catch((error) => {
          console.error(`pack import: ${error instanceof Error ? error.message : error}`);
          done(1);
        });
    });

  pack
    .command('list')
    .description('list existing DSH profiles')
    .action(() => {
      listProfiles()
        .then((profiles) => {
          for (const profile of profiles) console.log(profile);
          done(0);
        })
        .catch((error) => {
          console.error(`pack list: ${error instanceof Error ? error.message : error}`);
          done(1);
        });
    });

  pack
    .command('info <packPath>')
    .description('show what a .dshpack contains without importing it')
    .action((packPath) => {
      summarizePack(readFileSync(packPath))
        .then((summary) => {
          const meta = summary.meta;
          console.log(`name:        ${meta.name}${meta.title ? ` (${meta.title})` : ''}`);
          if (meta.description !== undefined) console.log(`description: ${meta.description}`);
          if (meta.createdAt !== undefined) console.log(`created:     ${meta.createdAt}`);
          if (meta.dshVersion !== undefined) console.log(`dsh version: ${meta.dshVersion}`);
          console.log(`files:       ${summary.fileCount}`);
          console.log('bundles:');
          for (const bundle of summary.bundles) console.log(`  - ${bundle}`);
          const deps = Object.entries(summary.dependencies);
          if (deps.length > 0) {
            console.log('dependencies:');
            for (const [dep, spec] of deps) console.log(`  - ${dep}@${spec}`);
          }
          done(0);
        })
        .catch((error) => {
          console.error(`pack info: ${error instanceof Error ? error.message : error}`);
          done(1);
        });
    });

  parseCmdline(ctx, program);
}
