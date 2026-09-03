# FEATURE-418 历史结果截图对比

## 目标

在 Mobile Test Console 中选择两个已完成的历史运行，按页面截图配对后做并排/滑杆对比；某一侧缺失的页面给出可定位提示。主目录与 worktree 作为两个路径项目，各自走现有多项目 Runtime，原图不搬家。

## 背景 / 已知事实

1. 用户已导入主目录 `/Users/fengit/workspace/biaoju/saas-mini-program`（`saas-mini-program-79cc7f8c`）和 worktree `sp-org`（`sp-org-3ddb7984`），需要对比两边的小程序页面截图。
2. 页面巡检截图文件名已包含角色和路由，例如 `newCustomer-pages_index.jpg`。真实 Result Bundle 的 `artifacts[].label` 就是该文件名，`role` 为 `screenshot`。
3. 同一轮巡检的四张截图挂在同一个 `caseId`（`tests/e2e/specs/wechatide-page-matrix.e2e · 最新版微信开发者工具全页面巡检`）下，通过 `case.evidenceRefs` 引用。配对主键采用 `caseId + screenshot.label`。
4. 现有结果读取入口是 `GET /api/tasks/:taskId/result` 与 `GET /api/tasks/:taskId/artifacts/:artifactId`。请求通过 `x-mtc-project-id` / `projectId` 绑定**一个** Runtime（`src/server/app.ts` onRequest hook）。对比必须同时读两个 `projectId`，不能复用单 Runtime 绑定。
5. `ProjectRuntimeRegistry.resolve(projectId)` 已按路径项目 ID 隔离 TaskManager、ResultBundleStore、TaskResultService。截图 URI 形如 `project://<projectId>/.test/results/<runId>/wechatide-page-matrix/<label>`。
6. 主目录当前历史任务是 Smoke，没有页面矩阵 Result Bundle；worktree `sp-org` 与 `FEATURE-403-infrastructure` 各有完整四角色 JPG。验收用真实 JPG 做配对，主目录无巡检截图时明确提示“该运行没有截图”。
7. 运行详情已有截图页签（`ScreenshotResult`），没有跨任务/跨项目对比入口。小程序工作区目前只有「项目概览」和「执行测试」。

## 需求要点

1. **选择两个历史结果**：从已登记项目中各选一个终态任务（可同项目、可主目录 vs worktree）。入口在独立「截图对比」工作区，测试页运行记录提供「加入对比」。
2. **配对**：默认 `caseId + screenshot.label`。一侧 `caseId` 对不上时，对剩余未匹配项按 `label` 补配，保证页面矩阵文件名稳定配对。
3. **对比视图**：选中一对后主区域默认左右并排；可切换滑杆覆盖。顶部展示两侧项目名、目录末段、任务时间、任务 ID。
4. **缺失页提示**：
   - 只在左侧：`仅左侧存在`
   - 只在右侧：`仅右侧存在`
   - 任务不存在或 Result Bundle/文件已清理：该侧显示 `源截图已清理` 或任务级错误，不中断另一侧已有页。
   - 选中的任务没有截图：候选列表或对比页给出可定位空态。
5. **数据隔离**：原图继续由各自项目 Runtime 提供，URL 带对应 `projectId`。对比结果只存两个 `{projectId, taskId}` 引用和配对索引，不复制图片。
6. **刷新恢复**：浏览器记住最近一次左右选择，重新打开工作区可再次请求对比。

## 范围外

- 一键「对比运行」（同时创建 A/B 两个测试任务）
- 像素差异、阈值、热区、基准审批、HTML 报告导出
- 给 Result Bundle 增加 `comparisonKey` 字段
- 修改页面巡检 Runner 的截图文件名规则
- 把主目录补跑出页面矩阵（主目录当前没有巡检截图时，用空态说明）

## 验收标准

- [ ] 从目录末段可区分的两个项目中，各选一个终态运行后能打开对比页
- [ ] 四张页面矩阵截图（`newCustomer/shopEmployee/shopManager/shopOwner-pages_index.jpg`）按 label 配对成功
- [ ] 并排模式同时显示左右原图；滑杆模式可拖动分界
- [ ] 故意缺少一侧某张图时，列表与主区域出现「仅左侧存在」或「仅右侧存在」
- [ ] 源任务删除或截图文件缺失时，对应页显示「源截图已清理」，另一侧仍可看
- [ ] 对比 API 分别解析两个 `projectId` 的 Runtime，不把 worktree 截图读到主目录 Runtime
- [ ] 回归测试覆盖配对函数、跨项目 HTTP 对比、缺失页 UI
- [ ] 用 `sp-org` 与 `FEATURE-403-infrastructure`（或主目录若有巡检截图）的真实 JPG / Result Bundle 跑通配对验证
