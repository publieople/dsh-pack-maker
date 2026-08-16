#!/usr/bin/env node
/**
 * Build the browser client bundle for dsh-pack-maker.
 *
 * DSH web loads a plugin's client as a single factory bundle registered on
 * `window.__ModuleLoader__`: the loader calls `factory(require)` and expects
 * the returned `module.exports` to expose `{ name, inject, apply }`. React and
 * the other runtime modules are provided by the loader, so they stay external.
 *
 * This mirrors the bundle shape dsh-market ships (tsdown + a banner
 * normalizer); here esbuild produces the same shape in one script, with no
 * extra toolchain.
 */
import { build } from 'esbuild';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const id = 'dsh-pack-maker';

const banner = [
  `window.__ModuleLoader__.load({ id: ${JSON.stringify(id)}, factory: (require) => {`,
  `\tvar module = { exports: {} };`,
  `\tvar exports = module.exports;`,
  `\tObject.defineProperty(exports, Symbol.toStringTag, { value: "Module" });`,
].join('\n');

const footer = [
  `\treturn module.exports;`,
  `}});`,
].join('\n');

mkdirSync(resolve(root, 'client'), { recursive: true });

await build({
  entryPoints: [resolve(root, 'src/client/index.tsx')],
  bundle: true,
  format: 'cjs',
  platform: 'browser',
  target: ['es2020'],
  outfile: resolve(root, 'client/client.js'),
  // Provided by the DSH web loader module table at runtime.
  external: ['react', 'react/jsx-runtime'],
  jsx: 'automatic',
  banner: { js: banner },
  footer: { js: footer },
  sourcemap: false,
  minify: false,
  logLevel: 'info',
});
