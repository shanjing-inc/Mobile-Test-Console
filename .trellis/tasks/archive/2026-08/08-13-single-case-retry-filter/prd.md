# 修复单页面复测范围未下发

## Goal

TBD.

## Requirements

- TBD

## Acceptance Criteria

- [ ] TBD

## Notes

- Keep `prd.md` focused on requirements, constraints, and acceptance criteria.
- Lightweight tasks can remain PRD-only.
- For complex tasks, add `design.md` for technical design and `implement.md` for execution planning before `task.py start`.
# 单页面复测范围下发

## Goal

修复结果页单页面“重新测试”实际重新执行整套页面的问题，让项目 Runner 能消费 MTC 下发的单页面过滤范围。

## Requirements

- 单模块复测任务携带稳定的 `caseIds`、`targetPages` 和 `caseRunIds`。
- 旧命令 Runner 通过标准模板变量和环境变量获得复测范围，项目脚本可选择性过滤页面。
- Provider Runner 的 `prepareRun`、执行命令和 `collectResult` 都能读取同一份范围 metadata。
- 示例 Lynx Runner 按 `targetPages` 只运行目标页面，并在 Result Bundle 中只输出目标页面。
- 整任务重测保持现有完整执行语义。

## Acceptance Criteria

- [x] 单页面复测命令收到 `MTC_RETRY_CASE_IDS`、`MTC_RETRY_TARGET_PAGES` 和对应模板变量。
- [x] 单页面复测示例只产生目标页面结果，整任务重测保持无过滤范围。
- [x] Provider Runner 测试确认范围从 RunPlan 贯通到准备、执行和结果收集。
- [x] `pnpm vitest run`、`pnpm typecheck`、`pnpm lint` 和 `pnpm build` 通过。
