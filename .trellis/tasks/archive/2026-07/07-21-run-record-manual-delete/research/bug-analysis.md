## Bug Analysis: 运行记录确认删除后刷新恢复

### 1. Root Cause Category

- **Category**: B - Cross-Layer Contract, D - Test Coverage Gap, E - Implicit Assumption
- **Specific Cause**: 删除能力横跨页面交互、Vite 代理、API 进程、`TaskManager`、`state.json` 和项目产物目录。最终阻断删除的直接原因是共享请求帮助函数给空 `DELETE` 请求附加了 `Content-Type: application/json`，Fastify 在进入删除路由前抛出 `FST_ERR_CTP_EMPTY_JSON_BODY`。开发模式的 lifecycle 热重载和端口冲突同时造成过 `ECONNREFUSED`，返利测试产物也需要按 `task.runId` 执行项目侧清理。

### 2. Why Fixes Failed

1. **增加删除按钮**: 页面具备操作入口，服务端持久化契约和实际请求可达性仍缺少验证。
2. **增加 API 与原生确认框**: 单元测试覆盖了删除方法，开发模式的 lifecycle 热重载和端口占用仍会中断实际请求。
3. **立即过滤前端快照**: 页面反馈变快，`state.json` 与本地测试产物仍需要由服务端形成原子顺序。
4. **重启 API 并确认配置**: 排除了旧配置与进程空窗后，真实浏览器请求仍失败；增加服务端未知异常堆栈后定位到空 JSON 请求头在路由前被拒绝。

### 3. Prevention Mechanisms

| Priority | Mechanism | Specific Action | Status |
| --- | --- | --- | --- |
| P0 | Architecture | 稳定父进程持有 lifecycle，watch 子进程只重载 HTTP 服务 | DONE |
| P0 | Runtime | 启动前探测 4310/4311，健康实例直接复用，其他占用返回退出码 2 | DONE |
| P0 | Cross-layer contract | `DELETE /api/tasks/:taskId` 在项目清理成功后更新内存和 `state.json` | DONE |
| P0 | Error handling | 清理失败返回 `TASK_DELETE_CLEANUP_FAILED` 并保留任务记录 | DONE |
| P0 | Request contract | 仅在请求体存在时设置 `Content-Type: application/json` | DONE |
| P1 | Test coverage | 覆盖配置 token、清理成功/失败、持久化恢复、旧快照过滤和页面内确认框 | DONE |
| P1 | Browser verification | 在真实 4311 页面验证删除、产物清理、页面刷新和服务重启后的持久化结果 | DONE |

### 4. Systematic Expansion

- **Similar Issues**: 空 `POST` 停止请求与空 `DELETE` 请求共享同一请求帮助函数；任何项目级启动/关闭命令都可能因 watch 子进程重启造成服务空窗；任何跨目录删除都需要由项目配置提供明确清理边界。
- **Design Improvement**: 控制台负责通用任务状态，项目通过受信任的命令配置负责业务产物。删除顺序固定为校验终态、清理项目文件、更新内存、持久化状态、返回响应。
- **Process Improvement**: 删除类功能的验收同时检查 UI、HTTP、内存、磁盘状态和服务重启结果，并在开发模式实际端口上执行浏览器验证。

### 5. Knowledge Capture

- [x] 更新 `.trellis/spec/backend/mobile-test-console-integration.md` 的删除清理签名、错误矩阵、测试断言和顺序示例。
- [x] 更新任务 PRD 的本地文件清理和页面内确认要求。
- [x] 增加返利 `delete-run` 隔离测试与控制台跨层回归测试。
