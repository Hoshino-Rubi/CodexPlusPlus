# Codex++ 本地协议与配置契约

## 传输

本地权限统一通过 `window.codex`（`shared/bridge.ts`）访问主进程。原版渲染器的 view 消息由 `viewTransport.ts` 适配，typed app-host MessagePort 由 `hostServices.ts` 复用原 capnweb 运行时。Preload 开启 context isolation，主进程使用换行分隔 JSON-RPC 连接独立 `app-server` 子进程。先发送 `initialize`，收到应答后发送 `initialized`；请求用唯一 ID 配对，通知直接转发，服务端反向请求由前端审批后经 `respond` 应答。事件保持官方 `ServerNotification` / `ServerRequest` 类型。

主进程使用隔离的应用数据目录下 `backend-home`，不复用用户现有 `.codex`。后端路径由 `CODEX_APP_SERVER_PATH` 或本项目编译输出选择，不回退执行 `native/codex-original.exe`。

开发态隔离目录由 Electron `app.getPath('userData')` 决定，当前 package name 为 `codex-plus-plus`；Windows 通常为 `%APPDATA%/codex-plus-plus/backend-home`，实际以 Electron 返回路径为准。应用启动时才创建配置，本次没有启动应用或创建真实密钥文件。

## 本地会话

前端 `LocalSession` 保留 `account: { type: 'apiKey' }`、`requiresOpenaiAuth: false` 与 Provider ID。这里的 ready 表示本地配置可用于发起请求，不代表远端验证密钥成功。Rust 中保留现有 `Account::ApiKey` / `AuthMode::ApiKey`，所有本地 Provider 显式配置 `requires_openai_auth = false`。本地模式不刷新 OAuth、不发现云工作区、不消费云 credits，不返回密钥或伪造云套餐。

## Provider 持久化

`providers.json` 使用以下结构：`version: 1`、`activeProviderId`、`providers` 数组。每项包含 `id`、`name`、`kind`、`baseUrl`、`wireApi`、`models: [{ id, label? }]`、`defaultModel`、可选 `envKey`。读取 IPC 只返回 `hasApiKey`；写入可带瞬时 `apiKey`，空输入保留原密钥，`clearApiKey: true` 才显式删除。不得把密钥写入日志、报告或版本控制。

同一配置事务生成后端 `config.toml` 的 `model_provider`、`model` 与 `[model_providers.<id>]`，使用已有 `base_url`、`wire_api`、`env_key` / `experimental_bearer_token`、`requires_openai_auth` 字段。活动会话运行中禁止无提示切换后端配置。

默认 OpenAI Provider 使用非保留 ID `openai-custom`、名称 `OpenAI` 与原 API URL。新配置禁止 ID `openai`；初始化迁移旧 registry/TOML 表及引用，真正 ID 冲突时保留旧项为 `openai-legacy[-N]`。合并保留其他 TOML 字段；仅旧 TOML 且没有活动项的推导边界见 BLOCKED.md B10。设置保存或选择模型会重启本地后端；活跃回合和在途 RPC 会明确拒绝该操作。历史线程恢复先应用当前选择，并核对后端返回的实际 Provider/模型；空闲错配最多取消当前连接订阅后重试一次，仍错配则拒绝发送。

| Provider | base_url | wire_api |
| --- | --- | --- |
| OpenAI | `https://api.openai.com/v1` | `responses` 或 `chat` |
| DeepSeek | `https://api.deepseek.com` | `chat` |
| Gemini | `https://generativelanguage.googleapis.com/v1beta/openai` | `chat` |
| 自定义 | 用户指定的完整 API base URL | `responses` 或 `chat` |

模型目录来自用户本地配置，模型 ID 原样传递，不编造支持列表。Gemini 选择其 OpenAI 兼容端点；不声称实现原生 `streamGenerateContent`。

## 流式适配

OpenAI Responses 继续使用官方路径。Chat Completions 请求适配已有模型输入和函数工具，SSE 将文本、工具调用与 reasoning 映射回官方 `ResponseEvent`，后续沿用 app-server JSON-RPC 通知。DeepSeek 的 `reasoning_content`、兼容输出中的 thought 字段不得混入最终正文。Chat 不支持的服务端原生工具能力明确禁用或返回错误。

