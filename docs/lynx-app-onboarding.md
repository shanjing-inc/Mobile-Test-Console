# Lynx App 接入指南

这份指南以独立 Lynx App Starter 和 `com.shanjing.example` 示例为模板，描述一个新的 Lynx App 如何接入 Mobile Test Console。MTC 负责本机设备发现、任务调度、取消、日志、结果存储和分析；项目仓库负责 App 构建、安装、页面启动、账号前置、测试驱动和原始产物转换。

## 0. 项目接入流程

MTC 的“项目”工作区将接入拆成可恢复的步骤：

1. 添加项目：优先点击“选择配置文件”，确认 `mobile-test.config.cjs` 后自动填入配置路径和 `project.root` 项目目录；也可以打开项目目录，让 MTC 自动扫描配置文件。MTC 从配置读取 ID、名称、`integrationType` 和 `deviceProviders`。
2. 完成 Starter 配置：在项目内写入 `mobile-test.config.cjs` 和 QA 脚本。
3. 验证设备环境：重新检测 Android、iOS 或 HarmonyOS 工具链和设备。
4. 运行基础 Smoke：让测试命令接收设备参数和 `runId`，确认退出码与取消语义。
5. 接入项目能力：加载 Provider manifest，验证构建、安装、账号和页面参数准备。
6. 接入结果分析：运行 `collectResult()`，检查 Result Bundle、截图和诊断证据。

`mobile-test.config.cjs` 是单一接入清单。`testing.environments` 描述可选运行环境，`testing.capabilities` 声明能力名称、Provider 和修复引导，`tests[]` 声明页面测试、流程测试或通用测试及其能力依赖，`taskResults` 声明结果协议、产物目录和兼容 Provider。MTC 负责读取和校验这些声明，项目 Adapter 负责实现能力与解释项目测试语义。

每个项目会记录步骤状态、最近检测时间和失败原因。Smoke 与 Result Bundle 证据会保存项目配置摘要和 Provider 能力版本摘要；MTC 启动或点击“验证接入”时发现摘要变化，会将这两步恢复为待验证并显示变化原因。当前 MTC 进程继续使用 `--config` 指定的项目执行任务，项目目录工作区负责登记和接入验收。

完成配置验收后，可以从项目卡片切换运行项目。MTC 会先确认没有排队、准备中或执行中的任务，再校验目标配置并重启当前控制台；项目任务和接入状态分别留在各自的 `stateDir` 与项目目录文件中。

首次通过的 Lynx 测试会将“基础 Smoke”标记为已验证。Provider 产出 `resultUri` 后，或外部将 Result Bundle 推送到 `/api/result-bundles` 后，“结果分析”会自动标记为已验证；失败任务携带有效 Result Bundle 时同样保留分析证据。

当配置摘要或 Provider 能力版本摘要发生变化，当前运行项目的步骤卡片会提供“重跑 Smoke”或“重跑分析”。入口会选中兼容测试并跳转到测试执行页；选择设备和参数后启动，完成任务后平台自动更新接入证据。

## 1. 接入资格

### 基础接入

项目具备以下条件即可运行第一条测试：

- 有 Android、iOS 或 HarmonyOS 原生宿主。
- 有一个可执行的 QA 测试命令。
- 测试命令接收设备 ID 和 `runId`，以退出码表达结果。
- QA 设备已经开启开发者模式，并能被 `adb`、`xcrun` 或 `hdc` 识别。

基础接入获得设备调度、并行任务、日志和停止语义。

### 标准接入

标准接入把项目生命周期交给 Provider：

| 能力 | 项目需要提供 | Starter 示例实现 |
| --- | --- | --- |
| `app.build` | 构建指定平台 QA 包 | `app-prepare` |
| `app.install` | 安装并验证 QA 包 | `app-prepare` |
| `account.preflight` | 检查或恢复测试账号 | `account-preflight` |
| `page-parameters.resolve` | 解析页面路由和参数画像 | `page-parameters-resolve` |
| `result.analysis` | 生成结构化结果 | `collectResult()` |

### 完整接入

完整接入还要输出页面事件、步骤、断言、截图、网络证据和脱敏诊断字段，并转换为 `test-analysis.run.v1`。

## 2. 设备自检

首次启动 MTC 后打开“接入引导”，点击“重新检测”。引导页从 `/api/snapshot` 读取设备和连接器能力，按平台显示以下状态：

- Android：确认 `adb devices` 返回 `device` 状态。
- iOS：模拟器确认 `xcrun simctl` 和 Xcode scheme destination；真机确认 `xcrun devicectl`、开发者模式和信任关系。
- HarmonyOS：确认 `hdc list targets` 返回在线设备。

项目通过 `deviceProviders` 声明目标平台，MTC 据此推导所需本机工具。MTC 启动时会自动搜索 Android SDK、OpenHarmony SDK 和 DevEco Studio 的常见安装目录，并把解析到的工具目录传给项目 Runner。自定义目录可以通过以下本机环境变量声明：

- Android：`ANDROID_ADB_PATH`、`ANDROID_SDK_ROOT`、`ANDROID_HOME`。
- HarmonyOS：`HARMONY_HDC_PATH`、`HARMONY_SDK_HOME`、`DEVECO_SDK_HOME`。
- iOS：使用 `xcode-select` 选择本机 Xcode Command Line Tools。

