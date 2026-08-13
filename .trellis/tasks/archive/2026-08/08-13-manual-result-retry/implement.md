# 测试结果模块复测与结果替换实施计划

1. 校正共享重试契约，使模块复测范围覆盖通过和失败用例，并保留来源任务、来源运行和稳定用例标识。
2. 在 TaskManager 中复用原任务创建新任务，把复测上下文写入 RunPlan metadata。
3. 调整重试 API，使用 TaskResult 校验任意来源用例并复用现有容量、设备和目标门禁。
4. 复测完成后聚焦新任务，使结果面板只显示最新复测结果；旧任务通过运行历史和入库操作保留。
5. 在每个结果模块增加“重新测试”按钮、模块级 pending 状态；失败结果总览保留批量入口。
6. 补充 TaskManager、Fastify API、Web API、结果合并与 SSR 渲染回归测试。
7. 运行相关 Vitest、typecheck、lint 和构建检查。

## 风险点

- 运行目标可能已忙，重试必须沿用现有并发锁。
- 旧任务没有 `retryOf`，所有显示逻辑需兼容缺失字段。
- 复测结果中的 `caseRunId` 可能随 runId 变化，映射优先使用稳定 `caseId` 与场景维度，发现歧义时保留来源结果并显示警告。
- 截图和证据属于复测任务，结果投影必须携带产物来源 taskId。

## 验证命令

```bash
pnpm vitest run tests/task-manager.test.ts tests/app.test.ts tests/web-results.test.ts
pnpm typecheck
pnpm lint
pnpm build
```
