/**
 * Plugin compatibility preflight for dsh-pack-maker.
 *
 * A pure-filesystem analysis of the profile being exported, mirroring the
 * machinery dsh-market uses to decide whether a profile's plugin stack will
 * actually boot. No processes, no network, no writes.
 *
 * It surfaces, for the pack about to be written:
 *
 *   1. bundle-stack completeness — every non-inbox bundle must declare a
 *      `dsh.bundle.patch` whose file exists, or the pack will import into a
 *      profile that cannot boot.
 *   2. cross-bundle loader conflicts — a loader entry id inserted by two
 *      different bundles fails the boot outright (duplicate id); a shared
 *      loader NAME across bundles decides which entry wins at runtime
 *      (shadowing, informational warning).
 *   3. peerDependencies ranges against DSH host core packages — a confirmed
 *      mismatch (`@deepseek-ai/cordis`, `@deepseek-ai/dsh`, …) is a
 *      directional risk and blocks export unless explicitly skipped.
 *   4. host-core-as-ordinary-dependency — a plugin that lists a DSH shared
 *      host package in `dependencies` can get its own copy hoisted to the
 *      profile root and shadow the host version (the dsh-excel-chat failure
 *      mode); reported as a warning here.
 *
 * The module stays dependency-free for pack building; it only needs
 * `js-yaml` when it has to read an entry-list patch, and degrades gracefully
 * (skipping entry parsing) when the library is absent.
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { dirname, join, sep } from 'node:path';

/** The three in-box bundles that every DSH installation ships. */
export const INBOX_BUNDLES = new Set([
  '@deepseek-ai/dsh-base',
  '@deepseek-ai/dsh-web-app',
  '@deepseek-ai/dsh-headless',
]);

const SEMVER_RE = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * DSH host core packages: the curated seed plus whatever the running install
 * ships under `node_modules/@deepseek-ai` whose name starts with dsh/cordis.
 */
export function corePackageNames(dshInstallDir) {
  const names = new Set([
    '@deepseek-ai/dsh',
    '@deepseek-ai/dsh-base',
    '@deepseek-ai/dsh-web-app',
    '@deepseek-ai/dsh-headless',
    '@deepseek-ai/dsh-app-boot',
    '@deepseek-ai/dsh-home-paths',
    '@deepseek-ai/dsh-launch-environment',
    '@deepseek-ai/dsh-cmdline',
    '@deepseek-ai/dsh-tools',
    '@deepseek-ai/dsh-llm',
    '@deepseek-ai/dsh-system-prompt',
    '@deepseek-ai/dsh-agent',
    '@deepseek-ai/dsh-agent-loop',
    '@deepseek-ai/dsh-session',
    '@deepseek-ai/dsh-subagent',
    '@deepseek-ai/dsh-attachment',
    '@deepseek-ai/cordis',
    '@deepseek-ai/cordis-plugin-loader',
    '@deepseek-ai/cordis-plugin-include',
    '@deepseek-ai/cordis-plugin-hmr',
    '@deepseek-ai/cordis-plugin-timer',
    '@deepseek-ai/cordis-plugin-group',
  ]);
  if (dshInstallDir === null) return names;
  try {
    for (const entry of readdirSync(join(dshInstallDir, 'node_modules', '@deepseek-ai'), { withFileTypes: true })) {
      if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
      if (/^(?:dsh|cordis)/.test(entry.name)) names.add(`@deepseek-ai/${entry.name}`);
    }
  } catch {
    // install node_modules unreadable — the curated seed stands.
  }
  try {
    const manifest = JSON.parse(readFileSync(join(dshInstallDir, 'package.json'), 'utf8'));
    if (typeof manifest.name === 'string') names.add(manifest.name);
  } catch {
    // not a package dir.
  }
  return names;
}

/** Locate the running dsh install from the process entry point. */
export function findDshInstallDir(entry = process.argv[1]) {
  if (typeof entry !== 'string' || entry === '') return null;
  let dir = dirname(entry);
  for (let depth = 0; depth < 12; depth += 1) {
    try {
      const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
      if (manifest.name === '@deepseek-ai/dsh') return dir;
    } catch {
      // keep walking up.
    }
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
  return null;
}

// ---------------------------------------------------------------------------
// semver subset
// ---------------------------------------------------------------------------

function parseSemver(value) {
  const m = SEMVER_RE.exec(String(value).trim());
  if (m === null) return null;
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]), pre: m[4] ? m[4].split('.') : [] };
}

