# 插件宿主修复与实机验收

本轮使用工作区构建的 Electron、指定的现成 `backend_official/codex-rs/target/release/codex-app-server.exe` 和真实本机依赖执行。未修改或重新编译官方后端，未读取用户 `.codex` 配置目录。

## 验收结果与证据范围

| 项目 | 实际验证 | 结果 |
| --- | --- | --- |
| 静态检查 | `npm run check`，`tsc --noEmit` | 退出码 0 |
| 生产构建 | `npm run build`，Vite 生产构建 | 退出码 0 |
| A 消息复制 | 真实模型生成回复后，CDP 鼠标移动、按下、松开复制按钮；原生剪贴板读回与完整回复逐字比较 | 一致，39 字符；无焦点错误；原剪贴板已恢复 |
| B 加号菜单 | 8 个核心及原已安装 Remotion 的图片加载、可见性 | 全部有效 |
| B 提及菜单 | 8 个核心、Remotion；安装期间额外检查 Superpowers | 全部有效；卸载后 Superpowers 消失 |
| C 浏览器 | 原 `browser-client.mjs` → 原 `browser-service.mjs` → 本地命名管道 → Electron CDP；本地 HTTP 页面导航、标题、DOM、输入、按钮点击及截图 | 输出文本一致；最终截图 13457 字节 |
| C 电脑 | 原技能 API `@oai/sky` → 本地 Windows 宿主；仅选择本工作区 Codex++ 窗口，查询窗口、UIAutomation 文本、真实截图 | 窗口匹配；UIAutomation 成功；最终截图 146295 字节 |
| C PDF | reportlab 创建含指定验收文字的一页 PDF；pypdf 读回；Poppler 渲染并检查 | 文字一致，1 页 |
| C Documents | python-docx 创建 DOCX，重新打开检查；运行原 `render_docx.py`，通过 LibreOffice、Poppler 渲染并检查页面 | 文档有效，文字一致 |
| C Spreadsheets | 原运行时 `@oai/artifact-tool` 创建 XLSX；SUM 公式计算；保存后用独立原运行时 Node 导入及 Python 读取；渲染检查 | 保存后合计为 5，结构有效 |
| C Presentations | 原运行时 `@oai/artifact-tool` 创建可编辑 PPTX；原工具渲染；python-pptx 重新打开检查文字和页数 | 1 页，文字一致 |
| C Template Creator | 真正运行原 `create-template-skill.mjs`，使用已渲染 DOCX 和预览图 | 生成 SKILL.md、agents、assets、artifact-template.json；验收后回收 |
| C Visualize | 真正运行原 `scripts/render.py`；原浏览器宿主打开导出的 iframe 页面；实际点击按钮 | 状态由 0 变 1，交互成功 |
| D 完整市场 | 实际页面统计 74 个唯一插件卡片，逐项检查原始图标；读取全部详情 | 8 核心 + 66 市场；74 详情成功、593 个技能、无图标缺失 |
| D 安装闭环 | 实际点击 Superpowers 详情和安装按钮，检查「個人」、提及菜单、SKILL 读取、原生后端技能列表 | 14 个真实技能热加载 |
| D 卸载闭环 | 实际点击「更多操作 → 解除安裝」；检查原生技能、提及菜单及缓存/安装目录 | 技能归零，菜单移除，目录清除 |

C 项文件与宿主任务通过运行中的 Electron 公共 IPC、app-server 的真实 MCP 调用执行。它们证明实际脚本、依赖、文件产出及宿主链路可用；没有将模型是否选择正确工具等同于程序执行成功，也没有声称逐个第三方业务接口均已认证或实测。

构建仍会打印原始 CSS 公共资源在运行时解析的警告，构建成功；实机页面使用这些资源正常显示。

## 主要实现

