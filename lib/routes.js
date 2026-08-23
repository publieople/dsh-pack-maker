/**
 * Host HTTP routes for dsh-pack-maker: the /dsh-pack/* API the settings-page
 * client talks to. Route registration only parses requests, calls the
 * dependency-free core, and serializes responses.
 *
 * Security model mirrors dsh-market: mutating routes accept same-origin
 * requests only, upload bodies are size-capped, profile names are validated,
 * and file downloads are served through an in-memory token map instead of
 * accepting arbitrary paths.
 */
import { randomUUID } from 'node:crypto';
import { createReadStream, existsSync, readFileSync } from 'node:fs';
import { stat } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { exportPack, importPack, listProfiles, summarizePack } from './core.js';
import { listMarketItems, resolvePackBuffer } from './market.js';

const PROFILE_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const MAX_UPLOAD_BYTES = 512 * 1024 * 1024;
const DOWNLOAD_TTL_MS = 60 * 60 * 1000;

function sendJson(response, status, payload) {
  response.writeHead(status, {
    'cache-control': 'no-store',
    'content-type': 'application/json; charset=utf-8',
  });
  response.end(JSON.stringify(payload));
}

function sendError(response, status, message) {
  sendJson(response, status, { ok: false, error: String(message) });
}

/** True when the request's Origin matches its Host — required on every POST. */
function sameOrigin(request) {
  const origin = request.headers.origin;
  const host = request.headers.host;
  if (origin === undefined || host === undefined) return false;
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

/** Read a raw request body into one buffer, capped at MAX_UPLOAD_BYTES. */
async function readRawBody(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > MAX_UPLOAD_BYTES) {
      throw new Error(`request body exceeds ${MAX_UPLOAD_BYTES} bytes`);
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

/**
 * Best-effort DSH version detection: walk up from the process entry point to
 * the nearest package.json named @deepseek-ai/dsh. Returns undefined when the
 * layout is unrecognizable (tests, embedded hosts).
 */
export function detectDshVersion() {
  try {
    const entry = process.argv[1];
    if (typeof entry !== 'string' || entry === '') return undefined;
    let dir = dirname(entry);
    for (let depth = 0; depth < 6; depth += 1) {
      const manifestPath = join(dir, 'package.json');
      if (existsSync(manifestPath)) {
        const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
        if (manifest.name === '@deepseek-ai/dsh' && typeof manifest.version === 'string') {
          return manifest.version;
        }
      }
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  } catch {
    // Detection is informational; never fail the request over it.
  }
  return undefined;
}

/**
 * Register every /dsh-pack route on a webServer host.
 * @param {object} webServer - the webServer service (ctx.webServer).
 * @param {object} config - resolved plugin config (outputDir, autoInstall).
 * @returns {() => void} disposer removing every registered route.
 */
export function mountPackRoutes(webServer, config) {
  /** token -> { path, expiresAt } for recently exported archives. */
  const downloads = new Map();
  const disposers = [];

  const register = (kind, path, handler) => {
    disposers.push(webServer.register({ kind, path, handler }));
  };

  // GET /dsh-pack/profiles — profile roster + DSH version for the export UI.
  register('exact', '/dsh-pack/profiles', async (request, response) => {
    if (request.method !== 'GET') {
      response.writeHead(405, { allow: 'GET' });
      response.end();
      return;
    }
    try {
      sendJson(response, 200, {
        ok: true,
        profiles: await listProfiles(),
        dshVersion: detectDshVersion(),
      });
    } catch (error) {
      sendError(response, 500, error);
    }
  });

  // POST /dsh-pack/export — build a .dshpack from an existing profile.
  register('exact', '/dsh-pack/export', async (request, response) => {
    if (request.method !== 'POST') {
      response.writeHead(405, { allow: 'POST' });
      response.end();
      return;
    }
    if (!sameOrigin(request)) {
      sendError(response, 403, 'cross-origin requests are not allowed');
      return;
    }
    try {
      const body = JSON.parse(await readRawBody(request));
      const profile = typeof body?.profile === 'string' ? body.profile : '';
      if (!PROFILE_RE.test(profile)) {
        sendError(response, 400, `invalid profile name ${JSON.stringify(profile)}`);
        return;
      }
      const result = await exportPack({
        profile,
        includeVendor: body?.includeVendor !== false,
        includeLockfile: body?.includeLockfile !== false,
        outputDir: config.outputDir,
      });
      const token = randomUUID();
      downloads.set(token, { path: result.outputPath, expiresAt: Date.now() + DOWNLOAD_TTL_MS });
      sendJson(response, 200, {
        ok: true,
        outputPath: result.outputPath,
        bytes: result.bytes,
        token,
      });
    } catch (error) {
      sendError(response, 500, error);
    }
  });

  // GET /dsh-pack/download?token= — stream a recently exported archive.
  register('exact', '/dsh-pack/download', async (request, response) => {
    if (request.method !== 'GET') {
      response.writeHead(405, { allow: 'GET' });
      response.end();
      return;
    }
    try {
      const url = new URL(request.url, 'http://localhost');
      const token = url.searchParams.get('token') ?? '';
      const entry = downloads.get(token);
      if (entry === undefined || entry.expiresAt < Date.now()) {
        sendError(response, 404, 'download token is missing or expired — export again');
        return;
      }
      const info = await stat(entry.path);
      if (!info.isFile()) {
        sendError(response, 404, 'exported file no longer exists');
        return;
      }
      response.writeHead(200, {
        'content-type': 'application/octet-stream',
        'content-disposition': `attachment; filename="${basename(entry.path)}"`,
        'content-length': String(info.size),
        'cache-control': 'no-store',
      });
      await new Promise((resolvePromise, reject) => {
        const stream = createReadStream(entry.path);
        stream.on('error', reject);
        stream.on('close', resolvePromise);
        stream.pipe(response);
      });
    } catch (error) {
      sendError(response, 500, error);
    }
  });

  // POST /dsh-pack/preview — parse an uploaded .dshpack and return a summary.
  register('exact', '/dsh-pack/preview', async (request, response) => {
    if (request.method !== 'POST') {
      response.writeHead(405, { allow: 'POST' });
      response.end();
      return;
    }
    if (!sameOrigin(request)) {
      sendError(response, 403, 'cross-origin requests are not allowed');
      return;
    }
    try {
      const buffer = await readRawBody(request);
      sendJson(response, 200, { ok: true, summary: await summarizePack(buffer) });
    } catch (error) {
      sendError(response, 400, error);
    }
  });

  // POST /dsh-pack/import?profileName=&overwrite= — install an uploaded pack.
  register('exact', '/dsh-pack/import', async (request, response) => {
    if (request.method !== 'POST') {
      response.writeHead(405, { allow: 'POST' });
      response.end();
      return;
    }
    if (!sameOrigin(request)) {
      sendError(response, 403, 'cross-origin requests are not allowed');
      return;
    }
    try {
      const url = new URL(request.url, 'http://localhost');
      const profileName = url.searchParams.get('profileName') ?? undefined;
      const overwrite = url.searchParams.get('overwrite') === 'true';
      if (profileName !== undefined && !PROFILE_RE.test(profileName)) {
        sendError(response, 400, `invalid profile name ${JSON.stringify(profileName)}`);
        return;
      }
      const buffer = await readRawBody(request);
      const result = await importPack({
        buffer,
        ...(profileName !== undefined ? { profileName } : {}),
        overwrite,
        autoInstall: config.autoInstall,
      });
      sendJson(response, 200, {
        ok: true,
        result: {
          profile: result.profile,
          dir: result.dir,
          ...(result.backupDir !== null ? { backupDir: result.backupDir } : {}),
          install: result.install ?? { ok: false, skipped: true },
        },
      });
    } catch (error) {
      sendError(response, 400, error);
    }
  });

  // GET /dsh-pack/market — merged remote + local pack catalogue.
  register('exact', '/dsh-pack/market', async (request, response) => {
    if (request.method !== 'GET') {
      response.writeHead(405, { allow: 'GET' });
      response.end();
      return;
    }
    try {
      const url = new URL(request.url, 'http://localhost');
      const query = (url.searchParams.get('query') ?? '').trim().toLowerCase();
      const { items, errors } = await listMarketItems({ ...config, workspace: process.cwd() });
      const filtered = query === ''
        ? items
        : items.filter((item) =>
            `${item.name} ${item.title} ${item.description} ${item.author}`.toLowerCase().includes(query));
      sendJson(response, 200, { ok: true, items: filtered, errors });
    } catch (error) {
      sendError(response, 500, error);
    }
  });

  // POST /dsh-pack/market/preview — resolve a market item and summarize it
  // without importing. Body: { source: 'local'|'remote', path?, url? }.
  register('exact', '/dsh-pack/market/preview', async (request, response) => {
    if (request.method !== 'POST') {
      response.writeHead(405, { allow: 'POST' });
      response.end();
      return;
    }
    if (!sameOrigin(request)) {
      sendError(response, 403, 'cross-origin requests are not allowed');
      return;
    }
    try {
      const body = JSON.parse(await readRawBody(request));
      const buffer = await resolvePackBuffer({ source: body?.source, path: body?.path, url: body?.url });
      sendJson(response, 200, { ok: true, summary: await summarizePack(buffer) });
    } catch (error) {
      sendError(response, 400, error);
    }
  });

  // POST /dsh-pack/market/import?profileName=&overwrite= — download/read a
  // market item and install it as a profile. Body: { source, path?, url? }.
  register('exact', '/dsh-pack/market/import', async (request, response) => {
    if (request.method !== 'POST') {
      response.writeHead(405, { allow: 'POST' });
      response.end();
      return;
    }
    if (!sameOrigin(request)) {
      sendError(response, 403, 'cross-origin requests are not allowed');
      return;
    }
    try {
      const url = new URL(request.url, 'http://localhost');
      const profileName = url.searchParams.get('profileName') ?? undefined;
      const overwrite = url.searchParams.get('overwrite') === 'true';
      if (profileName !== undefined && !PROFILE_RE.test(profileName)) {
        sendError(response, 400, `invalid profile name ${JSON.stringify(profileName)}`);
        return;
      }
      const body = JSON.parse(await readRawBody(request));
      const buffer = await resolvePackBuffer({ source: body?.source, path: body?.path, url: body?.url });
      const result = await importPack({
        buffer,
        ...(profileName !== undefined ? { profileName } : {}),
        overwrite,
        autoInstall: config.autoInstall,
      });
      sendJson(response, 200, {
        ok: true,
        result: {
          profile: result.profile,
          dir: result.dir,
          ...(result.backupDir !== null ? { backupDir: result.backupDir } : {}),
          install: result.install ?? { ok: false, skipped: true },
        },
      });
    } catch (error) {
      sendError(response, 400, error);
    }
  });

  return () => {
    for (const dispose of disposers) dispose();
  };
}
