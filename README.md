# dsh-pack-maker

[![CI](https://github.com/publieople/dsh-pack-maker/actions/workflows/ci.yml/badge.svg)](https://github.com/publieople/dsh-pack-maker/actions/workflows/ci.yml)

A DeepSeek Harness plugin that turns any DSH profile into a portable **integration pack** (`.dshpack`) and lets any user import such a pack as a new profile — fully offline.

Share ready-made DSH setups in one file: base profile configuration, user `cordis.patch.yml`, plugin dependencies, and **complete plugin snapshots** (vendored from `node_modules`) travel together, so importing needs no registry access at all.

## Features

- **Export** an existing profile to a `.dshpack` archive.
- **Import** a `.dshpack` archive as a new profile (or overwrite one, with a `.bak` backup).
- **Compatibility preflight**: before writing a pack, every bundled plugin is analyzed — `peerDependencies` ranges against DSH host core packages, cross-bundle loader entry id/name collisions, and host-core-as-ordinary-dependency shadowing. A real incompatibility **blocks the export** (`check: false` / `--no-check` skips it).
- **Pack market**: browse a remote catalogue or local `.dshpack` files and one-click import them as a new profile. The remote index comes from `DSCPACK_REGISTRY_URL` (or `config.marketRegistry`); local `.dshpacks` directories are the offline fallback.
- **Fully offline**: plugin directories are vendored into the pack; import resolves them via `file:` references, so no npm registry is needed.
- **Checksum-verified**: every pack carries a sha256 over its content; a modified archive is rejected on import.
- **Pre-import preview**: the web UI (and `dsh web pack info`) shows what a pack contains before you install it.
- Four surfaces: web settings page, `dsh web pack ...` commands, model-facing tools, and slash commands.
- Dependency-free archive format: only Node built-ins are used (plus `commander`/`@deepseek-ai/dsh-cmdline` for the command family).

## Install

From any initialized profile, install the tarball from the latest [GitHub Release](https://github.com/publieople/dsh-pack-maker/releases):

```sh
dsh plugin --profile web add https://github.com/publieople/dsh-pack-maker/releases/latest/download/dsh-pack-maker-0.1.3.tgz
```

or, from a local checkout:

```sh
dsh plugin --profile web add /path/to/dsh-pack-maker
```

The package declares `dsh.bundle`, so `dsh plugin` automatically appends it to the profile's `dsh.profile.bundles` and `cordis.patch.yml` mounts the tool (host plugin + command family).

## Usage

### Web UI

Open **Settings → 整合包 (Packs)**:

- **Export**: pick a profile, choose whether to vendor plugin snapshots and the lockfile, click *Export*, then *Download* the resulting `.dshpack`.
- **Import**: choose a `.dshpack` file, review the preview (name, creation time, bundled plugins, dependencies), optionally rename the target profile and/or overwrite an existing one, then click *Import*.
- **Pack market**: browse a remote catalogue or local packs right in the settings page, search, preview, and one-click import.

### Commands (inside a booted profile)

```text
dsh web pack export web -o ./backup.dshpack
dsh web pack import ./backup.dshpack -n my-copy
dsh web pack list
dsh web pack info ./backup.dshpack
dsh web pack market [query]
dsh web pack market-import ./web.dshpack my-copy
```

> Note: the web app owns the `dsh web` argument family, so alongside the pack
> output you will see one `error: too many arguments` line printed by the web
> app's own parser; the command still runs and exits 0. For scripting, use the
> standalone `dsh-pack` CLI below, which has no such coexistence issue.

### Standalone CLI

The package ships a small dependency-free CLI:

```sh
dsh-pack export web ./web.dshpack
dsh-pack import ./web.dshpack my-copy [--overwrite] [--no-install]
dsh-pack list
dsh-pack info ./web.dshpack
dsh-pack market [query]
dsh-pack market-import ./web.dshpack my-copy [--overwrite] [--no-install]
```

### Model-facing tools & slash commands

The agent in the profile can also call `export_dsh_pack` / `import_dsh_pack`, or you can type `/pack-export web ./web.dshpack` and `/pack-import ./web.dshpack my-copy` in the chat, plus browse the market (`list_dsh_pack_market` / `/pack-market`) and import from it (`import_dsh_pack_market` / `/pack-market-import <path-or-url> [name]`).

### Default output location

Without an explicit output path, exported packs go to `<workspace>/.dshpacks/<profile>.dshpack`.

## Plugin compatibility preflight

Before writing a pack, the plugin runs a pure-filesystem analysis of the target profile (no processes, no network), checking three classes of problem:

1. **DSH core dependency ranges**: each bundled plugin's `peerDependencies` declaring a DSH host core package (`@deepseek-ai/dsh`, `cordis`, `dsh-tools`, …) versus the resolved version. A confirmed mismatch (below the lower bound, or above an explicit upper bound) **blocks the export**.
2. **Cross-bundle loader collisions**: when two bundles insert the same loader entry id, the boot fails — that is an error and blocks; a NAME-only collision is surfaced as a warning.
3. **Host core package as an ordinary dependency**: a plugin listing a DSH shared host package (e.g. `@deepseek-ai/cordis`) in `dependencies` can get its own copy hoisted to the profile root and shadow the host's version — reported as a warning.

Any error (missing `dsh.bundle` declaration, duplicate loader entry id, confirmed peer mismatch) refuses the export unless you pass `check: false` (model tool) or `--no-check` (command family / standalone CLI). The export result carries the compatibility report (errors / warnings) for visibility.

## Pack market

The **pack market** is the `.dshpack` analogue of a plugin market: browse, search, preview, and one-click import.

- **Sources**:
  - Remote catalogue — a JSON index set via the `DSCPACK_REGISTRY_URL` environment variable or `config.marketRegistry`. Index shape:
    ```jsonc
    {
      "items": [
        { "name": "web", "title": "My website setup", "description": "...", "version": "0.1.0", "url": "https://.../web.dshpack", "size": 12345, "author": "...", "tags": ["web", "demo"] }
      ]
    }
    ```
  - Local fallback — `.dshpack` files under `<workspace>/.dshpacks` and `$DSH_HOME/.dshpacks` are scanned into the market (works fully offline).
- **Surfaces**: the web settings market card, `dsh web pack market` / `dsh web pack market-import`, `dsh-pack market` / `dsh-pack market-import`, the `list_dsh_pack_market` / `import_dsh_pack_market` tools, and the `/pack-market` / `/pack-market-import` slash commands.
- **Safety**: remote imports are downloaded server-side and only accepted from same-origin POSTs; import still goes through the existing `importPack` validation (checksum, path safety, overwrite protection).

## `.dshpack` format

A `.dshpack` is a gzip-compressed JSON document:

```jsonc
{
  "format": "dsh-pack/1",
  "checksum": "sha256 of the canonical body",
  "meta": {
    "name": "web",
    "title": "My DSH setup",
    "createdAt": "2026-08-15T00:00:00.000Z",
    "plugin": "dsh-pack-maker"
  },
  "files": {
    "profile/package.json": { "encoding": "utf8", "content": "..." },
    "profile/cordis.patch.yml": { "encoding": "utf8", "content": "..." },
    "profile/pnpm-workspace.yaml": { "encoding": "utf8", "content": "..." },
    "vendor/dshmarket/...": { "encoding": "utf8", "content": "..." }
  }
}
```

The three shipped bundles (`@deepseek-ai/dsh-base`, `@deepseek-ai/dsh-web-app`, `@deepseek-ai/dsh-headless`) are not vendored because they ship with every DSH installation. Other dependencies are snapshotted from the profile's `node_modules` into `vendor/`, and their manifest spec is rewritten to `file:./vendor/...` so the pack imports without resolving them from the registry.

## Safety

- Import refuses to overwrite an existing profile unless `overwrite` is passed; with it, the previous profile directory is moved to `profiles/<name>.bak-<timestamp>`.
- Archive paths are validated (`..` and absolute paths are rejected), and the web API only accepts same-origin requests with size-capped uploads.
- A pack whose checksum does not match its content is rejected outright — it was edited after export.
- Web downloads are served through short-lived tokens, never arbitrary filesystem paths.

## Development

```sh
npm install
npm run build:client   # rebuild the browser bundle into client/client.js
npm test               # node --test test/*.test.mjs
npm pack               # prepack runs build:client automatically
```

**CI/CD**: `.github/workflows/ci.yml` runs tests, the client build, and a pack-contents check on every push/PR; `.github/workflows/release.yml` triggers on a `v*` tag, packs the tarball, creates a GitHub Release with the `.tgz` attached, and publishes to npm when `NPM_TOKEN` is configured.

## License

MIT