- `electron/main.js`、`electron/preload.js`、`shared/bridge.ts`、恢复界面的 HostRoot 和 `frontend/src/main.tsx` 接通原生剪贴板。复制主路径与文本 Clipboard API 兜底均进入同一 IPC。
- 插件图标兼容原 composer/logo 规范和 icon/iconUrl/lightIcon/darkIcon；相互回退。HTML 与响应 CSP 同步允许本地、data、blob、HTTPS 图片。原包缺少图标的五个插件从发行者站点获取原始图标字节并缓存来源，未绘制替代品牌图案。
- `electron/browser-host.js` 管理实际 BrowserWindow、调试器、会话隔离、网络策略与原生管道；保留原客户端/服务实现。补全 iframe/worker 目标信息及 CDP 事件，修复跨进程 iframe 点击。
- `electron/node-repl.mjs` 与 `electron/repl-kernel.mjs` 提供持久 JavaScript MCP 会话、超时、复位、原服务 RPC、图片输出与运行时依赖路径。宿主连接密钥仅存于进程环境，不写入 TOML 或报告。
- `electron/computer-host.js`、`electron/windows-host.ps1`、本地 `@oai/sky` 包实现窗口查询、UIAutomation、截图和 Windows 输入桥。PowerShell 固定使用 7；UIAutomation 使用与 PowerShell 匹配的程序集。
- PluginCatalog 安装真实 manifest、脚本、资源、MCP/apps/hooks 声明，使用暂存目录后原子安装；卸载实际清目录和配置，并通知原生后端重载技能及 MCP。Git 源支持 Windows 长路径、稀疏检出和持久源缓存。旧官方市场路径及已有 app ID 能映射到已分发的真实包。
- 零技能连接器只增加本地连接说明技能，不编造服务能力。`LOCAL_SETUP.md`、`.env.example` 只说明真实依赖和环境变量名；外部认证通过原生 MCP OAuth 保留。

## 八个核心包与依赖

完整原始目录在 `electron/resources/plugins/<market>/plugins/<name>`，部署到隔离的 `backend-home/plugins/cache/<market>/<name>/<version>`。

| 市场 | 包名 | 技能/入口 | 实际运行依赖 |
| --- | --- | --- | --- |
| openai-bundled | browser | skills/control-in-app-browser；scripts/browser-client.mjs、browser-service.mjs | Node、Electron CDP、本地命名管道 |
| openai-bundled | computer-use | skills/computer-use；docs/api.md | 本地 @oai/sky、PowerShell 7、UIAutomation、Windows SendInput、Electron desktopCapturer |
| openai-bundled | visualize | skills/visualize/scripts/render.py | Python 标准库、浏览器 |
| openai-primary-runtime | documents | skills/documents/render_docx.py | python-docx、lxml、Pillow、LibreOffice、Poppler、pdf2image |
| openai-primary-runtime | pdf | skills/pdf | reportlab、pypdf、pdfplumber、Poppler |
| openai-primary-runtime | spreadsheets | skills/spreadsheets；另含 excel-live-control | @oai/artifact-tool；读取校验用 openpyxl |
| openai-primary-runtime | presentations | skills/presentations/container_tools | @oai/artifact-tool；读取校验用 python-pptx |
| openai-primary-runtime | template-creator | skills/template-creator/scripts/create-template-skill.mjs | 当前 Node，node:zlib crc32 |

优先使用依赖加载器发现的 `.cache/codex-runtimes/codex-primary-runtime/dependencies`：Node 24.22.1、Python 3.12.14、artifact-tool 2.8.158、Poppler。LibreOffice 已存在。系统 Python 缺失的用户授权依赖也已补齐，但核心验收采用发现的完整原运行时。

## Browser 与 Node 宿主协议

客户端入口为 `nodeRepl.rpc('browser', {method, params})`，method 为 `setup`、`execute`、`executeWithRecovery`；setup 返回原 apiManifest 等能力信息。电脑入口为 `nodeRepl.rpc('computer', {method, params})`，method 对应 sky API。

