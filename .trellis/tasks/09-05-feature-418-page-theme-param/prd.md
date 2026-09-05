# FEATURE-418 页面巡检外观参数由控制台注入

## 目标

Mobile Test Console 在「执行测试」里给小程序页面巡检入口展示「外观」下拉（浅色 / 深色），启动时把 `E2E_THEME` 传给项目命令。不要求每个已导入项目自己改 `mobile-test.config.cjs`。

## 背景 / 已知事实

1. 用户从 `Mobile-Test-Console.worktrees/FEATURE-418` 启动 MTC（`http://127.0.0.1:4311`）。本 issue 的代码改动只落这个 worktree。
2. 测试入口参数来自 `toPublicTestsFromConfig(options.config)`（`src/server/app.ts` snapshot）。UI 已能渲染 `select` 参数，项目配置里没有 `theme` 时界面就不会出现「外观」。
3. 当前选中的 FEATURE-403 页面巡检入口只有「页面」参数。`ProjectRuntimeRegistry` 首次 `load()` 后缓存 `LoadedProjectConfig`，磁盘配置更新不会自动进 snapshot。
4. 命令 env 只展开配置里写死的键（`resolveCommandDefinition`）。即使 UI 有 `params.theme`，配置没有 `E2E_THEME: '{{params.theme}}'` 时，子进程也拿不到主题。
5. 页面巡检测试的识别特征：`kind: "page"` 且带 `page-selection` 参数（例如「本地回放页面结构巡检」「真实服务端页面兼容性」）。Smoke / Unit 不带页面选择。
6. 截图对比标题已识别文件名中的 `light`/`dark`（`68bdf2e`）。主题真正改模拟器外观仍由项目巡检脚本读取 `E2E_THEME`。

## 需求要点

1. 对 `kind === "page"` 且含页面选择参数的测试，MTC 在加载/快照时注入 `theme` 选择参数：浅色=`light`，深色=`dark`，默认浅色。项目已声明同 id 时不重复。
2. 解析启动命令时，这类测试的 env 补上 `E2E_THEME={{params.theme}}`（配置已写则保留原模板）。
3. snapshot 返回的 `tests[].parameters` 含「外观」，现有测试页无需新控件。
4. Unit / Smoke / 非页面巡检入口保持原参数列表。
5. 不改用户本机小程序 worktree；本任务只改 FEATURE-418 控制台。

## 范围外

- 一次运行同时出浅色+深色两套截图
- 改 MTC 控制台自身的暗色样式
- 在本任务里改 saas-mini-program 巡检脚本或各 worktree 配置
- 像素对比、一键 A/B 对比运行

## 验收标准

- [ ] 导入的小程序项目打开「本地回放页面结构巡检」时，测试页出现「外观」下拉，选项为浅色 / 深色
- [ ] 项目 `mobile-test.config.cjs` 没有 `theme` 参数时，snapshot 仍返回该参数
- [ ] 选择深色后预览/启动命令 env 含 `E2E_THEME=dark`
- [ ] 已声明 `theme` 的项目不出现两个「外观」
- [ ] Smoke / Unit 入口不出现「外观」
- [ ] 单测覆盖注入、去重、命令 env；不改动 FEATURE-418 里与本任务无关的未提交文件
