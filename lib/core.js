/**
 * Core implementation for dsh-pack-maker.
 *
 * A `.dshpack` is a portable DeepSeek Harness integration-pack archive:
 * a gzip-compressed JSON document containing the profile manifest, user patch
 * layer, pnpm workspace/lockfile, and snapshots of every out-of-tree plugin
 * dependency needed to recreate the profile.
 *
 * The format is intentionally dependency-free (Node built-ins only) so the
 * plugin can run in any DSH profile without adding archive libraries.
 */

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { gunzipSync, gzipSync } from 'node:zlib';

export const PACK_FORMAT = 'dsh-pack/1';
export const PACK_EXTENSION = '.dshpack';
export const DEFAULT_OUTPUT_DIR = '.dshpacks';

/**
 * Resolve the DSH home directory without importing DSH packages, so the
 * plugin can be installed as a local `link:` package and still run from any
 * checkout location.
 */
export function resolveDshHome() {
  return process.env.DSH_HOME || join(homedir(), '.dsh');
}

/**
 * Resolve a profile directory under the DSH home.
 */
export function profileDir(name) {
  assertProfileName(name);
  return join(resolveDshHome(), 'profiles', name);
}

/**
 * Initialize a minimal profile directory. Mirrors the behavior of DSH's
 * app-boot helper but is intentionally dependency-free.
 */
export async function initProfile(dir, bundles = ['@deepseek-ai/dsh-base']) {
  await mkdir(dir, { recursive: true });
  const manifestPath = join(dir, 'package.json');
  if (!existsSync(manifestPath)) {
    const name = `dsh-profile-${dir.split(sep).pop()}`;
    await writeFile(manifestPath, JSON.stringify({
      name,
      private: true,
      dependencies: {},
      dsh: { profile: { bundles: [...bundles] } },
    }, null, 2) + '\n');
  }
  const patchPath = join(dir, 'cordis.patch.yml');
  if (!existsSync(patchPath)) {
    await writeFile(patchPath, '# Your patch layer for this dsh profile\n[]\n');
  }
  const workspacePath = join(dir, 'pnpm-workspace.yaml');
  if (!existsSync(workspacePath)) {
    await writeFile(workspacePath, 'packages:\n  - .\n\nnodeLinker: hoisted\nautoInstallPeers: false\n');
  }
}

/**
 * Directories that are never copied into a pack. node_modules is both huge and
 * rebuildable; .git is source control, not profile content.
 */
const SKIP_DIRS = new Set(['node_modules', '.git', '.pnpm', '.cache', '.turbo']);
/** Files that are not copied from the profile root. cordis.yml is generated. */
const SKIP_ROOT_FILES = new Set(['cordis.yml']);
/** The three bundles that every DSH installation already provides. */
const INBOX_BUNDLES = new Set([
  '@deepseek-ai/dsh-base',
  '@deepseek-ai/dsh-web-app',
  '@deepseek-ai/dsh-headless',
]);

function isSafeArchivePath(value) {
  if (typeof value !== 'string' || value.length === 0) return false;
  if (value.startsWith('/') || /^[a-zA-Z]:[\\/]/.test(value)) return false;
  const parts = value.split(/[\\/]+/);
  if (parts.some((part) => part === '' || part === '.' || part === '..')) return false;
  return true;
}

function normalizeArchivePath(value) {
  return value.split(sep).join('/');
}

/**
 * Recursively collect a directory's files into a map of
 * `normalizedRelativePath -> { encoding, content }`.
 */
async function collectDirectory(dir, prefix = '') {
  const files = {};
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isDirectory() && SKIP_DIRS.has(entry.name)) continue;
    const full = join(dir, entry.name);
    const rel = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory()) {
      Object.assign(files, await collectDirectory(full, rel));
    } else if (entry.isFile()) {
      files[normalizeArchivePath(rel)] = await encodeFile(full);
    }
  }
  return files;
}

async function encodeFile(file) {
  const raw = await readFile(file);
  // Prefer UTF-8 storage for text files to keep the archive human-inspectable.
  const text = raw.toString('utf8');
  if (Buffer.byteLength(text, 'utf8') === raw.length) {
    return { encoding: 'utf8', content: text };
  }
  return { encoding: 'base64', content: raw.toString('base64') };
}

