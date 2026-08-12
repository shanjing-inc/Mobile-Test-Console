# Mobile Test Console 平台与项目功能拆分

## Repository Ownership

本任务从 `../fanli/.trellis/tasks/08-05-mobile-test-console-platform-project-split` 迁入。后续平台实现、研究和任务状态以 Mobile Test Console 仓库中的副本为准；Fanli 保留项目适配器契约和历史记录。

## Goal

在保持当前 Fanli 真机测试、Lynx 页面套件、三端 One-click、页面参数、账号画像、业务脚本、录屏、结果详情和删除清理行为一致的前提下，将 Mobile Test Console 的平台能力与 Fanli/Lynx 项目能力分离。Mobile Test Console 逐步聚焦跨 App 与小程序的测试分析平台；项目仓库通过适配器提供执行、采集和领域数据。

## What I already know

* Mobile Test Console 与 `../fanli` 是两个 Git 仓库，Fanli 通过 `../fanli/qa/mobile-test.config.cjs` 注册生命周期、测试命令、结果 provider、页面参数 provider、业务脚本 provider 和账号画像 provider。
* 控制台当前拥有设备发现、设备启动、任务队列、子进程生命周期、日志、任务持久化、结果读取、附件安全校验和浏览器 UI。
* 控制台源码包含 Fanli/Lynx 领域语义，例如 `huigou://lynx`、`lynx_page_ready`、`LynxAlibcLoginModule` 和 Fanli 修复文案。
* Fanli 的 `qa-mobile-test-console.cjs` 同时承担控制台适配入口、构建协调、认证前置、套件执行、One-click、结果聚合、产物清理和修复复测。
* Mobile Test Console 的平台拆分改动已按阶段提交；Fanli 当前配置未启用 Codex repair。
* 目标平台需要支持 App 与小程序两类测试目标，并为执行结果提供统一的分析、证据、指标和问题下钻能力。

## Assumptions (temporary)

* 第一阶段保留现有 `mobile-test-console.config.v1` 和全部 CLI/HTTP 行为，通过兼容层完成渐进迁移。
* 结果分析平台优先支持本地开发机和本地文件产物，远程对象存储、多人协作和云端调度延后设计。
* 现有 Android、iOS、HarmonyOS 与 Fanli Lynx 流程作为回归基线，小程序先建立通用目标模型和连接器接口。
* 现有测试执行器继续由项目仓库维护，平台核心通过 Result Bundle 或任务协议消费执行结果。

第一阶段范围锁定为平台/项目边界、Result Bundle、文件与 HTTP 双入口、兼容导入和现有功能回归；真实小程序执行器列入后续阶段。

## Open Questions

* HTTP push 的鉴权和远程存储方案延后到平台服务化阶段。
* 现有控制台名称在本任务中保留，产品重命名单独处理。

## Research References

* [`research/result-bundle-contract.md`](research/result-bundle-contract.md) — Result Bundle、摄取、幂等、附件和 App/小程序目标模型。
* [`research/runner-plugin-boundaries.md`](research/runner-plugin-boundaries.md) — Runner SDK、兼容层和 Connector/Sidecar 演进边界。

## Requirements (evolving)

* 平台核心拥有通用项目、目标、运行、用例、步骤、断言、证据、指标、问题和分析查询模型。
* 项目适配器拥有项目测试清单、构建安装、设备准备、账号/页面/业务领域 provider、执行命令和原始产物布局。
* 通用结果协议使用平台中立的 schema 名称，支持 `target.kind = app | mini-program`，保留 `platform`、`runtime`、`appId`、`environment`、`runId`、`caseRunId`、步骤、断言、日志、网络、截图、录屏和文件摘要。
* 现有 `mobile-test-console.task-result.v1` 通过 Fanli 兼容 provider 继续可读，迁移期间的旧任务详情、截图、录屏和 API 调用展示保持一致。
* 平台核心通过稳定的 artifact URI、相对路径和内容摘要访问产物，项目绝对路径只存在于项目适配器边界。
* App 与小程序使用 capability 描述连接器能力，设备发现、启动、安装、录制、网络采集、回放和结果导出按能力注册。
* 平台 UI 使用通用分析页面；Fanli/Lynx 专属参数编辑、账号画像和业务脚本继续由项目插件提供。
* 任务状态、取消、删除、生命周期 cleanup、结果缓存、附件路径安全和失败诊断继续满足现有行为。
* 平台与项目协议提供版本协商、未知字段保留、幂等 runId、重试语义、敏感字段脱敏和失败原因分层。

