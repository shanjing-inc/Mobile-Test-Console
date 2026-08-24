# 实施计划

1. 在 `src/web/result-analysis.ts` 增加 Suite 识别与安全统计 helper，并覆盖通过、失败、跳过和耗时。
2. 在 `src/web/App.tsx` 增加 Suite 列表摘要、工具栏统计和测试点详情分支。
3. 在 `src/web/styles.css` 增加 Suite 详情布局与 390px 响应式样式。
4. 在 `tests/web-results.test.ts` 增加 Suite SSR 回归测试，验证页面专属信息隐藏、统计、详情、失败诊断与重试入口。
5. 运行 `pnpm vitest run tests/web-results.test.ts`、`pnpm lint`、`pnpm typecheck`、`pnpm test`、`git diff --check`。
6. 启动开发服务器并对真实 Suite Result Bundle 执行桌面与 390px 视觉验证。

## 回滚点

- 删除 `executionKind === suite` 展示分支即可恢复通用结果布局。
