# 技术设计

## 边界与数据流

```text
Result Bundle runs
  -> Web ResultPanel 按 targetPage 组织重试动作
  -> POST /api/tasks/:taskId/retry { caseRunIds? | targetPages? }
  -> TaskRetrySource(scope, caseRunIds, caseIds, targetPages, caseRuns)
  -> RunPlan.metadata.retry + MTC_RETRY_*
  -> Fanli Provider / qa-mobile-test-console.cjs
  -> 页面范围命令 --pages 或单用例 --case
  -> Result Bundle ingest
  -> TaskManager 终态 + 来源任务投影
```

## API 与共享契约

- 扩展 `RetryTaskRequest` 支持 `targetPages?: string[]`，请求只能选择 `caseRunIds` 或 `targetPages` 其中一种。
- 页面重试在服务端从来源 Result Bundle 中解析匹配 runs，冻结匹配的 `caseRunIds`、`caseIds`、`targetPages` 和 `caseRuns`；空页面集合返回明确的 `RETRY_PAGE_UNKNOWN`。
- `TaskRetrySource.scope` 使用 `cases` 表示精确页面/用例范围，整任务请求继续使用 `task`。现有旧状态字段保持可选兼容。

## Runner 与超时收敛

- Provider 继续从 `retry.targetPages` 生成 `--pages`，单用例优先使用 `--case`；页面重试命令不得回退到原始 `parameters.pages`。
- TaskManager 为重试任务建立独立 watchdog，超时通过现有 AbortController 和 runner cancel 终止进程，随后以 `failed` 终态保存“重试超时”及来源范围；普通首次运行沿用现有时限。
- watchdog 在 finalize、cancel 和 shutdown 时清理，避免晚到的计时器覆盖已完成状态。
- 结果收集或 Bundle ingest 异常仍进入失败终态，保留 runner 日志、resultUri 和错误原因，来源行据此解除活动锁定。

## Web 交互

- 结果总览增加“重试全部失败页面”，按 `targetPage` 去重后提交对应 `caseRunIds`；每个结果条目的“重新测试”继续只提交当前 `caseRunId`。
- 运行详情头部的“重试任务”文案明确为“重试全部页面”，保留整任务能力。
- 活动后代的来源行继续显示“正在重试”；后代进入失败、取消或超时后，轮询自动解除锁定并展示失败诊断。

## 兼容与回滚

- 旧客户端发送空 body 仍创建整任务重试；旧任务缺少 `target`、`retryOf` 或 `caseRuns` 时按当前兼容逻辑加载。
- Provider 不识别新字段时，服务端已将范围冻结为 `caseRunIds`，旧 Provider 至少可以按用例范围执行；无法精确执行时返回可见错误并保留来源记录。
- 回滚只需恢复页面请求字段和 UI 按钮，历史任务与已有重试链无需迁移。
