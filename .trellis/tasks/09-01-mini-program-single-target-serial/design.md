# 简化小程序单目标并保证串行执行：技术设计

## 范围与边界

本次修改覆盖测试工作台的小程序运行目标交互和 `TaskManager` 的并发回归测试。运行目标配置、启动 API、Runner 命令解析和任务结果协议保持现有契约。

## 前端设计

### 目标模式判定

- 继续用所选测试入口过滤 `visibleTargets`。
- `visibleTargets.length === 1` 时进入单目标绑定模式；现有 `initializeSelectedTargetKeys()` 负责将唯一目标写入 `selectedKeys`。
- 多目标模式继续以 `selectedKeys` 管理显式复选结果。

### 目标行交互

- `TargetRow` 接收是否为自动绑定模式的明确属性。
- 自动绑定模式展示固定绑定标识、目标名称、平台、运行时和可运行/测试中状态，不渲染 checkbox，也不触发取消选择。
- 多目标模式保留现有 checkbox、忙碌禁用和选择样式。
- App 的 `DeviceRow` 及其设备操作保持不变。

### 启动可用性

- 从 `activeTaskByConcurrencyKey` 派生已选目标是否繁忙。
- 小程序任一已选目标繁忙时禁用“启动测试”；轮询刷新任务状态后自动恢复。
- 后端仍是并发互斥的权威来源。若界面状态滞后，启动 API 返回现有 `TARGET_BUSY` 错误并由现有消息链路展示。
- 测试入口选择、目标自动补齐和命令预览继续共享 `selectedKeys`，避免新增第二套绑定状态。

## 后端串行保证

`TaskManager.start()` 继续使用 `target.concurrencyKey` 表示一个实际执行资源：

1. 校验同一请求内的目标不可共享 `concurrencyKey`。
2. 扫描内存任务表，拒绝已经存在活动任务的执行资源。
3. 创建的任务在第一次异步让出执行权前同步登记到内存任务表。
4. 同一 `TaskManager` 收到两个并发 `start()` 调用时，先执行到登记步骤的调用占用资源，后续调用观察到该活动任务并收到 `TARGET_BUSY`。

本任务保证单服务进程、单 `TaskManager` 实例内的串行执行。多进程部署需要共享锁服务，属于范围外能力。

## 测试设计

- 组件测试覆盖自动绑定行无 checkbox、信息与忙碌状态完整。
- 组件测试覆盖多目标行仍有可操作 checkbox。
- 纯状态测试继续覆盖唯一目标自动选择及多目标不自动选择。
- `TaskManager` 测试用 `Promise.allSettled()` 同时启动两个共享 `concurrencyKey` 的请求，断言一个成功、一个 `TARGET_BUSY`，并检查活动任务数量为一。
- 执行定向测试后运行 lint、typecheck 和全量测试。

## 兼容与回滚

- API 请求和响应结构保持不变，无迁移步骤。
- 单目标 UI 可独立回滚，后端互斥契约和并发测试仍可保留。
- 若并发测试暴露登记时序缺口，修复范围限制在 `TaskManager` 的资源占用临界区，不扩展为等待队列。