function comparePre(a, b) {
  const len = Math.max(a.length, b.length);
  for (let i = 0; i < len; i += 1) {
    const x = a[i];
    const y = b[i];
    if (x === undefined) return y === undefined ? 0 : -1;
    if (y === undefined) return 1;
    if (x === y) continue;
    const xn = /^\d+$/.test(x);
    const yn = /^\d+$/.test(y);
    if (xn && yn) return Number(x) - Number(y);
    if (xn) return -1;
    if (yn) return 1;
    return x < y ? -1 : 1;
  }
  return 0;
}

/** Compare two semver strings: negative | zero | positive. */
export function compareSemver(a, b) {
  const x = parseSemver(a);
  const y = parseSemver(b);
  if (x === null || y === null) return NaN;
  if (x.major !== y.major) return x.major - y.major;
  if (x.minor !== y.minor) return x.minor - y.minor;
  if (x.patch !== y.patch) return x.patch - y.patch;
  if (x.pre.length === 0 && y.pre.length === 0) return 0;
  if (x.pre.length === 0) return 1;
  if (y.pre.length === 0) return -1;
  return comparePre(x.pre, y.pre);
}

function nextBound(target, kind) {
  const v = parseSemver(target.replace(/-[0-9A-Za-z.-]+$/, ''));
  if (v === null) return '';
  if (kind === '^') {
    if (v.major > 0) return `${v.major + 1}.0.0-0`;
    if (v.minor > 0) return `0.${v.minor + 1}.0-0`;
    return `0.0.${v.patch + 1}-0`;
  }
  return `${v.major}.${v.minor + 1}.0-0`;
}

function parseComparator(part) {
  const p = part.trim();
  const m = /^(\^|~|>=|<=|>|<|=|)?\s*(.*)$/.exec(p);
  if (m === null) return null;
  const target = m[2] ? m[2].trim() : '';
  if (parseSemver(target) === null) return null;
  const op = m[1] ?? '=';
  return { op: op === '' ? '=' : op, target };
}

function satisfiedBy(version, comparator) {
  const v = parseSemver(version);
  const t = parseSemver(comparator.target);
  if (v === null || t === null) return null;
  const c = compareSemver(version, comparator.target);
  switch (comparator.op) {
    case '=': return c === 0;
    case '>': return c > 0;
    case '>=': return c >= 0;
    case '<': return c < 0;
    case '<=': return c <= 0;
    case '^': {
      const upper = nextBound(comparator.target, '^');
      return compareSemver(version, comparator.target) >= 0 && (upper === '' || compareSemver(version, upper) < 0);
    }
    case '~': {
      const upper = nextBound(comparator.target, '~');
      return compareSemver(version, comparator.target) >= 0 && (upper === '' || compareSemver(version, upper) < 0);
    }
    default: return null;
  }
}

/** Evaluate one space-separated comparator set. true / false / null (unknown). */
function evaluateSet(version, range) {
  const comparators = range.trim().split(/\s+/).filter(Boolean).map(parseComparator);
  if (comparators.length === 0 || comparators.some((c) => c === null)) return null;
  let sawUnknown = false;
  for (const comparator of comparators) {
    const result = satisfiedBy(version, comparator);
    if (result === true) continue;
    if (result === null) {
      sawUnknown = true;
      continue;
    }
    return false;
  }
  return sawUnknown ? null : true;
}

/** True when `version` satisfies a npm-style `range` (^, ~, comparators, ||). */
export function satisfiesRange(version, range) {
  const value = String(version).trim();
  if (range === '' || range === '*' || range === 'latest') return true;
  if (range.includes('||')) {
    const outcomes = range
      .split('||')
      .map((part) => evaluateSet(value, part))
      .filter((result) => result !== null);
    if (outcomes.some((result) => result === true)) return true;
    if (outcomes.length === 0) return null;
    return false;
  }
  return evaluateSet(value, range);
}

// ---------------------------------------------------------------------------
// peer direction (mirrors dsh-market compatibility.ts, trimmed)
// ---------------------------------------------------------------------------

const PEER_SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

