# 运行状态默认展示最近5条

## Goal

运行记录较多时优先展示最近五条，控制列表高度并保留查看全部记录的入口。

## Requirements

- 记录按现有列表顺序展示，默认只渲染最近五条。
- 当记录超过五条时，提供“查看更多”控制，展开后显示全部记录。
- 展开状态提供“收起”控制，恢复只显示最近五条。
- 五条及以内的记录保持现有列表展示，不显示多余控制。

## Acceptance Criteria

- [ ] 超过五条记录时默认只显示五个 `RunRow`。
- [ ] “查看更多”具备 `aria-expanded` 和 `aria-controls`，点击后显示全部记录。
- [ ] 点击“收起”恢复五条窗口，现有停止、保留、删除和聚焦行为保持不变。
- [ ] TypeScript、lint 和前端测试通过。

## Notes

- Keep `prd.md` focused on requirements, constraints, and acceptance criteria.
- Lightweight tasks can remain PRD-only.
- For complex tasks, add `design.md` for technical design and `implement.md` for execution planning before `task.py start`.