原服务通过 `nodeRepl.nativePipe.createConnection(path)` 使用 socket 的 on/write/end。报文为 4 字节小端长度加 UTF-8 JSON-RPC 2.0。`getInfo` 握手 metadata.codexSessionId 必须匹配 session_id。请求元信息来自 `nodeRepl.requestMeta['x-codex-turn-metadata']`，必须包含字符串 session_id、turn_id，可有 thread_id、thread_source。

主要环境变量：BROWSER_USE_AVAILABLE_BACKENDS=iab、BROWSER_USE_BACKEND_PATHS、CODEX_LOCAL_HOST_URL、CODEX_LOCAL_HOST_TOKEN、CODEX_HOME、PYTHON、PYTHONUTF8、PYTHONPATH、RUNTIME_NODE、RUNTIME_BIN_DIR、CODEX_PRIMARY_RUNTIME_NODE_MODULES、CODEX_LIBREOFFICE_PATH。连接地址和密钥由每次 Electron 启动生成。

原 native RPC 签名清单如下；meta 为 session_id、turn_id、session_context、可选 browser_surface：

```text
ping() -> pong
getInfo(meta)
getTabs(meta)
getCommittedTabUrl({tabId, ...meta})
createTab({preferredWindowId?, ...meta})
attach({tabId, networkPolicy, ...meta})
detach({tabId, ...meta})
attachTarget({tabId, targetId, ...meta})
detachTarget({tabId, targetId, ...meta})
executeCdp({target:{tabId, sessionId?, targetId?}, method, commandParams,
            timeoutMs?, preserveDebuggerOnTimeout?, ...meta})
executeCdpWithCachedExpression({...executeCdp, expressionCacheKey})
attachBrowserUseNetworkPolicy({tabId, policy, ...meta})
detachBrowserUseNetworkPolicy({tabId, ...meta})
getUserTabs(meta)
getTabContext({tabId, ...meta})
getUserHistory({queries?, limit?, from?, to?, ...meta})
executeTabRead({...input, ...meta})
claimUserTab({tabId, ...meta})
markTab({tabId, status:'handoff'|'deliverable', ...meta})
nameSession({name, ...meta})
followSessionTab({tabId, reason:'activity'|'handoff', ...meta})
executeUnhandledCommand({type, ...payload, ...meta})
moveMouse({...input, ...meta})
allowDownload({...input, ...meta})
setBlobDownloadOrigin({tabId, origin, url?, ...meta})
browserAuthNewTargetProtection({...input, ...meta})
turnEnded(meta)
```

实现了本轮导航、DOM、输入、截图所需的真实路径，以及 tab/target 管理和网络策略。未实现的历史、特殊下载等高级原生方法明确报不支持，不能将此清单误认为全部高级功能验收通过。live artifact_session 不由本地宿主提供；文件导入使用独立原运行时 Node 脚本，已实际验证。

## 市场协议与完整目录

`plugin/read` 使用 pluginName，选择 marketplacePath 或 remoteMarketplaceName；详情保留真实 skills、MCP server 名称、apps、hooks 及说明。`plugin/install` 安装真实 `.codex-plugin/plugin.json` 和资源并启用配置；`plugin/uninstall` 移除缓存目录与配置。原始 MCP 声明及认证要求保留，不创建虚假的 API Key 或认证结果。

openai-api-curated 共 51 项，9 类：

| 类别 | 全部插件 |
| --- | --- |
| Communication | slack |
| Creativity | remotion, hyperframes, figma, canva, product-design, higgsfield, chatcut |
| Data & Analytics | mixpanel-headless, posthog |
| Developer Tools | game-studio, superpowers, circleci, sentry, build-ios-apps, build-macos-apps, build-web-apps, build-web-data-visualization, test-android-apps, expo, coderabbit, plugin-eval, temporal, twilio-developer-kit, openai-developers, nvidia, magicpath, openai-ads-conversions, datadog, vercel, cloudflare, supabase, crowdstrike-falcon-foundry, crowdstrike-falcon-fusion, qodo, github, aws-core |
| Education & Research | life-science-research, zotero, ngs-analysis, consensus |
| Finance | stripe |
| Productivity | linear, notion, atlassian-rovo, dropbox, granola, monday-com, clickup |
| Scientific Research | boltz-api-cli |
| Security | codex-security |

