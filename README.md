# 私人 AI 陪伴 Harness

煤球桌宠开发版：运行 `npm run pet`，或双击 `desktop/start.command`。[启动、聊天与Codex接入](docs/implementation/hedgehog-desktop-companion.md) · [12段96帧动画素材](assets/hedgehog/v1/README.md) · [前期调研](docs/research/hedgehog-desktop-companion.md)。透明桌面窗口、独立bot聊天与Codex状态桥已实现；Codex hooks首次接入仍需在 `/hooks` 中信任。

已实现可启动的单用户内测工程版：TypeScript strict、Node.js 24+、SQLite、自有有界执行器，AI SDK Core 只负责接入模型。支持 DeepSeek 和 Grok 4.3，默认使用 DeepSeek，附带简单的聊天／Trace 测试 Web。

覆盖 M0–M4 的个人版工程能力和 M5 可自动执行的验证。7 天体验采样、14 天稳定观察、人格和记忆质量人工评估仍待真实使用。

## 启动

在本项目目录运行：

```sh
npm ci
npm run build
npm start
```

打开 [本地测试 Web](http://127.0.0.1:4317)。当前机器已安装依赖并构建，可直接 `npm start`；已有实例时直接打开页面即可。

新版记忆独立试用：[小野·记忆试用](http://127.0.0.1:4321/)，独立数据库，当前试聊已启用 E5，正式配置不变。停止后用 `npm run memory:trial` 再次启动；[试用说明与验证](docs/implementation/memory-trial-bot.md)。正式服务仍使用原配置。

独立试用最新更新：[候选质量、重复写入与确认入口修复](docs/implementation/memory-capture-fix.md) · [手动试聊测试用例](docs/implementation/memory-trial-test-cases.md)。

最新修复：[明确保存时不再重复询问、发布前回复检查及浏览器验收](docs/implementation/memory-explicit-save-fix.md)。独立试聊 bot 已更新，保留原有聊天与记忆；正式库未迁移，向量关闭。

2026-10-25：[读取不可用、空结果和部分召回不再推成“库中没有记录”](docs/implementation/memory-read-scope-fix.md)。独立试聊实例已更新，正式库不动，向量继续关闭。

隔离副本对照：[全量、关键词、E5 混合的 90 次回答与 9 次浏览器实测](docs/implementation/memory-strategy-comparison.md)，[实验页](http://127.0.0.1:4324/)。正式配置及原有聊天未改，现场超时和回答错误完整保留。

最新试聊：[E5、偏好约束和评审边界修复](docs/implementation/memory-hybrid-trial-release.md)，仅更新 4321 独立实例。

首次使用先确认远程模型外发范围。点击「启用浏览器通知」授权，并保持标签常驻；离线期间的关心留在站内，回来不会补弹旧通知。

- [启动、使用、备份和排障手册](docs/implementation/runbook.md)
- [工程验收报告与待验证项](docs/implementation/acceptance-report.md)
- [实现差异及实测记录](docs/engineering/implementation-notes.md)
- [全量代码审查与修复报告](docs/implementation/code-review-2026-10-23.md)：最新代码状态与回归证据。
- [Fish Audio 流式语音验收](docs/implementation/voice-streaming-acceptance.md)：甜妹、HTTP 边收边播、默认自动朗读和停止。

在「人格 → 运行设置」选择 DeepSeek（DS）或 xAI（Grok）。Grok 使用 `grok-4.3`，关闭 reasoning 并流式输出；输入自己的 API Key 后点击「保存运行设置」，即可保存 Key 和模型选择。也可以单独保存／移除 Key。「新建角色」弹窗可直接选择模型，创建后仍可调整。模型和两家的 BYOK Key 按角色独立保存，刷新、重启后保留。Key 仅保存在本机权限 0600 的私有文件中，不回显、不进入导出或数据库备份；已有后台 DeepSeek 配置继续可用。

[Grok／DS 与 BYOK 接入和验证记录](docs/implementation/model-providers-byok.md)。

## 已有能力

- 麦克风语音输入：支持本地 Whisper 和 Fish Audio，当前电脑默认本地识别；录音转成可编辑草稿，确认后发送，支持取消与角色隔离。[配置与验收](docs/implementation/voice-input-acceptance.md)
- 多 bot 创建／切换／归档／恢复；保留原小野，另有独立的 AI 小女友小棠。
- 角色背景、兴趣、称呼、相处模式、互动方式与边界；各角色聊天、记忆和任务独立。
- 人格版本、安全前缀、明确称呼边界、专注／免打扰。
- 流式对话、取消、幂等、有界工具、断线续看、重启恢复。
- 可选分条回复与发送间隔：每个 bot 独立保存，默认关闭；支持插话取消尾段、停止和刷新续看。[使用与验收](docs/implementation/reply-presentation-acceptance.md)
- 确认记忆、待确认建议、共同经历、日摘要、中文检索、修订和遗忘。
- 一次性跟进、每日／每周习惯、候选判断、草稿、持久 Outbox 和浏览器回执。
- 本地 Trace／上下文检查、用量、导出、一致性备份及带删除清单的恢复。

- [记忆 benchmark 定义、25项复核与剩余边界](docs/implementation/memory-benchmark-v1-audit.md) · [评分合同](docs/engineering/memory-benchmark-contract.md)

最新记忆修复：[引用闭合、复合句评审与过拟合审查](docs/implementation/memory-citation-closure-fix.md)；[新增问法五题复核与回答边界](docs/implementation/memory-answer-five-case-audit.md)；[两道漏召回与 25000 条读取延迟](docs/implementation/memory-recall-latency-fix.md)。

最新增量：[多 bot 与相处设定交付](docs/implementation/multibot-acceptance.md)、[记忆实验与最终方案](docs/research/vector-memory-decision.md)；[记忆 v1.1 首阶段验收](docs/implementation/memory-stage-one-acceptance.md)（保留首阶段快照）；[记忆完整实施与准确性验收](docs/implementation/memory-complete-acceptance.md)（分段摘要、历史找回、来源展开、本地 E5、混合召回、遗忘恢复及边界测试已实现；新功能默认关闭，正式库未迁移）。原单关系报告保留当时的测试快照，以增量报告和当前代码为准。

后续能力调研：[角色日常、故事系统与连续消息](docs/research/story-and-proactive-messaging.md)，包含现状、开源源码参考及建议接入顺序。分条回复与发送间隔已完成首轮实现；角色日常与故事尚未实施。

下一阶段设计：[角色生活系统工程方案](docs/engineering/character-life-system-plan.md)，覆盖设定、日常作息、事件、角色记忆、聊天接入、开关和分阶段验收；当前为设计，尚未实施。

临时凭据在后台读取的 `env.local`，BYOK 在当前角色数据目录下的 `model-keys.json`，权限均为 0600，已忽略。不要分享这些文件、`data/`、备份或敏感上下文。本版仅监听回环地址；多用户托管、Web Push、Electron 和十万用户容量验证属于后续阶段。

## 验证

```sh
npm run verify
npm run test:web
npm run test:crash
npm run test:memory:web
```

真实模型命令会消耗额度，见手册。验收报告记录实际结果，不把整张设计矩阵算作通过。

## 设计基线

下一阶段记忆与主动交流设计：[v3.4 方案导航](docs/engineering/companion-memory-v3-plan.md)，拆为[产品规则](docs/engineering/companion-memory-v3-product-rules.md)、[工程合同](docs/engineering/companion-memory-v3-engineering-contract.md)和[CM3 2 最小试聊清单](docs/engineering/companion-memory-v3-cm3-2-checklist.md)。主动发起复用FollowUp/Series/Outbox，明确授权、免打扰、频率、未回应暂停和在线通道限制；风险分级发布仍只作实验。v3.4已冻结，CM3 0至2最小切片已在新隔离入口 http://127.0.0.1:4331 开放试聊，启动命令 `node_modules/.bin/tsx scripts/memory-cm3-trial.ts`；[交付与验证记录](docs/implementation/companion-memory-cm3-2-release.md)。主动触达独立验收，72小时问候暂缓。现有4321、正式库和向量开关未变，新切片向量与主动发送关闭。

1. [最小版本](docs/engineering/minimum-version.md)、[技术决策](docs/engineering/architecture-decisions.md)
2. [完整工程方案](docs/engineering/harness-engineering-plan.md)、[接口合同](docs/engineering/api-and-runtime-contracts.md)
3. [规模路线](docs/engineering/web-and-scaling-roadmap.md)、[验收矩阵](docs/engineering/acceptance-matrix.md)、[评审回应](docs/engineering/review-response.md)
4. [开源实现比较](docs/research/open-source-implementation-review.md)、[源码证据](docs/research/source-evidence.md)、[固定版本](docs/research/source-lock.json)
5. [记忆系统工程方案](docs/engineering/memory-engineering-plan.md)：v1.1 确认漏斗优先、五层记忆、固定预算与滞后切换、历史找回、索引与遗忘、实施门槛及参数表；2026-10-24 实施规格；完整工程和隔离评测已交付；自然观察、正式启用和未测设备仍分别列明。

## 文档冻结与权威规则

v0.3 文档保留开工快照，其中「尚未实现」指冻结当时。用户随后授权一次性实施 M0–M4 及 M5 自动验证，当前状态见验收报告和实现记录，原设计不逐段追改。

1. 领域语义和权限以主方案及明确用户决定为准。此次范围已扩展，资源 API 不再受 M0 六路由上限约束。
2. 路由和实际行为以代码、测试为准；偏离领域意图仍须登记，不能因有代码就认定正确。
3. 验收区分通过、未执行、人工待验和后置。工程通过不等于陪伴体验成熟。
4. 上游源码观察保留固定证据；模型身份和数据条款持续核对。十万注册、日活、在线与同时生成分别评估。

语音音色对比：打开 [独立调试页](http://127.0.0.1:4317/voice-lab)，直接听四份已备样本，也可重新生成测试 HTTP Streaming。[操作与实测记录](docs/implementation/voice-lab.md)。

最新试聊修复：[保存承诺、确认状态与冻结新题验收](docs/implementation/memory-commit-release.md)，仅更新 4321 独立实例。
