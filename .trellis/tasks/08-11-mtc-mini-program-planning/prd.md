# 评估 MTC 并规划小程序测试支持

## Goal

将 Mobile Test Console（MTC）从 Fanli 单一项目语境中抽离，评估当前产品与工程完整度，并形成下一阶段可执行规划。若现有 App 测试能力已经满足阶段目标，则以 `/Users/loumzy/workspace/mini-program/saas-mini-program` 为首个目标项目，规划小程序测试支持。

用户价值：在同一个测试控制台内管理不同终端类型的测试工作，同时保持 App 与小程序在信息架构、项目配置、测试能力和结果展示上的清晰边界。

## Confirmed Facts

- MTC 当前代码库位于 `/Users/loumzy/workspace/app/mobile-test-console`，控制服务使用 Node / Fastify，控制台使用 React / Vite；Lynx App 是其被测项目类型之一。
- 后续开发不再绑定 Fanli 项目语境。
- 首个小程序目标项目位于 `/Users/loumzy/workspace/mini-program/saas-mini-program`。
- App 与小程序的测试内容和项目模型存在差异，产品布局需要明确分区。
- 本阶段先做现状审查与规划，实施需在规划评审通过后启动。
- MTC 当前完整质量门禁通过：38 个测试文件、283 个测试通过，lint、类型检查、Schema、构建、开源检查和发布包检查均通过。
- MTC 已有通用项目目录、Provider、Runner、Result Bundle 和 Connector 能力协议；`integrationType` 与结果协议已接受 `mini-program`。
- 小程序支持目前停留在协议骨架：真实 Connector 尚未接入，项目卡片明确标记为后续能力；核心 `Platform`、设备发现、测试入口和工作区仍限定 Android / iOS / HarmonyOS。
- 当前 MTC 产品导航以项目运行态的通用工作区展开，App / 小程序尚无一级分区和各自的上下文工作区。
- MTC 运行代码未发现 Fanli 业务字面量；`.trellis/spec/backend/mobile-test-console-integration.md` 仍大量绑定 Fanli 契约，项目知识需要重构为平台通用规范与项目适配规范。
- 历史 Trellis 任务中有已满足验收但仍标记 `in_progress` 的任务，也有“移除 Codex 修复链路”的未落地任务；当前源码仍保留 RepairJob / Codex 相关实现。
- `saas-mini-program` 使用 Taro 4 + React 18，目标微信小程序，生产构建目录为 `dist/`，已使用微信开发者工具与 `miniprogram-automator` 建立完整的本机 E2E 运行底座。
- `saas-mini-program` 已有 Unit、Smoke、全页面巡检、业务流程、录制回放、结果目录、静态报告、截图、资源隔离与清理协议；其测试体系适合作为 MTC 首个小程序项目适配器的能力来源。
- `saas-mini-program` 当前 P0 门禁依赖正式动态 fixture 契约，已完成的稳定路径包括角色入口、组织切换和店铺营业状态流程。

## Requirements

- 审查 MTC 当前功能、代码结构、测试、文档、配置和遗留业务耦合，识别影响通用化与稳定性的完善项。
- 对完善项按用户价值、风险和前置依赖排序，并判断 App 测试能力是否达到进入小程序支持阶段的基线。
- 分析 `saas-mini-program` 的框架、目录、构建方式、页面组织、环境配置及可测试接口。
- 设计 App / 小程序分区的信息架构、导航、项目模型和测试能力边界。
- 明确首期小程序测试的 MVP 范围、验收方式、兼容性与回滚策略。
- 保留现有 App 测试数据和工作流的兼容路径。

## Acceptance Criteria

- [ ] 形成基于代码与配置证据的 MTC 现状审查清单，并区分阻塞项、应完善项和后续项。
- [ ] 给出是否优先继续完善 MTC App 能力的明确结论及判断依据。
- [ ] 形成 `saas-mini-program` 技术画像和首期可测试范围。
- [ ] `design.md` 明确 App / 小程序的产品分区、领域边界、核心数据流、兼容与迁移方案。
- [ ] `implement.md` 提供分阶段实施清单、验证命令、风险点和回滚点。
- [ ] 用户评审并批准规划后，任务才能进入实现阶段。

## Out of Scope

- 本轮规划阶段不直接实现功能。
- 首期规划聚焦 `saas-mini-program`，其他小程序项目留作后续兼容验证。

## Open Questions

- 首期小程序支持采用“编排项目现有测试体系并统一展示结果”，还是同时重构项目测试运行器为 MTC 原生 Connector / Provider。

## Notes

- 本任务属于复杂规划，完成前需要 `prd.md`、`design.md` 和 `implement.md`。
