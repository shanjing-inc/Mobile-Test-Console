# Mobile Test Console Codex 修复集成（延期规划）

## 状态

- 优先级：P3
- 阶段：planning / deferred
- 当前决定：保留现有测试、RepairJob、worktree 和复测能力；暂停继续投入 ChatGPT 可见任务集成。
- 恢复条件：自动修复成为高频需求，或 Codex 提供稳定的 Desktop 任务创建与可见性契约。

## 背景

Mobile Test Console 已具备失败用例选择、错误上下文预览、独立 worktree、Codex 修复、同参数复测和 patch 产出能力。近期实现尝试通过独立 `codex app-server --stdio` 创建持久化 thread，并用 `codex://threads/<id>` 打开 ChatGPT Desktop。

当前链路能够获得 `codexThreadId`，真实 ChatGPT Desktop 任务列表可见性仍缺少稳定契约和端到端验证。现有自动化测试使用模拟 App Server，只覆盖协议交互、代码变更和复测结果。

## 已确认结论

1. Mobile Test Console 的 `RepairJob` 继续作为修复状态、证据、worktree、复测和制品的主记录。
2. Codex App Server 适合构建自有客户端；它创建的 thread 与 ChatGPT Desktop 项目任务属于不同产品表面，可见性需要单独验证。
3. 自动化修复任务后续优先使用 Codex SDK，减少手写 App Server JSON-RPC、进程管理和协议兼容代码。
4. ChatGPT 可见协作任务后续通过 Desktop 内原生创建，并使用项目 skill/MCP 读取 RepairJob、回传状态和触发复测。
5. Codex Cloud 可以提供 Web 可见任务；当前标准流程依赖 GitHub 仓库和 Cloud Environment。Fanli 使用阿里云代码库，接入前需要确定私有镜像、凭据与证据脱敏方案。
6. Multica 可继续作为测试执行或设备验证提供方；阿里云代码库 skill 负责人工审核后的分支、提交、推送和 MR 交付。

## 后续目标架构

```text
Mobile Test Console
  -> FailureClassifier
  -> RepairJob + ReplaySnapshot
  -> AgentProvider
       -> Codex SDK（后台自动修复）
       -> Codex Desktop Skill/MCP（可见协作任务）
       -> Codex Cloud（远期可选）
  -> Worktree + Patch
  -> 原设备、账号、参数复测
  -> 人工审核
  -> 阿里云代码库 Skill 交付
```

## 分阶段计划

### 阶段 A：稳定现有闭环

- 将 `executionProvider`、`visibilityStatus` 和 `codexThreadId` 分开建模。
- `codexThreadId` 表示 Codex thread 已创建；`visibilityStatus` 单独记录 Desktop 可见性验证结果。
- 保留失败分类。设备锁、登录、安装和账号画像等前置失败进入人工处理或重新复测，页面断言失败进入代码修复。
- RepairJob 继续持久化完整证据、事件、patch 和复测结果。

### 阶段 B：Codex SDK 自动修复

- 用 `@openai/codex-sdk` 实现默认 `AgentProvider`。
- 复用当前 worktree、紧凑提示词、结构化输出、取消、幂等和两轮复测机制。
- 控制台作为后台修复任务的唯一状态展示入口。

### 阶段 C：ChatGPT Desktop 可见协作

- 建立 `mobile-test-repair` skill 与本地 MCP。
- MCP 提供获取 RepairJob、认领任务、追加事件、完成修复和请求复测能力。
- 控制台准备 worktree 和提示词后，通过 `codex app <worktree>` 打开 Desktop。
- 开发者在 Desktop 中提交 `$mobile-test-repair <repairJobId>`，任务由 Desktop 原生创建并回调控制台。

### 阶段 D：阿里云代码交付

- 复测通过后进入 `ready_for_review`。
- 开发者确认后由阿里云 skill 创建 `codex/repair/<repairJobId>` 分支、中文提交和 MR。
- RepairJob 保存远端分支、commit、MR 地址与操作记录。

### 阶段 E：Codex Cloud 评估

- 评估阿里云仓库到 GitHub 私有镜像的同步方式。
- 评估 Cloud Environment、凭据、依赖缓存和失败证据上传方案。
- 通过 `codex cloud exec` 创建 Web 可见任务，下载 diff 到本地 worktree 后执行真机复测。

## 未来验收条件

- 后台自动修复使用稳定 SDK，并完整保留 RepairJob 状态与制品。
- Desktop 协作任务由 Desktop 原生创建，可在任务列表中打开和继续对话。
- Desktop skill/MCP 能回传任务状态、修复结果并触发同参数复测。
- 真实 Android 或 iOS 用例完成“失败、修复、复测、审核、阿里云 MR”的端到端演练。
- 服务重启、设备离线、重复触发和取消操作保持幂等与可恢复。

## 当前范围

本任务仅保留规划和已知限制。当前阶段不继续调整 Mobile Test Console、Codex App Server、Fanli QA runner 或阿里云交付代码。