Gemini 兼容工具调用的 `extra_content.google.thought_signature` 与原始调用 ID、工具名及参数存入 ResponseItem 的可选内部 `provider_metadata`。已有 rollout 序列化会保留它，Chat 续轮原样回传；Responses 请求仅清理发送副本的内部字段，保留落盘历史。依据 Google 官方 [thought signatures 契约](https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/thinking/thought-signatures)。Responses 的加密压缩历史不能转换成 Chat 明文，遇到时明确拒绝。

## 原版渲染器装配

`frontend/src/main.tsx` 调用 `recovered/boot.ts`，先从主进程加载原生 JSON 偏好，安装本地策略、view/host 服务与 Provider UI adapter，再载入原 `app-main` → `app-runtime` → 原 Provider 树和 memory Router。原 React 与组件使用同一运行时，不把原 hooks 混入 npm React 根。原始 ESM 图保持相对导入和 CSS 预加载关系，工作区壳、富文本编辑器、消息/工具/Markdown、审批、设置及菜单沿用原实现；早期七个 TSX 组件已不作为应用默认入口。

根认证/欢迎页面及注册引用通过 `.orchestration/route-transforms.mjs` 做静态裁剪。`providerUiTransforms.ts` 调整原 Model Providers 页 controller、模型数据/保存入口、本地设置可见性、Archived 分组和系统语言回退，保留原布局、字段、Dialog/Portal 焦点域、顶部/底部栏及模型菜单。每项源码锚点必须唯一；原始 `raw_frontend` 不变。

B09 新授权轮次已发布 v3：省略 22 个页面，清理残留导出及五处引导导入，两个混合模块保留原 helper 并移除整屏 UI。15,968 模块 AST 与全部相对导入、指向变换模块的具名导入通过静态核对；具体记录见 BLOCKED.md B09。没有启动或视觉验收。

模型菜单内部使用 `codex-local:<encoded provider>:<encoded model>` 区分同名模型；仅前端状态使用该标识。transport 在进入官方 RPC 前恢复原始模型 ID，核对当前保存态，并对 thread start/resume/fork 与 turn start/steer/settings 做 Provider 一致性保护。模型目录不凭空声明图像、reasoning effort 或服务等级能力。

applicationState、persisted atoms 与原 settings 使用 `userData/app-preferences.json` 的三个独立 scope。使用原 Glt/Wlt descriptor 的 schema、default、hostStorage 路由 General 设置，写盘成功后应答并推送快照；只迁移缺失的旧浏览器值并写单次迁移标记。原 Configuration 的 approval/sandbox RPC 不混入该本地设置注册表。系统语言来自 app.getLocale()，显式 localeOverride 优先。

discoverHost 暴露真实 home/codexHome、Shell、已安装编辑器与 WSL 发行版。Windows 探测有超时并使用 argv；WSL -l -q 支持 UTF-16LE。PowerShell 对应原单一 powershell 枚举并优先 pwsh；WSL 目录项保持 disconnected，不自动创建后端运输。编辑器目标通过受控原生 argv 打开。真实工作根仍来自原生选择窗口，文件读写走已有 `fs/*` RPC；未暴露的原生/远程边缘服务保持 unavailable 或明确 TODO(stub)，详见 BLOCKED.md。

projectlessThreads 在已选择的真实根中分配实际目录，支持可取消的 wait/dispose 操作；未选择根时仅在创建任务调用中请求原生目录选择。repositoryOrigins 通过只读 Git argv 读取真实元数据，缺少的 homeDir 明确返回 null。

## 源码与资产边界

`raw_frontend` 为只读来源，`frontend` 为重建代码。原始脚本模块、导出和依赖见 `.orchestration/renderer-catalog.json`；完整保留/裁剪/变换清单见 `.orchestration/renderer-recovery.json`，静态资产列表位于 `.orchestration/assets-manifest.json`，目标逐文件列在 `PROGRESS.md`。CSS 直接加载原始文件，不生成 Tailwind 替代样式。保留原 ESM 组件实现不等于恢复了未提供的原始 TSX 文件名、类型和 SourceMap；也不把静态资产复制等同于完成像素验收。

此前授权轮次已执行 `cargo build --release -p codex-app-server`，代理仅作用于当时编译命令进程。本轮仅运行用户授权的 `npm run check` 与 `npm run build`，没有修改或编译 Rust。不启动应用、生成的二进制、开发服务器或测试，因此不宣称完成运行或视觉验收。