完整原市场额外包含 15 项：google-calendar, gmail, teams, sharepoint, outlook-email, outlook-calendar, google-drive, zoom, airtable, shopify, data-analytics, creative-production, public-equity-investing, adobe, lovable。原 full 清单 65 项，API 独有 aws-core，因此并集为 66 项。四个 Git 源均已实际获取并读取详情：Falcon Foundry 14 技能、Falcon Fusion 7、Qodo 5、AWS Core 27。

## 实际限制

本次逐项运行了八个核心插件的指定本地任务，并完成一个市场插件真实 UI 安装/卸载闭环；没有逐一调用 66 个市场插件的第三方业务。外部 MCP、托管 Apps、API Key/OAuth、Xcode/macOS 等平台条件仍由各原插件声明决定。安装成功不代表这些外部服务已认证或业务可用。

原界面的 Box、Salesforce 云推荐不在这次分发的 66 个市场包内，读取其云目录仍需要 ChatGPT 认证；没有为它们伪造本地详情。电脑 list_apps 当前列出运行中的可定位窗口，不包含完整安装应用目录；特殊无障碍操作与浏览器高级下载/历史未逐项验收。

## 清理

测试回复对话已通过真实 archive/delete RPC 删除，测试草稿清空。验收文档、图片、HTML、模板及临时重复下载移入回收站，可恢复；正式运行依赖、原插件包、四个稳定 Git 源和原先安装的 Remotion 保留。最后关闭本工作区 Electron 及其后端/MCP 进程，临时 CDP 验收脚本回收。进程清理只针对本工作区，不关闭承载本次会话的其他 Codex 应用。

## 内置浏览器高级能力与中断收尾（2026-11-17）

接续任务 `01a1e6b6-2ff1-7fd1-a872-51c6165caadd`。本节补充上述高级功能的验收范围；既有通过项仅沿用中断任务记录，未重复执行。Blob 首次复测失败记录保留；后续修复后的真实 `<a download>` 单项复测已通过，详见末节。

| 项目 | 验收证据 | 结果 |
| --- | --- | --- |
| 静态检查与生产构建 | 本次执行 `npm run check && npm run build`；保留既有 CSS 运行时解析警告 | 退出码 0 |
| 普通文件下载 | 中断任务已实际点击下载链接，捕获下载通知，核对 72 字节文件及内容；SHA-256 为 `83852a8eb2385431ac7773c0d1d074cd0e6d6010bda30b2c1af70e09a6f70bd9` | 上轮通过，本次未重测 |
| Blob 下载 | 首次按钮用例失败；后续修复后，指定现有 release app-server 重启 Electron，仅点击一次真实 `<a download="blob-test.txt" href="blob:...">`，同时核对原客户端下载通知、宿主等待和落盘内容 | 最新单项复测通过：64 字节逐字节一致，两个等待接口返回同一路径 |
| 历史前进／后退与刷新 | 中断任务已验证 A → B → A → B 的 URL、标题与页面状态 | 上轮通过，本次未重测 |
| 多标签页接管 | 中断任务已验证 `target="_blank"`、`window.open()` 转为受管标签页，以及切换、读取、关闭 | 上轮通过，本次未重测 |
| 弹窗防阻塞 | 中断任务已验证 confirm 接受／拒绝、alert、beforeunload；Electron prompt 使用预设应答桥，不等同于原生 prompt | 上轮记录沿用，本次未重测 |
| PDF 导出 | 中断任务已使用 `webContents.printToPDF` 导出，独立解析确认为 2 页且包含正确页面标题 | 上轮通过，本次未重测 |
| 文件上传与键盘 | 中断任务已验证真实文件输入绑定、Ctrl+A 选择，并检查悬停和滚动 | 上轮通过，本次未重测 |

