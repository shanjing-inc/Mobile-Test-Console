# Research: Runner / Connector / Plugin 责任边界

- Query: 研究测试分析平台中 runner、connector、plugin 的通用架构边界，比较 2-4 种模式，覆盖 App 与小程序、设备发现、任务调度、能力描述、兼容迁移和回滚；结合当前 Mobile Test Console 与 Fanli 约束给出建议
- Scope: mixed
- Date: 2026-08-05

## Findings

### 当前实现基线

| 文件 | 现状与边界信号 |
| --- | --- |
| `src/shared/contracts.ts:1-39` | `Device` 只有 `platform`、物理/模拟器类型、连接状态和准备状态；目标 App、运行时、小程序实例没有独立模型。 |
| `src/shared/contracts.ts:75-106` | `TaskStatus`、`TestTask` 包含队列、准备、执行、取消、终态、日志和设备快照；每个设备是当前调度冲突单位。 |
| `src/shared/contracts.ts:140-183` | `TaskResultRun` 已含 `caseRunId`、页面、断言、API、截图和证据，`TaskResult` 固定为 `mobile-test-console.task-result.v1`。这是迁移到平台中立 Result Bundle 的可复用内核。 |
| `src/server/devices.ts:268-362` | Android、iOS（simctl/devicectl/xcodebuild）和 Harmony（hdc）的命令解析与厂商信息查询写在控制台服务中。 |
| `src/server/devices.ts:364-437` | `DeviceDiscoveryService` 负责并行发现、30 秒缓存、后台刷新和准备项挂载；`448-540` 还负责设备准备安装及 iOS 模拟器启动。 |
| `src/server/task-manager.ts:58-95` | 控制台校验测试/设备/平台、禁止同设备活动任务、创建任务并排队执行；`184-238` 解析命令、spawn 子进程、收集日志并完成状态。调度与 runner 执行目前耦合。 |
| `src/server/task-results.ts:128-163` | 控制台调用项目外部结果 provider，校验 schema/runId 并缓存终态结果；`257-293` 负责 artifact 根目录、真实路径和符号链接越界校验。结果安全和分析读取适合留在平台核心。 |
| `src/server/app.ts:189-201,367-408,463-483` | HTTP 层编排 snapshot、设备发现、账号能力校验、任务启动、结果读取和删除清理；接口可作为兼容 facade。 |
| `src/server/config.ts:119-137,331-367,385-445` | `mobile-test-console.config.v1` 以命令模板表达 lifecycle、task、result、页面参数、业务脚本和账号 provider；模板解析把项目根、设备、任务和参数注入命令。它是现有项目插件的事实接口。 |
| `../fanli/qa/mobile-test.config.cjs:1-183` | Fanli 声明三平台、iOS 工程、Maestro 准备、生命周期、删除 cleanup、结果 provider、页面参数、业务脚本、账号画像和 Lynx suite/One-click。平台核心应读取这些声明，项目适配器拥有语义。 |
| `../fanli/packages/lynx/scripts/qa/qa-mobile-test-console.cjs:47-99,485-598` | Fanli runner 生成 setup/execute 命令（含 Lynx 构建跳过、鉴权前置和 profile），并负责 coordinator cleanup、删除产物和把 QA 报告转换为 `mobile-test-console.task-result.v1`。迁移时应收敛为 Fanli adapter/legacy result translator。 |
| `.trellis/spec/backend/mobile-test-console-integration.md:6-7,138-173,221-264` | 现行约定明确：控制台拥有设备发现、任务调度、进程生命周期、持久化、HTTP/UI；App 仓库拥有测试定义和 runner 命令；需要保持配置、清理、结果、设备和回归行为。 |

当前约束还包括：本地开发机、Node `>=18.20.0`、pnpm 10.x；Android 使用 `adb`，iOS 使用 `simctl/devicectl`，Harmony 使用 `hdc`（`package.json:1-40`, `README.md:1-18`）。第一阶段不重写 Maestro/adb/xcrun/hdc/Lynx runner，不强制删除 v1 配置或旧命令（任务 `prd.md` 的 Out of Scope）。

### 三层术语与推荐责任边界

