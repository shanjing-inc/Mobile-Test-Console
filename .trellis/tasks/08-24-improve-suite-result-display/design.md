# 技术设计

## 输入契约

Suite Result Bundle case 使用 `metadata.executionKind: suite`。`metadata.assertions` 中每项包含测试点名称、完整名称、状态与耗时；case `targetPage` 保存测试文件路径，case `assertions` 继续提供通用通过依据。

## 数据投影

`TaskResults.hydrateBundle` 已将 `metadata.executionKind` 和 `metadata.assertions` 投影到 `TaskResultRun`，前端通过共享 helper 识别 Suite，并从 assertions 计算总数、状态计数和耗时。

## 展示分支

- `AnalysisRuns` 对 Suite 渲染源文件与测试统计，对其他类型保持页面运行摘要。
- `RunDiagnosticDetail` 对 Suite 渲染测试点详情，对其他类型保持页面诊断。
- `diagnoseTaskResultRun` 对 Suite 失败返回单元测试诊断，避免页面打开失败分类。
- 纯 Suite 工具栏展示“套件数 · 测试点数”。

## 兼容性

旧结果缺少 Suite metadata 时继续进入通用展示。共享 `TaskResultRun.assertions` 保持 `Record<string, unknown>[]`，Suite helper 负责安全读取和默认值。

## 响应式约束

Suite 状态统计允许换行；测试点标题支持断词；状态与耗时列保持稳定宽度。390px 视口使用单列详情布局。