function boundsForCompatibility(range) {
  const alternatives = [];
  for (const raw of range.split('||')) {
    const parts = raw.trim().split(/\s+/).filter(Boolean);
    const parsed = parts.map(parseComparator);
    if (parsed.some((p) => p === null)) return null;
    let lower = null;
    let upper = null;
    let explicitUpper = false;
    let exact = null;
    for (const p of parsed) {
      if (p.op === '=') { exact = p.target; continue; }
      if (p.op === '^' || p.op === '~') {
        const bound = nextBound(p.target, p.op);
        if (bound === '') return null;
        if (lower === null || compareSemver(p.target, lower.target) > 0) lower = p;
        if (upper === null || compareSemver(bound, upper.target) < 0) upper = { op: '<=', target: bound };
        continue;
      }
      if (p.op === '>=' || p.op === '>') {
        if (lower === null || compareSemver(p.target, lower.target) > 0) lower = p;
      } else {
        if (upper === null || compareSemver(p.target, upper.target) < 0) upper = p;
        explicitUpper = true;
      }
    }
    alternatives.push({ lower, upper, explicitUpper, exact });
  }
  return alternatives;
}

function belowAllMins(resolved, bounds) {
  return bounds.every((alternative) => {
    if (alternative.exact !== null) return compareSemver(resolved, alternative.exact) < 0;
    if (alternative.lower === null) return false;
    return alternative.lower.op === '>'
      ? compareSemver(resolved, alternative.lower.target) <= 0
      : compareSemver(resolved, alternative.lower.target) < 0;
  });
}

function aboveAllMaxes(resolved, bounds) {
  return bounds.every((alternative) => {
    if (alternative.exact !== null) return compareSemver(resolved, alternative.exact) > 0;
    if (alternative.upper === null) return false;
    return alternative.upper.op === '<'
      ? compareSemver(resolved, alternative.upper.target) >= 0
      : compareSemver(resolved, alternative.upper.target) > 0;
  });
}

function hasExplicitUpperOrExact(bounds) {
  return bounds.every((alternative) => alternative.exact !== null || alternative.explicitUpper);
}

/** Translate one confirmed peer mismatch into a directional verdict. */
export function classifyPeer(plugin, peer, range, resolved, optional) {
  if (resolved === null) return { kind: 'none' };
  if (optional) return { kind: 'warning', warning: { plugin, peer, range, resolved, reason: 'optional' } };
  const bounds = boundsForCompatibility(range);
  if (bounds === null || !PEER_SEMVER.test(String(resolved).trim())) return { kind: 'none' };
  if (belowAllMins(resolved, bounds)) return { kind: 'risk', risk: { plugin, peer, range, resolved, direction: 'belowMin' } };
  if (aboveAllMaxes(resolved, bounds)) {
    return hasExplicitUpperOrExact(bounds)
      ? { kind: 'risk', risk: { plugin, peer, range, resolved, direction: 'aboveMax' } }
      : { kind: 'warning', warning: { plugin, peer, range, resolved, reason: 'aboveMax' } };
  }
  return { kind: 'none' };
}

// ---------------------------------------------------------------------------
// filesystem helpers
// ---------------------------------------------------------------------------

function resolveBundleDir(anchorPackageJson, name) {
  let paths = [];
  try {
    paths = createRequire(anchorPackageJson).resolve.paths(name) ?? [];
  } catch {
    return null;
  }
  for (const searchPath of paths) {
    const candidate = join(searchPath, name);
    if (existsSync(join(candidate, 'package.json'))) return candidate;
  }
  return null;
}

function bundleDir(profileDir, name, dshInstallDir) {
  const anchors = [
    dshInstallDir !== null ? join(dshInstallDir, 'package.json') : null,
    join(profileDir, 'package.json'),
  ];
  for (const anchor of anchors) {
    if (anchor === null) continue;
    const dir = resolveBundleDir(anchor, name);
    if (dir !== null) return dir;
  }
  return null;
}

/** Version of `name` as physically resolved at `base`/node_modules, or null. */
function readNodeModulesVersion(base, name) {
  const manifest = readJson(join(base, 'node_modules', name, 'package.json'));
  return typeof manifest?.version === 'string' ? manifest.version : null;
}

function readProfileVisibleVersion(profileDir, name) {
  const direct = readNodeModulesVersion(profileDir, name);
  if (direct !== null) return direct;
  const workspaceRoot = dirname(profileDir);
  if (workspaceRoot === profileDir) return null;
  return readNodeModulesVersion(workspaceRoot, name);
}

