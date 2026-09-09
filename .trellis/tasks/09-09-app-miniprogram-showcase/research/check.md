# 独立检查记录

## 2026-09-09 初始检查
- 上下文：已读 check.jsonl、对应组件规范、research/showcase.md、PRD、设计和实施计划。
- 生产源码保持原状；本轮只写本检查记录。
- `pnpm lint`：通过，退出码 0。
- `pnpm typecheck`：通过，退出码 0。
- `pnpm test`：失败；53 文件，45 通过 / 8 失败；504 用例，490 通过 / 14 失败。
- `env TMPDIR=/private/tmp pnpm test`：失败；53 文件，46 通过 / 7 失败；504 用例，494 通过 / 10 失败。测试耗时 14.43 秒。
- 第二轮确认 tests/config.test.ts 的四个 /var 与 /private/var 临时目录别名失败消失；仍有 project-provider-runtime、runner-runtime、app、shanjing-example、lynx-app-starter、startup-project 等测试基线问题。具体已见：Provider demo-app 未注册、Runner demo-runner 未注册、CLI 源码断言仍期待 loadRunnerRuntime 调用、预期固定项目 ID 与实际派生 ID 不同。
- 本轮未修改 src/ 或 tests/；以上既有测试契约/实现问题超出媒体任务范围，已向主会话报告。

## 源片审查
- 10 秒：左设备栏、右运行列表均出现个人设备名与序列号。
- 60 秒：结果元信息重复设备名和标识；右侧登录截图含手机号、订单截图含订单明细。
- 90 秒：运行列表、详情标题仍有设备名；接口元信息出现 IPv6，响应正文需完整保护审阅。
- app-details 接触表末段包含二维码，已建议剪辑代理排除或保护。
- 114 秒：微信实际状态包含未知、跳过、通过，截图显示 401；使用“历史结果”“异常页面”措辞，并保留真实状态。
- 已将源片坐标和建议发送主会话与 edit_media。最终媒体、GIF、封面及 README 链接待产出后验收。

## 干净 HEAD 基线复核
- git archive HEAD 导出目录：/private/tmp/mtc-head-check-h4tnkucq；仅链接共享 node_modules。
- HEAD：8a3ca2c30af41f39794a5e98f4a068dea8286bd3
- 使用与工作区一致的 Node v24.18.0 显式路径、TMPDIR=/private/tmp，执行 vitest run --reporter=json。
- 结果：494 通过 / 10 失败 / 504 总计，与当前工作区使用规范临时路径时一致。
- 机器结果：/private/tmp/mtc-head-check-results.json。
- 精确失败列表：
  - app.test.ts：HTTP API 登记项目并返回持久化接入步骤
  - lynx-app-starter.test.ts：Lynx App Starter 加载完整 Provider/Runner 并摄取 Smoke Result Bundle
  - open-source-readiness.test.ts：开源发布契约 两个 Lynx 项目都通过配置边界注册自己的 Provider 与 Runner
  - project-provider-runtime.test.ts：项目 Provider 运行时 按配置文件相对路径加载 CJS/ESM Provider 插件并注入 Runner
  - runner-runtime.test.ts：Runner CLI 运行时 生产 CLI 与开发生命周期入口都在启动前创建 Runner Runtime
  - runner-runtime.test.ts：Runner CLI 运行时 按配置文件相对路径加载 CJS/ESM Runner 插件并传入项目上下文
  - shanjing-example.test.ts：com.shanjing.example 加载最小 Lynx App 配置、Provider 与 Runner
  - startup-project.test.ts：MTC 启动项目解析 目录已有活跃项目时仍启动平台壳并保留目录状态
  - startup-project.test.ts：MTC 启动项目解析 显式配置优先于目录中的活跃配置
  - startup-project.test.ts：MTC 启动项目解析 无参数启动不读取失效的目录配置

## 微信动态片段补充
- 108–112 秒截图包含编辑个人资料/申请加入团队的手机号，以及订单详情/订单列表；虽然部分字段呈示例数据形态，仍按本任务约定要求保护。已向 edit_media 通知。
- 113–118 秒接触表主要为提现、教程、401 和首页，抽样中未发现上述信息。

## 最终媒体复核
- 初版 API 动态末端（成片约 43 秒）因源画面滚动导致固定遮挡失位，个人设备名、序列号及 IPv6 再次进入画面。已通知实施代理，最终脚本改为源 90 秒安全定格 9 秒；重查最终成片 43 秒确认保护稳定。
- 取消镜头准确显示三条已取消及三条历史通过；字幕明确启动后取消与历史结果切换。
- 微信 108 秒采用安全定格，113–118 秒动态按 10 fps 抽取右截图列 50 帧审阅，未发现手机号、订单或个人标识；114 秒定格保留未知、跳过、通过与 401。
- 最终 MP4：66 秒、1280×800、30 fps、H.264、yuv420p、无音轨。全片 ffmpeg 解码通过。
- 最终 App GIF：28 秒、1000×625、35 帧、1,898,748 字节。微信 GIF：19 秒、1000×625、42 帧、2,242,906 字节。二者 ffmpeg 全解码通过，优化后均低于 8 MB。
- README.md、README.en.md 和 docs/showcase.md 的 12 个本地媒体/说明链接均指向存在文件。
- 干净 HEAD 的开源扫描重复确认 tests/page-parameters.test.ts 的 Linux 绝对路径误报；通过 GIT_DIR/GIT_WORK_TREE 指向归档内容并移除临时依赖链接，唯一失败仍为该项。
- 最终 API 35–44 秒完整 270 帧解码通过，并以 2 fps 全段 18 帧接触表复查裁切与遮挡稳定。
- Pillow 检查两 GIF loop=0（无限循环），累计延时分别为 28,000 / 19,000 ms；MP4 的 moov 位于 mdat 之前，支持 faststart。
