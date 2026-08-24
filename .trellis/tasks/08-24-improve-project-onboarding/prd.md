# 优化新项目接入引导

## Goal

降低开源用户首次接入项目时的理解和操作成本，让用户能从项目接入中心明确知道当前阻塞项、需要执行的动作，以及可用的项目模板与文档入口。

## Confirmed Facts

- 项目接入中心使用项目目录、接入配置、运行环境、项目能力四个检查步骤决定是否可执行测试。
- 运行环境步骤会执行 `testing.targets[].healthCheck`；失败详情会展示环境检查输出和配置建议。
- 项目能力步骤要求在 `testing.capabilities` 中声明 Project Provider，并提供“生成能力模板”操作。
- 现有界面将未完成步骤自动展开，展示说明、下一步、工具检查详情和需要处理项。
- 仓库提供 README、Lynx App 接入指南、Lynx App Starter 与最小完整示例。

## Requirements

- 将首次接入流程表达为面向任务的引导，使每个未完成步骤具备清晰的目标、单一主要操作和完成反馈。
- 优化运行环境与项目能力的失败信息，区分用户动作、检查结果、配置位置和可复制的解决路径。
- 为开源用户提供与当前项目类型匹配的模板或文档入口。
- 首期同时覆盖 Lynx App 与小程序；两类项目共用接入主流程，并按项目类型提供对应模板、术语和帮助入口。
- 首次引导以“跑通首个测试”为完成标准：接入检查通过后，用户应进入可执行的示例测试或项目测试入口并看到结果。
- 面向没有 MTC、Provider、Runner 或 health check 使用经验的开源用户设计引导，优先呈现用户目标和可点击动作，再按需展示术语、配置路径和原始检查详情。
- 基础配置和能力骨架继续使用“预览后确认执行”的安全写入方式；预览明确展示会写入的文件、执行的命令和复检结果。
- 保持现有接入检查、模板生成和重新验证能力可用。

## Acceptance Criteria

- [x] 首次接入项目时，用户可在首屏识别当前所处步骤、剩余步骤和下一项需要完成的操作。
- [x] 每个阻塞项提供明确的处理目标、一个主要操作、配置文件位置或命令信息，以及完成后的验证入口。
- [x] 项目能力引导以用户收益解释 Provider 的作用，并让用户可直接预览和生成适配项目类型的能力模板，或打开对应接入文档。
- [x] 运行环境引导说明环境检查的目的，以易理解的状态呈现检查结果；原始命令、输出和技术术语保留在可展开详情中。
- [x] 小程序运行目标缺少 `healthCheck` 时，页面展示可复制的配置与脚本示例；新项目初始化直接生成对应检查骨架。
- [x] 完成接入操作后，界面自动重新验证状态，并提供清晰的“运行首个测试”入口。
- [x] 小程序与 Lynx App 的引导使用对应术语、模板和文档链接，同时共享一致的步骤结构。
- [x] 既有项目接入中心、配置校验和 Web 测试持续通过。

## Out Of Scope

- 改变 `mobile-test.config.cjs`、Provider、Runner 或 health check 的底层契约。
- 为所有项目类型新增完整的自动化初始化实现。

## Open Questions

无。规划已获确认。

## Notes

- Keep `prd.md` focused on requirements, constraints, and acceptance criteria.
- Lightweight tasks can remain PRD-only.
- For complex tasks, add `design.md` for technical design and `implement.md` for execution planning before `task.py start`.
