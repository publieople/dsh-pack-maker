#!/usr/bin/env node
/**
 * Minimal standalone CLI for dsh-pack-maker.
 *
 * This is an optional convenience wrapper; inside DSH the same operations are
 * available as agent tools and web slash commands.
 *
 * Usage:
 *   dsh-pack export <profile> [outputPath]
 *   dsh-pack import <packPath> [profileName] [--overwrite] [--no-install]
 *   dsh-pack list
 */

import { exportPack, importPackFile, listProfiles, summarizePack } from '../lib/core.js';

const [command, ...rest] = process.argv.slice(2);

async function main() {
  switch (command) {
    case 'export': {
      if (rest.length < 1 || rest.length > 2) {
        throw new Error('Usage: dsh-pack export <profile> [outputPath]');
      }
      const result = await exportPack({
        profile: rest[0],
        ...(rest[1] ? { outputPath: rest[1] } : {}),
      });
      console.log(`Exported ${result.profile} -> ${result.outputPath} (${result.bytes} bytes)`);
      break;
    }
    case 'import': {
      if (rest.length < 1 || rest.length > 4) {
        throw new Error('Usage: dsh-pack import <packPath> [profileName] [--overwrite] [--no-install]');
      }
      const packPath = rest[0];
      const profileName = rest[1] && !rest[1].startsWith('--') ? rest[1] : undefined;
      const flags = new Set(rest.slice(profileName ? 2 : 1));
      const result = await importPackFile({
        packPath,
        ...(profileName ? { profileName } : {}),
        overwrite: flags.has('--overwrite'),
        autoInstall: !flags.has('--no-install'),
      });
      console.log(`Imported ${result.profile} -> ${result.dir}`);
      if (result.install?.ok === true) console.log('Dependencies installed with pnpm.');
      else if (result.install?.ok === false && !result.install.skipped) {
        console.error(`Warning: pnpm install failed (${result.install.error ?? `exit ${result.install.exitCode}`}).`);
      }
      if (result.backupDir) console.log(`Previous profile moved to ${result.backupDir}`);
      break;
    }
    case 'list': {
      const profiles = await listProfiles();
      for (const profile of profiles) console.log(profile);
      break;
    }
    case 'info': {
      if (rest.length !== 1) {
        throw new Error('Usage: dsh-pack info <packPath>');
      }
      const { readFileSync } = await import('node:fs');
      const summary = await summarizePack(readFileSync(rest[0]));
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
      break;
    }
    default:
      console.log(`dsh-pack — DeepSeek Harness profile pack tool

Usage:
  dsh-pack export <profile> [outputPath]
  dsh-pack import <packPath> [profileName] [--overwrite] [--no-install]
  dsh-pack list
  dsh-pack info <packPath>
`);
      if (command !== undefined && command !== 'help' && command !== '--help' && command !== '-h') {
        process.exitCode = 2;
      }
  }
}

main().catch((error) => {
  console.error(`dsh-pack: ${error.message}`);
  process.exitCode = 1;
});
