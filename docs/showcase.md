# 功能演示与剪辑复现

这组素材来自项目维护者提供的真实控制台录屏，用于展示 App 测试启动与 App、微信小程序的历史结果浏览。

## 观看素材

- [完整视频（MP4）](../assets/showcase/showcase.mp4)
- [App：多设备启动与历史截图（GIF）](../assets/showcase/app-demo.gif)
- [微信小程序：历史结果与页面截图（GIF）](../assets/showcase/wechat-results.gif)
- [视频封面](../assets/showcase/poster.jpg)

## 内容说明

App 片段展示 Android、iOS、HarmonyOS 设备及测试页面的选择、测试启动和运行状态。本次录制在启动后取消测试，随后展示已保存的历史结果。成片以字幕交代取消与历史结果的切换。

微信片段展示微信开发者工具运行目标及已有测试记录，包含用例状态、页面截图和异常信息。原始记录中的通过、未知和跳过状态均按实录保留。

个人设备名、设备标识，以及截图中的手机号和订单信息经过遮挡或裁切。成片使用中文字幕，适合静音观看。

## 复现剪辑

需要 Python 3、Pillow 9.1 或更新版本、可在 PATH 中调用的 `ffmpeg` / `ffprobe`，以及支持中文的字体。macOS 默认查找 Hiragino Sans GB，Linux 默认查找 Noto Sans CJK；也可通过 `--font` 指定字体。

可以使用独立 Python 环境安装 Pillow：

```bash
python3 -m venv /tmp/mtc-showcase-venv
/tmp/mtc-showcase-venv/bin/python -m pip install "Pillow>=9.1"
```

从仓库根目录运行剪辑脚本，输入维护者保存的原始录屏：

```bash
/tmp/mtc-showcase-venv/bin/python scripts/build-showcase.py /path/to/recording.mov
```

默认输出到 `assets/showcase/`。自定义字体和输出目录：

```bash
/tmp/mtc-showcase-venv/bin/python scripts/build-showcase.py /path/to/recording.mov \
  --font /path/to/chinese-font.ttc \
  --output /tmp/mtc-showcase-output
```

脚本会覆盖输出目录中的同名成片。中间帧使用临时目录，完成后自动清理；源录屏只读使用。

脚本校验原片的 SHA-256 摘要，固定时间轴与遮挡只应用于已审阅的原片。原始素材长度为 118.385 秒，分辨率为 1920×972，帧率约 59.94 fps，无音轨。脚本中的剪辑时间和遮挡区域对应这份录屏；更换原片时需要重新审阅素材、校准时间轴和遮挡坐标，再更新摘要并复核输出。

原片由维护者保存在本地。仓库交付成片、GIF、封面和生成脚本，复现需要自行提供原片。

## 输出与时间轴

| 素材 | 时长 | 分辨率 / 帧率 | 大小 |
| --- | --- | --- | --- |
| 完整视频 | 66 秒 | 1280×800 / 30 fps | 0.84 MB |
| App GIF | 28 秒 | 1000×625 / 动态片段 8 fps | 1.90 MB |
| 微信 GIF | 19 秒 | 1000×625 / 动态片段 8 fps | 2.24 MB |
| 封面 | 静态图片 | 1280×800 | 0.09 MB |

GIF 将定格镜头保存为单帧长停留，保留动态片段并减小文件体积。

精确选段与遮挡坐标保存在脚本 `SHOTS` 中。成片时间轴：

| 成片时间 | 内容 |
| --- | --- |
| 00:00～00:03 | 标题与素材来源说明 |
| 00:03～00:15 | App 选择设备、启动与运行状态 |
| 00:15～00:19 | 取消说明，转入历史结果 |
| 00:19～00:35 | App 历史结果总览及页面截图 |
| 00:35～00:44 | 历史接口请求与响应 |
| 00:44～01:03 | 微信运行目标、历史结果与异常截图 |
| 01:03～01:06 | 项目与 README 入口 |

## 编辑原则

保留设备选择、测试启动和关键结果页面，压缩等待与重复滚动。部分结果页面使用从实录选取的定格镜头，方便阅读并避开滚动中的个人信息。App 历史结果部分展示页面截图和接口详情；微信部分展示历史用例与截图。

MP4 使用 H.264 与浏览器兼容的像素格式，并为在线播放优化文件头。GIF 单独选择适合循环观看的片段，重点保证状态文字、字幕和页面截图可读。

## 维护检查

更新素材后核对：

1. App 取消操作与历史结果切换有明确字幕；微信段准确标明历史结果。
2. 每个保留镜头中的个人信息遮挡完整，滚动和转场也在检查范围内。
3. 视频及 GIF 可完整解码，字幕可读，画面比例正确。
4. 中英文 README 的图片、视频与说明链接均指向存在的文件。
5. `pnpm check:open-source` 与 `pnpm check:package` 通过，媒体文件位于 `assets/showcase/`，保持在 npm 发布包之外。

在本地仓库和 GitHub 上使用相对路径观看素材。npm 包的 README 提供 GitHub 演示区入口；推广媒体随 Git 仓库分发。