本次 Blob 复测时间为 `2026-11-17T03:25:58Z` 至 `03:26:13Z`。`.orchestration/runtime-debug.log` 记录了 `setBlobDownloadOrigin`（origin 为本地验收页面 origin，url 为 null）及点击对应的鼠标事件，但该窗口没有 `BROWSER_DOWNLOAD` 捕获记录；原客户端下载等待以 `Timed out after 15000ms waiting for download.` 结束。遵守仅复测一次的范围限制，未继续重试、修改实现或重跑既有通过项。

### 本次清理与改动边界

- 新建临时线程 `01a1e789-51c5-7180-b2ce-52dc098ca70e` 已通过真实 `thread/archive`、`thread/delete` RPC 清除；活动与归档列表均未发现本工作区其余验收线程。
- `.orchestration/browser-acceptance-20261117.mjs`、3 个普通下载 TXT 和 3 个导出 PDF 已移入 Windows 回收站，可恢复；未生成 Blob 文件。验收脚本及上述产物剩余数量为 0。
- 已关闭本工作区旧、新 Electron、指定 app-server、相关子进程及临时 HTTP 验收服务；工作区范围内 `electron.exe`、`codex-app-server.exe`、`codex-code-mode-host.exe` 残留数量为 0。承载当前任务的其他 Codex 进程未关闭。
- 本次未修改后端源码或二进制、`frontend/src/original/providerUiTransforms.ts`、`PROGRESS.md`、`BLOCKED.md`、`SUMMARY.md`，也未追加实现代码；构建产物已刷新，诊断日志保留。

## Blob 下载专项修复与复测通过（2026-11-17）

本次实现仅修改 `electron/browser-host.js`，未触碰 `backend_official/`、`frontend/` 或三个根目录状态文件。未重跑其他浏览器验收项。

- 下载捕获入口第一条可执行语句同步调用 `item.setSavePath`，先使用已存在的专用下载目录抑制原生 Save As，再在同一同步事件栈内选择并设置最终保存路径；两次调用之间无 `await`。紧接第一次路径设置同步绑定 `done`，缓存可能提前到达的终态，再检查 `item.getState() === 'completed'`；完成处理具有幂等保护。
- 受管 `webContents` 发起的 Blob 下载直接纳入追踪，不再以可选的 `blobOrigin` 元数据为必要条件；保留受管标签页归属检查、源页面网络策略和现有文件防覆盖行为。下载记录增加 `sourceUrl`，保存配置与等待查询兼容 Blob URL 及源页面来源匹配。
- `node --check electron/browser-host.js` 退出码为 0。设置指定 `CODEX_APP_SERVER_PATH` 后启动 `npx electron . --remote-debugging-port=9222`，使用临时本地 HTTP 页面中已生成的真实 `<a download="blob-test.txt" href="blob:...">`，只点击一次。
- 原 `tab.playwright.waitForEvent('download')` / `download.path()` 与宿主 `waitForDownload` 均成功；后者按源页面 URL 查询，二者返回相同的 `.orchestration/blob-test.txt`。实际记录 `state=completed`、`receivedBytes=64`、`totalBytes=64`，开始于 `2026-11-17T03:55:41.661Z`，完成于 `03:55:41.778Z`。
- 文件经应用运行时逐字节比较，并由独立 PowerShell 文件哈希复核；SHA-256 为 `9b7e3ad6808b9408b722df97998fb322a376c5d05a0e8a213eb6b6e972199fca`。内容为两行 UTF-8 文本 `Codex++ Blob download 2026-11-17`、`真实 Blob 下载内容一致`，每行以 LF 结束。

临时线程 `01a1e7a4-7beb-71d2-a705-2a83eb4123df` 已通过真实 archive/delete RPC 删除；临时验收脚本与 Blob 文件均已移入 Windows 回收站，可恢复。临时 HTTP 服务及本工作区 Electron、app-server 和相关子进程已关闭，工作区范围内指定三类残留进程为 0；其他 Codex 应用未关闭。诊断日志保留。本节通过结论限定于上述真实 Blob 链接下载，不将单次结果扩展为所有下载触发方式均已复测。
