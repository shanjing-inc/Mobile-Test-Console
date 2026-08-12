# 精简 Mobile Test Console Codex 功能

## Goal

Mobile Test Console 聚焦失败结果诊断与错误信息复制，移除无法稳定传递参数和启动 Codex 任务的功能，降低控制台运行时依赖与维护成本。

## What I already know

* 控制台位于相邻 Git 项目 `../mobile-test-console`。
* 失败用例诊断区当前展示“交给 Codex 修复”，并支持确认、创建修复任务、重试复测、打开 Codex 任务和取消任务。
* Fanli 适配配置 `qa/mobile-test.config.cjs` 当前配置 `codexRepair`，其中包含 Codex 可执行文件和 replay 命令。
* 用户要求保留复制错误的功能，移除启动 Codex 的部分。

## Assumptions (temporary)

* 复制错误信息沿用现有错误详情复制能力与提示样式，内容使用完整诊断上下文。
* 本次变更同时覆盖控制台前端、服务端 Codex 修复链路、共享类型、测试和 Fanli 配置。

## Decision (ADR-lite)

**Context**: Codex 启动链路无法稳定传递页面参数，控制台需要保留人工诊断入口。
**Decision**: 失败用例复制操作输出完整诊断上下文，包含错误信息、页面、设备、参数和关键证据；控制台移除 Codex 启动和修复任务链路。
**Consequences**: 人工可以直接复制上下文交给外部工具处理，控制台运行时依赖更少；复制内容持续遵循现有脱敏规则。

## Requirements

* 失败结果诊断区提供复制错误信息操作。
* 控制台页面不展示启动、确认、重试、取消或打开 Codex 修复任务的入口。
* 服务端不初始化或暴露 Codex 修复任务接口。
* Fanli 适配配置移除 `codexRepair` 配置块，同时保留失败复测与错误证据产出能力。
* 复制内容遵循现有 JSON 格式化和脱敏后的结果数据。
* 更新相关测试和文档，保证构建、类型检查和测试通过。

## Acceptance Criteria

* [ ] 用户可以从失败用例诊断区复制错误信息，并获得成功或失败反馈。
* [ ] 复制内容包含错误、页面、设备、参数和关键证据。
* [ ] 页面渲染结果中不存在启动 Codex 的操作入口。
* [ ] 控制台启动不要求 Codex 可执行文件、App Server 或修复服务初始化。
* [ ] 相关 API、类型和测试与移除后的能力边界一致。
* [ ] 控制台测试、类型检查和构建通过。

## Definition of Done

* 测试覆盖复制错误和 Codex 入口移除。
* lint、typecheck、测试和构建通过。
* 文档同步描述当前能力边界。

## Out of Scope

* 修改 Fanli QA 页面测试、复测命令和诊断证据格式。
* 新增自动错误分析或人工修复工作流。
* 删除独立的 Codex 本地 QA runner 文档和命令。

## Technical Notes

* 重点文件：`../mobile-test-console/src/web/App.tsx`、`src/web/api.ts`、`src/server/app.ts`、`src/server/cli.ts`、`src/server/repair-job-manager.ts`、`src/shared/contracts.ts`、相关测试与 README。
* Fanli 配置：`qa/mobile-test.config.cjs`。
* MCP 未提供 `lynx-docs` 资源，本任务主要修改 Mobile Test Console 控制台及其 Fanli QA 适配层。
