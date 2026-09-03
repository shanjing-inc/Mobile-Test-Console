# 设计：历史结果截图对比

## 边界

- **平台核心**拥有对比会话、配对算法、跨项目读取和对比 UI。
- **各项目 Runtime** 继续拥有任务索引、Result Bundle、截图文件和静态访问。
- **不改** Result Bundle schema、Runner 文件名、页面巡检命令。

## 数据流

```
UI 选择 left/right {projectId, taskId}
  → POST /api/screenshot-comparisons
  → runtimes.resolve(left.projectId).taskResults.load(left.taskId)
  → runtimes.resolve(right.projectId).taskResults.load(right.taskId)
  → pairScreenshots(left.runs.screenshots, right.runs.screenshots)
  → 返回 sides + pairs（artifact URL 带各自 projectId）
  → UI 并排 / 滑杆；缺失页用占位，不请求空 URL
```

原图仍走现有 `GET /api/tasks/:taskId/artifacts/:artifactId?projectId=`。

## 合约

### 配对键

```ts
screenshotComparisonKey(caseId, label) => `${caseId.trim() || "_"}::${label.trim()}`
```

1. 先按完整键配对。
2. 未匹配项再按 `label` 补配一次。
3. 仍未匹配 → `left-only` / `right-only`。

展示名：优先 `label`（去扩展名），必要时附 `targetPage`。页面矩阵 label `newCustomer-pages_index.jpg` 可解析出角色 `newCustomer` 与路由 `pages/index`，仅用于标题，不参与键。

### HTTP

`GET /api/projects/:projectId/screenshot-comparison/candidates`

- 走 catalog 路径，**不**依赖当前请求绑定的 Runtime。
- 列出该项目终态任务：`taskId`、`runId`、`testLabel`、时间、目录末段、`screenshotCount`（load 失败则 0 并带 `error`）。

`POST /api/screenshot-comparisons`

```json
{ "left": { "projectId": "...", "taskId": "..." }, "right": { "projectId": "...", "taskId": "..." } }
```

约束：left/right 都要有；允许同一项目两个任务；禁止同一 `taskId` 对比自己。

响应：

```ts
interface ScreenshotComparison {
  comparisonId: string; // sha1(left.projectId:taskId|right.projectId:taskId).slice(0,16)
  left: ScreenshotComparisonSide;
  right: ScreenshotComparisonSide;
  pairs: ScreenshotComparisonPair[];
}

interface ScreenshotComparisonSide {
  projectId: string;
  projectName: string;
  projectRoot: string;
  directoryName: string;
  taskId: string;
  runId: string;
  testLabel: string;
  createdAt: string;
  finishedAt: string;
  sourceRevision: string; // Result Bundle provenance，没有则空串
  error: string;          // 任务不存在、结果不可读
}

interface ScreenshotComparisonPair {
  key: string;
  caseId: string;
  label: string;
  title: string;
  presence: "both" | "left-only" | "right-only";
  left: ScreenshotComparisonImage | null;
  right: ScreenshotComparisonImage | null;
}

interface ScreenshotComparisonImage {
  taskId: string;
  projectId: string;
  artifactId: string;
  url: string;
  available: boolean; // false → 源截图已清理
  missingReason: string;
}
```

错误码：

| 条件 | code | HTTP |
|---|---|---|
| body 无效 / 左右相同 | `SCREENSHOT_COMPARISON_INVALID` | 400 |
| 项目未登记 | `PROJECT_UNKNOWN` | 404 |
| 任务不存在 | 写入对应 side.error，HTTP 200 | — |
| 活动任务 | 写入 side.error（沿用 TASK_RESULT_ACTIVE 文案） | 200 |

任务级失败不让整个对比 5xx，以便一侧清理后另一侧仍能看。

### 持久化

服务端不落盘。前端用 `sessionStorage` 键 `mtc.screenshot-comparison.v1` 保存 `{left, right}`。刷新后重新 POST。

## 运行时兼容

- 对比 handler 使用 `baseOptions.runtimes.resolve(projectId)`，忽略 onRequest 绑定的单一 Runtime。
- 无 registry 的单项目测试：仅当两个 `projectId` 都等于 `config.project.id` 时走默认 `taskResults`。
- 截图 URL 必须带该侧 `projectId`，避免 `x-mtc-project-id` 指向当前查看项目时读错 Runtime。
- `hydrateBundle` 已校验 `bundle.project.id === task.projectId`，对比不得绕过。

## 前端

- `WorkspaceView` 增加 `screenshot-compare`。小程序与 App 都展示，不要求 `adapter.workspaces`。
- 新文件 `src/web/ScreenshotComparisonWorkspace.tsx`：项目/任务选择、配对列表、并排、滑杆。
- 运行记录「加入对比」：第一次填左侧，第二次填右侧并切到对比工作区；已选满则替换右侧。
- 缺失页不渲染 `<img>`，展示文案。可用图片 `onError` 也切到「源截图已清理」。

## 取舍

- **即时计算 vs ComparisonSession 落盘**：MVP 即时计算。没有缓存差异图，无需服务端会话。
- **像素差异延后**：当前需求是肉眼看主目录/worktree 页面差和缺页。
- **不改 TaskResult hydrate**：缺失文件仍只进 warnings；对比层把「有 case/label 无 artifact」视为 left/right-only。文件在 hydrate 后被删导致 URL 404，由 UI `onError` 显示「源截图已清理」。

## 回滚

删除对比路由、工作区入口和 `src/shared/screenshot-comparison.ts` 即可。不迁移数据，不影响现有任务结果。
