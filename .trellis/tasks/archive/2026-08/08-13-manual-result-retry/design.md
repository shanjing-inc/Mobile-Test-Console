# 测试结果模块复测与结果替换设计

## 边界

MTC 负责选择复测范围、创建新任务、执行调度、持久化来源关系，以及把最新复测结果投影到来源结果页。集成项目负责把 Runner Plan 中的用例范围映射为项目自己的测试过滤参数。

## 数据流

```text
结果页任意用例模块
  -> POST /api/tasks/:taskId/retry { caseRunIds? }
  -> TaskResult 校验来源用例
  -> TaskManager 复用原 test/parameters/target 创建新任务
  -> TestTask.retryOf 持久化来源与范围
  -> RunPlan.metadata.retry 传给 Runner / Project Provider
  -> 新 runId 独立采集结果
  -> 来源结果页按稳定用例标识合并最新复测结果
```

## 契约

`TaskRetrySource` 包含直接来源 `taskId/runId`、`scope`、`attempt`，以及定向范围所需的 `caseRunIds/caseIds/targetPages`。任务重试使用 `scope=task`；模块复测使用用例范围。

API 接受来源任务中的任意 `caseRunId`。服务端从统一 `TaskResult` 投影稳定字段，前端只提交标识符。页面复测成功后自动聚焦新任务，因此结果面板只读取最新复测任务；旧任务仍存在于运行历史，可通过现有“长期保留/入库”操作保护产物。附件 URL 使用产出复测结果的 taskId，确保状态、诊断和证据来自同一次执行。

## 兼容性

`retryOf` 是 `TestTask` 可选字段，旧状态文件继续加载。Runner metadata 新增可选 `retry`。定向复测要求项目适配器消费用例范围并产出可映射的 Result Bundle。

## 错误与并发

复测调用复用 `TaskManager.start`，沿用目标存在性、平台支持和 concurrencyKey 锁。来源任务须为终态。定向范围为空、包含未知用例或重复用例时拒绝请求。

## 回滚

删除新增 API、UI 入口和可选字段即可回滚；现有任务数据与 Result Bundle 协议无需迁移。