| 层 | 必须拥有 | 明确不拥有 |
| --- | --- | --- |
| **Platform Core / Scheduler** | 项目中立 contracts、`Project`/`Target`/`Device`/`Run`/`CaseRun`/`Artifact`、任务状态机、队列与资源 lease、幂等 `runId`、取消/超时/重试策略、持久化、Result Bundle 摄取与 schema 演进、artifact URI 安全、分析查询/API/UI。 | adb/xcrun/hdc/DevTools 命令、Fanli 页面 ID、Lynx 事件、账号/业务领域数据、某厂商安装细节。 |
| **Runner** | 一个已调度 run 的执行计划：将项目用例/参数编译为步骤，按顺序调用 connector，管理该 run 的子进程/流式事件/退出原因，产生平台中立 `RunEvent` 和 Result Bundle；实现本 run 的 precondition 与 cleanup。 | 全局队列、公平调度、设备库存、跨项目分析、厂商命令解析。 |
| **Connector** | 绑定一种设备/运行时协议的能力实现：发现设备、健康检查、启动/解锁、安装/卸载、目标 attach/launch/reload、UI/网络/日志/截图/录屏采集、取消底层动作、产物导出；返回结构化 capability snapshot 和稳定设备/目标 key。 | 测试套件清单、业务断言语义、全局 task 状态、Result Bundle 聚合、项目绝对路径对外暴露。 |
| **Project Plugin / Adapter** | 项目 manifest、测试清单与参数 schema、构建/安装入口、账号画像/页面参数/业务脚本 provider、目标映射（App 或小程序）、用例步骤生成、旧产物转换、项目 cleanup。 | 直接扫描所有设备、抢占队列、决定平台分析维度、改变核心任务状态机。 |
| **Compat Facade** | 解析 `mobile-test-console.config.v1`、把命令 provider 包成 Plugin/Runner、旧 `mobile-test-console.task-result.v1` 双读/双写、新旧 API/CLI feature flag、迁移告警和回滚。 | 新能力的长期领域逻辑；兼容层应可删除。 |

建议将 `Device`（物理执行资源）与 `Target`（App/小程序测试目标）分离：`Target.kind = app | mini-program`，附 `runtime`、`platform`、`appId/packageName`、版本/环境和 connector id；一次任务引用 `deviceKey + targetKey + runnerVersion`。小程序可复用 Android/iOS/Harmony 设备 connector，同时由 mini-program connector 处理开发者工具、宿主 App、二维码/包安装、热重载和目标 attach；平台分析只看统一 target/run/case/event。

能力描述采用版本化、可组合且带约束的声明，而非只用平台字符串：

```json
{
  "schemaVersion": "mobile-test-console.capabilities.v1",
  "connectorId": "android-adb",
  "scope": { "platform": "android", "deviceType": ["physical", "emulator"] },
  "capabilities": [
    { "id": "device.discover", "version": 1 },
    { "id": "target.app.install", "version": 1 },
    { "id": "evidence.screenshot", "version": 1 },
    { "id": "evidence.recording", "version": 1, "limits": { "maxSeconds": 300 } }
  ],
  "constraints": { "requires": ["unlocked"], "excludes": ["mini-program.devtools-only"] }
}
```

Scheduler 只按 capability + constraint 选择 connector/设备并建立 lease；Runner 根据 capability 分支执行。能力缺失进入可诊断的 `precondition`，不会伪装成用例断言失败，也不应消耗修复次数；这与现有 repair spec 对 precondition/assertion 的区分一致（`.trellis/spec/backend/mobile-test-console-integration.md:50-68`）。

### 架构模式比较

#### 模式 A：进程内 Hexagonal Core + Typed Runner SDK（推荐第一阶段）

**形态**：平台核心定义 ports（`DeviceConnector`, `Runner`, `ProjectPlugin`, `ResultImporter`）；Node/TypeScript SDK 让 App connector、小程序 connector 和 Fanli adapter 作为同一进程内模块注册。Core 调度和持久化调用 port，runner 调 connector。

**责任/流程**：

1. connector `discover()` 返回 `Device[]` 与 capability snapshot；core 将设备和目标库存分开缓存。
2. plugin 返回项目测试清单、目标清单和 `createPlan(case, target, params)`；core 校验声明并创建 lease。
3. scheduler 启动 runner，runner 用 connector 执行构建/安装/步骤，逐事件上报；core 负责总超时、状态持久化和取消信号。
4. runner 完成后通过 importer 生成 Result Bundle；core 解析、存储 artifact URI、分析并保留旧 facade。

