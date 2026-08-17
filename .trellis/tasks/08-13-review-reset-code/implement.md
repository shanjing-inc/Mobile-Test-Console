# 实施计划

1. 读取相关 Trellis 规范、历史任务、Lynx 文档和当前完整差异，建立跨层字段与状态映射。
2. 审核页面选择链路，检查默认选择、显式冻结、筛选、全选当前、清空和校验行为。
3. 审核复测创建与范围下发，检查 API、任务持久化、RunPlan、命令模板、环境变量和 Provider 生命周期。
4. 审核结果累计合并、运行列表投影和删除重试链，覆盖兄弟重试、多层重试、部分通过与异常结果。
5. 审核现有测试的断言强度，先运行相关 Vitest；对确认问题实施最小修复并补充回归测试。
6. 运行 `pnpm lint`、`pnpm typecheck`、`pnpm test`、`pnpm schema:check`、`pnpm check:open-source`、`pnpm build` 和 `pnpm check:package`，最终以 `pnpm check` 复核完整门禁。
7. 执行 Trellis 质量检查与规范更新判断，核对最终 diff 和提交边界。
8. 暂存经审核的相关文件，使用中文提交信息提交，并检查提交结果与剩余工作区状态。

## 风险文件

- `src/server/app.ts`：API 输入校验、重试创建和任务列表投影集中于同一模块。
- `src/server/task-results.ts`：缓存指纹、附件归属和多次复测合并容易产生状态串扰。
- `src/server/task-manager.ts`：重试链遍历与清理涉及持久化和外部清理命令。
- `src/web/App.tsx`：来源行聚合、加载状态和操作锁需要与服务端状态同步。
- `src/runner/sdk.ts`、`src/runner/project-provider-command-runner.ts`：环境变量在不同 Runner 路径中需保持一致。

## 验证命令

```bash
pnpm vitest run tests/app.test.ts tests/task-manager.test.ts tests/task-results.test.ts tests/runner-sdk.test.ts tests/project-provider-command-runner.test.ts tests/web-delete.test.ts tests/web-page-selection.test.ts tests/web-results.test.ts tests/lynx-app-starter.test.ts
pnpm check
```

## 提交门禁

- 所有确认的高、中风险问题均已解决。
- 质量命令全部通过。
- `git diff --check` 通过。
- 暂存内容与本任务审核范围一致。
- 提交主题和正文使用中文。
