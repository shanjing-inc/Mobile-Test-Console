# App 多设备并行测试设计

## 根因与边界

控制台调度层为不同设备各自创建任务并调用 `execute()`，当前语义仍将同设备活动任务作为启动错误处理。Fanli App Runner 在每项任务运行前调用 Provider；Provider 对每项任务传入服务进程 PID 作为 QA 构建协调器参与者 ID。多个设备任务因此共享状态记录，无法稳定表达并行参与者。

QA Bundle 本身属于共享项目资源。协调器继续以项目级互斥锁串行化源码校验、QA Bundle 构建和平台同步，保证构建输入和写入的原生资源一致。每个任务完成对应平台同步后，App 安装、账号预检、页面参数解析和测试执行通过各自设备命令并行运行。

## 调度模型

- `TaskManager` 维护以 `device.key` 为键的 FIFO 队列。
- 新任务始终先持久化为 `queued`；设备空闲时调度头部任务，设备繁忙时保留在该设备队列。
- App 启动校验以 `(testId, device.key)` 为唯一活动键；存在 `queued`、`preparing` 或 `running` 任务时返回 `TASK_DUPLICATE`。其他 `testId` 可继续加入该设备队列。
- 任务完成、失败、取消和启动异常均触发该设备下一项任务调度。
- 排队任务取消后直接标记 `cancelled`，并继续调度该设备后续任务。
- 服务恢复将遗留的 `preparing`、`running` 和 `queued` 任务标为 `interrupted`，保持现有运行恢复模型。

## Runner 协作

- Provider 用 `plan.runId` 生成构建协调器的 `participantId`，并保留 MTC 服务 PID 作为存活探测 PID。
- 共享构建协调器只保护 Bundle 构建和平台同步临界区；它按任务记录参与者，用相同 fingerprint 复用 QA Bundle。
- Provider Runner 在准备命令完成后开始每设备独立执行链路，避免平台级全局执行锁。

## 验证

- `TaskManager` 单元测试覆盖同设备 FIFO、排队取消、空闲与繁忙设备混合批量启动。
- Runner/Provider 回归测试断言 Android 和 HarmonyOS 生成不同参与者 ID。
- 协调器测试覆盖两个相同 fingerprint 的参与者可分别注册、同步并释放。
- 集成测试使用 Android 与 HarmonyOS 两个假设备，验证两个任务同时进入运行态并独立结束。
