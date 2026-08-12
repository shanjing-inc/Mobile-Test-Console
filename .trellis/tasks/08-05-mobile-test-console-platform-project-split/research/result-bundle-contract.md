# Research: Result Bundle / Test Result Ingestion Contract

- Query: 研究通用测试结果 Bundle 与 ingestion 协议，比较 Allure、JUnit/Open Test Reporting、ReportPortal、OpenTelemetry/OTLP，并映射到 App 与小程序测试分析平台。
- Scope: mixed（Fanli 与 sibling Mobile Test Console 内部代码 + 外部标准文档）
- Date: 2026-08-05

## Findings

### 1. 内部代码与现有约束

| 文件 | 观察 |
| --- | --- |
| `.trellis/tasks/08-05-mobile-test-console-platform-project-split/prd.md:29-39,80-102` | 目标协议要求 `target.kind = app \| mini-program`、`platform/runtime/appId/environment/runId/caseRunId`、步骤、断言、日志、网络、截图、录屏、文件摘要、幂等、重试、版本协商、脱敏和旧协议兼容。迁移顺序从 schema/兼容导入开始，再抽取核心服务和 runner。 |
| `.trellis/spec/backend/mobile-test-console-integration.md:407-503` | 现有 provider 是终态任务读取模型：`mobile-test-console.task-result.v1`；provider JSON 最大 16 MiB、30 秒超时、根 `runId` 必须匹配任务；服务端按 task fingerprint 缓存，`refresh=1` 强制重读；附件要求真实路径位于 `artifactsRoot` 下，公开对象只含 opaque ID、MIME、大小。 |
| `src/server/task-results.ts:18-114,136-225` | Zod schema 已有 `runs[]`、`caseRunId`、`assertions`、`passBasis`、`apiCalls`、`screenshots`、`evidenceFiles`、`failureLogExcerpt` 与 `preconditions[]`；服务端重新计算 counts，并丢弃跨任务 run 和越界/缺失/不支持格式图片。 |
| `src/shared/contracts.ts:108-194` | 共享类型对截图附件采用 `{id,label,mimeType,sizeBytes}`，API 事件保留请求/响应和 DNS/connect/protocol 信息；`TaskResultPrecondition` 细分 passed/failed 及 action。 |
| `../fanli/packages/lynx/scripts/qa/qa-mobile-test-console.cjs:509-597` | Fanli adapter 按 `runId` 或 `runId-*` 目录聚合 summary，生成旧协议结果；正式 case run 的统计排除 setup/preflight 目录，录屏和截图当前在 adapter 边界转为绝对路径，随后由 console hydrate。 |
| `../fanli/qa/mobile-test.config.cjs:68-78` | Fanli 通过本地 Node provider 以 `--run-id` 与 `--artifacts-root` 读取结果，项目根目录负责业务产物布局。 |

内部结论：Result Bundle 应成为 runner/项目适配器到平台核心的稳定边界，平台核心消费规范化事件和 URI，项目适配器负责把 Fanli/Lynx 原始 summary、preflight、截图、录屏和 API 事件转换为规范字段。兼容期保留旧 provider 与新 Bundle 双读或双写。

### 2. 外部协议对比