## Acceptance Criteria (evolving)

* [ ] 现有 Fanli 配置可在兼容模式下启动控制台并完成 smoke、all-pages、business-all 和三端 One-click。
* [ ] 现有任务状态流转、停止、删除、cleanup、结果详情、截图/录屏访问和诊断复制行为通过回归测试。
* [x] 平台核心源码不包含 Fanli、Lynx、Huigou、淘宝登录模块和业务页面 ID 等项目语义。
* [x] Fanli 项目适配器源码可独立替换结果、页面参数、账号画像和业务脚本 provider。
* [x] Result Bundle 可通过本地文件导入和至少一种服务端接口进入平台，并生成与旧结果等价的详情数据。
* [x] Result Bundle 能表达 App 和小程序目标，平台分析查询按目标类型保持统一。
* [x] 新增一个最小 demo 项目配置，验证平台核心不依赖 Fanli 路径、命令和资源。
* [ ] TypeScript 类型检查、Node QA 测试、Mobile Test Console 测试和现有构建检查全部通过。
* [ ] 每个迁移阶段具备回滚开关，旧协议和新协议可在同一版本共存。
* [x] Result Bundle 的文件导入与 HTTP push 对同一 `runId` 具备幂等结果，并能报告重复、冲突和版本不兼容。
* [x] 平台核心对旧 Fanli 绝对路径执行归一化，外部结果只暴露受控 artifact URI 和 digest。

## Definition of Done

* 单独的协议、核心服务、项目适配器和兼容层目录边界完成。
* 迁移 PR 按阶段拆分，每阶段包含实现、测试、文档和回滚说明。
* Fanli 与 Mobile Test Console 的现有用户流程通过自动化回归。
* App 与小程序目标模型和连接器扩展点有最小 demo 或契约测试。
* 平台核心、Fanli 适配器和兼容入口的责任归属写入项目 spec。

## Out of Scope

* 第一阶段重写现有 Maestro、hdc、xcrun、adb 或 Lynx QA runner。
* 第一阶段迁移云端设备农场、远程对象存储、权限系统和多人协作。
* 第一阶段启用或重做 Codex 自动修复产品流程。
* 第一阶段强制删除 `mobile-test-console.config.v1`、旧 provider 或旧 CLI 命令。
* 第一阶段完成所有小程序平台的实际自动化实现。

## Technical Approach

### Target boundaries

* `mobile-test-core`: 通用 contracts、Result Bundle schema、摄取、存储、附件索引、分析服务、查询 API 和平台 UI。
* `mobile-test-runner-sdk`: 设备/目标/能力/任务协议，供 App 与小程序 runner 实现。
* `mobile-test-runner-app`: Android、iOS、HarmonyOS 的设备与 App 执行连接器。
* `mobile-test-runner-miniprogram`: 小程序运行时、开发者工具和平台连接器，按 capability 渐进加入。
* `fanli-qa-adapter`: Fanli 配置、Lynx QA 命令、页面参数、账号画像、业务脚本和旧结果转换。
* `mobile-test-console-compat`: 旧 config/provider/CLI 到新协议的兼容层，提供 feature flag 和回滚路径。

### Result Bundle draft

```json
{
  "schemaVersion": "test-analysis.run.v1",
  "project": { "id": "fanli", "name": "返利 App" },
  "target": { "kind": "app", "runtime": "lynx", "platform": "ios", "appId": "..." },
  "run": { "runId": "...", "environment": "qa", "status": "passed" },
  "cases": [],
  "artifacts": [],
  "provenance": { "runnerVersion": "...", "sourceRevision": "..." }
}
```

### Migration order

1. 建立 schema、contract tests、兼容导入器和双写/双读开关。
2. 抽取平台核心的任务、结果、附件和分析服务，保留旧 API facade。
3. 将 Fanli provider 和 `qa-mobile-test-console.cjs` 收敛为项目适配器。
4. 抽取 App runner 与设备连接器，验证三端等价回归。
5. 加入小程序目标类型和首个 connector demo。
6. 迁移 UI 到通用分析视图，保留项目插件入口。
7. 通过观测期后再计划旧协议和旧命令的弃用窗口。

### Phase 1 deliverables

