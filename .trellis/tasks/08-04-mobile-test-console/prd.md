# 排查 Mobile Test Console 初始化耗时

## Goal

缩短 Mobile Test Console 首次打开及持续刷新时的可感知等待，重点解决设备列表和运行状态列表获取耗时过长，同时保持设备状态、任务状态与页面能力数据的正确性。

## What I already know

* Web 端 `App.tsx` 在首次渲染以及每 1 秒调用一次 `load`。`load` 并行请求 `/api/snapshot` 和 `/api/account-profiles`。
* `/api/snapshot` 每次请求都会调用 `DeviceDiscoveryService.discover()`，并串接 Android/Harmony 厂商查询、iOS `simctl`、`devicectl`、`xcodebuild -showdestinations` 以及设备准备项检查。
* `DeviceDiscoveryService.discover()` 对每个在线 Android/Harmony 设备执行额外 shell 命令，对每个匹配设备执行准备项 `check` 命令。
* 运行状态（tasks/repairJobs）和设备发现共用 `/api/snapshot`，因此任务状态轮询会重复触发完整设备发现。
* `CommandRunner.capture` 默认超时 15 秒，iOS 工程目标查询允许 120 秒，单次请求可能被最慢平台命令拖住。

## Assumptions (temporary)

* 设备状态变化频率低于任务状态变化频率，设备数据可以短时间缓存并在显式刷新或设备操作后失效。
* 运行状态需要继续支持约 1 秒级更新。
* 当前任务允许直接修改 sibling `../mobile-test-console` 项目并补充测试。

## Open Questions

* 已确认接受设备列表在后台刷新期间短暂显示上一次快照。

## Requirements (evolving)

* 将设备发现从高频运行状态轮询路径中解耦，避免每秒重复执行外部设备命令。
* 为设备发现增加可控缓存/并发合并机制，首个请求共享同一次 discovery，后续请求复用近期结果。
* 保留显式设备刷新、设备启动、准备项安装后的准确重查。
* 运行状态列表保持及时更新，接口响应应能快速返回。
* 增加针对缓存命中、并发请求合并、失效重查和 snapshot 响应行为的测试。

## Acceptance Criteria (evolving)

* [x] 连续请求 `/api/snapshot` 不会每次都执行完整设备发现命令。
* [x] 多个并发 discovery 调用只产生一个底层平台发现流程。
* [x] 设备启动或准备项安装完成后，下一次读取能获得新的设备状态。
* [x] 任务/运行状态轮询不等待不必要的 iOS `xcodebuild`、Android/Harmony 厂商检查。
* [x] 相关单元测试及 `pnpm check` 通过。

## Definition of Done (team quality bar)

* Tests added/updated (unit/integration where appropriate)
* Lint / typecheck / CI green
* Docs/notes updated if behavior changes
* Rollout/rollback considered if risky

## Out of Scope (explicit)

* 改变设备选择、任务调度、外部命令参数及设备状态语义。
* 重写 Mobile Test Console 前端视觉结构。

## Technical Notes

* 主要文件：`../mobile-test-console/src/server/devices.ts`、`../mobile-test-console/src/server/app.ts`、`../mobile-test-console/src/web/App.tsx`、相关 `tests/devices.test.ts` 与 `tests/app.test.ts`。
* 设备发现瓶颈集中在 iOS 工程兼容性查询和每设备准备项检查；状态轮询频率由 `App.tsx` 的 `setInterval(..., 1_000)` 控制。
* 新增故障证据：Codex App Server 完成 turn 后，控制台立即对整个进程发送 `SIGTERM`，子进程 `close` 事件得到 `code=null`，最终错误显示为“Codex 工作台退出码: unknown”。真实日志同时存在 ChatGPT/MCP 认证失败与远程 MCP 403，导致 App Server 进程提前退出。
* 修复策略：turn 完成后先关闭 stdin 等待 App Server 以 code 0 退出，仅在 2 秒后仍未退出时发送 SIGTERM；修复工作台启动时关闭项目级远程 MCP，避免失效认证配置让代码修复进程崩溃。
* 设备快照采用 30 秒内存缓存。默认 `/api/snapshot` 在无缓存时立即返回空设备集合并后台发现，缓存过期时返回旧快照并后台刷新；`?refresh=1` 等待最新结果。设备启动和准备项安装成功后使缓存失效。
