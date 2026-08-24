# 支持测试条目折叠

## Goal

为运行状态列表提供整体折叠能力，减少测试条目较多时占用的页面空间，同时保留当前运行状态和条目数量信息。

## Requirements

- 运行状态区域提供可访问的折叠/展开控制。
- 展开状态显示现有全部运行条目；折叠状态隐藏条目列表。
- 控制按钮反映当前状态并支持键盘操作，折叠时保留标题和记录数量。
- 折叠状态仅作用于当前页面会话，刷新页面后恢复默认展开。

## Acceptance Criteria

- [ ] 运行状态列表默认展开，点击控制后隐藏/显示 `.run-list`。
- [ ] 控制按钮包含 `aria-expanded` 和明确的 `aria-controls`，视觉上有展开方向反馈。
- [ ] 现有条目点击、停止、保留、删除和详情焦点行为保持不变。
- [ ] TypeScript 检查和相关前端测试通过。

## Notes

- Keep `prd.md` focused on requirements, constraints, and acceptance criteria.
- Lightweight tasks can remain PRD-only.
- For complex tasks, add `design.md` for technical design and `implement.md` for execution planning before `task.py start`.
