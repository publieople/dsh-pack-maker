/**
 * Integration-pack marketplace for dsh-pack-maker.
 *
 * The market is the .dshpack analogue of dsh-market: a catalogue you can
 * browse and one-click import. It merges two sources:
 *
 *   - a remote JSON index (`DSCPACK_REGISTRY_URL` / config.marketRegistry)
 *     listing packs published somewhere, each with a download URL.
 *   - local directories scanned on disk (`<workspace>/.dshpacks`,
 *     `$DSH_HOME/.dshpacks`, and `$DSH_HOME/profiles/<name>`), so the market
 *     still works fully offline against packs you already have.
 *
 * Everything here is dependency-free (Node built-ins only) and never downloads
 * a remote pack except when the caller asks to resolve its buffer.
 */

import { readFile, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { PACK_EXTENSION, summarizePack } from './core.js';

export const MARKET_SCHEMA = 'dsh-pack-market/v1';

/** Env var used for the remote registry URL when config does not provide one. */
export const REGISTRY_ENV = 'DSCPACK_REGISTRY_URL';

/** Directories, relative to `workspace`, scanned for local packs when none are configured. */
export const DEFAULT_LOCAL_DIRS = (workspace, dshHome) => [
  join(workspace, '.dshpacks'),
  join(dshHome, '.dshpacks'),
];

/**
 * Resolve the registry URL: explicit config wins, then the env var, then null
 * (remote browsing disabled, local scan only).
 */
export function resolveRegistryUrl(config = {}) {
  if (typeof config.marketRegistry === 'string' && config.marketRegistry.trim() !== '') {
    return config.marketRegistry.trim();
  }
  const env = process.env[REGISTRY_ENV];
  return typeof env === 'string' && env.trim() !== '' ? env.trim() : null;
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Normalize one remote index entry into a market item, dropping fields that
 * are not safe/usable. Remote items carry `url` and no `path`.
 */
export function normalizeRemoteItem(entry) {
  if (!isRecord(entry)) return null;
  const name = typeof entry.name === 'string' ? entry.name.trim() : '';
  const url = typeof entry.url === 'string' ? entry.url.trim() : '';
  if (name === '' || url === '') return null;
  const description = typeof entry.description === 'string' ? entry.description : '';
  return {
    id: name,
    name,
    title: typeof entry.title === 'string' && entry.title.trim() !== '' ? entry.title : name,
    description,
    version: typeof entry.version === 'string' ? entry.version : 'unknown',
    author: typeof entry.author === 'string' ? entry.author : '',
    tags: Array.isArray(entry.tags) ? entry.tags.filter((tag) => typeof tag === 'string') : [],
    source: 'remote',
    url,
    path: null,
    size: typeof entry.size === 'number' ? entry.size : null,
    createdAt: typeof entry.createdAt === 'string' ? entry.createdAt : null,
    bundles: [],
    dependencies: {},
    fileCount: null,
  };
}

/** Parse a remote registry index into items, throwing on a malformed body. */
export async function fetchMarketIndex(url, timeoutMs = 12000) {
  const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  if (!response.ok) {
    throw new Error(`market index HTTP ${response.status} ${response.statusText}`);
  }
  const body = await response.json();
  if (!isRecord(body) || !Array.isArray(body.items)) {
    throw new Error('market index is missing the items array');
  }
  return body.items
    .map(normalizeRemoteItem)
    .filter((item) => item !== null);
}

/**
 * Scan a set of local directories for .dshpack files and summarize each into a
 * market item. Unparseable archives are skipped; unreadable directories are
 * ignored. `workspace` and `dshHome` are used to build the default dir list.
 */
export async function scanLocalPacks(dirs = []) {
  const items = [];
  const seen = new Set();
  for (const dir of dirs) {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isFile() || !(entry.name.endsWith(PACK_EXTENSION))) continue;
      const path = join(dir, entry.name);
      if (seen.has(path)) continue;
      seen.add(path);
      try {
        const buffer = await readFile(path);
        const summary = await summarizePack(buffer);
        const meta = summary.meta;
        const info = await stat(path);
        items.push({
          id: meta.name,
          name: meta.name,
          title: typeof meta.title === 'string' && meta.title.trim() !== '' ? meta.title : meta.name,
          description: typeof meta.description === 'string' ? meta.description : '',
          version: typeof meta.dshVersion === 'string' ? meta.dshVersion : 'unknown',
          author: '',
          tags: [],
          source: 'local',
          url: null,
          path,
          size: info.size,
          createdAt: typeof meta.createdAt === 'string' ? meta.createdAt : null,
          bundles: summary.bundles,
          dependencies: summary.dependencies,
          fileCount: summary.fileCount,
        });
      } catch {
        // unparseable archive — not a market entry.
      }
    }
  }
  return items;
}

/**
 * Merge remote and local items into one catalogue. Remote entries win on a
 * name collision (the published catalogue is authoritative); local-only names
 * are kept as offline fallbacks. Order is stable: remote sorted by name, then
 * local additions.
 */
export function mergeMarketItems(remote = [], local = []) {
  const byName = new Map();
  const order = [];
  for (const item of [...remote, ...local]) {
    if (byName.has(item.name)) continue;
    byName.set(item.name, item);
    order.push(item);
  }
  return order.sort((a, b) => {
    if (a.source !== b.source) return a.source === 'remote' ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
}

/**
 * Build the merged market catalogue.
 *
 * @param {object} options
 * @param {string} [options.workspace] - workspace root for local dirs.
 * @param {string} [options.dshHome] - DSH home for local dirs.
 * @param {string[]} [options.localDirs] - explicit dirs to scan (overrides default).
 * @param {string} [options.registryUrl] - remote index URL (overrides env/config).
 * @param {boolean} [options.remote=true] - whether to fetch the remote index.
 * @returns {Promise<{items: Array, errors: Array}>}
 */
export async function listMarketItems(options = {}) {
  const workingDir = options.workspace ?? process.cwd();
  const dshHome = options.dshHome ?? process.env.DSH_HOME ?? join(process.env.HOME ?? '', '.dsh');
  const localDirs = Array.isArray(options.localDirs) && options.localDirs.length > 0
    ? options.localDirs
    : DEFAULT_LOCAL_DIRS(workingDir, dshHome);

  const local = await scanLocalPacks(localDirs);
  const errors = [];

  const registry = options.registryUrl ?? resolveRegistryUrl(options);
  if (registry === null || options.remote === false) {
    return { items: local, errors };
  }
  try {
    const remoteItems = await fetchMarketIndex(registry);
    // remote entries first; local-only items remain as offline fallbacks.
    return { items: mergeMarketItems(remoteItems, local), errors };
  } catch (error) {
    errors.push({ source: 'remote', message: error instanceof Error ? error.message : String(error) });
  }
  return { items: local, errors };
}

/**
 * Resolve a market item to an in-memory buffer: read the local path, or
 * download the remote URL. The caller owns the resulting Buffer.
 */
export async function resolvePackBuffer(item) {
  if (item?.source === 'local' && typeof item.path === 'string') {
    return readFile(item.path);
  }
  if (item?.source === 'remote' && typeof item.url === 'string' && item.url !== '') {
    const response = await fetch(item.url, { signal: AbortSignal.timeout(60000) });
    if (!response.ok) {
      throw new Error(`download HTTP ${response.status} ${response.statusText}`);
    }
    return Buffer.from(await response.arrayBuffer());
  }
  throw new Error('market item has no resolvable source');
}
