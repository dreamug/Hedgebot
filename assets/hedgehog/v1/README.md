# 煤球动画素材 v0.1

暖栗棕像素小刺猬，共12段连续动画、每段8帧、合计96帧。新增了吃大果子、比心冒桃心、举牌“飞飞爱你”、背着蛋糕开心晃悠。

这是一版可播放的动画原型；当前预览尚未连接 bot 或 Codex。

## 查看

在项目根目录运行 `node scripts/hedgehog/serve-preview.mjs`，打开 http://127.0.0.1:4347 。可以选动作、调大小/速度、暂停、切浅色/深色/透明检查背景，也可以看模拟的 coding 陪伴流程。

- `previews/actions-overview.gif`：全部动作的动态总览。
- `previews/<action>.gif`：单个动作预览。
- `previews/contact-sheet.png`：静态总览。

## 集成

应用使用 `manifest.json` 与 `sheets/*.png`，或者按 `frames/*/*.png` 逐帧加载。每帧128×128；图集1024×128，8帧横排；RGBA透明底，锚点(64,116)，使用最近邻缩放。每帧时长不同，按清单播放；happy / wave 播放一次后回 idle，其余循环。向左走可以由播放器镜像 walk；举牌文字禁止镜像。

64px适合迷你显示；举牌四字在小尺寸下难以阅读，招牌动作建议使用128px及以上，或用聊天气泡同步展示文字。桌宠窗口位移独立于原地步态帧。talk 是表达性口型动画，不是音素级唇形同步。

## 来源与复现

创作图像使用内置 image_gen，以 `source/coal-master.png` 为身份母图；20种静态姿势仅作前期概念参考。完整提示词及修订保存在 `generation.json`。透明底由图像生成工具输出；导入脚本仅做裁格、对齐、硬alpha、最近邻缩放、图集打包和GIF导出，不用代码代画角色。

重新导入：`node scripts/hedgehog/build-assets.mjs`。

预览验证：先运行本地预览服务，再执行 `node scripts/hedgehog/verify-preview.mjs`。依赖当前项目已有 Playwright Chromium 和本机 FFmpeg；终端输出和 qa 文件记录实际检查结果。

`raw/` 保留原始8帧表；`qa.json` 和 `preview-qa.json` 记录尺寸、透明、不同帧、播放控制与资源加载检查。它们不等同于像素级手工精修或真实桌面性能验收；最终母体轮廓、循环接缝和跨动作大小仍可继续在 Aseprite 中精修。
