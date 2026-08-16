# dsh-pack-maker

一个 DeepSeek Harness 插件：把任意 DSH profile 打包成可移植的 **整合包**（`.dshpack`），并让任何用户都能把这种整合包导入为新的 profile——**完全离线**。

把一个配置好的 DSH 环境装进一个文件：基础 profile 配置、用户 `cordis.patch.yml`、插件依赖、以及**完整的插件快照**（从 `node_modules` 打包）一起走，导入时完全不需要访问 npm registry。

## 功能

- **导出**：把已有 profile 导出为 `.dshpack` 归档。
- **导入**：把 `.dshpack` 归档导入为新的 profile（可覆盖已有 profile，旧目录自动移到 `.bak` 备份）。
- **完全离线**：插件目录整体 vendor 进包，导入时通过 `file:` 引用解析，无需联网。
- **checksum 校验**：每个包都带内容 sha256，导出后被修改过的包会被拒绝导入。
- **导入前预览**：Web UI（以及 `dsh web pack info`）在安装前展示包内包含的内容。
- **四个使用面**：Web 设置页、`dsh web pack ...` 命令、模型工具、斜杠命令。
- 归档格式零外部依赖（只用 Node 内置模块；命令族额外依赖 `commander`/`@deepseek-ai/dsh-cmdline`）。

## 安装

在任意已初始化 profile 中，从 [GitHub Release](https://github.com/publieople/dsh-pack-maker/releases) 安装 tarball：

```sh
dsh plugin --profile web add https://github.com/publieople/dsh-pack-maker/releases/latest/download/dsh-pack-maker-0.1.0.tgz
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

### DSH 内命令

```text
dsh web pack export web -o ./backup.dshpack
dsh web pack import ./backup.dshpack -n my-copy
dsh web pack list
dsh web pack info ./backup.dshpack
```

### 独立 CLI

包内附带一个零依赖的小 CLI：

```sh
dsh-pack export web ./web.dshpack
dsh-pack import ./web.dshpack my-copy [--overwrite] [--no-install]
dsh-pack list
dsh-pack info ./web.dshpack
```

### 模型工具与斜杠命令

profile 里的智能体也可以调用 `export_dsh_pack` / `import_dsh_pack`,或在聊天里输入 `/pack-export web ./web.dshpack`、`/pack-import ./web.dshpack my-copy`。

### 默认输出位置

不指定输出路径时,导出的包写到 `<workspace>/.dshpacks/<profile>.dshpack`。

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

## License

MIT