async function decodeFile(record) {
  if (record?.encoding === 'utf8') return Buffer.from(record.content, 'utf8');
  if (record?.encoding === 'base64') return Buffer.from(record.content, 'base64');
  throw new Error(`dsh-pack-maker: unsupported file encoding in archive: ${JSON.stringify(record?.encoding)}`);
}

/** Validate an arbitrary string is a usable profile name. */
function assertProfileName(name) {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name ?? '')) {
    throw new Error(`dsh-pack-maker: invalid profile name ${JSON.stringify(name)}`);
  }
}

/** Return a vendor path for a package name, using the npm name as path. */
function vendorPathForPackage(packageName) {
  return `vendor/${packageName}`;
}

/**
 * Resolve a package directory for a dependency of a profile. pnpm may store
 * scoped packages under `node_modules/@scope/name` and unscoped under
 * `node_modules/name`.
 */
function installedPackageDir(profileDir, packageName) {
  return join(profileDir, 'node_modules', ...packageName.split('/'));
}

/**
 * Build a `.dshpack` buffer from a local DSH profile.
 *
 * @param {object} options
 * @param {string} options.profile - profile name under $DSH_HOME/profiles.
 * @param {string} [options.title] - optional human-readable pack title.
 * @param {string} [options.description] - optional human-readable description.
 * @param {boolean} [options.includeLockfile=true] - include pnpm-lock.yaml.
 * @param {boolean} [options.includeVendor=true] - snapshot non-inbox dependencies.
 * @param {string} [options.dshVersion] - optional DSH version to record.
 */
export async function buildPack({
  profile,
  title,
  description,
  includeLockfile = true,
  includeVendor = true,
  dshVersion,
}) {
  assertProfileName(profile);
  const dir = profileDir(profile);
  if (!existsSync(join(dir, 'package.json'))) {
    throw new Error(`dsh-pack-maker: profile ${JSON.stringify(profile)} does not exist at ${dir}`);
  }

  const manifest = JSON.parse(await readFile(join(dir, 'package.json'), 'utf8'));
  const dependencies = manifest.dependencies ?? {};
  const vendored = [];

  const files = {};
  const profilePrefix = 'profile';

  if (includeVendor) {
    for (const packageName of Object.keys(dependencies)) {
      if (INBOX_BUNDLES.has(packageName)) continue;
      const packageDir = installedPackageDir(dir, packageName);
      if (!existsSync(join(packageDir, 'package.json'))) continue;
      const prefix = vendorPathForPackage(packageName);
      Object.assign(files, await collectDirectory(packageDir, prefix));
      vendored.push(packageName);
    }
  }

  // Snapshot the profile manifest; for vendored dependencies, point at the
  // local vendor copy so import does not need the original registry spec.
  const manifestForPack = structuredClone(manifest);
  for (const packageName of vendored) {
    manifestForPack.dependencies = {
      ...(manifestForPack.dependencies ?? {}),
      [packageName]: `file:./${vendorPathForPackage(packageName)}`,
    };
  }
  files[`${profilePrefix}/package.json`] = {
    encoding: 'utf8',
    content: JSON.stringify(manifestForPack, null, 2) + '\n',
  };

  for (const name of ['cordis.patch.yml', 'pnpm-workspace.yaml']) {
    const file = join(dir, name);
    if (existsSync(file)) files[`${profilePrefix}/${name}`] = await encodeFile(file);
  }
  if (includeLockfile && existsSync(join(dir, 'pnpm-lock.yaml'))) {
    files[`${profilePrefix}/pnpm-lock.yaml`] = await encodeFile(join(dir, 'pnpm-lock.yaml'));
  }

  const meta = {
    name: profile,
    ...(title ? { title } : {}),
    ...(description ? { description } : {}),
    createdAt: new Date().toISOString(),
    plugin: 'dsh-pack-maker',
    ...(dshVersion ? { dshVersion } : {}),
  };

  const pack = { format: PACK_FORMAT, meta, files };
  // Content checksum over the canonical body (format, meta, files in fixed
  // order). Written as a top-level sibling so parsePack can re-derive it from
  // the parsed object; any content edit after packing breaks the match.
  const checksum = createHash('sha256').update(canonicalJson(pack)).digest('hex');
  return gzipSync(Buffer.from(JSON.stringify({ ...pack, checksum }, null, 2), 'utf8'));
}

