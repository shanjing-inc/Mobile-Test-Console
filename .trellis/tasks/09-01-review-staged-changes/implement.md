# 执行计划

- [x] 在 `TaskManager` 中增加按任务串行化的终态提交 Promise。
- [x] 将重试停止与重试超时的 Runner 取消改为尽力调用，终态提交不等待取消 Promise。
- [x] 让 `StateStore` 写队列在单次失败后恢复并允许后续保存。
- [x] 补充取消挂起、取消抛错、超时与 Runner 返回竞争、单次完成通知测试。
- [x] 提取失败页面去重纯函数，让结果页复用并添加直接回归断言。
- [x] 更新 `.gitignore`，从 Git 索引移除示例 Android 构建报告并保留本地文件。
- [x] 运行 `pnpm exec vitest run tests/task-manager.test.ts tests/web-results.test.ts`。
- [x] 运行 `pnpm lint`、`pnpm typecheck` 与 `pnpm test`。
- [x] 由独立 `trellis-check` 复核并发路径、测试有效性和暂存范围。

## 风险与回滚点

- 终态优先级依赖首个 `finalize()` 调用者；看门狗路径必须在触发取消后的同一同步栈中登记失败终态。
- 异步取消错误可能晚于终态产生，日志持久化需要保持安全且不可再次触发完成通知。
- Git 索引清理只作用于明确的构建报告路径。
