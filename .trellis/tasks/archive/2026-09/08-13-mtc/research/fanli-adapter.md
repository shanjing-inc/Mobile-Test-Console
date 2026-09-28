# Fanli 项目适配上下文

## 边界

MTC 负责页面选择器、显式范围冻结、重试任务编排、重试链展示、结果合并和删除保护。Fanli 负责提供页面目录数据，并把通用重试 metadata 映射为项目测试命令。

## Fanli 文件

- `../fanli/qa/mobile-test.config.cjs`：页面测试使用 `page-selection` 参数，默认 `all-pages`，页面范围只保留“全部页面”兼容预设；流程测试继续使用 Smoke/P0/P1/P2 分组。
- `../fanli/packages/lynx/scripts/qa/mtc-lynx-project-provider.cjs`：优先读取 `metadata.retry.targetPages` 和 `metadata.retry.caseIds`；单 case 使用 `--case`，多页面使用 `--pages`；重试沿用已安装 QA App并跳过 App setup。
- `../fanli/packages/lynx/scripts/qa/qa-mobile-test-console.cjs`：优先消费 `MTC_RETRY_TARGET_PAGES` 和 `MTC_RETRY_CASE_IDS`，只执行重试范围。
- `../fanli/packages/lynx/scripts/qa/qa-lynx-core.cjs`：解析项目页面与 suite/case 范围，属于 Fanli 执行层实现。
- `../fanli/qa/README.md`：记录页面选择与流程分组的产品语义。

## 数据流

```text
Fanli 页面目录
  -> MTC PageSelectionField
  -> 用户显式页面 ID
  -> POST /api/tasks
  -> 任务参数冻结
  -> Fanli Provider --pages/--case
  -> Fanli Result Bundle
  -> MTC 来源任务结果
```

重试数据流：

```text
来源 item.caseRunId
  -> POST /api/tasks/:taskId/retry
  -> TaskRetrySource.caseRuns/caseIds/targetPages
  -> RunPlan.metadata.retry + MTC_RETRY_* 环境变量
  -> Fanli 定向执行
  -> MTC 按来源 caseRunId 合并通过结果
```

## 已确认约束

- 搜索只改变可见范围。
- “全选当前”作用于当前筛选结果，再次触发会取消当前结果。
- 清空会写入明确空字符串，表单初始化不能用默认值覆盖该状态。
- 页面选择器通过通用 `PageSelectionItem` 消费项目页面数据。
- 来源任务存在活动重试时，运行列表与详情显示“正在重试”，删除、保留和重试操作锁定。
- 重试结果按创建时间累计；只替换通过的对应 item，失败结果保留来源 item 的状态、截图、接口和证据。
- 删除来源任务时一次清理全部后代重试任务及产物。
