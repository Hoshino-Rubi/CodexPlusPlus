# Codex++

Codex++ 是 Windows 上的本地 BYOK 桌面工作区。无需登录即可打开主界面；调用模型时，需要在“模型供应商”设置中配置自己的服务凭证和端点。

## 下载

从 [Releases](../../releases) 下载 Windows x64 版。ZIP 解压后运行 `CodexPlusPlus.exe`；便携 EXE 可直接运行，首次启动需要自解压。两个版本均无需安装向导。本地发行包未签名。

## 本地构建

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
