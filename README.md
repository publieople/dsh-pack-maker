# dsh-pack-maker

A DeepSeek Harness plugin that turns any DSH profile into a portable **integration pack** (`.dshpack`) and lets any user import such a pack as a new profile — fully offline.

Share ready-made DSH setups in one file: base profile configuration, user `cordis.patch.yml`, plugin dependencies, and **complete plugin snapshots** (vendored from `node_modules`) travel together, so importing needs no registry access at all.

## Features

- **Export** an existing profile to a `.dshpack` archive.
- **Import** a `.dshpack` archive as a new profile (or overwrite one, with a `.bak` backup).
- **Fully offline**: plugin directories are vendored into the pack; import resolves them via `file:` references, so no npm registry is needed.
- **Checksum-verified**: every pack carries a sha256 over its content; a modified archive is rejected on import.
- **Pre-import preview**: the web UI (and `dsh web pack info`) shows what a pack contains before you install it.
- Four surfaces: web settings page, `dsh web pack ...` commands, model-facing tools, and slash commands.
- Dependency-free archive format: only Node built-ins are used (plus `commander`/`@deepseek-ai/dsh-cmdline` for the command family).

## Install

From any initialized profile, install the tarball from the latest [GitHub Release](https://github.com/publieople/dsh-pack-maker/releases):

```sh
dsh plugin --profile web add https://github.com/publieople/dsh-pack-maker/releases/latest/download/dsh-pack-maker-0.1.0.tgz
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

### Commands (inside a booted profile)

```text
dsh web pack export web -o ./backup.dshpack
dsh web pack import ./backup.dshpack -n my-copy
dsh web pack list
dsh web pack info ./backup.dshpack
```

### Standalone CLI

The package ships a small dependency-free CLI:

```sh
dsh-pack export web ./web.dshpack
dsh-pack import ./web.dshpack my-copy [--overwrite] [--no-install]
dsh-pack list
dsh-pack info ./web.dshpack
```

### Model-facing tools & slash commands

The agent in the profile can also call `export_dsh_pack` / `import_dsh_pack`, or you can type `/pack-export web ./web.dshpack` and `/pack-import ./web.dshpack my-copy` in the chat.

### Default output location

Without an explicit output path, exported packs go to `<workspace>/.dshpacks/<profile>.dshpack`.

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

## License

MIT