/** Top-level installed package names, scoped names included, excluding pnpm internals. */
function installedPackageNames(profileDir) {
  const names = [];
  const isPkgDir = (entry) => entry.isDirectory() || entry.isSymbolicLink();
  let root = [];
  try {
    root = readdirSync(join(profileDir, 'node_modules'), { withFileTypes: true })
      .filter((entry) => isPkgDir(entry) && entry.name !== '.bin' && entry.name !== '.pnpm' && entry.name !== '.dsh-plugin-backups')
      .map((entry) => entry.name);
  } catch {
    return names;
  }
  for (const name of root) {
    if (!name.startsWith('@')) { names.push(name); continue; }
    try {
      for (const scoped of readdirSync(join(profileDir, 'node_modules', name), { withFileTypes: true })) {
        if (isPkgDir(scoped)) names.push(`${name}/${scoped.name}`);
      }
    } catch {
      // empty scope dir.
    }
  }
  return names;
}

// ---------------------------------------------------------------------------
// entry-list patch parsing (js-yaml dialect, mirrors dsh-app-boot)
// ---------------------------------------------------------------------------

let yamlPromise;
function loadYaml() {
  yamlPromise ??= import('js-yaml').catch(() => null);
  return yamlPromise;
}

function makeEntrySchema(yaml) {
  const { JSON_SCHEMA, Type } = yaml;
  const jsExpr = new Type('tag:yaml.org,2002:js', {
    kind: 'scalar',
    resolve: (data) => typeof data === 'string',
    construct: (data) => ({ __jsExpr: String(data) }),
  });
  return JSON_SCHEMA.extend(jsExpr);
}