**优点**：共享 TypeScript 类型；对当前本地控制台改动小；不改变 adb/xcrun/hdc 命令；调试和测试成本低。**代价**：插件崩溃会影响 API 进程；connector 仍受 Node 运行时和权限约束；第三方小程序 SDK 难以隔离。

**适配 App/小程序**：App runner 复用现有三端命令；mini-program runner 只扩展 target plan，设备控制仍可复用 connector。Mini-program capability 必须包含宿主/开发者工具版本、可 attach 状态和目标 appId，防止把“设备在线”误判为“小程序可执行”。

**兼容/回滚**：`CompatPlugin` 将 v1 config 命令模板包装为 `legacy-command-runner`，`LegacyResultImporter` 继续读 v1。用 `MTC_EXECUTION_MODE=legacy|sdk` 和 `MTC_RESULT_MODE=legacy|dual|bundle` 控制；双模式对同一 `runId` 写入 legacy 与 bundle，校验摘要一致后按项目开关切换，异常立即回到 legacy。

#### 模式 B：进程外 Sidecar Runner/Connector（HashiCorp/Kubernetes 风格）

**形态**：core 通过 stdio、JSON-RPC 或 gRPC 与 runner/connector sidecar 通信；sidecar 自带命令依赖、语言运行时和崩溃边界。设备发现可采用流式 `ListAndWatch` 语义，任务执行使用 `Start/Cancel/Collect` RPC。

**责任/流程**：core 保留 schema、队列、lease、分析和 artifact index；sidecar 实现平台命令及运行时；plugin 只提供 manifest/plan。sidecar 将事件和产物 URI 流式返回，core 统一落盘与脱敏。

**优点**：崩溃、依赖和权限隔离；小程序可用 Python/Go/厂商 CLI 独立实现；可逐步把连接器移到远程设备代理。**代价**：本地进程管理、协议超时、版本协商、日志顺序、路径/权限映射复杂；当前 Fanli runner 的一次性 Node 命令需改成可恢复 RPC。

**适配 App/小程序**：每个设备协议一个 connector sidecar，App 与 mini-program 可共享设备 sidecar；mini-program devtools sidecar 独立升级。Core 必须处理 sidecar 无响应和能力过期，保留已上报事件及幂等 run。

**兼容/回滚**：将现有 `executable + args` 当作 `shell-sidecar` 适配器；先 shadow discover/result，后按 connector allowlist 切换。sidecar handshake 失败、schema 不兼容或结果摘要不一致时，单 run 回落 legacy；禁止在迁移期间删除旧 artifact 路径。

#### 模式 C：持久化 Workflow/Job Orchestrator + Connector Activities

**形态**：core 采用 Temporal/类似 durable workflow，任务拆为 discover → reserve → prepare → build → install → execute → collect → import → cleanup 活动；runner 是 activity worker，connector 是 activity 实现或 worker 插件。

**优点**：长任务、设备暂离、重启恢复、重试和定时调度语义清晰；适合云端设备农场和跨项目并发。**代价**：引入 workflow server/worker 运维；活动必须确定性、幂等；本地单机控制台的持久化和 CLI 会显著变复杂。

**适配 App/小程序**：目标和设备 lease 是 workflow 输入；mini-program 的开发者工具 attach/人工确认可建成等待信号。能力声明决定 workflow 分支和活动超时；证据事件应外置存储，避免 workflow history 膨胀。

**兼容/回滚**：workflow versioning 与 `runId` 绑定；旧任务继续由 legacy worker 执行，新 workflow 只接新 project/target。回滚只能停止新 workflow、恢复 legacy 创建入口，已开始的 workflow 需通过 cancel/compensation 完成 cleanup，不能简单重放以免重复安装、录制或删除。

#### 模式 D：声明式 Plugin Registry + Event Bus（适合领域/UI 扩展）

**形态**：插件 manifest 声明项目、target、测试入口、capability requirement 和 UI panels；core 发布 `run.created`、`case.failed`、`artifact.indexed` 等事件，插件通过 hook 生成计划或扩展分析页面。设备 connector 仍应使用 A/B 的受控 port，不应由任意事件订阅者直接操作设备。

**优点**：Fanli 页面参数、账号画像、业务脚本和未来小程序项目可独立发布；插件可按项目启停；UI 扩展自然。**代价**：事件顺序、失败传播、权限和 schema 兼容难度高；直接把执行放进 event bus 会造成不可预测调度。

