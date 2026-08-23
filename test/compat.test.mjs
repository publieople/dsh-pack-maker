import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkProfileCompat } from '../lib/check.js';
import { exportPack } from '../lib/core.js';

/**
 * Build a throwaway profile dir under a fresh DSH_HOME. `plugins` is a map of
 * package name -> package.json fields; a `patch` + `patchContent` pair writes
 * the bundle patch file.
 */
async function makeProfile({ bundles = [], deps = {}, plugins = {}, extraFiles = {} }) {
  const home = await mkdtemp(join(tmpdir(), 'dsh-compat-'));
  process.env.DSH_HOME = home;
  const dir = join(home, 'profiles', 'demo');
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'package.json'), JSON.stringify({
    name: 'dsh-profile-demo',
    private: true,
    dependencies: deps,
    dsh: { profile: { bundles } },
  }, null, 2));
  await writeFile(join(dir, 'cordis.patch.yml'), '[]\n');
  for (const [name, spec] of Object.entries(plugins)) {
    const pdir = join(dir, 'node_modules', ...name.split('/'));
    await mkdir(pdir, { recursive: true });
    await writeFile(join(pdir, 'package.json'), JSON.stringify({ name, version: '1.0.0', type: 'module', ...spec }, null, 2));
    if (spec.patch !== undefined && spec.patchContent !== undefined) {
      await writeFile(join(pdir, spec.patch), spec.patchContent);
    }
  }
  for (const [rel, content] of Object.entries(extraFiles)) {
    const target = join(dir, rel);
    await mkdir(join(target, '..'), { recursive: true });
    await writeFile(target, content);
  }
  return { home, dir };
}

const healthyPlugin = {
  patch: './cordis.patch.yml',
  patchContent: '- insert:\n    - id: demo\n      name: demo-plugin\n',
  index: '',
};

test('checkProfileCompat passes a healthy profile', async () => {
  const { home } = await makeProfile({
    bundles: ['@deepseek-ai/dsh-base', 'demo-plugin'],
    deps: { 'demo-plugin': '^1.0.0' },
    plugins: { 'demo-plugin': { main: 'index.js', dsh: { bundle: { patch: './cordis.patch.yml' } }, ...healthyPlugin } },
  });
  try {
    const report = await checkProfileCompat(join(home, 'profiles', 'demo'));
    assert.equal(report.ok, true);
    assert.equal(report.errors.length, 0);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test('checkProfileCompat blocks a confirmed peer mismatch', async () => {
  const { home } = await makeProfile({
    bundles: ['@deepseek-ai/dsh-base', 'incompat-plugin'],
    deps: { 'incompat-plugin': '^1.0.0' },
    plugins: {
      'incompat-plugin': {
        main: 'index.js',
        peerDependencies: { '@deepseek-ai/cordis': '^4.0.0' },
        dsh: { bundle: { patch: './cordis.patch.yml' } },
        patch: './cordis.patch.yml',
        patchContent: '- insert:\n    - id: x\n      name: incompat-plugin\n',
      },
    },
    extraFiles: { 'node_modules/@deepseek-ai/cordis/package.json': JSON.stringify({ name: '@deepseek-ai/cordis', version: '3.0.0' }, null, 2) },
  });
  try {
    const report = await checkProfileCompat(join(home, 'profiles', 'demo'));
    assert.equal(report.ok, false);
    assert.ok(report.errors.some((line) => line.includes('incompat-plugin peer @deepseek-ai/cordis')));
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test('checkProfileCompat reports duplicate loader entry ids across bundles', async () => {
  const { home } = await makeProfile({
    bundles: ['@deepseek-ai/dsh-base', 'a-plugin', 'b-plugin'],
    deps: { 'a-plugin': '^1.0.0', 'b-plugin': '^1.0.0' },
    plugins: {
      'a-plugin': {
        main: 'index.js', dsh: { bundle: { patch: './cordis.patch.yml' } },
        patch: './cordis.patch.yml', patchContent: '- insert:\n    - id: shared\n      name: a-plugin\n',
      },
      'b-plugin': {
        main: 'index.js', dsh: { bundle: { patch: './cordis.patch.yml' } },
        patch: './cordis.patch.yml', patchContent: '- insert:\n    - id: shared\n      name: b-plugin\n',
      },
    },
  });
  try {
    const report = await checkProfileCompat(join(home, 'profiles', 'demo'));
    assert.equal(report.ok, false);
    assert.ok(report.errors.some((line) => line.includes('duplicate loader entry id "shared"')));
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test('checkProfileCompat flags host-core-as-dependency as a warning, not a block', async () => {
  const { home } = await makeProfile({
    bundles: ['@deepseek-ai/dsh-base', 'shadow-plugin'],
    deps: { 'shadow-plugin': '^1.0.0' },
    plugins: {
      'shadow-plugin': {
        main: 'index.js',
        dependencies: { '@deepseek-ai/cordis': '^4.0.0' },
        dsh: { bundle: { patch: './cordis.patch.yml' } },
        patch: './cordis.patch.yml', patchContent: '- insert:\n    - id: s\n      name: shadow-plugin\n',
      },
    },
  });
  try {
    const report = await checkProfileCompat(join(home, 'profiles', 'demo'));
    assert.equal(report.ok, true);
    assert.ok(report.warnings.some((line) => line.includes('shadow-plugin lists host core package @deepseek-ai/cordis')));
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test('exportPack refuses an incompatible profile with PACK_COMPAT', async () => {
  const { home } = await makeProfile({
    bundles: ['@deepseek-ai/dsh-base', 'incompat-plugin'],
    deps: { 'incompat-plugin': '^1.0.0' },
    plugins: {
      'incompat-plugin': {
        main: 'index.js', peerDependencies: { '@deepseek-ai/cordis': '^4.0.0' },
        dsh: { bundle: { patch: './cordis.patch.yml' } },
        patch: './cordis.patch.yml', patchContent: '- insert:\n    - id: x\n      name: incompat-plugin\n',
      },
    },
    extraFiles: { 'node_modules/@deepseek-ai/cordis/package.json': JSON.stringify({ name: '@deepseek-ai/cordis', version: '3.0.0' }, null, 2) },
  });
  try {
    await assert.rejects(
      () => exportPack({ profile: 'demo', outputPath: join(home, 'out.dshpack') }),
      (error) => error.code === 'PACK_COMPAT',
    );
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test('exportPack with check:false exports the same incompatible profile', async () => {
  const { home } = await makeProfile({
    bundles: ['@deepseek-ai/dsh-base', 'incompat-plugin'],
    deps: { 'incompat-plugin': '^1.0.0' },
    plugins: {
      'incompat-plugin': {
        main: 'index.js', peerDependencies: { '@deepseek-ai/cordis': '^4.0.0' },
        dsh: { bundle: { patch: './cordis.patch.yml' } },
        patch: './cordis.patch.yml', patchContent: '- insert:\n    - id: x\n      name: incompat-plugin\n',
      },
    },
    extraFiles: { 'node_modules/@deepseek-ai/cordis/package.json': JSON.stringify({ name: '@deepseek-ai/cordis', version: '3.0.0' }, null, 2) },
  });
  try {
    const result = await exportPack({ profile: 'demo', outputPath: join(home, 'out.dshpack'), check: false });
    assert.ok(result.outputPath.endsWith('.dshpack'));
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