/**
 * Canonical JSON body of a pack: fixed key order and formatting so a checksum
 * can be re-derived from a parsed object.
 */
export function canonicalJson(pack) {
  return JSON.stringify(
    { format: pack.format, meta: pack.meta, files: pack.files },
    null,
    2,
  );
}

/**
 * Write a `.dshpack` file to disk.
 *
 * @param {object} options - same as buildPack.
 * @param {string} [options.outputPath] - output file path. Defaults to
 *   `<workspace>/<outputDir>/<profile>.dshpack`.
 * @param {string} [options.workspace] - workspace root used for default path.
 */
export async function exportPack(options) {
  const outputPath = options.outputPath ?? resolve(
    options.workspace ?? process.cwd(),
    options.outputDir ?? DEFAULT_OUTPUT_DIR,
    `${options.profile}${PACK_EXTENSION}`,
  );
  const buffer = await buildPack(options);
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, buffer);
  return {
    profile: options.profile,
    outputPath,
    bytes: buffer.length,
  };
}

/**
 * Parse and validate a `.dshpack` buffer.
 */
export function parsePack(buffer) {
  let pack;
  try {
    pack = JSON.parse(gunzipSync(buffer).toString('utf8'));
  } catch (error) {
    throw new Error(`dsh-pack-maker: not a valid .dshpack archive: ${error.message}`);
  }
  if (pack?.format !== PACK_FORMAT) {
    throw new Error(`dsh-pack-maker: unsupported pack format ${JSON.stringify(pack?.format)}`);
  }
  if (!pack.meta || typeof pack.meta !== 'object' || typeof pack.meta.name !== 'string') {
    throw new Error('dsh-pack-maker: pack is missing meta.name');
  }
  if (!pack.files || typeof pack.files !== 'object' || Array.isArray(pack.files)) {
    throw new Error('dsh-pack-maker: pack is missing files map');
  }
  for (const path of Object.keys(pack.files)) {
    if (!isSafeArchivePath(path)) {
      throw new Error(`dsh-pack-maker: archive contains unsafe path ${JSON.stringify(path)}`);
    }
  }
  // Packs created by dsh-pack-maker carry a checksum; older packs without one
  // stay importable. A present but mismatched checksum means the archive was
  // edited after packing and is rejected outright.
  if (typeof pack.checksum === 'string') {
    const actual = createHash('sha256').update(canonicalJson(pack)).digest('hex');
    if (actual !== pack.checksum) {
      throw new Error('dsh-pack-maker: archive checksum mismatch — the pack was modified after export');
    }
  }
  return pack;
}

/**
 * Summarize a `.dshpack` buffer for a pre-import preview: metadata plus the
 * plugin bundles and dependency specs recorded in the packed profile manifest.
 */
export async function summarizePack(buffer) {
  const pack = parsePack(buffer);
  let bundles = [];
  let dependencies = {};
  const manifestRecord = pack.files['profile/package.json'];
  if (manifestRecord !== undefined) {
    try {
      const manifest = JSON.parse((await decodeFile(manifestRecord)).toString('utf8'));
      bundles = manifest.dsh?.profile?.bundles ?? [];
      dependencies = manifest.dependencies ?? {};
    } catch {
      // A broken packed manifest still allows a raw import; the preview just
      // shows what could be read.
    }
  }
  return {
    format: pack.format,
    meta: pack.meta,
    bundles,
    dependencies,
    fileCount: Object.keys(pack.files).length,
  };
}

/**
 * Write one archived file under a profile directory, ensuring parent
 * directories exist.
 */
