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

import { exportPack, importPack, importPackFile, listProfiles, summarizePack } from '../lib/core.js';
import { listMarketItems, resolvePackBuffer } from '../lib/market.js';

const [command, ...rest] = process.argv.slice(2);

async function main() {
  switch (command) {
    case 'export': {
      if (rest.length < 1 || rest.length > 3) {
        throw new Error('Usage: dsh-pack export <profile> [outputPath] [--no-check]');
      }
      const profile = rest[0];
      const outputPath = rest[1] && !rest[1].startsWith('--') ? rest[1] : undefined;
      const flags = new Set(rest.slice(outputPath ? 2 : 1));
      const result = await exportPack({
        profile,
        ...(outputPath ? { outputPath } : {}),
        check: !flags.has('--no-check'),
      });
      console.log(`Exported ${result.profile} -> ${result.outputPath} (${result.bytes} bytes)`);
      if (result.compatibility?.warnings?.length) {
        for (const warning of result.compatibility.warnings) console.log(`  warning: ${warning}`);
      }
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
    case 'market': {
      const query = rest[0] ?? '';
      const { items } = await listMarketItems({ workspace: process.cwd() });
      const filtered = query
        ? items.filter((item) => `${item.name} ${item.title} ${item.description}`.toLowerCase().includes(query.toLowerCase()))
        : items;
      if (filtered.length === 0) {
        console.log('No integration packs in the market.');
        break;
      }
      console.log(`Integration-pack market (${filtered.length}):`);
      for (const item of filtered) {
        console.log(`- ${item.name}${item.title && item.title !== item.name ? ` (${item.title})` : ''} [${item.source}]${item.version && item.version !== 'unknown' ? ` v${item.version}` : ''}${item.path ? ` (${item.path})` : ''}`);
        if (item.description) console.log(`    ${item.description}`);
      }
      break;
    }
    case 'market-import': {
      if (rest.length < 1 || rest.length > 4) {
        throw new Error('Usage: dsh-pack market-import <pathOrUrl> [profileName] [--overwrite] [--no-install]');
      }
      const sourceArg = rest[0];
      const profileName = rest[1] && !rest[1].startsWith('--') ? rest[1] : undefined;
      const flags = new Set(rest.slice(profileName ? 2 : 1));
      const item = /^https?:\/\//.test(sourceArg)
        ? { source: 'remote', url: sourceArg }
        : { source: 'local', path: sourceArg };
      const buffer = await resolvePackBuffer(item);
      const result = await importPack({
        buffer,
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
    default:
      console.log(`dsh-pack — DeepSeek Harness profile pack tool

Usage:
  dsh-pack export <profile> [outputPath] [--no-check]
  dsh-pack import <packPath> [profileName] [--overwrite] [--no-install]
  dsh-pack list
  dsh-pack info <packPath>
  dsh-pack market [query]
  dsh-pack market-import <pathOrUrl> [profileName] [--overwrite] [--no-install]
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
