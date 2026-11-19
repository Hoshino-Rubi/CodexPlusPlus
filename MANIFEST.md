# 迁移交接清单

- 目标工作区：项目根目录。
- 旧备份：项目外部的本地迁移备份；始终仅执行只读访问和拷贝，未修改、移动或删除源目录中的文件。
- 已补全 Electron 主进程、Preload、完整渲染资产，并获取与原后端精确版本匹配的官方 Rust 源码。
- 未调用 IDA Pro MCP 或反汇编工具，未安装 npm/cargo 依赖，未构建应用，未编写业务代码或生成测试代码。
- 根目录 `.gitignore` 保留指定规则：`target/`、`node_modules/`、`*.i64`、`*.idb`、`*.log`。未初始化工作区根 Git 仓库；`backend_official/` 的 Git 元数据来自本次授权的官方仓库克隆。

## Electron 完整资产与来源核对

已定位原安装包：

```text
C:/Program Files/WindowsApps/OpenAI.Codex_26.1023.6123.0_x64__2p2nqsd0c76g0/app/resources/app.asar
```

旧备份的 `unpacked_modules/` 已包含完整的 `app.asar` 根结构。直接读取原 ASAR 文件目录及其 SHA-256 完整性字段进行核对，未执行归档内的应用代码：

- 原归档文件总数：**22,333**。
- 排除 `node_modules/` 后：**21,563** 个文件；排除的依赖文件为 **770** 个。
- 旧备份对应文件数：**21,563**。
- **21,563 个文件逐一通过原 ASAR 中的 SHA-256 校验**；缺失、大小不符、哈希不符、额外文件及链接成员均为 0。
- 因已有经核对的完整解包目录，未重复运行 `npx @electron/asar extract`，也未创建 `raw_frontend_full/`。

将 `unpacked_modules/` 中除 `node_modules/` 外的全部内容按原相对路径拷贝到 `raw_frontend/`，包含全部语言包及 `native-menu-locales/`。本轮新增 **21,563 个文件**，合计 **649,359,094 字节**；全部副本已逐一核对文件大小。

`raw_frontend/package.json`：

```json
{
  "name": "openai-codex-electron",
  "version": "26.1023.50603",
  "main": ".vite/build/early-bootstrap.js"
}
```

| 架构部分 | 已就位路径 | 文件数 |
| --- | --- | ---: |
| Electron 根配置 | `raw_frontend/package.json` | 1 |
| 主进程、Preload 及配套构建产物 | `raw_frontend/.vite/build/` | 39 |
| 完整渲染界面与静态资源，包含所有原始语言包 | `raw_frontend/webview/` | 21,459 |
| 原生菜单语言资源 | `raw_frontend/native-menu-locales/` | 64 |

已确认入口 `.vite/build/early-bootstrap.js` 及其引用的 `bootstrap-6cT5OGXH.js` 存在；主进程构建文件为 `.vite/build/main-CP9z2iYn.js`。同时确认 `preload.js`、`sandbox-preload.js`、`browser-page-preload.js`、`webview/index.html` 和 `webview/detached-window.html` 均已就位。

当前完整目录结构（括号内为递归文件数）：

```text
raw_frontend/                              (42,901)
├── package.json                           (1)
├── .vite/build/                           (39)
│   ├── early-bootstrap.js
│   ├── bootstrap-6cT5OGXH.js
│   ├── main-CP9z2iYn.js
│   ├── preload.js
│   ├── sandbox-preload.js
│   ├── browser-page-preload.js
│   └── 其余配套构建产物
├── webview/                               (21,459；本轮完整渲染资产)
│   ├── index.html
│   ├── detached-window.html
│   ├── assets/
│   ├── apps/
│   ├── images/
│   ├── licenses/
│   └── service-worker/
├── native-menu-locales/                    (64)
├── assets/                                (21,176；首轮筛选快照)
├── apps/                                  (29；首轮筛选快照)
├── images/                                (129；首轮筛选快照)
├── licenses/                              (1；首轮筛选快照)
├── service-worker/                        (1；首轮筛选快照)
├── index.html                             (1；首轮筛选快照)
└── detached-window.html                   (1；首轮筛选快照)
```

