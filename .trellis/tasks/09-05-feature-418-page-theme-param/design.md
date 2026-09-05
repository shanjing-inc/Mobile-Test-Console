# 设计：控制台注入页面巡检外观

## 边界

MTC 拥有测试入口参数的展示和命令 env。项目拥有 `E2E_THEME` 的消费（模拟器主题、截图文件名）。本任务只做 MTC 侧注入。

## 数据流

```
loadProjectConfig / snapshot
  → ensurePageInspectionTheme(tests)
  → PublicTestDefinition.parameters 含 theme
  → 测试页 select「外观」
  → startTasks parameters.theme
  → resolveTargetCommand env.E2E_THEME
  → 项目 pnpm test:e2e:pages
```

## 方案

在 `src/server/page-inspection-theme.ts` 提供：

- `PAGE_INSPECTION_THEME_PARAMETER`：`id=theme`，`label=外观`，`type=select`，`light/dark`
- `isPageInspectionTest(test)`：`kind === "page"` 且参数含 `page-selection`
- `ensurePageInspectionTheme(test)`：满足条件则追加参数；各 platform command.env 缺 `E2E_THEME` 时写入 `{{params.theme}}`
- `ensureConfigPageInspectionTheme(config)`：对 `tests` / `mainConfigTests` / `sidecarTests` 就地处理

调用点：

1. `loadProjectConfig` 返回前
2. `GET /api/snapshot` 返回前（覆盖已缓存 Runtime，避免必须重启 MTC）

就地修改 Runtime 持有的 `config.tests`，`validateParameters` 与命令解析看到同一份参数。

## 取舍

| 方案 | 结论 |
|---|---|
| 只改各小程序 worktree 的 config | 用户明确要求本 issue 改 FEATURE-418 |
| 只 reload 磁盘配置 | FEATURE-403 当时磁盘没有 theme，界面仍空 |
| 控制台注入参数 + env | 所有已导入巡检入口立刻出现「外观」，命令能传主题 |

已声明 `theme` 的项目：参数不去重追加；env 已有 `E2E_THEME` 则不覆盖。

## 兼容

- 默认 `light`，旧截图流程不变
- 未知 `theme` 值仍走现有 `PARAMETER_INVALID`
- 不改 snapshot schema，只多一个已支持的 select 参数

## 回滚

删除 `page-inspection-theme.ts` 及其调用即可；项目自己声明的 theme 不受影响。