| 协议/版本（截至 2026-08-05） | 数据粒度与摄取 | 稳定身份、历史、重试 | 步骤/证据/指标 | 可复用约定与边界 |
| --- | --- | --- | --- | --- |
| **Allure 2/3 result format** | 本地结果目录中每个测试一个 `{uuid}-result.json`；附件独立为 `{uuid}-attachment.ext`，报告生成器扫描目录。Allure 3 可将历史写入单个 JSONL 文件。 | `uuid` 是本次结果唯一 ID；`historyId` 由测试全名与非 excluded 参数稳定计算，用于跨 launch history；同一 historyId 的多次文件在一次 launch 中显示 retries。 | `steps[]` 可递归嵌套；每个 test/step 有 status、stage、start/stop、statusDetails；attachments 带 name/source/type；labels、links、parameters 支持导航、脱敏（masked/hidden）和自定义元数据。 | 适合离线 Bundle 和丰富 UI 详情；身份与参数规范值得采纳。其目录扫描和报告生成模型缺少服务端幂等 ACK，需外层 ingestion manifest。 |
| **JUnit Platform Open Test Reporting 1.9 / legacy XML** | JUnit Platform 当前同时生成 Open Test Reporting（事件型、整次执行单 XML）和 legacy XML（每个 root 一个 XML）；输出目录可配置，支持 socket 事件流。legacy XML 是 Ant/JUnit 4 生态的事实标准。 | Open Test Reporting 使用测试引擎 unique ID、容器层级和 execution events；legacy XML 依赖 suite/classname/name 组合，跨工具 dialect 差异显著。 | Open 格式能表达层级、display name、tags、stdout/stderr；legacy 常见 `<testsuite>/<testcase>/<failure|error|skipped>`，附件通常靠工具约定嵌入 `system-out`。 | 适合作为低门槛导入/导出格式和 CI 互操作层；平台内部应采用 JSON schema 以承载移动端网络、视频和 capability，JUnit XML 作为 adapter 输入输出。 |
| **ReportPortal Reporting API（v1）** | 通过 HTTP 生命周期摄取：start launch → start root/container/test/step item → post logs（可带 multipart attachment）→ finish item → finish launch。 | launch UUID、item UUID、parent item UUID 构成树；`uniqueId`、`parameters`、`retry`/`rerunOf` 支持跨运行识别和重试；launch status 可由 child items 计算。 | Item type 支持 suite/story/test/scenario/step 和 fixture；attributes、description、parameters、issue（含外部工单）用于分析；日志拥有 level、time、item/launch 归属和附件。 | 适合服务端实时 push、层级展开、日志流和缺陷聚类；多次 HTTP 调用需要客户端 outbox、幂等键和断点恢复，平台本地文件导入可先生成相同层级再批量提交。 |
| **OpenTelemetry OTLP 1.11（trace/metric/log stable）+ semconv 1.44** | OTLP 使用 protobuf over gRPC 或 protobuf/JSON over HTTP 的 Export 请求；支持批量、并发、压缩、部分成功响应和重试语义；trace、metric、log 是通用 telemetry 信号。 | `trace_id/span_id/parent_span_id` 关联事件；Resource 与 attributes 记录 service、device、CI/CD 等上下文；协议承认中间 Collector 的端到端交付由系统自行保证。 | Span 的 events/attributes/status 适合步骤、网络请求和运行时事件；Log 可携带 trace/span ID；测试语义约定提供 `test.case.name`、`test.case.result.status`（pass/fail）、`test.suite.name`、`test.suite.run.status`；CI/CD span 提供 pipeline/task result、run ID、error.type。 | 适合作为实时遥测底座和跨组件关联层，移动测试领域状态、附件索引、history/retry、业务断言仍需 Result Bundle 领域 schema。采用 OTLP correlation IDs 与 Resource 属性可复用观测基础设施。 |

#### 2.1 Allure 可复用字段

Allure 官方 `Test result file` 文档定义单测试 JSON，核心字段为：`uuid`、`historyId`、`testCaseId`、`fullName`、`name`、`links[]`、`labels[]`、`parameters[]`、`status`、`statusDetails`、`stage`、`start`、`stop`、递归 `steps[]`、`attachments[]`。参数 `mode=masked|hidden` 和 `excluded=true` 提供公开值与历史 key 的分离；附件对象只在结果中引用 source，内容单独存文件。

