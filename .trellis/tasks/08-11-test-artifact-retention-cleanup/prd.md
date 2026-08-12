# 测试产物保留与清理策略

## Goal

由 Mobile Test Console 统一管理测试产物的保留策略、清理触发、清理预览和执行状态；接入项目通过配置声明清理适配器，由项目脚本处理自身产物目录、设备侧诊断文件和项目缓存。平台保持项目目录无感知，项目保持平台策略无感知。

## What I already know

- Fanli `qa/history` 当前占用约 33 GiB，其中 `qa/history/artifacts` 占用约 33 GiB，共 522 个任务/用例目录。
- 两次 iOS 全量运行分别占用约 15.90 GiB 和 14.37 GiB，是当前空间增长的主要来源。
- iOS 每个用例会从 App 容器复制整个 `Documents/diagnostics`；历史运行诊断被重复复制到每个新用例目录。单个用例目录约 200 MiB，81 个用例形成约 16 GiB 的单次运行产物。
- Harmony 准备产物中的 `entry-qa.hap` 单个约 183 MiB；Android 录屏单个约 7–20 MiB。
- MTC 状态目录 `~/.mobile-test-console/fanli` 当前占用约 2.4 GiB，主要来自 17 个 `repair-worktrees`；最大两个约 1.2 GiB 和 540 MiB。
- MTC 已支持删除终态任务，并在删除任务前调用项目配置的 `taskDeletion.cleanup`。
- Fanli 已提供 `delete-run`，能够删除 `qa/history/artifacts` 下名称等于 `runId` 或以 `runId-` 开头的目录。
- 当前 `delete-run` 只覆盖单个运行的项目产物；MTC 尚未提供自动保留策略、空间配额、清理预览、任务保留标记和 repair worktree 定期回收。

## Recommended Architecture

采用“平台策略编排 + 项目清理适配器”两层模型。

### MTC owns policy and orchestration

- 在项目状态目录保存保留策略与最近清理结果。
- 根据任务状态、完成时间、运行结果、用户保留标记和实际空间占用计算清理候选。
- 保护 `queued`、`preparing`、`running`、正在修复、正在查看以及用户标记保留的任务。
- 支持启动后延迟检查、任务完成后异步检查、周期检查和手动“清理历史”。
- 展示清理预览：候选运行、候选文件数、预计释放空间、清理原因和保留原因。
- 调用项目适配器执行清理；记录结果、错误和释放空间；清理成功后再移除任务索引。
- 直接回收 MTC 自有的 repair worktree、repair snapshot、result bundle 和过期临时文件。

### Project owns artifact semantics

- Fanli 脚本识别一次运行关联的用例目录、准备产物、报告、录屏、诊断包和设备侧诊断目录。
- Fanli 脚本执行路径边界校验，所有可删除路径必须位于配置声明的根目录或明确的设备 App 沙箱路径。
- Fanli 脚本支持 `plan` 与 `apply`，两种模式返回相同结构的 JSON；`plan` 只计算，`apply` 执行并返回实际结果。
- Fanli 脚本按 `runId` 接收清理目标，避免 MTC 依赖 Fanli 的目录命名规则。
- Fanli 在诊断采集成功后回收设备侧当前运行文件，阻止设备沙箱持续积累。

## Adapter Contract v1

MTC 在自身状态目录生成请求 JSON，通过配置中的项目命令传入请求文件路径。

请求包含：

- `schemaVersion`
- `mode`: `plan | apply`
- `projectId`
- `artifactsRoot`
- `protectedRunIds`
- `candidateRunIds`
- `policy`: 年龄、数量、空间、成功/失败保留规则

响应包含：

- `schemaVersion`
- `ok`
- `items[]`: `runId`、路径摘要、文件数、字节数、原因、状态
- `bytesFreed`
- `filesRemoved`
- `skipped[]`
- `errors[]`

MTC 只消费结构化响应；项目脚本决定每个 `runId` 对应的真实文件集合。

## Retention Policy

建议默认值：

- 总空间软上限：10 GiB；超过后从最旧的可清理任务开始回收。
- 普通任务最长保留 7 天，最多保留最近 20 次。
- 每个平台保留最近 1 次成功运行和最近 3 次失败运行。
- 用户标记“保留”的任务长期保留，并在空间统计中单独展示。
- 任务摘要、统计和清理审计保留 30 天；大文件产物按上述运行策略保留。
- 单次运行超过空间软上限时保留该运行，同时在 MTC 显示超额告警和最大文件分类。

