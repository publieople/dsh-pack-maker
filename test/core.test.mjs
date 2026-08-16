import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  PACK_FORMAT,
  buildPack,
  exportPack,
  importPack,
  importPackFile,
  listProfiles,
  parsePack,
} from '../lib/core.js';

async function makeProfileHome(profile = 'demo') {
  const home = await mkdtemp(join(tmpdir(), 'dsh-pack-test-'));
  process.env.DSH_HOME = home;
  const dir = join(home, 'profiles', profile);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'package.json'), JSON.stringify({
    name: `dsh-profile-${profile}`,
    private: true,
    dependencies: {
      'demo-plugin': '^1.0.0',
    },
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', 'demo-plugin'] } },
  }, null, 2));
  await writeFile(join(dir, 'cordis.patch.yml'), '# user patch\n[]\n');
  await writeFile(join(dir, 'pnpm-workspace.yaml'), 'packages:\n  - .\n');
  const pluginDir = join(dir, 'node_modules', 'demo-plugin');
  await mkdir(pluginDir, { recursive: true });
  await writeFile(join(pluginDir, 'package.json'), JSON.stringify({
    name: 'demo-plugin',
    version: '1.0.0',
    type: 'module',
    main: 'index.js',
    dsh: { bundle: { patch: './cordis.patch.yml' } },
  }, null, 2));
  await writeFile(join(pluginDir, 'index.js'), 'export const ok = true;\n');
  await writeFile(join(pluginDir, 'cordis.patch.yml'), '- insert:\n    - id: demo\n      name: demo-plugin\n');
  return { home, dir, pluginDir };
}

test('buildPack creates a parseable .dshpack with profile and vendor files', async () => {
  const { home } = await makeProfileHome();
  try {
    const buffer = await buildPack({ profile: 'demo', title: 'Demo' });
    const pack = parsePack(buffer);
    assert.equal(pack.format, PACK_FORMAT);
    assert.equal(pack.meta.name, 'demo');
    assert.equal(pack.meta.title, 'Demo');
    assert.ok(pack.files['profile/package.json']);
    assert.ok(pack.files['profile/cordis.patch.yml']);
    assert.ok(pack.files['vendor/demo-plugin/package.json']);
    assert.ok(pack.files['vendor/demo-plugin/index.js']);
    assert.ok(!pack.files['vendor/demo-plugin/cordis.patch.yml'] ? false : true);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test('exportPack writes .dshpack to default output directory', async () => {
  const { home } = await makeProfileHome();
  try {
    const workspace = join(home, 'work');
    await mkdir(workspace, { recursive: true });
    const result = await exportPack({ profile: 'demo', workspace });
    assert.ok(result.outputPath.endsWith('.dshpack'));
    assert.ok(result.bytes > 0);
    const stat = await import('node:fs/promises').then(({ stat }) => stat(result.outputPath));
    assert.equal(stat.size, result.bytes);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test('importPack restores a profile from a pack', async () => {
  const { home } = await makeProfileHome();
  try {
    const buffer = await buildPack({ profile: 'demo' });
    process.env.DSH_HOME = join(home, 'other-home');
    const result = await importPack({ buffer, profileName: 'restored', autoInstall: false });
    assert.equal(result.profile, 'restored');
    assert.equal(result.install.skipped, true);
    const manifest = JSON.parse(await readFile(join(result.dir, 'package.json'), 'utf8'));
    assert.equal(manifest.name, 'dsh-profile-demo');
    assert.deepEqual(manifest.dependencies, { 'demo-plugin': 'file:./vendor/demo-plugin' });
    assert.ok(await readFile(join(result.dir, 'vendor/demo-plugin/index.js'), 'utf8'));
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test('importPackFile works from a file path', async () => {
  const { home } = await makeProfileHome();
  try {
    const packPath = join(home, 'demo.dshpack');
    await exportPack({ profile: 'demo', outputPath: packPath });
    process.env.DSH_HOME = join(home, 'other-home-2');
    const result = await importPackFile({ packPath, profileName: 'from-file', autoInstall: false });
    assert.equal(result.profile, 'from-file');
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test('importPack refuses to overwrite unless requested', async () => {
  const { home } = await makeProfileHome('src');
  try {
    const buffer = await buildPack({ profile: 'src' });
    process.env.DSH_HOME = join(home, 'overwrite-home');
    await importPack({ buffer, profileName: 'same', autoInstall: false });
    await assert.rejects(() => importPack({ buffer, profileName: 'same', autoInstall: false }), /already exists/);
    const replaced = await importPack({ buffer, profileName: 'same', autoInstall: false, overwrite: true });
    assert.ok(replaced.backupDir);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test('parsePack rejects unsafe archive paths', async () => {
  const { home } = await makeProfileHome();
  try {
    const buffer = await buildPack({ profile: 'demo' });
    const pack = parsePack(buffer);
    pack.files['../evil'] = { encoding: 'utf8', content: 'x' };
    const { gzipSync } = await import('node:zlib');
    const evilBuffer = gzipSync(Buffer.from(JSON.stringify(pack)));
    assert.throws(() => parsePack(evilBuffer), /unsafe path/);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test('listProfiles returns initialized profiles', async () => {
  const home = await mkdtemp(join(tmpdir(), 'dsh-pack-list-'));
  process.env.DSH_HOME = home;
  try {
    const dir = join(home, 'profiles', 'alpha');
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'package.json'), '{}');
    const profiles = await listProfiles();
    assert.ok(profiles.includes('alpha'));
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test('parsePack accepts a pack and rejects a tampered one via checksum', async () => {
  const { home } = await makeProfileHome();
  try {
    const buffer = await buildPack({ profile: 'demo' });
    // Untouched pack parses fine.
    const pack = parsePack(buffer);
    assert.equal(pack.format, PACK_FORMAT);
    assert.equal(typeof pack.checksum, 'string');

    // Editing any content and re-gzipping breaks the checksum.
    // Tamper with content while keeping the original checksum: re-deriving
    // the canonical body must now disagree with it.
    const tampered = structuredClone(pack);
    tampered.files['profile/cordis.patch.yml'] = { encoding: 'utf8', content: '# evil\n[]\n' };
    const { gzipSync } = await import('node:zlib');
    const evilBuffer = gzipSync(Buffer.from(JSON.stringify(tampered)));
    assert.throws(() => parsePack(evilBuffer), /checksum mismatch/);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test('parsePack still accepts legacy packs without a checksum', async () => {
  const { home } = await makeProfileHome();
  try {
    const buffer = await buildPack({ profile: 'demo' });
    const pack = parsePack(buffer);
    delete pack.checksum;
    const { gzipSync } = await import('node:zlib');
    const legacy = gzipSync(Buffer.from(JSON.stringify(pack)));
    assert.doesNotThrow(() => parsePack(legacy));
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test('summarizePack previews metadata, bundles and dependencies', async () => {
  const { home } = await makeProfileHome();
  try {
    const buffer = await buildPack({ profile: 'demo', title: 'Demo setup', description: 'A demo' });
    const summary = await import('../lib/core.js').then((m) => m.summarizePack(buffer));
    assert.equal(summary.meta.name, 'demo');
    assert.equal(summary.meta.title, 'Demo setup');
    assert.ok(summary.bundles.includes('@deepseek-ai/dsh-base'));
    assert.ok(summary.bundles.includes('demo-plugin'));
    assert.deepEqual(summary.dependencies, { 'demo-plugin': 'file:./vendor/demo-plugin' });
    assert.ok(summary.fileCount > 0);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
