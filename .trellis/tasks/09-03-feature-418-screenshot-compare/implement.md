# 实现清单

## 顺序

1. 纯函数配对：`src/shared/screenshot-comparison.ts`（key、label 解析、pairScreenshots）。
2. 合约类型放入 `src/shared/contracts.ts`。
3. 服务：`src/server/screenshot-comparison.ts`（读两侧 Runtime、组装 URL、side.error）。
4. HTTP：`src/server/app.ts` 增加 candidates GET 与 comparisons POST；handler 显式 `runtimes.resolve`。
5. 前端 API：`src/web/api.ts`。
6. 工作区：`project-workspaces.ts` + `ScreenshotComparisonWorkspace.tsx` + `App.tsx` 入口/「加入对比」+ `styles.css`。
7. 测试：配对、HTTP 跨项目、缺失页 UI、真实 Result Bundle 配对。
8. spec：在 `mobile-test-console-integration.md` 追加截图对比场景。

## 验证命令

```bash
pnpm exec vitest run tests/screenshot-comparison.test.ts tests/web-screenshot-comparison.test.ts tests/web-project-workspaces.test.ts
pnpm exec vitest run tests/task-results.test.ts tests/project-runtime.test.ts
pnpm typecheck
```

真实截图验证（本机路径存在时跑，不断言用户机器以外的环境）：

- 读取 `sp-org` 与 `FEATURE-403-infrastructure` 的 Result Bundle
- 断言四张 `*-pages_index.jpg` 全部 `presence=both`
- 去掉右侧一张后断言 `left-only`

## 风险文件

- `src/server/app.ts`：onRequest 单 Runtime 绑定，对比路由必须自己 resolve。
- `src/web/api.ts` 的全局 `x-mtc-project-id`：截图 URL 用 query `projectId`，对比 POST 不依赖当前项目头。
- `src/web/project-workspaces.ts`：小程序目前拦截非 tests 视图，必须给 `screenshot-compare` 开例外。

## 回滚点

对比代码全部是新增路径；若 HTTP 测试失败，先保留纯函数与 UI，不下线现有截图页签。