**适配 App/小程序**：插件只声明 target/case 与所需 capability；core 负责选择 runner/connector。小程序可先以 plugin + legacy command 交付，再替换为 SDK/sidecar connector。

**兼容/回滚**：manifest `apiVersion`、插件 feature flag、事件 schema registry 和旧 facade 并存；插件加载失败只禁用该项目入口并保留旧配置，核心健康和历史分析继续可用。

### 模式选择矩阵

| 维度 | A 进程内 SDK | B Sidecar RPC | C Workflow | D Plugin/Event |
| --- | --- | --- | --- | --- |
| 当前本地 Fanli 改动量 | 最低 | 中 | 高 | 中 |
| 设备发现/启动隔离 | 低 | 高 | 取决于 worker | 低 |
| App + 小程序扩展 | 中，受 Node 约束 | 高，语言/依赖自由 | 高，适合长任务 | 高，适合领域/UI |
| 调度/取消/重启恢复 | core 可做到 | 需协议设计 | 最强 | 弱，事件需回 core |
| 结果/分析统一性 | 强 | 强 | 强 | 取决于插件纪律 |
| 本地调试成本 | 最低 | 中高 | 高 | 中 |
| 推荐用途 | 第一阶段 ports + 兼容迁移 | 第二阶段隔离厂商/小程序 connector | 云端设备农场阶段 | 项目领域与 UI 扩展 |

### 对当前 Mobile Test Console / Fanli 的落地建议

推荐 **A → B 的混合渐进路线**，并把 D 限定为项目领域插件；C 留到远程设备农场。目录/模块职责可以按任务 PRD 的方向收敛：`mobile-test-core`、`mobile-test-runner-sdk`、`mobile-test-runner-app`、`mobile-test-runner-miniprogram`、`fanli-qa-adapter`、`mobile-test-console-compat`。

1. **先冻结协议和资源模型**：新增 `Target`、`CapabilitySnapshot`、`RunPlan`、`RunEvent`、`ArtifactRef` 和 `test-analysis.run.v1`；保留 `Device` 的平台字段以兼容现有 UI。把绝对路径限制在 adapter/importer，平台内部只存稳定 URI、相对路径和摘要。
2. **抽出 connector port**：将 `devices.ts` 中 adb/simctl/devicectl/hdc 的解析、发现、准备、启动迁移到 App connector；core 继续做缓存、并发刷新和设备 lease。`DeviceDiscoveryService` 的 30 秒缓存/后台刷新语义应作为 core contract 保留，避免每次 snapshot 执行命令（spec `mobile-test-console-integration.md:337-381`）。
3. **抽出 runner port**：将 `TaskManager` 的队列/状态/持久化留在 core，将 `spawn`、stdout/stderr 事件、底层 cancel 和单 run cleanup 交给 runner host。调度资源从单一 `deviceKey` 扩展为 `deviceKey + targetKey + resourceLocks`，小程序宿主/DevTools 独占锁显式声明。
4. **Fanli adapter 先包裹现有 runner**：把 `../fanli/qa/mobile-test.config.cjs` 的 tests/parameters/providers 变成 plugin manifest；`qa-mobile-test-console.cjs` 通过 `LegacyCommandRunner` 继续执行 suite/oneclick，保留 Lynx build coordinator、鉴权前置、账号画像、页面参数和 cleanup。Fanli 继续拥有 Lynx 页面/业务语义。
5. **Result Bundle 双读双写**：`TaskResultService` 的 provider 调用和 artifact 越界检查保留在 core；Fanli adapter 把现有 `mobile-test-console.task-result.v1` 转成 `test-analysis.run.v1`，按 `runId` 做幂等导入，未知字段保留在 `extensions`。shadow 模式比较 case 数、状态、失败摘要、artifact 摘要；差异降级旧结果并记录迁移告警。
6. **小程序最小 demo**：先实现 manifest/target/capability/Result Bundle 和 fake connector，验证平台不依赖 Fanli 路径；真实开发者工具 connector 采用 B sidecar，避免将厂商 SDK/GUI 进程带入平台 API。
7. **回滚开关和观测**：按项目/测试/connector/run 维度支持 `legacy|sdk|sidecar`；记录协议版本、connector/runner 版本、能力快照、fallback 原因和迁移差异。旧 v1 API、CLI、artifact 目录和删除 cleanup 保留完整观察窗口，连续稳定后再弃用。

