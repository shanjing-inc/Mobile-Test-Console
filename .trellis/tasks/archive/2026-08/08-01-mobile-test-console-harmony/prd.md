# 修复 Mobile Test Console Harmony 一键启动参数解析失败

## Goal

修复 Mobile Test Console 在 Harmony 设备上执行“平台 One-click”时的 Ability 启动参数解析失败，保持平台基础冒烟测试能够完成构建、安装、启动、自动操作和证据采集。

## What I already know

- 控制台的 `platform-oneclick` 入口调用 `qa-mobile-test-console.cjs oneclick`，Harmony 分支最终执行 `qa-harmony-oneclick.cjs`。
- 平台 One-click 用于当前平台的基础冒烟：复用 QA Lynx 资源，构建并安装 QA App，启动 App，执行短时自动操作，采集截图、日志和结构化摘要。
- 失败产物 `qa/history/artifacts/fanli-20260801014506-807a79ef/harmony-oneclick.log` 显示 `aa start` 收到 `--ps qaPage ""` 与 `--ps qaFixture ""`，HDC 返回 `invalid number of parameters for option --ps`。
- 页面套件会提供非空 `qaPage`；裸平台 One-click 没有指定页面，预期启动 App 默认入口并执行平台基础冒烟。

## Requirements

- Harmony Ability 启动命令仅携带有值的可选字符串参数。
- 裸平台 One-click 保持默认 App 启动路径和现有 monkey、截图、日志采集行为。
- 页面套件继续传递非空 `qaPage`、`qaFixture` 和导航参数。
- HDC 已有的设备断开、安装失败、Ability 启动失败分类保持有效。

## Acceptance Criteria

- [x] 未提供 `--qa-page` 与 `--qa-fixture` 时，Harmony `launch-app` 命令不包含空参数值。
- [x] 未提供页面时，命令不包含 `--ps qaPage` 与 `--ps qaFixture`。
- [x] 提供页面与 fixture 时，两组参数保持完整传递。
- [x] 本任务相关 QA 脚本单元测试通过。
- [x] 连接的 Harmony 设备上，平台 One-click 可以越过 Ability 启动步骤。

## Definition of Done

- 回归测试覆盖空值与非空值两种启动命令。
- QA 相关测试通过。
- 当前任务的 Trellis 记录与代码一起提交。

## Technical Approach

在 Harmony one-click 启动参数构造处按值追加 `qaPage` 与 `qaFixture`，保留必需 QA 上下文参数和非空 Base64 导航参数。测试直接检查 `buildSteps()` 产出的 `launch-app.command`，避免依赖 HDC 环境复现参数数组。

## Decision (ADR-lite)

**Context**：Harmony `aa start --ps` 要求键和值成对出现，Node 子进程传入的空字符串会被 HDC 解析为缺失值。

**Decision**：把 `qaPage` 与 `qaFixture` 视为可选 Want 参数，仅在值非空时追加。

**Consequences**：裸平台冒烟启动默认 App 页面；页面级测试仍通过显式页面参数进入目标 Lynx 页面。

## Out of Scope

- 调整 Mobile Test Console 的测试入口 UI。
- 改变 Android、iOS One-click 的默认页面行为。
- 修改 Harmony monkey 的随机动作策略。

## Technical Notes

- 控制台配置：`qa/mobile-test.config.cjs`
- 控制台桥接：`packages/lynx/scripts/qa/qa-mobile-test-console.cjs`
- Harmony 启动命令：`packages/lynx/scripts/qa/qa-harmony-oneclick.cjs`
- 回归测试：`packages/lynx/scripts/qa/__tests__/qa-platform-oneclick.test.cjs`
- 相关契约：`.trellis/spec/backend/mobile-test-console-integration.md`、`.trellis/spec/frontend/lynx-page-automation.md`
- 设备验证：`mobile-test-console-harmony-fix-20260801` 在 `127.0.0.1:5555` 上通过 Ability 启动与进程存活检查。
- 全量 `qa:test` 共 254 项，253 项通过；剩余失败来自工作区既有 `IPHONEOS_DEPLOYMENT_TARGET = 16` 改动与测试契约 `16.6` 的差异。
