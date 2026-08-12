# Codex 集成能力边界

## 当前实现观察

- Mobile Test Console 为每个 RepairJob 启动独立 `codex app-server --stdio`。
- `thread/start` 返回的 `codexThreadId` 会持久化到 RepairJob。
- `ephemeral: false` 保存 Codex thread 历史。
- `threadSource` 是客户端来源分类字段。
- `codex://threads/<id>` 用于导航到已存在的 thread。
- 当前测试通过模拟 App Server 验证协议交互，尚未覆盖真实 Desktop 任务列表。

## 官方能力边界

- Codex App Server 面向自定义客户端中的认证、对话历史、审批和流式事件集成。
- 自动化任务和内部工具优先使用 Codex SDK。
- Codex Cloud 任务可在 Web 中启动和审查，标准环境通过 GitHub 仓库配置。

参考：

- https://learn.chatgpt.com/docs/app-server
- https://learn.chatgpt.com/docs/codex-sdk
- https://learn.chatgpt.com/docs/cloud

## 保留决策

后续使用 `AgentProvider` 隔离 Codex SDK、Desktop Skill/MCP 和 Codex Cloud。RepairJob 继续承担业务状态，ChatGPT 可见性作为独立能力记录和验收。