* 新增通用 `test-analysis.run.v1` contracts、Zod 校验和 JSON Schema 快照。
* 新增 `ResultBundleImporter`，支持文件导入、HTTP push、幂等去重、版本拒绝和冲突诊断。
* 新增 Fanli legacy provider adapter，将 `mobile-test-console.task-result.v1` 转成 Result Bundle，再映射回旧 `TaskResult`。
* 新增平台核心的 target/capability 字段和最小 `mini-program` target fixture，不执行真实小程序动作。
* 保留原有控制台 API 和 UI，增加 feature flag 控制新摄取路径，默认按兼容模式运行。
* 为 Fanli smoke、all-pages、business-all、One-click、删除清理、截图/录屏和失败详情建立迁移回归矩阵。

### Phase 2 deliverables

* 将任务状态、结果缓存、附件索引和分析查询移入平台核心服务。
* 保留旧 API facade，旧配置 provider 通过 adapter 接入核心服务。
* 平台核心源码移除 Fanli/Lynx/业务页面默认值，项目语义转入 adapter manifest。

### Phase 3 deliverables

* 抽取进程内 Runner SDK，统一任务事件、取消、日志、能力和结果导出。
* Fanli 继续使用兼容命令 runner；App runner 连接器按 Android/iOS/HarmonyOS 能力接入。
* 对需要独立依赖或厂商工具链的 connector 预留 Sidecar 进程协议。

Phase 3 当前实现已新增进程内 Runner SDK、三端 App capability manifest、小程序 connector contract、旧命令/设备 provider 兼容 facade，以及 `mobile-test-console.sidecar.v1` 握手与 start/cancel/collect 协议。`TaskManager` 在构建 `RunPlan` 后通过 `RunnerResolver` 为每个任务选择 Runner，并将停止和 shutdown 生命周期路由到已选择的实例；默认 resolver 继续使用 `LegacyTaskRunner`，第三构造参数保持单 Runner 注入兼容。

Phase 4 当前已将 Fanli Lynx App 的构建、安装、账号前置、页面参数解析和结果分析接入项目 Provider。`prepareRun()` 固定按 `app-prepare`、`account-preflight`、`page-parameters-resolve` 顺序返回命令，平台 `ProjectProviderCommandRunner` 依次执行后再启动套件主命令；任务通过或失败后，`collectResult()` 将 Fanli 旧产物转换为 Result Bundle，平台完成校验、幂等摄取并把 `resultUri` 持久化到任务。旧 TaskResult API 从存储 bundle 映射详情和安全截图，取消任务跳过收集；`MTC_LYNX_APP_RUNNER=0` 保留 legacy 完整流程和按需结果 provider。

接入引导阶段已以 Fanli 链路为模板抽取平台中立的 Lynx App onboarding：MTC 快照公开 Provider 能力清单，首次空项目进入接入引导工作区，页面按 Android/iOS/HarmonyOS 展示设备和工具链状态、基础/标准/完整接入等级，并提供最小配置复制入口。`examples/lynx-app-starter` 提供 Provider、Runner、准备命令、Smoke 命令和 Result Bundle 转换模板，项目只需替换真实构建、安装、页面驱动和产物转换逻辑。

项目目录阶段已新增 `mobile-test-console.project-catalog.v1`、本机持久化目录和“项目概览”工作区。CLI 当前配置项目会自动登记为活跃项目，其他项目优先通过系统文件选择器打开 `mobile-test.config.cjs`，MTC 从配置解析 `project.root` 自动回填项目目录；打开项目目录时也会自动扫描配置文件。接入状态固定为项目目录、接入配置、设备环境和项目能力四项，全部通过后开放测试执行与项目声明的工作区。当前阶段保持 `--config` 单活跃运行项目，项目登记与验证只更新目录元数据。

项目激活阶段新增 `POST /api/projects/:projectId/activate`。切换请求会检查目标配置和当前活动任务，成功后由 CLI 使用目标配置重启进程；活动任务返回 `PROJECT_SWITCH_TASK_ACTIVE`，目标配置缺失或不一致返回可操作的配置错误。重启边界保留现有任务、设备、Provider 和项目状态隔离。

项目目录支持通过页面内确认弹窗删除任意项目登记。删除只更新 `mobile-test-console.project-catalog.v1`，保留项目目录、配置文件、项目 `stateDir`、活动任务和已加载的运行配置；删除当前运行项目时保留 `activeProjectId` 作为持久化删除标记，重新登记同一配置后恢复当前项目状态。

