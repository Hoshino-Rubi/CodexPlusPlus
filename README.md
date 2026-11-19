# Codex++

[简体中文](#简体中文)

Codex++ is a local Windows desktop workspace that lets you bring your own API key (BYOK). You can open the workspace without signing in. To use a model, configure your provider credentials and endpoint in the Model Providers settings.

## Download

Download the Windows x64 release from [Releases](../../releases). For the ZIP, extract it and run `CodexPlusPlus.exe`. You can run the single-file portable EXE directly; it unpacks itself on first launch. Neither version requires an installer. Both release files are unsigned.

## Build locally

This repository tracks the core source code and plugin marketplace manifests. It does not include extracted upstream assets, generated protocol files, the backend binary, or the plugin bundles. A source checkout alone cannot reproduce the release. To build, you need Windows x64, Node.js x64, PowerShell 7, and the following local inputs that match this release:

| Path (relative to the repository root) | Required contents |
| --- | --- |
| `backend_official/codex-rs/target/release/codex-app-server.exe` | A prebuilt Windows x64 app server. This release uses `0.165.0-alpha.1.2`. |
| `backend_official/codex-rs/models-manager/` | `models.json` and `prompt.md` from the same version |
| `protocol_schema/typescript/` | TypeScript protocol declarations matching the backend, including `ClientRequest.ts` and `v2/` |
| `frontend/public/original/` | Original renderer assets matching the frontend integration |
| `electron/resources/plugins/{openai-bundled,openai-primary-runtime,openai-curated}/plugins/` | Plugin bundles matching the marketplace manifests in each corresponding `.agents/` directory |

```powershell
npm ci
npm run check
npm run build
npm run dist:win
```

Packages are written to `release/`. `dist:win` reuses the prebuilt backend without recompiling Rust. Do not commit model credentials, `backend-home/`, or local build outputs. Some document plugin features require additional Python or Office dependencies.

## 简体中文

Codex++ 是 Windows 上的本地 BYOK 桌面工作区。无需登录即可打开主界面；调用模型时，需要在“模型供应商”设置中配置自己的服务凭证和端点。

### 下载

从 [Releases](../../releases) 下载 Windows x64 版。ZIP 解压后运行 `CodexPlusPlus.exe`；便携 EXE 可直接运行，首次启动需要自解压。两个版本均无需安装向导。本地发行包未签名。

### 本地构建

本仓库只跟踪核心源码和市场清单，不包含从上游提取的资源、协议生成物、后端二进制或插件实体。仅克隆源码不能直接复现发行版。构建前需要 Windows x64、Node.js x64、PowerShell 7，以及与本版匹配的以下本地输入：

| 路径（相对仓库根目录） | 所需内容 |
| --- | --- |
| `backend_official/codex-rs/target/release/codex-app-server.exe` | 已构建的 Windows x64 app-server，本版使用 `0.165.0-alpha.1.2` |
| `backend_official/codex-rs/models-manager/` | 同版本的 `models.json` 和 `prompt.md` |
| `protocol_schema/typescript/` | 与后端匹配的 TypeScript 协议声明，包括 `ClientRequest.ts` 和 `v2/` |
| `frontend/public/original/` | 与前端适配层匹配的原始渲染资源 |
| `electron/resources/plugins/{openai-bundled,openai-primary-runtime,openai-curated}/plugins/` | 与各目录下 `.agents/` 市场清单匹配的插件包实体 |

```powershell
npm ci
npm run check
npm run build
npm run dist:win
```

发行文件输出到 `release/`。`dist:win` 复用已有后端，不会重编 Rust。模型凭证、`backend-home/` 和本机构建产物不应提交到 Git。部分文档插件功能需要另行安装对应的 Python 或 Office 依赖。
