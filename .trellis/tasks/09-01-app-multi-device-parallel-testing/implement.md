# 实施计划

1. 扩展 `TaskManager`：将设备活动冲突改为每设备 FIFO 排队，添加排队任务取消、终态后续调度、同入口同设备活动任务去重和重启中断处理。
2. 更新 API 与 Web：允许选择已有任务的设备，展示等待状态和队列位置，提供排队任务停止入口。
3. 更新 Fanli Provider：将 `prepare --id` 从服务 PID 改为 `plan.runId` 派生的任务级唯一标识。
4. 审核并收紧 QA 构建协调器：共享锁只覆盖 Bundle 构建和平台同步，参与者状态按任务独立维护。
5. 添加 TaskManager、HTTP API、Provider、构建协调器和 Android+HarmonyOS 并行的回归测试；覆盖同入口同设备在运行和排队状态的去重。
6. 执行 TypeScript 检查、相关 Vitest 测试和 Fanli QA Node 测试；用实际 Android 与 HarmonyOS 设备完成并行启动验证。

## 回滚点

- 调度改动集中在 `src/server/task-manager.ts`，可单独回退。
- Fanli Runner 改动集中在 `packages/lynx/scripts/qa/mtc-lynx-project-provider.cjs`，可单独回退。
- QA 协调器锁范围保持构建与同步临界区，回滚后继续使用当前项目级锁策略。
