# Trellis 迁移清单

MTC 仓库是本任务通用开发资料的权威位置。

## 当前任务

| MTC 文件 | 来源或用途 |
| --- | --- |
| `prd.md` | 合并 Fanli `.trellis/tasks/08-13-mtc/prd.md`，并使用 MTC 视角修正跨仓库路径和验收状态 |
| `task.json` | 同步任务身份，补充 MTC/Fanli 相关文件和仓库边界 |
| `implement.jsonl` | MTC 实现所需规范与研究上下文 |
| `check.jsonl` | MTC 检查所需规范与验证上下文 |
| `implement.md` | 页面选择、重试合并、活动锁定和整链删除的实施记录 |
| `research/fanli-adapter.md` | 从 Fanli 配置、Provider、Runner、页面解析和 QA 文档提取的项目适配上下文 |
| `research/decision-history.md` | 本轮讨论形成的产品与技术决策 |
| `research/verification.md` | MTC 与 Fanli 已执行的验证命令和结果 |

## 既有 MTC 归档

以下相关历史任务已保存在 MTC：

- `.trellis/tasks/archive/2026-08/08-13-manual-result-retry/`
- `.trellis/tasks/archive/2026-08/08-13-single-case-retry-filter/`
- `.trellis/tasks/archive/2026-08/08-13-collapse-retry-run-row/`

## 规范与日志

- `.trellis/spec/backend/mobile-test-console-integration.md` 保存 MTC 通用跨层契约。
- `.trellis/spec/frontend/component-guidelines.md` 保存页面选择和结果重试交互契约。
- `.trellis/workspace/loumzy/journal-1.md` 已保存此前 MTC 重试与小程序接入会话。
- `.trellis/workspace/loumzy/index.md` 已索引对应会话。

Fanli 仓库继续保留原任务副本与 `lynx-page-automation.md` 项目规范，用于项目侧适配追溯。