Smoke、Result Bundle、运行结果和失败诊断统一归属“执行测试”工作区。项目目录只持久化四项接入检查，测试终态与结果摄取不会回写项目接入状态。

### 项目接入工作区层级重构（已实现）

目标：项目概览只承担项目接入、环境诊断和修复引导；测试执行与项目工具作为接入成功后的同级工作区。

已确认需求：

* 顶部项目导航统一为“项目概览、执行测试、页面列表、业务脚本、账号画像”。
* 五个工作区入口始终显示。项目处于接入中时只有“项目概览”可点击，“执行测试、页面列表、业务脚本、账号画像”保持禁用并说明尚未满足的接入条件。
* 运行前条件全部满足后启用“执行测试”，并根据项目配置声明启用页面列表、业务脚本和账号画像。
* 项目概览只保留接入前检查。Smoke、Result Bundle 和运行结果统一进入“执行测试”的运行记录与结果详情。
* 选择项目目录但缺少 `mobile-test.config.cjs` 时，项目概览展示配置初始化引导，并基于 `examples/lynx-app-starter` 生成或复制最小接入骨架。
* 设备环境失败时，项目概览展示具体缺失工具、受影响平台、检测命令和安装/修复脚本，并支持修复后重新检测。
* 项目能力失败时，项目概览展示缺失 capability、对应 Provider/Runner 接入位置、Starter 文件和可执行的初始化/修复动作。
* 任何会写入项目文件或运行安装命令的动作都要展示目标路径、命令和影响范围，并由用户显式触发。

验收条件：

* [x] 接入中的项目显示全部五个工作区入口，项目概览可用，其余入口禁用并提供明确原因。
* [x] 接入成功后启用执行测试与配置声明的项目工具；项目未声明的工具继续显示为禁用状态并说明配置要求。
* [x] 当前工作区在接入状态退回时自动回到“项目概览”。
* [x] 缺少配置文件的项目可以进入目录并看到初始化入口、目标文件清单和冲突保护。
* [x] 设备诊断区能够区分工具链缺失、设备未连接、设备未授权和设备准备项缺失，并给出对应动作。
* [x] 项目能力诊断区列出 Lynx App 五项 capability 的缺失项及 Starter 对应文件。
* [x] 项目概览不再展示 Smoke、结果分析或运行后验证状态。

执行决策：

* 配置初始化、设备环境安装和能力模板生成统一采用“展示计划 → 用户确认 → MTC 执行 → 自动复检”。
* 计划必须包含目标文件、命令、工作目录和影响说明；执行接口校验计划摘要，防止预览后项目状态变化导致执行不同内容。
* 文件冲突、命令不可用或执行失败时保留原文件，并将错误写回对应接入步骤供用户继续处理。

### Phase 4 deliverables

* 将小程序 target/capability 接入真实 runner，优先交付一个最小 connector。
* 将页面参数、账号画像、业务脚本等项目工作台通过插件注册到平台 UI。
* 完成双写观测、旧协议弃用公告和可回滚开关清理评估。

## Decision (ADR-lite)

**Context**: 当前控制台通过项目配置实现了仓库隔离，核心代码仍包含 Fanli/Lynx 领域和执行编排，平台需要扩展到 App 与小程序分析。

**Decision**: 采用“平台核心 + runner SDK + 项目适配器 + 兼容 facade + Result Bundle”的渐进式拆分。先建立数据协议和导入边界，再移动执行职责，保持现有功能和入口稳定。

**Consequences**: 迁移期会同时维护旧协议和新协议，并增加适配测试与双读观测；平台核心获得跨项目、跨目标类型的分析能力；Fanli 继续独立演进其 Lynx QA 细节。

## Technical Notes

* Fanli integration config: `../fanli/qa/mobile-test.config.cjs`
* Fanli adapter: `../fanli/packages/lynx/scripts/qa/qa-mobile-test-console.cjs`
* Console config/contracts: `src/server/config.ts`, `src/shared/contracts.ts`
* Console execution: `src/server/task-manager.ts`, `src/server/devices.ts`
* Console analysis: `src/server/task-results.ts`, `src/web/result-analysis.ts`
* Existing integration spec: `.trellis/spec/backend/mobile-test-console-integration.md`
* Current worktree contains unrelated user changes; migration must preserve and accommodate them.
