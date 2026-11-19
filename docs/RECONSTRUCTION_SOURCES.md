# 静态测绘与源码覆盖

## 已确认入口

原 Electron：`raw_frontend/.vite/build/early-bootstrap.js` → `bootstrap-6cT5OGXH.js` → `main-CP9z2iYn.js`；原 Preload 为 `.vite/build/preload.js`。原渲染入口为 `raw_frontend/webview/index.html` → `assets/index-8f2d791e1123.js`。这些文件不执行、不改写。

原 stdio 桥位于 `application-network-startup-DMyt3FBI.js`，使用换行 JSON 消息，不是 LSP Content-Length framing。重建桥按此传输边界对接官方协议，并保留服务端反向请求。

原壳要求 Owl 扩展的 Electron API；原 manifest 依赖 `@oai/asb-rpc-client`、`browser-api`、`git-worker` 等内部 workspace/vendor 包。重建桥采用独立实现，不能据此声称已恢复原版浏览器、Git worker、MCP sandbox 或全部 Owl 特性。

## 前端证据索引

| 目标 | 主要原始证据 |
| --- | --- |
| 工作区框架与顶部栏 | `app-primary-8eba40dc50b2.js` 的 `OP/hjt/bjt/Ajt/BPt`；`thread-app-shell-chrome-cad943bedea5.js` |
| 侧栏 | 同包的 `mSr/hSr/gSr/cSr/LAt/BAt` 与 `.sidebar-*` 样式 |
| Composer | `app-initial-b0cd131b9dba.js` 的 `Jj` / `_ComposerLayout*_1q7o3_2`；`composer-content-a151cc8dbbb3.js` 的 `FK`；`codex-composer-adapter-6b724302bfa6.js` |
| 模型选择器 | `app-primary-8eba40dc50b2.js` 的 ModelPickerTrigger/CSS module 映射；不能把 `model-*.js` 数学可视化误认成模型选择器 |
| 设置 | `settings-page-frame`、`settings-content-layout`、`settings-shared` 及设置表单 chunks；Provider 表单为本项目扩展 |
| 会话内容 | local thread / user-message / reasoning / tool activity chunks 与原始文本样式 |

全部静态 CSS/图像/字体等文件逐项列于 `.orchestration/assets-manifest.json`，目标为 `frontend/public/original`。复制 5,466 项后已核对存在性与字节大小，未生成替代 CSS 或图标库。不能把静态资产验收计为全部 UI 组件完成。

## 后端证据索引

Provider 定义实际位于 `codex-rs/model-provider-info/src/lib.rs`，并非旧版 `core/src/model_provider_info.rs`。传输边界为 `codex-api::ResponseEvent`，沿 `core/src/client.rs` 与 `core/src/session/turn.rs` 下发 app-server 事件。新 Chat 适配器复用这个边界。

账户 Handler 实际位于 `app-server/src/request_processors/account_processor.rs` 与其子模块；账户协议位于 `app-server-protocol/src/protocol/v2/account.rs`。保留原协议类型，不手改 `protocol_schema/typescript` 生成物。

## 覆盖边界

完整模块测绘已覆盖 16,006 个 JS/MJS/MTS 文件，静态解析无语法错误。`renderer-catalog.json` 保留逐文件导出、相对导入、动态导入及资源引用；六路 DeepSeek 补充了 layout/messages/composer/settings/panels/exclusions 的精确符号证据。20 路隔离 DeepSeek 先原样迁移 15,915 个非疑似页面 JS，再根据真实依赖补回共享工具/图标，剔除根登录与引导页面，最终以 `renderer-recovery.json` 为准。

默认入口现改为真实 `app-main` → `initializeApp/app-runtime` → 原 Provider 树 → 原 memory Router → `AuthedRoute/AppLayoutRoute/HomeComposerRoute`。本地会话消息、persisted atoms 与 typed app-host 服务接入新桥，原壳、resizable panels/tabs、富文本、Markdown/代码/工具渲染及设置页面沿用原 ESM 实现，七个早期 TSX 替代组件已退出默认入口。`app-primary` 内的原函数及原样 CSS/SVG 保留，没有重新近似绘制。

静态路由转换与 Provider UI 转换清单分别保存在 `route-transforms.mjs`、`providerUiTransforms.ts`；变换先核对唯一锚点和输入语法，再写派生目录，不执行原程序。缺 SourceMap 不构成放弃组件恢复的理由，但无法凭空还原原始 TSX 文件名和类型声明。

原主进程私有服务中未在 DesktopBridge 暴露的能力依然有限，包括远程传输、部分原生窗口/文件元数据、浏览器与 Git worker 等。保留页面代码并不代表这些原生功能已可运行；已明确 unavailable/TODO 的项见 BLOCKED.md。按用户限制，没有运行或视觉验收，不能报告经像素验证的全量 1:1。

原始 Login/Auth/Onboarding 页面不纳入重建，不创建目标页面文件；默认入口直接挂载主工作区。按照用户规范不启动任何应用或视觉检查。

最终实际保留 15,968 个 JS（15,954 个逐字节不变、14 个定点变换），省略 22 个完整页面；5,466 静态资产逐字节核对一致。B09 新授权轮次发布 v3，清理 Njr/qd、五处引导导入与两个混合模块的整屏 UI，真实 helper 与共享嵌入式步骤保留。全图 AST 错误、未解决相对导入及指向变换模块的无效具名导入均为 0；证据见 b09-verification.json。此为静态结论，未启动应用。

六路只读 DeepSeek 对额外 48 个疑似模块的语义分类保存为 `.orchestration/policy-review.json`，不以名称或依赖闭包判定页面。原始 ESM 的恢复不等于从 SourceMap 还原原始 TSX 类型。

五路只读 DeepSeek 原始报告保留在 `.orchestration/reports`；REA 对整个大型目录的辅助分析在 300 秒时工具超时，未返回可引用 Evidence，后续结论全部以本地静态文件为依据。