“项目概览 → 设备环境”会先验证工具链，再检查设备连接、授权和 Maestro 等设备准备项。工具链缺失时，“执行测试”保持锁定，页面提供安装或本机路径配置提示。

状态处理顺序：

1. “检测中”：等待后台发现完成。
2. “需处理”：先阅读平台错误，再重新检测。
3. “可测试”：设备连接、控制状态和项目准备条件全部通过。

设备可用性属于运行前条件。测试脚本内部再次发现设备会产生并发竞争，项目脚本应使用 MTC 传入的 `device.id`。

## 3. 项目开发约定

### QA App

- Android、iOS、HarmonyOS 使用独立 QA 包或 QA scheme。
- 包名、scheme、bundle ID、deeplink 和测试环境固定且可配置。
- Lynx 页面提供稳定路由，例如 `demo://lynx?bundle=home.bundle`。
- 页面在初始化完成后发送 `page_opened`、`page_ready`；交互成功后发送 `action_succeeded`。
- 测试环境提供可重置账号和脱敏数据。

### 测试命令

测试命令通过 `executable + args` 声明：

```js
commands: {
  default: {
    executable: "pnpm",
    args: [
      "qa:lynx:smoke",
      "--platform", "{{device.platform}}",
      "--device", "{{device.id}}",
      "--run-id", "{{task.runId}}",
      "--environment", "{{params.environment}}",
    ],
  },
},
```

命令应满足：

- 使用传入的 `device.id`、`device.platform` 和 `task.runId`。
- 以 `0` 表示通过，以非零退出码表示失败。
- 接收终止信号，结束子进程并清理临时文件。
- 将每次运行的原始结果写入 `qa/artifacts/<runId>/`。
- 将日志、截图、网络文件和事件文件放在项目产物目录内。

### Result Bundle

Provider 的 `collectResult()` 接收只读的 `RunPlan`、`RunnerResult` 和取消信号：

```js
collectResult(request) {
  const bundle = buildResultBundle({
    projectRoot: request.plan.command.cwd,
    runId: request.plan.runId,
    status: request.result.status,
  });
  return { bundle };
}
```

Bundle 必须满足：

- `schemaVersion` 为 `test-analysis.run.v1`。
- `project.id` 等于当前配置的项目 ID。
- `run.runId` 等于当前任务的 `runId`。
- `run.status` 与 `RunnerResult.status` 一致。
- 截图和证据使用 `project://<project-id>/...` URI。
- 敏感请求头、Cookie、Token、账号字段已经脱敏。

MTC 会在写入前校验 `runId`、`projectId` 和终态；相同 `runId` 与相同内容保持幂等，冲突内容会被拒绝。

## 4. 配置与插件

### 最小配置

```js
module.exports = {
  schemaVersion: "mobile-test-console.config.v1",
  project: { id: "my-lynx-app", name: "My Lynx App", root: ".", integrationType: "lynx-app" },
  deviceProviders: ["android", "ios", "harmony"],
  tests: [{
    id: "lynx-smoke",
    label: "Lynx Smoke",
    runnerId: "legacy-command-runner",
    platforms: ["android", "ios", "harmony"],
    commands: { default: { executable: "pnpm", args: ["qa:lynx:smoke", "--device", "{{device.id}}"] } },
  }],
};
```

### Provider 与 Runner

```js
projectProviderPlugins: [{ module: "./qa/lynx-project-provider.cjs" }],
runnerPlugins: [{ module: "./qa/lynx-runner.cjs" }],
```

Provider manifest 的 `scope.targetKinds` 使用 `app`，Lynx 项目使用 `runtimes: ["lynx"]`，平台列表按实际支持范围填写。声明 `result.analysis` 时必须实现 `collectResult()`；Runner 通过 `services.createProviderCommandRunner()` 复用平台的执行、取消和结果摄取语义。

## 5. 推荐开发顺序

1. 先用 `legacy-command-runner` 跑通一个只读页面 Smoke。
2. 把构建和安装抽成 `app.build`、`app.install`。
3. 增加 `page_opened`、`page_ready` 和页面路由参数。
4. 增加账号前置与可复现的 QA 账号。
5. 将原始报告转换为 Result Bundle，并加入截图和断言。
6. 在 Android、iOS、HarmonyOS 各执行一次通过和失败任务。
7. 记录取消、重试、重复 `runId` 和路径越界测试结果。

## 6. Starter 模板

仓库提供可复制的模板：[examples/lynx-app-starter](../examples/lynx-app-starter)。

```bash
pnpm dev -- --config examples/lynx-app-starter/mobile-test.config.cjs
```

日常启动直接运行 `pnpm dev` 即可。MTC 会进入项目接入中心，用户在后台选择项目并切换运行后加载项目环境。`--config` 适合临时指定项目或调试独立配置。

模板中的 `qa/prepare.cjs`、`qa/lynx-suite.cjs` 和 `qa/result-bundle.cjs` 是项目适配边界。迁移到真实 App 时保留 Provider、Runner 和参数契约，替换这三个脚本的示例实现。

## 7. 发布前检查

- 三个平台至少各有一个可运行 QA 设备或模拟器。
- MTC 引导页的设备状态与命令行检查结果一致。
- 通过、失败、取消三种任务状态符合预期。
- Result Bundle 的上下文校验、幂等和冲突测试通过。
- 截图、录屏、日志和网络证据全部位于受控产物目录。
- README、Starter、Provider 类型和示例配置保持同一协议版本。