官方参考：[Test result file](https://allurereport.org/docs/how-it-works-test-result-file/)、[Container file](https://allurereport.org/docs/how-it-works-container-file/)、[History and retries](https://allurereport.org/docs/history-and-retries/)。

对移动平台的取舍：采用 `historyId` 的稳定身份思想，改名为平台中立的 `historyKey`；保留 `step` 递归结构与附件引用；将 `statusDetails` 拆成安全的 `message`、`traceRef`、`failure.kind`，禁止把原始 token、session 或主机路径放进默认结果。

#### 2.2 JUnit/Open Test Reporting 可复用字段

JUnit Platform 文档说明 `junit-platform-reporting` 同时提供事件型 Open Test Reporting 与 legacy XML。Open 格式覆盖层级测试结构、display name、tags、stdout/stderr；可写文件 `open-test-report.xml`，也可通过 socket 发送事件。legacy 格式兼容 Ant 生态的事实标准，跨工具导入面广，字段常见为 suite/class/testcase、duration、failure/error/skipped 和输出流。

官方参考：[JUnit Platform Reporting](https://github.com/junit-team/junit5/blob/main/documentation/modules/ROOT/pages/advanced-topics/junit-platform-reporting.adoc)、[Open Test Reporting XSD](https://github.com/junit-team/junit5/blob/main/junit-platform-reporting/src/main/resources/org/junit/platform/reporting/open/xml/junit.xsd)。

对移动平台的取舍：Result Bundle 导入器应支持 JUnit legacy XML 和 Open Test Reporting XML 的最小映射（suite/testcase、status、timestamps、stdout/stderr、failure）；XML dialect 字段进入 `extensions.junit`，规范化字段进入 `cases[]`/`steps[]`，确保 App 与小程序 runner 可采用不同测试框架。

#### 2.3 ReportPortal 可复用字段

ReportPortal 官方开发者指南规定实时上报顺序和树结构：先创建 launch，再按父子关系创建 suite/container/test/step item，运行中写 log/attachment，结束时依次 finish item 与 launch。Launch 支持 `uuid`、`startTime`、`attributes`、`mode`、`rerun`、`rerunOf`；Item 支持 `uuid`、`launchUuid`、`type`、`parentItemUuid`、`attributes`、`codeRef`、`parameters`、`uniqueId`、`retry`；finish 支持 status、issue、external ticket；log 支持 level、时间和附件。

官方参考：[Reporting developers guide](https://github.com/reportportal/docs/blob/develop/docs/developers-guides/ReportingDevelopersGuide.md)。

对移动平台的取舍：把 `launchUuid` 对应 `run.runId`，`item.uuid` 对应 `caseRunId`/`stepId`，`parentItemUuid` 对应 `parentStepId`；摄取层支持事件流和批量 Bundle 两种入口。为 HTTP 重试增加 `eventId`/`idempotencyKey`，服务端以 `(projectId,runId,eventId)` 去重；finish 具备可重复提交语义；缺失父节点、迟到日志和部分成功进入 warnings/dead-letter。

#### 2.4 OpenTelemetry/OTLP 可复用字段

OTLP 规范定义 `Export` 请求、gRPC/HTTP 传输、protobuf/JSON 编码、gzip 压缩、批量与并发、partial success 和 retryable response；trace/metric/log 信号状态为 Stable（OTLP 文档 1.11）。Semantic Conventions 1.44 的 Test 属性包括：`test.case.name`、`test.case.result.status`（well-known `pass|fail`）、`test.suite.name`、`test.suite.run.status`（`success|failure|skipped|aborted|timed_out|in_progress`）。CI/CD spans（Release Candidate）提供 `cicd.pipeline.result`、`cicd.pipeline.task.name`、`cicd.pipeline.task.run.id`、`cicd.pipeline.task.run.result` 和条件 `error.type`。

官方参考：[OTLP specification](https://github.com/open-telemetry/opentelemetry-proto/blob/main/docs/specification.md)、[Test attributes](https://opentelemetry.io/docs/specs/semconv/registry/attributes/test/)、[CI/CD spans](https://opentelemetry.io/docs/specs/semconv/cicd/cicd-spans/)。

对移动平台的取舍：每个 Bundle 写入可选 `telemetry` 段或独立 OTLP sidecar；所有日志、网络请求、设备事件和步骤带 `traceId/spanId`，并在 case/step 上设置 `test.*` 属性。OTLP `Resource` 承载 project/target/device/runtime，便于跨 App、小程序和 runner 查询；Result Bundle 继续拥有断言、附件清单、history/retry 与安全策略等领域字段。

### 3. 通用 Result Bundle 建议契约

#### 3.1 Envelope 与身份

```json
{
  "schemaVersion": "test-analysis.run.v1",
  "bundleId": "bundle-uuid",
  "project": { "id": "fanli", "name": "返利 App" },
  "target": {
    "kind": "app",
    "platform": "ios",
    "runtime": "lynx",
    "appId": "com.example.fanli",
    "version": "9.1.0",
    "capabilities": ["install", "screenshot", "recording", "network"]
  },
  "run": {
    "runId": "console-task-run",
    "attemptId": "attempt-01",
    "status": "passed",
    "environment": "qa",
    "startedAt": "2026-08-05T09:00:00Z",
    "finishedAt": "2026-08-05T09:08:00Z",
    "historyKey": "sha256:...",
    "retryOf": null
  },
  "cases": [],
  "artifacts": [],
  "telemetry": { "traceId": "...", "spans": [], "logs": [] },
  "provenance": {
    "runner": "fanli-qa-adapter",
    "runnerVersion": "...",
    "sourceRevision": "git-sha",
    "generatedAt": "2026-08-05T09:08:01Z"
  },
  "extensions": {}
}
```

字段要求：

- `schemaVersion` 采用平台中立 namespace 与显式主版本；解析器按主版本协商，保留未知字段到 `extensions`。
- `bundleId` 标识一次摄取文件；`run.runId` 与控制台 task run 一一对应，重试使用新的 `attemptId` 和 `retryOf`；重复提交同一 `bundleId` 或 `(projectId,runId,eventId)` 返回幂等成功。
- `target.kind` 只取 `app|mini-program`；平台、runtime、appId/packageName、版本、设备和能力进入同一 target 结构，业务差异放入 `target.extensions`。
- `historyKey` 由稳定 case identity、非敏感参数、target 版本策略计算；账号 token、session、临时路径和时间戳进入 excluded/masked 参数或 `secretRef`，不参与历史 key。

#### 3.2 Case、步骤、断言

```json
{
  "caseId": "lynx.page.home.open",
  "caseRunId": "console-task-run-case-001",
  "name": "打开首页",
  "suite": "smoke",
  "status": "failed",
  "statusDetails": { "message": "lynx_page_ready 未出现" },
  "startedAt": "2026-08-05T09:01:00Z",
  "finishedAt": "2026-08-05T09:01:12Z",
  "parameters": [{ "name": "environment", "value": "qa", "visibility": "public" }],
  "steps": [
    {
      "stepId": "step-1",
      "name": "导航到首页",
      "status": "passed",
      "startedAt": "...",
      "finishedAt": "...",
      "events": ["lynx_page_opened", "lynx_page_ready"],
      "assertions": []
    }
  ],
  "assertions": [
    { "assertionId": "page-ready", "status": "failed", "kind": "event", "expected": "lynx_page_ready", "actual": null }
  ],
  "failure": { "kind": "precondition|assertion|infrastructure|timeout", "message": "...", "traceRef": "artifact:log-1" },
  "evidenceRefs": ["artifact:screenshot-1", "artifact:recording-1"]
}
```

- `caseId` 是测试定义的稳定 ID；`caseRunId` 是一次执行实例，满足 repair、重试和下钻的精确寻址。
- `status` 采用统一枚举：`passed|failed|skipped|blocked|cancelled|aborted|timeout|infra_error|unknown`；`failure.kind` 将前置条件、断言、设备/runner、超时分层，便于诊断和 repair policy。
- `steps[]` 递归支持 page/scenario/action/API/fixture；每步必须有稳定 `stepId`、状态、时间，事件详情通过 `eventRefs` 或 telemetry span 关联。
- `assertions[]` 保留预期、实际、比较器、状态和脱敏值；平台统计以断言和 case 状态为准，runner 原始 `passBasis` 进入扩展字段。

#### 3.3 Artifact 与安全

```json
{
  "artifactId": "screenshot-1",
  "kind": "screenshot",
  "uri": "artifacts/cases/case-001/screenshot.png",
  "mimeType": "image/png",
  "sizeBytes": 183244,
  "sha256": "...",
  "createdAt": "...",
  "retention": "run",
  "visibility": "project",
  "metadata": { "width": 1170, "height": 2532, "orientation": "portrait" }
}
```

- Bundle 只传稳定 URI/相对路径、MIME、大小、SHA-256、媒体元数据；宿主绝对路径留在 adapter，公开 API 用 opaque artifact ID。
- 允许 `screenshot|recording|log|network|trace|stdout|stderr|file|har|video` 等 kind；大文件支持外部 `uri` + `digest`，HTTP 上传使用预签名/分块句柄。
- 导入器先解析真实 artifact root，再做 `realpath` containment、常规文件检查、扩展/MIME 白名单和大小上限；符号链接逃逸、越界、缺失和不支持格式成为 warning/dead-letter。
- 默认结果只展示脱敏预览；request/response、账号 UID、token、session_key、authorization code 通过 allowlist、mask 或 `secretRef` 处理。

#### 3.4 Telemetry 与关联

- 每个 case/step 可附 `traceId`、`spanId`、`parentSpanId`；网络请求、页面事件、设备连接、构建安装和 runner 日志用 span/event/log 表达。
- OTLP Resource 建议字段：`service.name`（runner）、`service.version`、`deployment.environment.name`、`device.id`（脱敏）、`device.model`、`os.name`、`os.version`、`test.case.name`、`test.suite.name`、`test.case.result.status`。
- Bundle 的规范化 `network[]` 保留 method/url/host/path/status/result/durationMs/protocol 等现有字段；原始 OTLP payload 可通过 `telemetryRef` 关联，避免重复存储。
- 指标按 run/case 聚合：duration、pass/fail/skip、retryCount、stepCount、assertionCount、apiFailureCount、eventMissingCount、artifactCount、devicePrepFailureCount。

#### 3.5 摄取与生命周期

推荐同时提供两条入口：

1. **本地文件导入**：目录或 zip 包含 `manifest.json`（Bundle 元数据、文件清单、schemaVersion、sha256）和 `result.json`/JSONL；导入先校验 manifest digest，再原子写入 run、case、artifact 索引。适合现有本地 QA 和离线小程序开发工具。
2. **HTTP push/事件流**：`POST /api/v1/runs` 接收完整 Bundle；`POST /api/v1/runs/{runId}/events` 接收分块事件；`POST /api/v1/runs/{runId}/artifacts` 接收附件或外部 URI；`POST /api/v1/runs/{runId}/finish` 关闭运行。每个请求携带 `Idempotency-Key`，响应返回 accepted/rejected/warnings 和已落库 cursor。

摄取状态建议为 `accepted|partial|rejected|duplicate|quarantined`，错误分为 schema、identity、authorization、artifact、transport、runner 五类。分块事件允许乱序到达：服务端按 `eventId` 去重、按 `sequence` 排序，finish 之前保持可追加，finish 之后迟到事件进入补录窗口并触发版本递增。

与现有 console 对齐的初始限制：保留 16 MiB provider JSON、30 秒本地 provider timeout 作为兼容模式；新 HTTP 入口采用可配置 Bundle/attachment 限制、压缩和分块。结果读取默认使用 `(projectId,runId,finishedAt,status)` fingerprint 缓存，`refresh=1` 或 `revision` 参数触发重新索引。

#### 3.6 版本、兼容与未知字段

- 主 schema `test-analysis.run.v1` 只在破坏性变更时升级；可加字段保持向后兼容，解析器必须保存未知字段。
- `acceptedSchemaVersions[]`、`capabilities[]` 和 `extensions` 参与版本协商；adapter 同时输出旧 `mobile-test-console.task-result.v1` 与新 Bundle，平台通过 feature flag 切换读取路径。
- 旧 `runId`/`caseRunId`、screenshots、recording、apiCalls、preconditions 字段做确定性转换；转换过程写 `provenance.transformedFrom` 与 warning，确保回滚可追溯。
- `schemaVersion`、run identity、status、timestamps、case IDs、artifact digest 是强校验字段；业务 labels、custom events、vendor fields 放到 namespaced `extensions`。

### 4. App 与小程序场景映射

| 统一字段 | App（Android/iOS/HarmonyOS） | 小程序（微信/支付宝/字节等） |
| --- | --- | --- |
| `target.kind` | `app` | `mini-program` |
| `target.platform` | `android|ios|harmony`；`appId` 为 bundle/package 名 | 平台名；`appId` 为小程序原始 appId，另存 `hostAppId`/开发者工具项目 ID |
| `target.runtime` | `native|lynx|webview`，Fanli 使用 `lynx` | `mini-program-runtime`、基础库/宿主版本、开发者工具或真机运行时 |
| 设备身份 | `device.id/model/os/version`、连接器 capability（install、recording、network） | `device` + `host`（宿主 App）、模拟器/开发者工具 session、授权/登录 capability |
| case identity | 页面/业务脚本/原生测试稳定 `caseId`；route/profile 作为参数 | 页面 path、分包、组件或业务流程稳定 `caseId`；query、scene、账号环境作为参数 |
| 运行证据 | screenshot、video、logcat/syslog、Maestro/adb/xcrun、HTTP/GraphQL API call | 页面截图/录屏、console log、网络请求、宿主桥接事件、开发者工具日志、包构建摘要 |
| 前置条件 | 设备连接、安装、登录/账号 profile、权限 | 宿主登录、二维码/授权、开发者工具连接、分包下载、基础库兼容性 |
| 能力声明 | `install`, `launch`, `replay`, `screenshot`, `recording`, `network`, `export` | `launch`, `replay`, `screenshot`, `recording`, `network`, `devtools`, `miniProgramAuth`, `export`；按 connector 渐进实现 |

统一查询维度采用 `project.id + target.kind + target.platform + target.runtime + run.environment + caseId + historyKey`；平台 UI 通过 capability 决定可用操作，业务参数编辑继续由项目插件提供。

### 5. 推荐的 MVP Bundle 示例（跨目标）

```json
{
  "schemaVersion": "test-analysis.run.v1",
  "bundleId": "b-20260805-001",
  "project": { "id": "demo", "name": "Demo" },
  "target": { "kind": "mini-program", "platform": "wechat", "runtime": "base-library-3.x", "appId": "wx123", "capabilities": ["screenshot", "network"] },
  "run": { "runId": "r-001", "attemptId": "a-001", "status": "failed", "environment": "staging", "startedAt": "2026-08-05T09:00:00Z", "finishedAt": "2026-08-05T09:00:20Z", "historyKey": "sha256:..." },
  "cases": [{
    "caseId": "home.open", "caseRunId": "r-001-c-001", "name": "打开首页", "status": "failed",
    "steps": [{ "stepId": "s1", "name": "navigate /pages/home", "status": "passed", "startedAt": "...", "finishedAt": "..." }],
    "assertions": [{ "assertionId": "ready", "status": "failed", "kind": "event", "expected": "page-ready", "actual": "timeout" }],
    "failure": { "kind": "timeout", "message": "page-ready 未在阈值内出现" },
    "evidenceRefs": ["artifact:screenshot-1"]
  }],
  "artifacts": [{ "artifactId": "screenshot-1", "kind": "screenshot", "uri": "artifacts/home.png", "mimeType": "image/png", "sizeBytes": 120000, "sha256": "..." }],
  "provenance": { "runner": "demo-mini-program-adapter", "runnerVersion": "0.1.0", "sourceRevision": "abc123", "generatedAt": "2026-08-05T09:00:21Z" }
}
```

### 6. 实施建议与契约测试

1. 先实现 JSON Schema/Zod 与 fixture：passed、assertion failed、precondition blocked、timeout、cancelled、partial artifact、duplicate bundle、unknown extension、App 与 mini-program 两个 target。
2. 写 `fanli-qa-adapter` 转换器，将旧 `TaskResultRun` 字段映射到 case/step/assertion/artifact/telemetry，并保留 `extensions.legacyTaskResult` 以支持回滚。
3. 对 ingestion 进行属性测试：任意重复提交保持同一 run revision；乱序事件经 sequence 重排后结果稳定；未知字段往返保留；敏感字段在 API、日志和默认 UI 中均脱敏。
4. 端到端覆盖本地目录导入、HTTP push、`refresh=1`、附件 containment、删除 cleanup、旧 API facade 和移动端页面下钻。
5. 观测期记录双读差异：case 数量、通过/失败、precondition、API 失败、截图/录屏引用、duration 和历史 key；差异达到阈值时保持旧协议为回退源。

## Related specs

- `.trellis/tasks/08-05-mobile-test-console-platform-project-split/prd.md`
- `.trellis/spec/backend/mobile-test-console-integration.md`
- `.trellis/spec/backend/error-handling.md`
- `.trellis/spec/backend/quality-guidelines.md`
- `.trellis/spec/guides/cross-layer-thinking-guide.md`

## Caveats / Not Found

- JUnit legacy XML 是事实标准并存在多种 dialect；Open Test Reporting XML 更严格且主要由 JUnit Platform 生成，平台需要容错导入器和 source-format 标记。
- ReportPortal 的文档描述实时 API 生命周期，服务端异步、网络重试、日志附件大小和幂等行为依部署版本与 agent 实现而异；Result Bundle 需要自行定义 outbox、cursor 和去重协议。
- OpenTelemetry Test attributes 页面当前标注属性组稳定度与具体字段级别，`test.case.result.status` 仅定义 `pass|fail`，移动平台的 skipped/blocked/timeout 继续放在扩展状态映射中；CI/CD spans 为 Release Candidate，采用时应记录 semconv 版本。
- OTLP 只承载 telemetry 传输，规范把多跳链路端到端交付留给部署系统；Bundle 的 run/case/artifact 事务、历史和删除策略需要平台自有协议。
- 当前 console 结果 provider 仅允许终态 task、16 MiB 输出和 30 秒执行；新协议分块/实时摄取属于扩展能力，迁移阶段应保留原限制和旧 facade。
- 现有 Fanli adapter 对录屏/截图仍生成绝对路径，平台目标要求 URI/相对路径和 digest；转换器必须在 adapter 边界完成路径归一化，并由 console 再做 realpath containment。