首轮排除了 121 个非 `en` / `zh` 语言包的 21,338 个文件保持原位。本轮完整 `webview/` 未执行语言筛选，已包含这些语言包。当前 `raw_frontend/` 总计 **42,901 个文件、1,028,063,845 字节**；其中 `node_modules/` 文件数为 0。

22,333 对应原 `app.asar` 的全部文件数；21,459 对应其 `webview/` 子目录文件数，原先的统计差异已解释清楚。

## 精确版本及官方 Rust 源码

命令：

```powershell
.\native\codex-original.exe --version
```

完整输出（退出码 0）：

```text
codex-cli 0.165.0-alpha.1.2
```

安装目录的 `app/resources/codex.exe` 与 `native/codex-original.exe` 的 SHA-256 一致（`5C1B55966BF9F757DCBF00065C9A6CB862EAD55D34B015F1BE1939FF18E43943`），确认此后端与上述 Electron 原安装包对应。

- 官方仓库：[openai/codex](https://github.com/openai/codex)。
- 检出的精确 Tag：[`rust-v0.165.0-alpha.1.2`](https://github.com/openai/codex/tree/rust-v0.165.0-alpha.1.2)。
- Commit：`720fec862a608ae1e5878d1eecb04fb93192e93c`。
- 提交时间：`2026-10-26 20:54:03 -0700`；提交标题：`Release 0.165.0-alpha.1.2`。
- 克隆方式：深度 1 的浅克隆；按 Tag 检出，处于 detached HEAD。
- 已核对 `origin`、精确 Tag 和 commit；Git 工作区干净，跟踪文件共 **9,507** 个。
- 成功下载使用用户指定的 `http://127.0.0.1:18080` 代理；通过 `git -c` 仅对该命令生效，未修改全局代理配置。

成功执行的克隆命令：

```powershell
git clone --depth 1 --branch rust-v0.165.0-alpha.1.2 https://github.com/openai/codex.git ./backend_official
```

| 必要源码目录 | 文件数 | `Cargo.toml` |
| --- | ---: | --- |
| `backend_official/codex-rs/app-server/` | 371 | 已确认 |
| `backend_official/codex-rs/app-server-protocol/` | 1,146 | 已确认 |
| `backend_official/codex-rs/core/` | 1,041 | 已确认 |

完整官方仓库已保留，未安装 Rust 依赖或运行构建。

## 后端协议导出

已将 `artifacts/native/codex-original.exe` 拷贝至 `native/codex-original.exe`。原件与副本的 SHA-256 一致：

```text
5C1B55966BF9F757DCBF00065C9A6CB862EAD55D34B015F1BE1939FF18E43943
```

程序大小：357,330,736 字节。

`app-server --help` 明确支持 `generate-ts` 和 `generate-json-schema`。以下两条导出命令均成功退出（退出码 0），未安装或指定额外格式化工具：

```powershell
.\native\codex-original.exe app-server generate-ts --experimental --out .\protocol_schema\typescript
.\native\codex-original.exe app-server generate-json-schema --experimental --out .\protocol_schema\json-schema
```

`--experimental` 用于同时保留实验性方法和字段。

| 输出目录 | 导出结果 | 文件数 |
| --- | --- | ---: |
| `protocol_schema/typescript/` | TypeScript 协议类型；包含 `serde_json/`、`v2/` | 906 |
| `protocol_schema/json-schema/` | JSON Schema；包含 `v1/`、`v2/` | 460 |

合计 1,366 个协议定义文件，均非空。

### `codex-original.exe app-server --help` 完整输出

执行位置：目标工作区根目录；命令：`.\native\codex-original.exe app-server --help`；退出码：0。

````text
[experimental] Run the app server or related tooling

Usage: codex app-server [OPTIONS] [COMMAND]

Commands:
  daemon                Manage the local app-server daemon
  proxy                 Proxy stdio bytes to the running app-server control socket
  generate-ts           [experimental] Generate TypeScript bindings for the app server protocol
  generate-json-schema  [experimental] Generate JSON Schema for the app server protocol
  help                  Print this message or the help of the given subcommand(s)

Options:
  -c, --config <key=value>
          Override a configuration value that would otherwise be loaded from `~/.codex/config.toml`.
          Use a dotted path (`foo.bar.baz`) to override nested values. The `value` portion is parsed
          as TOML. If it fails to parse as TOML, the raw string is used as a literal.

          Examples: - `-c model="o3"` - `-c 'sandbox_permissions=["disk-full-read-access"]'` - `-c
          shell_environment_policy.inherit=all`

      --startup-sign-out
          Sign out using the managed auth path before loading fresh startup requirements

      --enable <FEATURE>
          Enable a feature (repeatable). Equivalent to `-c features.<name>=true`

      --print-startup-config
          Validate configuration and print requirements as JSON without starting the app server

      --disable <FEATURE>
          Disable a feature (repeatable). Equivalent to `-c features.<name>=false`

      --startup-client-info <STARTUP_CLIENT_INFO>
          ClientInfo JSON used for configuration/auth request identity

      --cloud-skills-snapshot <PATH>
          Load frozen cloud skills from a JSON snapshot instead of a live skill service

      --code-mode-host <URL>
          Connect to a remote code-mode host instead of starting a local host

      --strict-config
          Error out when config.toml contains fields that are not recognized by this version of
          Codex

      --listen <URL>
          Transport endpoint URL. Supported values: `stdio://` (default), `unix://`, `unix://PATH`,
          `ws://IP:PORT`, `off`

          [default: stdio://]

      --stdio
          Use stdio as the transport (equivalent to `--listen stdio://`)

      --analytics-default-enabled
          Controls whether analytics are enabled by default.

          Analytics are disabled by default for app-server. Users have to explicitly opt in via the
          `analytics` section in the config.toml file.

          However, for first-party use cases like the VSCode IDE extension, we default analytics to
          be enabled by default by setting this flag. Users can still opt out by setting this in
          their config.toml:

          ```toml [analytics] enabled = false ```

          See https://developers.openai.com/codex/config-advanced/#metrics for more details.

      --ws-auth <MODE>
          Authentication mode for incoming WebSocket connections

          [possible values: capability-token, signed-bearer-token]

      --ws-token-file <PATH>
          Absolute path to the capability-token file

      --ws-token-sha256 <HEX>
          Hex-encoded SHA-256 digest of the capability token

      --ws-shared-secret-file <PATH>
          Absolute path to the shared secret file for signed JWT bearer tokens

      --ws-issuer <ISSUER>
          Expected issuer for signed JWT bearer tokens

      --ws-audience <AUDIENCE>
          Expected audience for signed JWT bearer tokens

      --ws-max-clock-skew-seconds <SECONDS>
          Maximum clock skew when validating signed JWT bearer tokens

  -h, --help
          Print help (see a summary with '-h')

````

## SourceMap 核对

已检查原始 `app.asar` 的全部 22,333 个文件成员、完整 `unpacked_modules/` 非依赖文件和当前 `raw_frontend/`：

- `.js.map`：0 个。
- `.css.map`：0 个。
- 全部 `.map`：0 个。
- 具体路径：无。
- 部分 JavaScript 含 `sourceMappingURL` 注释，但原 ASAR 未提供对应映射文件。
- 因未发现映射文件，未创建 `raw_frontend/sourcemaps/`。

## 保留的中断克隆目录

本次两次中断的克隆元数据仍保留于 `backend_official.clone-incomplete/` 和 `backend_official.clone-incomplete-http1/`。自动审批审查拒绝了清理操作，返回原因为 `blocked by policy`，未执行删除。正式完整源码位于已核对的 `backend_official/`。

以上目录、版本、归档完整性、协议导出记录及文件数量均在写入本清单前核对；写入后结束操作。
