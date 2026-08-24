# 修复重测结果状态投影

## Goal

让重测结果的展示状态以已摄取的 Result Bundle 汇总结论为准，保证所有重测项通过后，来源任务在快照接口和页面中展示为通过。

## Requirements

- Result Bundle 摄取仅校验 `runId` 与 `projectId`，Bundle 结论可独立于外层项目命令的退出状态。
- 项目 Provider Runner 在已摄取 Bundle 时使用 Bundle 汇总状态作为任务终态，并持久化原始 `runnerStatus` 与 `finalStatus` 诊断信息。
- `/api/snapshot` 为已完成重测链路投影展示状态：合并结果存在且失败数为零时，来源任务响应为 `status: "passed"`、`phase: "重试后通过"`、`exitCode: 0`、空 `error`。
- `TaskManager` 中的原始失败状态、进程退出信息与日志继续用于诊断，展示投影不回写或覆盖原始记录。
- 本任务范围仅限 Mobile Test Console；Fanli App 端的截图与 QA 脚本改动不纳入本次提交。

## Acceptance Criteria

- [x] Bundle 摄取接受项目命令失败时仍可归属到对应任务的有效 Bundle。
- [x] Runner 已摄取 Bundle 后按 Bundle 汇总判定最终任务状态。
- [x] 全部重测项通过时，快照中来源任务展示为通过及“重试后通过”。
- [x] 原始失败任务状态和日志保留为诊断信息。
- [x] `tests/result-bundle.test.ts`、`tests/project-provider-command-runner.test.ts`、`tests/app.test.ts` 回归通过。
- [x] TypeScript 类型检查、ESLint 与 Vitest 全量检查通过，共 41 个测试文件、362 项测试。

## Notes

- 已在实际服务 `http://127.0.0.1:4310` 验证任务 `db6d3942-ef77-4b59-b197-92c2d57fca49` 的投影响应为 `status: "passed"`、`phase: "重试后通过"`、`exitCode: 0`、空 `error`。