async function writeArchivedFile(profileDir, archivePath, record) {
  const relativePath = archivePath.replace(/^profile\//, '');
  const target = resolve(profileDir, relativePath);
  const root = resolve(profileDir);
  if (target !== root && !target.startsWith(root + sep)) {
    throw new Error(`dsh-pack-maker: refusing to write outside profile directory: ${archivePath}`);
  }
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, await decodeFile(record));
}

/**
 * Import a `.dshpack` buffer as a new DSH profile.
 *
 * @param {object} options
 * @param {Buffer} options.buffer - parsed .dshpack content.
 * @param {string} [options.profileName] - target profile name. Defaults to
 *   the name stored in the pack.
 * @param {boolean} [options.overwrite=false] - if true, move an existing
 *   profile aside instead of failing.
 * @param {boolean} [options.autoInstall=true] - run `pnpm install` after
 *   restoring files.
 */
export async function importPack({ buffer, profileName, overwrite = false, autoInstall = true }) {
  const pack = parsePack(buffer);
  const targetProfile = profileName ?? pack.meta.name;
  assertProfileName(targetProfile);
  const dir = profileDir(targetProfile);

  const backupDir = overwrite && existsSync(dir) ? `${dir}.bak-${Date.now()}` : null;
  if (existsSync(dir)) {
    if (!overwrite) {
      throw new Error(`dsh-pack-maker: profile ${JSON.stringify(targetProfile)} already exists at ${dir} (use overwrite: true to replace it)`);
    }
    await rm(backupDir, { recursive: true, force: true });
    await mkdir(dirname(backupDir), { recursive: true });
    await renameDir(dir, backupDir);
  }

  // Initialize a minimal profile first so the directory layout matches DSH.
  await initProfile(dir, []);
  for (const [archivePath, record] of Object.entries(pack.files)) {
    if (!archivePath.startsWith('profile/') && !archivePath.startsWith('vendor/')) continue;
    await writeArchivedFile(dir, archivePath, record);
  }

  // If the archive has no manifest (shouldn't happen after validation), keep
  // the initialized empty one; otherwise the manifest has already been written.
  const manifestPath = join(dir, 'package.json');
  if (!existsSync(manifestPath)) {
    await initProfile(dir, []);
  }

  let install;
  if (autoInstall) {
    install = await installProfileDeps(dir);
  } else {
    install = { ok: false, skipped: true };
  }

  return {
    profile: targetProfile,
    dir,
    backupDir,
    install,
  };
}

/**
 * Read a .dshpack file and import it as a profile.
 */
export async function importPackFile({ packPath, profileName, overwrite = false, autoInstall = true }) {
  const buffer = await readFile(resolve(packPath));
  return importPack({ buffer, profileName, overwrite, autoInstall });
}

/**
 * List existing DSH profile names.
 */
export async function listProfiles() {
  const profilesDir = join(resolveDshHome(), 'profiles');
  if (!existsSync(profilesDir)) return [];
  const entries = await readdir(profilesDir, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isDirectory() && existsSync(join(profilesDir, entry.name, 'package.json')))
    .map((entry) => entry.name)
    .sort();
}

/**
 * Run `pnpm install` in a profile directory.
 *
 * @returns {Promise<null|{ok: boolean, stdout: string, stderr: string, exitCode: number|null}>}
 */
export function installProfileDeps(dir) {
  return new Promise((resolvePromise) => {
    const child = spawn('pnpm', ['install'], {
      cwd: dir,
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: process.platform === 'win32',
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', (error) => {
      resolvePromise({ ok: false, error: error.message, stdout, stderr, exitCode: null });
    });
    child.on('close', (code) => {
      resolvePromise({ ok: code === 0, stdout, stderr, exitCode: code });
    });
  });
}

/**
 * Rename a directory; falls back to copy+remove for exotic filesystems.
 */
async function renameDir(from, to) {
  try {
    await import('node:fs/promises').then(({ rename }) => rename(from, to));
  } catch {
    const { cp } = await import('node:fs/promises');
    await cp(from, to, { recursive: true });
    await rm(from, { recursive: true, force: true });
  }
}

/** Helpers used by tests and other tooling. */
export { collectDirectory, installedPackageDir, normalizeArchivePath };
