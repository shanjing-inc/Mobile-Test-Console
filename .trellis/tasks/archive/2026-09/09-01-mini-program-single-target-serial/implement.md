# 简化小程序单目标并保证串行执行：实施计划

## 实施步骤

- [x] 在 `src/web/App.tsx` 派生单目标绑定模式与已选运行目标繁忙状态。
- [x] 调整 `TargetRow`：单目标绑定模式展示固定状态且无 checkbox，多目标模式保留现有选择交互。
- [x] 将已选执行资源繁忙状态纳入小程序“启动测试”按钮的禁用条件。
- [x] 在 `tests/web-device-start.test.ts` 增加单目标绑定、多目标可选和忙碌展示测试，保留现有自动选择覆盖。
- [x] 在 `tests/task-manager.test.ts` 增加两个并发 `start()` 请求共享 `concurrencyKey` 的回归测试，断言成功数、`TARGET_BUSY` 和活动任务数。
- [x] 根据实现结果更新 `.trellis/spec/backend/mobile-test-console-integration.md` 中单实例互斥保证，并补充前端规范中单目标绑定交互契约。

## 验证命令

```bash
pnpm vitest run tests/web-device-start.test.ts tests/task-manager.test.ts
pnpm lint
pnpm typecheck
pnpm test
```

## 风险与回滚点

- `src/web/App.tsx` 当前包含上一任务的暂存修改；实施时只追加本任务所需差异并逐段复核 staged/unstaged diff。
- `src/server/task-manager.ts` 当前包含上一任务的暂存修改；并发测试优先验证现有临界区，仅在测试证明存在时序缺口时修改实现。
- 前端按钮禁用属于体验层保护，`TaskManager` 的 `TARGET_BUSY` 继续承担最终一致性保护。

## 启动前检查

- [x] `prd.md`、`design.md`、`implement.md` 内容一致且无开放产品问题。
- [x] `implement.jsonl` 与 `check.jsonl` 均包含真实规范上下文。
- [x] 用户审批本规划后再执行 `task.py start`。
