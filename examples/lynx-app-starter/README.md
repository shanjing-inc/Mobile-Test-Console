# Lynx App Starter

该示例提供平台中立的 Project Provider、Runner、设备参数和 Result Bundle 完整生命周期。

## 运行示例

在 Mobile Test Console 仓库执行：

```bash
pnpm dev -- --config examples/lynx-app-starter/mobile-test.config.cjs
```

连接 Android、iOS 或 HarmonyOS 设备后，在“接入引导”中刷新检测，再执行 `Lynx Smoke`。示例命令只验证平台契约和结果链路。

## 迁移到真实 App

1. 修改 `mobile-test.config.cjs` 中的项目 ID、名称、根目录、`integrationType` 和平台；MTC 登记项目时直接读取这些字段。
2. 在 `qa/prepare.cjs` 接入项目的构建、安装、账号前置和页面参数解析命令。
3. 在 `qa/lynx-suite.cjs` 接入真实 deeplink、scheme、自动化驱动和 Lynx runtime 事件。
4. 在 `qa/result-bundle.cjs` 将项目原始报告、截图和网络证据转换为 `test-analysis.run.v1`。
5. 保持 Result Bundle 的 `project.id`、`run.runId` 和 `run.status` 与当前任务一致。

单页面复测时，MTC 会通过 `MTC_RETRY_TARGET_PAGES`、`MTC_RETRY_CASE_IDS` 和 `MTC_RETRY_CASE_RUN_IDS` 传入过滤范围。测试脚本需要读取这些变量，只执行对应页面并在 Result Bundle 中只输出对应 case；没有这些变量时执行完整测试集合。

真实项目可以保留同一插件边界，并逐步替换三个脚本中的示例实现。
