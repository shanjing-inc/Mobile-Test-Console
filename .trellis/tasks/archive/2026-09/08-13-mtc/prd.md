# MTC 页面测试改为用户显式选择

## Goal

将 MTC 的 Lynx 页面测试范围改为用户在页面目录中直接选择页面。页面测试默认展示全部可测试页面，用户通过搜索、筛选、全选当前结果或逐项勾选确定执行范围；Smoke、P0、P1、P2 不再作为页面测试范围预设。优先级和标签继续作为页面属性，用于筛选、展示、报告和录屏策略。

## What I already know

* Fanli `qa/mobile-test.config.cjs` 页面测试参数此前提供 `smoke`、`p0`、`p1`、`p2`、`all-pages` 预设，默认值为 `smoke`。
* MTC 的 `PageSelectionField` 已支持页面目录、搜索、逐项勾选和全选当前筛选结果，并将显式选择序列化为逗号分隔页面 ID。
* Fanli `qa-mobile-test-console.cjs suite` 接受 `--suite` 或 `--pages`，页面选择可以进入 `qa-lynx-run.cjs --pages` 的显式页面分支。
* MTC 单用例重试会写入 `MTC_RETRY_TARGET_PAGES`、`MTC_RETRY_CASE_IDS` 和 `MTC_RETRY_CASES` 环境变量；Fanli 当前页面 suite 命令尚未消费这些重试范围变量。
* MTC 页面选择、任务创建、重试元数据和 Provider runner 构成跨层数据流。

## Requirements

* 页面测试参数默认值改为完整页面选择语义，提交任务前得到明确的页面 ID 列表。
* 页面测试 UI 保留页面搜索、优先级/标签等筛选、全选当前结果、逐项勾选和已选数量展示。
* 页面测试配置移除 Smoke/P0/P1/P2 页面范围预设；流程测试继续保留流程分组预设。
* 显式选择页面后，页面清单后续变化不影响已创建任务的执行范围。
* MTC 对单个页面或单个失败用例发起复测时，Fanli 只执行对应页面/用例，不回退到原任务的全页面范围。
* `all-pages` 可作为兼容输入解析，但新建页面测试任务不再依赖该隐式项目套件。
* 补充配置、参数解析、runner 命令和重试范围的回归测试，并更新相关 QA 文档。
* 运行列表只展示来源测试组；活动重试期间显示“正在重试”并锁定删除、保留和重复重试操作。
* 重试完成后只用通过的结果替换来源 item；失败、取消、中断或结果不可用时保留原 item。
* 多次重试按创建时间累计成功结果，删除来源记录时一次清理完整重试链。

## Acceptance Criteria

* [x] 页面测试页面范围没有 Smoke/P0/P1/P2 预设，默认页面选择结果与用户当前勾选一致。
* [x] 用户选择两个页面时，任务命令携带这两个页面 ID，执行结果只包含这两个页面。
* [x] 用户选择“全部当前页面”后，任务保存展开后的页面 ID 列表。
* [x] 单个页面复测只执行该页面；单个失败用例复测只执行该用例。
* [x] 页面优先级/标签筛选仍可用，并继续影响展示、报告和录屏策略。
* [x] 搜索只筛选页面范围，全选当前可反向取消，清空保留明确空选择。
* [x] 活动重试锁定来源测试组；重试失败保留原 item，重试通过只替换对应 item。
* [x] MTC lint、类型检查及 337 个测试通过；Fanli Lynx QA 385 个测试通过。

## Definition of Done

* 实现跨层参数契约并补充回归测试。
* 更新 MTC/QA 使用文档，明确页面测试与流程测试的范围选择差异。
* 完成 lint、typecheck 和相关测试验证。

## Out of Scope

* 不改变流程测试的 Smoke/P0/P1/P2 分组语义。
* 不改变页面优先级对录屏策略、报告排序和统计的既有作用。
* 不重构 MTC 通用页面目录协议。

## Technical Notes

* MTC 页面选择组件：`src/web/PageSelectionField.tsx`
* MTC 任务创建与页面预设展开：`src/server/app.ts`
* MTC 重试接口：`src/server/app.ts`
* Fanli 配置：`../fanli/qa/mobile-test.config.cjs`
* Fanli MTC 命令适配：`../fanli/packages/lynx/scripts/qa/qa-mobile-test-console.cjs`
* Fanli 项目 Provider：`../fanli/packages/lynx/scripts/qa/mtc-lynx-project-provider.cjs`