function parsePatchFile(yaml, path) {
  let text;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    return null;
  }
  try {
    const schema = makeEntrySchema(yaml);
    const value = yaml.load(text, { schema });
    return Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

/** Collect every entry { id, name } a patch declares, recursively into groups. */
function collectEntries(rows) {
  const entries = [];
  const walk = (value) => {
    if (!Array.isArray(value)) return;
    for (const node of value) {
      if (node === null || typeof node !== 'object') continue;
      if (typeof node.id === 'string') entries.push({ id: node.id, name: typeof node.name === 'string' ? node.name : undefined });
      if (Array.isArray(node.config)) walk(node.config);
    }
  };
  for (const patch of rows) {
    if (patch === null || typeof patch !== 'object') continue;
    if (Array.isArray(patch.insert)) walk(patch.insert);
    if (typeof patch.id === 'string' && !Array.isArray(patch.insert)) entries.push({ id: patch.id, name: typeof patch.name === 'string' ? patch.name : undefined });
  }
  return entries;
}

// ---------------------------------------------------------------------------
// the check
// ---------------------------------------------------------------------------

/**
 * Analyze one profile directory for pack-export compatibility.
 *
 * @param {string} profileDir - absolute profile directory being exported.
 * @param {object} [options]
 * @param {string|null} [options.dshInstallDir] - host install dir; auto-detect when omitted.
 */
export async function checkProfileCompat(profileDir, options = {}) {
  const dshInstall = options.dshInstallDir !== undefined ? options.dshInstallDir : findDshInstallDir();
  const core = corePackageNames(dshInstall);
  const yaml = await loadYaml();

  const errors = [];
  const warnings = [];

  const manifest = readJson(join(profileDir, 'package.json'));
  if (manifest === null) {
    return { ok: false, errors: ['profile package.json is unreadable'], warnings: [], bundles: [], peerMismatches: [], duplicateIds: [], duplicateNames: [], shadowedHostDeps: [] };
  }
  const bundleNames = Array.isArray(manifest.dsh?.profile?.bundles)
    ? manifest.dsh.profile.bundles.filter((name) => typeof name === 'string')
    : [];

  const bundles = [];
  for (const name of bundleNames) {
    const info = { name, kind: INBOX_BUNDLES.has(name) ? 'official' : 'community', error: null, entries: [] };
    bundles.push(info);
    if (info.kind === 'official') continue;
    const dir = bundleDir(profileDir, name, dshInstall);
    if (dir === null) {
      info.error = 'bundle package is not installed — the pack will fail to boot';
      errors.push(`bundle ${name}: ${info.error}`);
      continue;
    }
    const pkg = readJson(join(dir, 'package.json'));
    const patch = pkg?.dsh?.bundle?.patch;
    if (typeof patch !== 'string') {
      info.error = 'declares no dsh.bundle.patch — not a valid profile bundle';
      errors.push(`bundle ${name}: ${info.error}`);
      continue;
    }
    const patchPath = join(dir, patch);
    if (!existsSync(patchPath)) {
      info.error = `declared patch ${patch} is missing`;
      errors.push(`bundle ${name}: ${info.error}`);
      continue;
    }
    if (yaml !== null) {
      const rows = parsePatchFile(yaml, patchPath);
      if (rows === null) {
        info.error = 'patch file is not a valid entry list';
        errors.push(`bundle ${name}: ${info.error}`);
      } else {
        info.entries = collectEntries(rows);
      }
    }
  }

  // Cross-bundle loader entry id / name conflicts. Same-layer reuse is normal
  // (a bundle defining several entries under one name), so only report when
  // the SAME id/name appears in MORE THAN ONE bundle layer.
  const idOwners = new Map();
  const nameOwners = new Map();
  for (const bundle of bundles) {
    for (const entry of bundle.entries) {
      const ids = idOwners.get(entry.id) ?? new Set();
      ids.add(bundle.name);
      idOwners.set(entry.id, ids);
      if (entry.name !== undefined) {
        const names = nameOwners.get(entry.name) ?? new Set();
        names.add(bundle.name);
        nameOwners.set(entry.name, names);
      }
    }
  }
  const duplicateIds = [];
  for (const [id, layers] of idOwners) {
    if (layers.size < 2) continue;
    const entry = { id, layers: [...layers], count: layers.size };
    duplicateIds.push(entry);
    errors.push(`duplicate loader entry id ${JSON.stringify(id)} (${layers.size} bundles: ${[...layers].join(', ')})`);
  }
  const duplicateNames = [];
  for (const [name, layers] of nameOwners) {
    if (layers.size < 2) continue;
    const entry = { name, layers: [...layers], count: layers.size };
    duplicateNames.push(entry);
    warnings.push(`loader name ${JSON.stringify(name)} is shared by ${layers.size} bundles — the later layer wins at runtime`);
  }

  // peerDependencies vs DSH core packages + host-core-as-dependency shadowing.
  const peerMismatches = [];
  const shadowedHostDeps = [];
  const seenPeers = new Set();
  for (const plugin of installedPackageNames(profileDir)) {
    const pluginDir = join(profileDir, 'node_modules', plugin);
    const pkg = readJson(join(pluginDir, 'package.json'));
    if (pkg === null) continue;

    // --- peer ranges against DSH core packages ---
    const peers = pkg.peerDependencies;
    if (peers !== null && typeof peers === 'object') {
      for (const [name, range] of Object.entries(peers)) {
        if (typeof range !== 'string') continue;
        if (!core.has(name)) continue;
        const key = `${plugin}\u0000${name}\u0000peer`;
        if (seenPeers.has(key)) continue;
        seenPeers.add(key);
        const hoisted = readProfileVisibleVersion(profileDir, name);
        const nested = readNodeModulesVersion(pluginDir, name);
        const host = dshInstall !== null ? readNodeModulesVersion(dshInstall, name) : null;
        const resolved = nested ?? hoisted ?? host;
        const checked = resolved !== null ? satisfiesRange(resolved, range) : null;
        const optional = pkg.peerDependenciesMeta?.[name]?.optional === true;
        const satisfied = checked === null ? null : checked;
        peerMismatches.push({ plugin, name, range, resolved, satisfied, optional });
        if (satisfied === false) {
          const verdict = classifyPeer(plugin, name, range, resolved, optional);
          if (verdict.kind === 'risk') {
            errors.push(`${plugin} peer ${name}@${range} is incompatible with resolved ${resolved} (${verdict.risk.direction})`);
          } else if (verdict.kind === 'warning') {
            warnings.push(`${plugin} peer ${name}@${range} resolves to ${resolved} (${verdict.warning.reason})`);
          }
        }
      }
    }

    // --- host core package declared as an ordinary dependency ---
    if (pkg.dependencies !== null && typeof pkg.dependencies === 'object') {
      for (const name of Object.keys(pkg.dependencies).sort()) {
        if (!core.has(name)) continue;
        const declaredRange = pkg.dependencies[name];
        if (typeof declaredRange !== 'string') continue;
        shadowedHostDeps.push({ plugin, dependency: name, declaredRange });
        warnings.push(`${plugin} lists host core package ${name} as a dependency — the profile copy may shadow the host's version`);
      }
    }
  }

  return {
    ok: errors.length === 0,
    errors,
    warnings,
    bundles,
    peerMismatches,
    duplicateIds,
    duplicateNames,
    shadowedHostDeps,
  };
}
