# 运行记录支持手动删除

## Goal

为移动端可视化测试控制台的“运行状态”列表增加手动删除能力，帮助用户清理已完成的历史记录，同时保留运行中任务的停止与状态保护。

## What I already know

* 控制台位于同级独立项目 `../mobile-test-console`，返利仓库通过 `qa/mobile-test.config.cjs` 提供测试配置。
* 当前运行记录由 `TaskManager` 保存在 `StateStore`，通过 `GET /api/snapshot` 返回前端。
* 前端 `RunRow` 已根据任务状态显示停止操作，详情面板跟随 focused task 展示日志。
* 用户确认支持手动删除；删除范围沿用已确认规则：终态记录可删除，运行中记录使用取消操作。

## Requirements

* 为任务 API 增加按任务 ID 删除的接口，删除成功后从内存列表和持久化状态中移除记录。
* 服务端只允许删除 `passed`、`failed`、`cancelled`、`interrupted` 终态任务；`queued`、`preparing`、`running` 返回明确业务错误。
* 删除未知任务返回现有统一错误格式和 `TASK_UNKNOWN` 错误码。
* 运行状态列表中的终态记录显示删除按钮，运行中记录继续显示停止按钮。
* 删除按钮执行二次确认，确认后刷新列表；被删除记录是当前详情时同步清空详情选择。
* 二次确认使用页面内弹窗，明确提示运行记录及匹配 `runId` 的本地测试文件会被删除。
* 项目配置可声明删除前清理命令；返利项目按 `task.runId` 清理 `qa/history/artifacts/` 下同名或同前缀产物。
* 本地文件清理失败时返回明确业务错误，并保留内存与 `state.json` 中的任务记录。
* API、任务管理器和前端交互增加回归测试，覆盖成功删除、运行中保护、未知任务和持久化结果。

## Acceptance Criteria

* [x] `DELETE /api/tasks/:taskId` 删除终态任务后，后续快照不再包含该任务。
* [x] 删除操作更新 `state.json`，服务重启后被删除记录不会恢复。
* [x] 删除活动任务返回业务错误，活动进程和任务状态保持不变。
* [x] 删除未知任务返回 HTTP 404 和 `TASK_UNKNOWN`。
* [x] 前端仅在终态行显示删除入口，确认取消不会发起请求，删除当前 focused task 后详情面板关闭。
* [x] 删除成功后立即从本地快照移除记录，并过滤并发轮询返回的旧记录。
* [x] 开发模式服务端热更新复用顶层生命周期 owner，避免重型 prepare/cleanup 造成删除请求连接失败。
* [x] 重复执行开发命令时在 lifecycle startup 前检测 4310/4311；健康实例提示复用并成功退出，其他端口占用返回错误。
* [x] `mobile-test-console` 的 lint、类型检查和测试通过。
* [x] 删除返利运行记录时同步移除匹配 `runId` 的本地产物，其他运行产物保持不变。
* [x] 页面内确认框可取消或确认删除，确认成功后刷新页面和服务重启均不会恢复记录。
* [x] 本地文件清理失败时任务记录保持可见，接口返回 `TASK_DELETE_CLEANUP_FAILED`。

## Definition of Done

* 后端、前端和共享契约完成实现。
* 单元测试与 HTTP API 测试覆盖新增行为。
* 运行 `pnpm check`（或项目等效检查命令）并记录结果。
* 用户可从现有控制台页面完成终态运行记录清理。

## Technical Approach

在 `TaskManager` 增加 `delete(taskId)` 方法，复用现有活动状态集合进行终态校验，先执行可选的 `taskDeletion.cleanup` 命令，再删除任务并调用现有 `persistNow()`。在 Fastify 增加 `DELETE /api/tasks/:taskId` 路由，返回 `{ task }` 以保持 API 响应风格。返利配置通过 `{{task.runId}}` 调用 `delete-run`，限定清理 `qa/history/artifacts/` 下同名或 `${runId}-` 前缀条目。前端 API 层封装删除请求，`RunRow` 为终态任务渲染删除按钮，页面层使用页面内确认框；接口成功后立即过滤本地快照并记录已删除 ID，避免设备发现耗时或并发旧快照延迟、回退删除反馈。

## Decision (ADR-lite)

**Context**: 运行记录会持续累积，用户需要清理失败、取消和通过记录；活动任务仍由停止流程管理。

**Decision**: 采用服务端按任务 ID 的删除接口，服务端拒绝活动状态并在持久化删除前执行项目清理命令，前端对终态记录提供页面内确认后删除。

**Consequences**: 删除立即生效并从持久化文件移除；日志、详情和匹配 runId 的本地产物一起删除；清理失败时记录保留并显示错误；后续可在此接口上增加批量删除或保留策略。

## Out of Scope

* 批量删除、按时间筛选删除和自动保留策略。
* 删除运行中任务并隐式停止进程。
* 恢复已删除记录或额外的回收站存储。

## Technical Notes

* 目标代码位于同级项目 `../mobile-test-console/src/server/task-manager.ts`、`src/server/app.ts`、`src/shared/contracts.ts`、`src/web/api.ts`、`src/web/App.tsx` 和对应 `tests/`。
* 返利侧集成契约见 `.trellis/spec/backend/mobile-test-console-integration.md`。
* Lynx 文档资源 `lynx-docs://llms.txt` 当前返回 404 页面；本任务沿用仓库已有控制台集成契约和测试模式。
* 现场日志显示 `tsx watch` 热重启等待项目 cleanup 超过 5 秒后强杀进程，新进程又在监听 4310 前执行 Lynx prepare，期间删除请求收到 `ECONNREFUSED`。开发启动器现以稳定父进程 PID 执行一次 prepare/cleanup，热更新子进程跳过生命周期。
* 最终浏览器复现显示空 `DELETE` 请求携带 `Content-Type: application/json`，Fastify 在路由前返回 `FST_ERR_CTP_EMPTY_JSON_BODY`。请求帮助函数现仅为存在请求体的调用设置 JSON 内容类型，并由回归测试覆盖两侧行为。