所有规则取并集形成保护集合，再按时间从旧到新清理其余任务，直至同时满足年龄、数量和空间约束。

## Immediate Root-Cause Fix

保留策略上线前先修复 iOS 诊断采集：

- 真机只拉取 `Documents/diagnostics/<current-run-id>`，模拟器只复制当前运行目录。
- 当前运行的 runtime log 使用相同的运行范围采集。
- 采集成功且结果校验完成后删除设备侧当前运行诊断；采集失败时保留设备侧文件供重试。
- 诊断目录大小和文件数量写入结果摘要，异常增长时产生告警。

该修复会把一次 81 页面 iOS 全量运行从约 16 GiB 降至当前运行证据的实际大小，并消除历史诊断按用例重复复制的问题。

## Write Amplification Controls

测试证据保持完整，写入控制聚焦于重复数据、无效临时文件和不必要的多份公共资源。

### Evidence preservation

- 结果摘要、关键运行事件、页面截图、录屏、系统日志、运行时日志和诊断包均可保留。
- 失败用例和用户指定用例保留完整证据链，成功用例保留同样的唯一证据集合。
- 测试配置提供证据保留开关，默认值为保留；用户可以在单次运行中显式关闭某类证据。
- 清理策略按运行和证据类型管理，删除候选必须显示具体文件和释放空间。

### Per-run write budget

- 测试开始前由 MTC 根据测试数量、平台和证据级别估算写入量。
- 超过项目配置的单次运行预算时，MTC 显示预计写入量并要求用户确认，或自动降级到 `summary`。
- 录屏默认保留；调试录屏设置最大时长和最大字节数，超过上限时截断并在摘要中标记。
- 高频日志先进入内存缓冲，再批量追加到产物文件；终态保留完整日志或按配置切分归档。
- 诊断目录只读取当前 `runId`，采集成功后立即回收设备侧同一目录。

### Storage circuit breaker

- 启动测试前检查可用磁盘空间、项目产物占用和本次估算写入量。
- 剩余空间低于安全水位时，先触发 MTC 清理计划；清理后仍不足则阻止测试启动并给出具体释放建议。
- 运行过程中达到写入预算时，停止录屏和非必要诊断采集，继续保留结果摘要和错误日志。
- MTC 记录每次运行的 `estimatedBytes`、`writtenBytes`、`bytesFreed`，用于发现异常写放大。

### Reduce duplicate writes

- MTC 任务日志采用批量刷新和时间窗口合并，避免每行日志都写 `state.json`。
- 测试结果只保留摘要索引，完整证据使用当前运行目录按需读取。
- 相同运行内的安装包、QA bundle、公共诊断文件和设备元数据只生成一份，用 manifest 引用关系关联到各用例。
- 项目脚本在清理前支持 dry-run，避免反复扫描和重复删除。

### Storage location

- MTC 提供可配置的 `artifactRoot`，支持项目目录、外接磁盘、共享目录和 NAS 挂载点。
- MTC 启动测试前检查目标存储的挂载状态、可写权限、可用空间和文件系统标识。
- 目标存储暂时不可用时，MTC 暂停测试并明确提示；项目配置支持用户确认后的临时回退目录。
- 运行临时目录、测试结果目录和长期归档目录可以分别配置，测试结束后通过 rename 或同文件系统移动完成归档，减少重复拷贝。
- 同一块内置磁盘上的另一个目录或分区只改变路径，写入量仍然计入同一块磁盘；外接磁盘或 NAS 才能把写入压力迁移到其他存储设备。
- 内存盘可以减少落盘写入，但会增加内存压力且断电丢失数据，只用于可重建的临时文件，不作为证据归档位置。

## Product Flow

### Project overview

- 显示“测试存储”卡片：项目产物、MTC 数据、总占用、配额和最近清理时间。
- 提供“查看清理计划”和“立即清理”入口。
- 配置缺少项目清理适配器时，接入验证展示具体配置示例。

### Test results

