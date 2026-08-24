# 小程序项目类型筛选

## Goal

在“小程序”tab 中添加项目时，初始化流程生成小程序类型项目配置，使登记结果归入小程序项目列表并使用小程序运行目标模型。

## Confirmed Facts

- 项目侧栏以 `ProjectFamily` 区分 App 与小程序，切换到小程序 tab 后可进入添加项目页面。
- 当前初始化请求只携带 `projectDirectory` 与 `platforms`。
- `ProjectCatalogService.buildInitializationPlan` 固定生成 Lynx App 配置与 Smoke 脚本，因此小程序 tab 的初始化结果仍为 App 类型。
- 已有项目配置登记会从配置文件读取 `integrationType`，本次范围是缺少配置文件时的初始化流程。

## Requirements

- 添加项目时使用当前侧栏 tab 的项目类型作为初始化类型。
- 小程序 tab 的初始化计划与写入配置声明 `integrationType: "mini-program"`。
- 小程序初始化流程提供适配小程序运行环境的配置骨架，不展示 App 设备平台选择。
- App tab 保持现有 Lynx App 初始化流程与平台选择行为。
- 初始化计划预览与实际应用使用同一项目类型，避免预览结果和写入文件不一致。

## Acceptance Criteria

- [ ] 在小程序 tab 中初始化项目后，生成的配置包含 `project.integrationType: "mini-program"`。
- [ ] 新登记项目在侧栏“小程序项目”列表中显示，并采用小程序工作区能力。
- [ ] 小程序初始化页面不显示 Android、iOS、HarmonyOS 的 App 平台勾选项。
- [ ] App 初始化仍生成既有 Lynx App 配置，现有项目目录接入流程保持可用。
- [ ] 前端组件测试和项目目录服务测试覆盖 App 与小程序初始化分支。

## Out of Scope

- 为小程序初始化流程生成真实微信开发者工具命令或项目 Runner 实现。
- 修改已有项目配置的类型或迁移历史项目。

## Open Questions

- 无。

## Notes

- Keep `prd.md` focused on requirements, constraints, and acceptance criteria.
- Lightweight tasks can remain PRD-only.
- For complex tasks, add `design.md` for technical design and `implement.md` for execution planning before `task.py start`.
