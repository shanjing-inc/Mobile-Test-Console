# 执行计划

1. 更新共享契约与服务端重试请求校验，增加 `targetPages` 互斥校验、Result Bundle 页面匹配和范围冻结。
2. 更新 Web ResultPanel：增加全部失败页面重试，区分当前页面、全部失败页面和整任务文案及 pending key。
3. 更新 TaskManager 重试 watchdog、取消/完成清理和超时失败日志，确保活动重试最终进入终态。
4. 校验 Runner SDK、Fanli Provider 与 QA 命令对 `targetPages` 的透传，补充页面范围回归测试。
5. 补充 API、任务管理器、Web 结果交互和 Fanli QA 命令测试，覆盖页面去重、空范围、整任务兼容、超时和停止恢复。
6. 执行质量门禁：
   - `pnpm exec tsc --noEmit`
   - `pnpm exec eslint src tests`
   - `pnpm exec vitest run tests/app.test.ts tests/task-manager.test.ts tests/web-results.test.ts tests/runner-sdk.test.ts tests/project-provider-command-runner.test.ts`
   - Fanli 对应 QA 测试文件
7. 检查运行列表截图场景：页面重试只影响目标页面，超时/停止后来源行恢复操作按钮。

## 风险与回滚点

- `src/server/app.ts` 的请求兼容和结果匹配是第一回滚点；保留空 body 的整任务语义。
- `src/server/task-manager.ts` watchdog 涉及所有重试任务；先以测试 Runner 验证计时器清理，再接入实际命令。
- Web 入口修改只影响按钮和请求参数，结果合并逻辑保持不变。
- Fanli 目录位于相邻仓库，提交前分别确认两个仓库的变更边界。