- 单个终态任务支持“删除结果”和“标记保留”。
- 删除结果沿用现有任务删除链路，并展示项目适配器返回的释放空间。
- 概览按测试条目展示对应截图缩略图，支持显示或隐藏图片；隐藏时释放图片节点，原图入口保持可用。

### Cleanup preview

- 按项目展示待清理运行和预计释放空间。
- 需要用户确认后执行手动清理。
- 自动清理只处理策略明确选中的终态任务。

## Delivery Phases

1. 修复 Fanli iOS 当前运行诊断采集与设备侧回收，补充回归测试。
2. 扩展 Fanli 清理命令为结构化 `plan/apply`，覆盖运行产物和设备侧临时文件。
3. 在 MTC 增加保留策略、候选计算、清理记录、后台触发和项目适配器契约。
4. 在 MTC 增加存储概览、清理预览、保留标记和执行反馈。
5. 在 MTC 内部增加 repair worktree、snapshot、result bundle 的生命周期回收。

## Requirements

- MTC 负责策略与触发，Fanli 负责项目文件语义与安全删除。
- 活动任务、活动修复任务和用户保留任务必须受到保护。
- 自动清理不得阻塞测试完成、项目切换或 MTC 启动。
- 清理失败不得删除 MTC 中的任务记录，失败原因需要可见并可重试。
- 每次清理必须提供可审计的结构化结果。
- MTC 不直接编码 `qa/history`、Fanli bundle ID 或具体平台目录。
- Fanli 脚本不得接受任意删除路径，只接受受校验的 `runId` 和配置根目录。

## Acceptance Criteria

- [ ] iOS 单个用例只保存当前运行的诊断文件，历史诊断不再复制进新用例目录。
- [ ] 默认保留配置声明的完整证据，公共资源和重复诊断只生成一份。
- [ ] MTC 在测试开始前检查磁盘安全水位和单次运行写入预算。
- [ ] 运行达到写入预算后停止非必要证据采集，测试结果仍可完成。
- [ ] MTC 统计估算写入量、实际写入量和释放空间，并能识别异常写放大。
- [ ] MTC 支持配置外接磁盘或 NAS 作为产物根目录，并展示实际挂载卷信息。
- [ ] Fanli 清理适配器支持 `plan` 和 `apply`，并通过路径越界、活动运行保护和幂等测试。
- [ ] MTC 能按年龄、数量、状态和空间配额生成稳定、可解释的清理计划。
- [ ] MTC 能保护活动任务、活动修复任务和用户保留任务。
- [ ] 自动清理异步运行，测试结果先进入终态并可立即查看。
- [ ] 项目清理成功后，MTC 同步更新任务索引与空间统计。
- [ ] 项目清理失败后，任务和结果索引保持可见，并提供重试入口。
- [ ] MTC 能回收自身过期 repair worktree，且不会删除正在使用的 worktree。
- [ ] 项目概览能展示项目产物、MTC 自有数据、配额、预计释放空间和最近清理结果。
- [x] 测试结果概览按测试条目展示对应的懒加载截图，并支持显示或隐藏图片。
- [ ] 现有手动删除终态任务功能保持兼容。

## Definition of Done

- Fanli QA 单元测试与三平台相关回归测试通过。
- MTC 单元测试、集成测试、类型检查和开源边界检查通过。
- 配置 schema、接入文档、示例项目和迁移说明同步更新。
- 对现有 33 GiB 历史产物先生成 dry-run 报告，经确认后执行首次清理。

## Out of Scope

- 云端对象存储和跨机器共享产物。
- 产物压缩、内容寻址去重和增量上传。
- 清理项目源码、依赖缓存、系统级 Xcode DerivedData 或 Gradle 全局缓存。
- 首次上线时直接删除现有 33 GiB 数据。

## Open Question

- 默认总空间软上限采用 10 GiB，或采用更宽松的 20 GiB？

## Technical Notes

- MTC: `src/server/task-manager.ts`, `src/server/config.ts`, `src/server/repair-job-manager.ts`, `src/server/state-store.ts`
- Fanli: `qa/mobile-test.config.cjs`, `packages/lynx/scripts/qa/qa-mobile-test-console.cjs`, `packages/lynx/scripts/qa/qa-ios-oneclick.cjs`
- Research: [`research/retention-conventions.md`](research/retention-conventions.md)
