# 煤球桌宠开发版

2026-10-26 · 分支 `research/hedgehog-companion`。

## 启动和分享给别人

这是在本机运行的源码版桌宠。复制或克隆仓库后，安装 Node.js 24 或更高版本，在项目目录运行：

```sh
npm ci
npm run pet
```

Windows 可以双击 `desktop/start.cmd`：检查 Node 版本，首次自动安装依赖，再启动煤球。macOS 可以双击 `desktop/start.command`（首次先运行 `npm ci`）。正常聊天和语音不依赖 Python、Whisper 或 FFmpeg；FFmpeg 只供开发者运行合成语音验收脚本。

第一次打开会先显示设置页，分别输入自己的 DeepSeek 和 Fish Audio API Key。两个服务都保存后才能聊天；修改设置时，已保存的 Key 可以留空保留。界面只显示“已在本机保存”，不会回显 Key。保存并不等于服务商已验证 Key，错误 Key、余额不足、断网会在实际使用时明确提示。

程序、窗口、SQLite 聊天记录、记忆和 Key 保存在本机。DeepSeek 聊天、Fish Audio 听写及合成声音需要联网，并使用各自账号额度；不是完全离线模型。Key 不写入聊天、数据库、浏览器存储、Git 或导出；默认数据目录 `local-data/hedgehog-app/` 被 Git 忽略。请分享仓库，不要打包这个目录、`env.local` 或备份给别人。