### 迁移与回滚不变量

- `runId`、`caseRunId`、`projectId`、`targetKey` 是跨旧新协议的关联键；重试沿用同一 run 的 attempt 语义或生成明确的 `attemptId`，禁止重复导入。
- Capability/precondition 失败分类为设备/目标准备错误，显示 actionable detail 并保留证据；page assertion 才进入测试失败/修复流程。现有 repair contract 要求 precondition 不消耗 Codex attempt（`.trellis/spec/backend/mobile-test-console-integration.md:50-68`）。
- 取消顺序是 scheduler 撤销 lease → runner 停止单 run → connector 终止底层进程/录制 → importer flush 已有事件 → core 标记 cancelled；服务重启时恢复 queued/preparing/running 为 interrupted 或可恢复状态。
- artifact 只允许 connector/adapter 返回 `artifact://project/run/...` 或 artifactsRoot 内相对引用；core 统一 realpath、MIME、大小和符号链接边界检查，维持 `task-results.ts:257-293` 的安全性质。
- legacy 与 bundle 的 verdict 不一致时，用户可见结果继续采用已验证的旧结果，bundle 进入 quarantine；修复、删除和历史详情优先保证旧链路可用。

## External References

- HashiCorp, **go-plugin README / Protocol**（访问 2026-08-05）：https://github.com/hashicorp/go-plugin 。进程外插件通过 handshake、RPC/双向 RPC、版本协商和 host/plugin 生命周期实现隔离，支持模式 B 的 sidecar 思路。
- Kubernetes, **Device Plugins**（文档版本随站点发布，访问 2026-08-05）：https://kubernetes.io/docs/concepts/extend-kubernetes/compute-storage-net/device-plugins/ 。`Registration`、`ListAndWatch`、`Allocate` 展示设备发现、能力/资源声明与调度分配的可复用边界；Mobile Console 可借鉴流式发现和 allocation lease，不需要引入 Kubernetes。
- W3C, **WebDriver, Capabilities**（Recommendation/Working Draft 页面，访问 2026-08-05）：https://www.w3.org/TR/webdriver2/#capabilities 。能力在 session 建立时协商并由实现拒绝不支持项，适合作为 connector capability version/constraint 的协议参考。
- Temporal, **Workflows / Durable Execution**（文档版本随站点发布，访问 2026-08-05）：https://docs.temporal.io/workflows 。工作流通过持久化状态、重试和外部信号支持长任务恢复，适合作为模式 C 的后续远程设备农场选型参考。
- Visual Studio Code, **Extension Host**（文档版本随站点发布，访问 2026-08-05）：https://code.visualstudio.com/api/advanced-topics/extension-host 。扩展宿主与 UI/主进程分离、扩展按权限运行，支持模式 D 中领域/UI 插件与核心隔离的设计取舍。

## Related Specs

- `.trellis/spec/backend/mobile-test-console-integration.md`：当前控制台与 App 仓库边界、配置 v1、设备发现/调度/结果/artifact/cleanup 回归契约。
- `.trellis/spec/backend/directory-structure.md`：后端目录和兼容入口约定。
- `.trellis/spec/guides/cross-layer-thinking-guide.md`：跨层数据流、契约和回滚思考要求。
- `.trellis/tasks/08-05-mobile-test-console-platform-project-split/prd.md`：目标模块、Result Bundle 草案、迁移顺序、验收与 out-of-scope。

## Caveats / Not Found

- `python3 ./.trellis/scripts/task.py current --source` 当前返回 `Current task: (none)`；本研究按父任务明确给出的目录写入，未修改任务状态或其他文件。
- 当前 MCP 未提供 `lynx-docs://llms.txt` 资源或模板；Lynx 约束依据 `../fanli/qa/README.md`、Fanli runner 和 Trellis integration spec。
- 外部引用用于架构模式佐证，未将 Kubernetes、Temporal 或 go-plugin 直接列为第一阶段依赖；本地 Fanli 仍以 Node/TypeScript、命令行 runner 和本地 artifact 为约束。
- 真实小程序开发者工具的 attach/录制/网络采集 API 取决于具体平台（微信/支付宝等），需要在实现 connector 前单独验证厂商 CLI/SDK 与授权模型。
