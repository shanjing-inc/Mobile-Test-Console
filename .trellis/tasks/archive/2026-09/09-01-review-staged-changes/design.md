# 技术设计

## 边界与不变量

- `TaskManager` 是任务终态、持久化顺序和完成通知的唯一所有者。
- 每个任务只允许一个终态提交过程；后续终态请求等待该过程并接受首个结果。
- Runner 的 `abort` 与 `cancel()` 是执行资源清理信号，任务终态提交不依赖取消 Promise 完成。
- 完成监听器只在终态成功持久化并写回内存后执行一次。

## 终态串行化

新增按任务 ID 保存的终态 Promise。`finalize()` 在任何异步操作前同步登记首个提交过程；并发调用复用同一 Promise。提交过程继续保持现有顺序：构造终态快照、持久化、写回内存、通知监听器。

该设计保留持久化失败时的重试能力：失败 Promise 从映射移除，任务内存状态继续保持活动态，后续调用可以再次提交。

`StateStore` 的串行写队列只向当前调用者传播本次写入错误，内部队列随后恢复为可继续调度的状态，保证后续保存具备真实重试能力。

## 取消数据流

```text
人工停止 / 看门狗触发
  -> 标记取消请求与阶段日志
  -> abort Runner signal
  -> 发起尽力 cancel()，同步或异步错误写入日志
  -> 立即提交 cancelled / failed 终态
  -> 清理 TaskManager 的 Runner 引用
```

看门狗先登记 `failed` 终态提交，再允许 Runner 返回路径处理取消结果，因此超时失败拥有确定优先级。人工停止在看门狗已经取得所有权时复用同一终态 Promise。

## 页面去重

在 `result-analysis.ts` 增加纯函数，按首次出现顺序返回失败运行的唯一 `targetPage`。`ResultPanel` 使用该函数，测试直接覆盖重复页面输入与唯一数组输出。

## 生成产物

`.gitignore` 忽略 `examples/com.shanjing.example/android/build/`。已跟踪的报告从 Git 索引移除，工作区构建文件可由 Gradle 继续管理。

## 兼容性与回滚

- 保持 `InProcessRunner`、HTTP API、任务持久化结构和 UI 文案不变。
- 回滚点集中在 `TaskManager` 终态串行化、`StateStore` 写队列恢复、结果分析辅助函数和构建目录跟踪四处。
