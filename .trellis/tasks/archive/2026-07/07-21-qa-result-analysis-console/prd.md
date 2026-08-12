# QA 测试结果分析控制台

## Goal

在现有本机 Node 测试控制台中增加 QA 结果分析能力，让测试人员从运行记录直接查看测试结论、截图、接口调用、请求参数、响应结果、动作链路和失败证据。

## What I Already Know

* Node 控制台位于同级独立项目 `../mobile-test-console`，当前提供设备发现、任务执行、状态、日志、停止和删除能力。
* 返利 QA 产物位于 `qa/history/artifacts/<run-id>/`，包含三端 summary、截图、runtime events、日志、UI hierarchy 和 diagnostics。
* `qa-lynx-test-report.cjs` 已输出 `qa.lynx.test-report.v1`，并归一化截图、UI 动作、API 调用、请求/响应预览、失败日志和证据文件。
* 现有 API 证据采用脱敏预览；完整请求/响应只有在证据生产端明确采集并完成脱敏时才能展示。
* 现有 `visual-device-test-dashboard` 任务已经完成控制台主体，本任务作为运行详情的结果分析扩展。
* Lynx MCP 文档索引当前返回 404，本任务以仓库现有 QA 报告协议为实现依据。

## Assumptions (Temporary)

* 结果详情按需读取，避免截图和大型 JSON 进入轮询快照。
* 通用控制台只消费标准结果协议；返利侧负责把现有三端产物转换成该协议。
* 结果页面保持本机回环访问，文件读取限制在配置声明的产物根目录。

## Open Questions

* 当前无阻塞问题。

## Requirements (Evolving)

* 运行记录详情增加“概览、截图、接口、日志/证据”结果视图。
* MVP 在测试进入终态后加载已经落盘的本地 QA 产物，不读取运行中的增量文件。
* 概览展示状态、平台、设备、页面、场景、耗时、失败摘要、缺失事件和证据数量。
* 截图以可查看原图的画廊展示，并标明文件名与所属用例。
* 接口列表展示时间顺序、方法、URL/operation、耗时、状态、请求参数预览和响应预览。
* JSON 请求与响应提供格式化、折叠和复制能力。
* 证据视图展示事件、动作、文件清单和脱敏失败日志摘要；原始证据文件首版不向页面提供下载。
* 结果缺失、部分损坏或仍在生成时显示明确状态，运行记录主体仍可使用。
* Node 服务通过任务 ID 读取结果，校验任务与 `runId` 的归属关系。
* 图片和附件只能从项目配置声明的产物根目录读取，并阻止路径穿越与符号链接越界。
* 请求、响应与日志延续现有脱敏规则，限制单项和单次响应大小。
* 返利项目复用 `qa-lynx-test-report.cjs` 的归一化能力，通用控制台不包含返利文件名或业务字段硬编码。

## Acceptance Criteria (Evolving)

* [x] 从一条有产物的运行记录可以打开结果分析视图。
* [x] 页面可以显示 Android、iOS、HarmonyOS 产物中的 PNG/JPEG 截图。
* [x] 页面按时间展示 API 方法、目标、耗时、状态、请求预览和响应预览。
* [x] JSON 内容格式化显示，长内容受大小限制，敏感字段保持脱敏。
* [x] 通过构造 `../`、绝对路径和符号链接验证附件接口拒绝越界读取。
* [x] 缺少 summary、截图或 runtime events 时返回部分结果，页面展示缺失说明。
* [x] `GET /api/snapshot` 不携带图片和大型结果正文。
* [x] 结果 API、附件 API、结果适配器和主要页面状态有回归测试。

## Definition of Done

* `mobile-test-console` lint、typecheck、测试与构建通过。
* 返利结果适配器测试覆盖三端 summary、截图和 API 证据。
* 使用内置浏览器验证真实运行记录的截图、接口请求和响应展示。
* 安全边界、脱敏规则和使用方式写入控制台与返利 QA 文档。

## Technical Approach (Provisional)

采用“项目结果提供器 + 通用控制台查看器”。返利配置声明产物根目录和受信任结果命令；结果命令按 `task.runId` 调用现有报告归一化逻辑并输出标准 JSON。Node 服务校验结果协议，通过独立结果 API 返回轻量元数据，并通过任务范围内的附件 API 流式提供图片与安全文件。Web 端在当前运行详情中增加标签页，按需加载结果。

建议 API：

```text
GET /api/tasks/:taskId/result
GET /api/tasks/:taskId/artifacts/:artifactId
```

结果中的附件使用稳定 `artifactId` 引用，服务端保存或重建 `artifactId -> 受限绝对路径` 映射，浏览器不接收本机绝对路径。

## Research References

* [`research/result-analysis-architecture.md`](research/result-analysis-architecture.md) — 推荐项目结果提供器与通用附件查看器结构。

## Decision (ADR-lite, Evolving)

**Context**: QA 结果数据是返利项目特定的，展示与安全读取能力适合复用到多个 App。

**Decision**: 返利负责产物归一化，通用控制台负责协议校验、任务授权、附件服务和结果 UI。

**Consequences**: 需要新增一个跨仓库结果协议；控制台保持通用，后续项目可实现自己的结果提供器。首版结果在任务终态后按需加载，运行中增量分析留作后续扩展。

## Out of Scope (Explicit)

* 公网部署、远程上传和多人共享。
* TLS 抓包或替代 Charles/Proxyman/mitmproxy 采集全量网络流量。
* 在控制台中修改或重放接口请求。
* 展示未经脱敏的 token、cookie、密码、手机号和 session 信息。
* 从页面直接查看或下载未经单独脱敏的原始日志与 JSON/JSONL 证据。
* 首期跨运行趋势、历史对比和失败聚类。
* 运行中实时读取增量截图、日志和接口事件。

## Technical Notes

* 现有归一化入口：`packages/lynx/scripts/qa/qa-lynx-test-report.cjs`。
* 现有证据解析：`packages/lynx/scripts/qa/qa-evidence.cjs`。
* 现有 API 摘要生产：`packages/lynx/src/utils/request-core.ts`。
* 控制台扩展点：`../mobile-test-console/src/server/config.ts`、`src/server/app.ts`、`src/shared/contracts.ts`、`src/web/App.tsx`。
* 标准结果协议：`mobile-test-console.task-result.v1`；返利适配器按控制台 `runId` 聚合完全匹配和 `${runId}-*` 目录。
* 服务端默认按终态任务指纹缓存结果，`GET /api/tasks/:taskId/result?refresh=1` 强制重新执行结果提供器。
* 浏览器验收记录：Harmony 历史任务包含 5 个用例、4 张 `1256x2760` 截图、46 次接口调用，请求与响应 JSON 展示和复制功能正常，`390x844` 视口无横向溢出。
* HTTP 实测记录：另一条真实结果包含 6 个用例、6 张截图、22 次接口调用，PNG 附件响应大小为 1,532,493 字节。
* 自动化验收记录：控制台 `pnpm check` 通过 10 个测试文件、38 项测试；返利 Lynx QA 测试通过 100 项。
