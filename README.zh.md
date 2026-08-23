# dsh-pack-maker

[![CI](https://github.com/publieople/dsh-pack-maker/actions/workflows/ci.yml/badge.svg)](https://github.com/publieople/dsh-pack-maker/actions/workflows/ci.yml)

一个 DeepSeek Harness 插件：把任意 DSH profile 打包成可移植的 **整合包**（`.dshpack`），并让任何用户都能把这种整合包导入为新的 profile——**完全离线**。

把一个配置好的 DSH 环境装进一个文件：基础 profile 配置、用户 `cordis.patch.yml`、插件依赖、以及**完整的插件快照**（从 `node_modules` 打包）一起走，导入时完全不需要访问 npm registry。

## 功能

- **导出**：把已有 profile 导出为 `.dshpack` 归档。
- **导入**：把 `.dshpack` 归档导入为新的 profile（可覆盖已有 profile，旧目录自动移到 `.bak` 备份）。
- **兼容性检查**：导出前分析所有要打包的插件——每个插件的 `peerDependencies` 对 DSH 核心包的范围匹配、插件之间重复的 loader entry id/name、以及把宿主核心包当作普通依赖的 shadowing 风险。不兼容的插件会**阻断导出**（`check:false` 可跳过检查）。
- **整合包市场**：浏览远程目录或本地已有的 `.dshpack`，一键导入为新 profile。远程索引走 `DSCPACK_REGISTRY_URL`（或 `config.marketRegistry`），本地 `.dshpacks` 目录作为离线兜底。
- **完全离线**：插件目录整体 vendor 进包，导入时通过 `file:` 引用解析，无需联网。
- **checksum 校验**：每个包都带内容 sha256，导出后被修改过的包会被拒绝导入。
- **导入前预览**：Web UI（以及 `dsh web pack info`）在安装前展示包内包含的内容。
- **四个使用面**：Web 设置页、`dsh web pack ...` 命令、模型工具、斜杠命令。
- 归档格式零外部依赖（只用 Node 内置模块；命令族额外依赖 `commander`/`@deepseek-ai/dsh-cmdline`）。

## 安装

在任意已初始化 profile 中，从 [GitHub Release](https://github.com/publieople/dsh-pack-maker/releases) 安装 tarball：

```sh
dsh plugin --profile web add https://github.com/publieople/dsh-pack-maker/releases/latest/download/dsh-pack-maker-0.1.3.tgz
```

或从本地目录安装：

```sh
dsh plugin --profile web add /path/to/dsh-pack-maker
```

包声明了 `dsh.bundle`,`dsh plugin` 会自动把它追加进 profile 的 `dsh.profile.bundles`,`cordis.patch.yml` 会挂载工具(宿主插件 + 命令族)。

## 用法

### Web UI

打开 **设置 → 整合包 (Packs)**：

- **导出**：选一个 profile,选择是否打包插件快照和 lockfile,点「导出」,再点「下载」拿到 `.dshpack` 文件。
- **导入**：选择 `.dshpack` 文件,先预览(名称、创建时间、包含的插件、依赖),可选改目标 profile 名和覆盖已有 profile,然后点「导入」。
- **整合包市场**：在设置页下方的市场卡里浏览远程目录或本地 `.dshpack`,可搜索、预览,并一键导入为新 profile。

### DSH 内命令

```text
dsh web pack export web -o ./backup.dshpack
dsh web pack import ./backup.dshpack -n my-copy
dsh web pack list
dsh web pack info ./backup.dshpack
dsh web pack market [query]
dsh web pack market-import ./web.dshpack my-copy
```

> 说明:web app 独占 `dsh web` 的参数族,所以 pack 命令输出旁边会出现一行 web app 自己打印的 `error: too many arguments` 提示;命令本身照常执行并以 0 退出。写脚本时建议用下面的独立 `dsh-pack` CLI,它没有这个共存问题。

### 独立 CLI

包内附带一个零依赖的小 CLI：

```sh
dsh-pack export web ./web.dshpack
dsh-pack import ./web.dshpack my-copy [--overwrite] [--no-install]
dsh-pack list
dsh-pack info ./web.dshpack
dsh-pack market [query]
dsh-pack market-import ./web.dshpack my-copy [--overwrite] [--no-install]
```

### 模型工具与斜杠命令

profile 里的智能体也可以调用 `export_dsh_pack` / `import_dsh_pack`,或在聊天里输入 `/pack-export web ./web.dshpack`、`/pack-import ./web.dshpack my-copy`,以及浏览市场(`list_dsh_pack_market` / `/pack-market`)和从市场导入(`import_dsh_pack_market` / `/pack-market-import <path-or-url> [name]`)。

### 默认输出位置

不指定输出路径时,导出的包写到 `<workspace>/.dshpacks/<profile>.dshpack`。

## 插件兼容性检查

导出前，插件会对目标 profile 跑一次纯文件系统分析（不启动进程、不联网），检查三类问题：

1. **DSH 核心依赖范围匹配**：每个要打包插件的 `peerDependencies` 声明的 DSH 核心包（`@deepseek-ai/dsh`、`cordis`、`dsh-tools` 等）范围 vs 已解析版本。确认不兼容（低于下限 / 高于显式上限）会**阻止导出**。
2. **插件间 loader 冲突**：不同 bundle 若插入相同的 loader entry id（boot 会失败）会**阻止导出**；仅 NAME 冲突记为警告。
3. **宿主核心包当普通依赖**：插件把 DSH 共享宿主包（如 `@deepseek-ai/cordis`）列为普通依赖，可能导致其副本被 hoist 到 profile 根并遮蔽宿主版本，记为警告。

任一 **error**（缺 `dsh.bundle` 声明、重复 loader entry id、确认的 peer 不兼容）都会拒绝导出，除非显式传 `check: false`（模型工具）、`--no-check`（命令族 / 独立 CLI）。导出的结果里会附带兼容性报告（errors / warnings），方便你在聊天或日志里看到详情。

## 整合包市场

「整合包市场」是 `.dshpack` 版的插件市场：浏览、搜索、预览、一键导入。

- **数据源**：
  - 远程目录——一个 JSON 索引，通过 `DSCPACK_REGISTRY_URL` 环境变量或 `config.marketRegistry` 指定。索引结构：
    ```jsonc
    {
      "items": [
        { "name": "web", "title": "我的网站配置", "description": "...", "version": "0.1.0", "url": "https://.../web.dshpack", "size": 12345, "author": "...", "tags": ["web", "demo"] }
      ]
    }
    ```
  - 本地兜底——`<workspace>/.dshpacks`、`$DSH_HOME/.dshpacks` 里的 `.dshpack` 会被扫描进市场（离线可用）。
- **使用面**：Web 设置页的市场卡、`dsh web pack market` / `dsh web pack market-import`、`dsh-pack market` / `dsh-pack market-import`、模型工具 `list_dsh_pack_market` / `import_dsh_pack_market`、斜杠命令 `/pack-market` / `/pack-market-import`。
- **安全**：远程导入走服务端下载（同源 POST 才允许），导入仍走既有的 `importPack` 校验（checksum、路径安全检查、overwrite 防护）。

## `.dshpack` 格式

`.dshpack` 是一个 gzip 压缩的 JSON 文档：

```jsonc
{
  "format": "dsh-pack/1",
  "checksum": "规范内容的 sha256",
  "meta": {
    "name": "web",
    "title": "我的 DSH 配置",
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

三个内置 bundle(`@deepseek-ai/dsh-base`、`@deepseek-ai/dsh-web-app`、`@deepseek-ai/dsh-headless`)不会被打包,因为每个 DSH 安装都自带。其余依赖会从 profile 的 `node_modules` 快照到 `vendor/`,manifest 里的 spec 被改写为 `file:./vendor/...`,因此导入时无需再从 registry 解析。

## 安全

- 导入拒绝覆盖已有 profile,除非显式传 `overwrite`;覆盖时旧 profile 目录会移到 `profiles/<name>.bak-<timestamp>`,不会立即删除。
- 归档路径经过校验(`..` 和绝对路径会被拒绝);Web API 只接受同源请求,上传有大小上限。
- checksum 与内容不符的包会被直接拒绝——它一定是在导出后被改过的。
- Web 下载通过短期 token 提供,不接受任意文件系统路径。

## 开发

```sh
npm install
npm run build:client   # 重新构建浏览器 bundle 到 client/client.js
npm test               # node --test test/*.test.mjs
npm pack               # prepack 会自动先构建 client
```

**CI/CD**：`.github/workflows/ci.yml` 在 push/PR 时跑测试、构建 client 并校验打包清单；`.github/workflows/release.yml` 在推送 `v*` 标签时自动打包、创建 GitHub Release 并附上 `.tgz`，若配置了 `NPM_TOKEN` 还会发布到 npm。

## License

MIT
