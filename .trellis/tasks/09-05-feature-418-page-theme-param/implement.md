# 实现清单

1. 新增 `src/server/page-inspection-theme.ts`：识别页面巡检测试、注入 `theme` 参数、补 `E2E_THEME` 模板。
2. `loadProjectConfig` 返回前调用 `ensureConfigPageInspectionTheme`。
3. `GET /api/snapshot` 组 tests 前对 `options.config` 再调用一次，让已加载 Runtime 立刻可见。
4. 新增 `tests/page-inspection-theme.test.ts`：
   - 带页面选择的 page 测试注入外观且命令 env 含 `E2E_THEME=dark`
   - 已有 theme 不重复
   - smoke / 无页面选择的 page 测试不注入
5. 不提交 FEATURE-418 工作区里与本任务无关的未提交改动（README、project.id 等）。
6. 验证：`pnpm exec vitest run tests/page-inspection-theme.test.ts`；本地 snapshot 刷新后页面巡检出现「外观」。
