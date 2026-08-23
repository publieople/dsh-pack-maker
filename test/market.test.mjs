import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildPack } from '../lib/core.js';
import {
  scanLocalPacks,
  mergeMarketItems,
  fetchMarketIndex,
  normalizeRemoteItem,
  resolvePackBuffer,
} from '../lib/market.js';

/** Build a minimal profile and write its .dshpack into `home`. */
async function createPack(home, profileName = 'demo') {
  process.env.DSH_HOME = home;
  const dir = join(home, 'profiles', profileName);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'package.json'), JSON.stringify({
    name: `dsh-profile-${profileName}`,
    private: true,
    dependencies: {},
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base'] } },
  }, null, 2));
  await writeFile(join(dir, 'cordis.patch.yml'), '[]\n');
  const buffer = await buildPack({ profile: profileName, title: `Title ${profileName}` });
  const path = join(home, `${profileName}.dshpack`);
  await writeFile(path, buffer);
  return path;
}

test('normalizeRemoteItem drops entries missing a name or url', () => {
  assert.equal(normalizeRemoteItem({ name: '', url: 'http://x/a.dshpack' }), null);
  assert.equal(normalizeRemoteItem({ name: 'a', url: '' }), null);
  const item = normalizeRemoteItem({ name: 'a', url: 'http://x/a.dshpack', title: 'A', version: '1.0.0', tags: ['x', 'y'] });
  assert.equal(item.source, 'remote');
  assert.equal(item.id, 'a');
  assert.deepEqual(item.tags, ['x', 'y']);
});

test('scanLocalPacks finds and summarizes local .dshpack archives', async () => {
  const home = await mkdtemp(join(tmpdir(), 'dsh-market-'));
  try {
    const path = await createPack(home, 'localpack');
    const items = await scanLocalPacks([home]);
    const entry = items.find((item) => item.name === 'localpack');
    assert.ok(entry);
    assert.equal(entry.source, 'local');
    assert.equal(entry.path, path);
    assert.equal(entry.title, 'Title localpack');
    assert.ok(entry.fileCount > 0);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test('mergeMarketItems prefers remote over local on a name collision and keeps local-only', () => {
  const remote = [{ name: 'dup', source: 'remote', url: 'http://x/dup.dshpack', title: 'R' }];
  const local = [
    { name: 'dup', source: 'local', path: '/tmp/dup.dshpack', title: 'L' },
    { name: 'only', source: 'local', path: '/tmp/only.dshpack', title: 'Only' },
  ];
  const merged = mergeMarketItems(remote, local);
  assert.equal(merged.length, 2);
  const dup = merged.find((item) => item.name === 'dup');
  assert.equal(dup.source, 'remote');
  assert.ok(merged.some((item) => item.name === 'only'));
});

test('fetchMarketIndex parses a remote index served over HTTP', async () => {
  const server = createServer((request, response) => {
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({ items: [{ name: 'a', url: 'http://127.0.0.1/a.dshpack', title: 'A' }] }));
  });
  await new Promise((resolve) => server.listen(0, resolve));
  const port = server.address().port;
  try {
    const items = await fetchMarketIndex(`http://127.0.0.1:${port}/index.json`);
    assert.equal(items.length, 1);
    assert.equal(items[0].name, 'a');
    assert.equal(items[0].source, 'remote');
  } finally {
    server.close();
  }
});

test('fetchMarketIndex rejects a malformed index', async () => {
  const server = createServer((request, response) => {
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({ nope: true }));
  });
  await new Promise((resolve) => server.listen(0, resolve));
  const port = server.address().port;
  try {
    await assert.rejects(() => fetchMarketIndex(`http://127.0.0.1:${port}/index.json`), /items array/);
  } finally {
    server.close();
  }
});

test('resolvePackBuffer reads a local .dshpack path', async () => {
  const home = await mkdtemp(join(tmpdir(), 'dsh-market-resolve-'));
  try {
    const path = await createPack(home, 'localpack');
    const buffer = await resolvePackBuffer({ source: 'local', path });
    assert.ok(buffer.length > 0);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