聊天页：[http://127.0.0.1:4348/pet/chat](http://127.0.0.1:4348/pet/chat)。4347 继续作为动画素材预览。

## 桌宠交互

- **单击煤球**：展开语音小面板，暂不开麦克风。
- **按住“按住说话”**：等待“正在听写”后说话；面板持续显示当前识别文字和音量变化。
- **松开按钮**：结束录音，确认最后几个字后自动发送，随后显示并播放煤球的回复。按住时可以停顿，不会因为静默自动发出半句话。单次最长45秒。
- **取消或按 Escape**：停止这一段语音，不提交未发送的录音。授权期间提前松手，也不会在授权完成后突然开录。连接中断、没有听清、转写降级都不会把临时字幕发送出去。
- **双击煤球**：打开文字聊天，不启动录音。Enter 发送，Shift+Enter 换行；支持草稿恢复、停止回复和断线续看。
- 拖动煤球移动；右键调大小、切换动作、暂停或退出；收起聊天窗后煤球仍留在桌面。

煤球使用 Fish Audio「[砂糖](https://fish.audio/m/a79f5a16b0d44355928252aa6e0e4083/)」音色，`reference_id` 为 `a79f5a16b0d44355928252aa6e0e4083`。

语音功能和自动语音回复默认开启，可在“陪伴设置”关闭。“默认开启”指功能可用，仍然要按住按钮才使用麦克风。第一次需要系统麦克风授权；Windows 需要允许桌面应用访问麦克风。锁屏、休眠、页面隐藏或取消时释放输入与播放资源。

界面已重做为紧凑聊天窗、独立首次设置页和煤球上方的语音面板。12段96帧动画可用；吃大果子、冒桃心、举牌“飞飞爱你”、背蛋糕可在聊天底栏或右键菜单触发。支持64/96/128/192尺寸和透明像素命中测试。

## 实时语音的实现

麦克风通过 Chromium `getUserMedia` 与 AudioWorklet 输出单声道 PCM16，每100ms发送一批。本地服务中继到 Fish Audio `transcribe-stream-1` 实时 WebSocket，开启 drafts 并使用 manual turn。录音期间每次 draft 替换当前字幕；松手发送 `audio_done`，只使用 committed 最终文本。音频不落盘，不进入聊天记忆。

浏览器先通过 Cookie + CSRF 申请30秒、单次使用的本地连接票据。Fish Key 只由服务端加入上游请求头。连接限制、音频大小与时间上限、隐私 epoch 变化和断线清理均在服务端检查。失败不降级成“假实时字幕”，也不会自动重发聊天。

回复只朗读已发布、且所属 run 成功完成的文字。MP3 支持边接收边播放；不支持该方式时使用完整音频播放。录音、生成和播放都属于当前语音轮次，开始新轮或取消时清理旧资源。依据：[Fish 实时语音协议](https://docs.fish.audio/api-reference/endpoint/websocket/asr-realtime)、[Electron 麦克风授权](https://www.electronjs.org/docs/latest/api/system-preferences#systempreferencesaskformediaaccessmediatype-macos)。实时模型仍为服务商 Preview 服务。

## Codex 编程陪伴

```sh
npm run pet:hooks
```

然后在 Codex 的 `/hooks` 审核并信任本项目观察器，在项目里发起新回合，再从煤球聊天窗“连接设置”选择会话。这是 [Codex 官方 hooks 信任要求](https://learn.chatgpt.com/docs/hooks#review-and-trust-hooks)。桌宠不代替用户审批，也不自行批准、拒绝或继续编程任务。

观察桥只接收思考、修改文件、等待确认、回合结束和中断等白名单状态，不读取会话文件，不转发 prompt、源码、命令和工具输出。Stop 只表示回合结束，不表示测试通过。没有事件或状态陈旧时如实显示，不能把受控联调算作用户当前聊天已经连接。

Windows 使用官方支持的 `commandWindows`，通过编码的 PowerShell 命令处理空格和中文路径；POSIX 使用独立的引号规则。目录边界兼容两种路径分隔符；POSIX 文件权限检查不会误用于 Windows。安装器保留其他 hooks，重复安装不叠加；`npm run pet:hooks:remove` 只移除煤球观察器。桥离线时输出空 JSON，HTTP 等待上限250ms，外层 hook 超时3秒。[配置依据](https://learn.chatgpt.com/docs/hooks#config-shape)

## 进程和数据

复用 BotManager / Harness / CM3 记忆与发布检查，煤球角色 id 为 `meiqiu`，与原小野身份、聊天和记忆隔离。煤球服务使用4348，Codex桥使用4349；Cookie 与原 Web 不同，避免同一 localhost 不同端口覆盖会话。

SQLite 服务运行在外部 Node 进程，Electron 负责窗口与有限 IPC，避免原生模块 ABI 冲突。退出通过进程消息优雅关闭自己启动的服务，超时才强制结束；复用的既有服务不被关闭。窗口启用 sandbox / context isolation，关闭 Node integration、任意导航和弹窗；系统麦克风权限限定在可见的煤球语音窗口。

Windows 入口和兼容改动已实现，增加 `.github/workflows/hedgehog-desktop.yml` 的 Windows/macOS 自动验收。**本次实际运行环境为 macOS，未运行 Windows 真机或远程 CI，不声称 Windows 已完美验收。** 当前仍为源码版，没有独立签名安装包、开机自启或直接发起 Codex 任务的 app-server 入口。

## 验证证据

最终结果和平台范围见 [hedgehog-verification.json](hedgehog-verification.json)。

- `npm run verify`：类型检查、全量单元测试与构建。
- `npm run test:pet:desktop`：真实 Electron 窗口与 getUserMedia / AudioWorklet，使用 Chromium 合成麦克风、本地 ASR 协议夹具和有效 MP3；检查首次设置、单击只展开、按住实时字幕、松开发送、播放事件、取消不发送、授权拒绝、授权期间松手、断线、双击文字、动画、Codex hook 进程和收起窗口。
- `npm run smoke:pet:voice`：合成中文语音通过真实 Fish 实时 ASR，在松手前观察 draft；最终文字经过真实 DeepSeek 对话，再通过真实 Fish 合成 MP3。仅使用临时数据库与合成测试文本，清理后不保留用户会话。
- `npm run smoke:pet:live`：独立合成文本的真实 DeepSeek 回归。

合成音频测试不能替代实际麦克风在不同设备、噪声环境和 Windows 权限状态下的体验验收。多显示器拖动、macOS Spaces、一小时功耗和签名安装包仍待后续验证。

工程上继续 Adapt Kimi 固定参考 `MoonshotAI/kimi-code@9e1248416faa22d9f0b777b91ad092bbf1e19182` 的会话资源随生命周期释放不变量，不引入第二套代理循环或额外工具执行权。
