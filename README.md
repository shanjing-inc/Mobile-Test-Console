# Mobile Test Console

[简体中文](README.md) | [English](README.en.md)

Mobile Test Console 是一个开源、配置驱动的多终端测试控制台，运行在开发机上，为移动 App 和小程序提供统一的设备管理、测试调度、运行监控、日志与结果分析工作区。

它支持 Android、iOS、HarmonyOS 和小程序运行目标。项目通过配置、Runner、Project Provider 与 Result Bundle 协议接入，测试实现和业务数据继续保留在各自仓库中。

当前版本为 `0.1.0-beta.1`，面向 App 与小程序项目开放接入验证。平台核心使用 MIT License，项目能力通过配置、Runner、Project Provider 和 Result Bundle 契约注册。

## 核心能力

- 统一发现和管理 Android、iOS、HarmonyOS 设备及小程序运行目标
- 调度测试任务，提供并发控制、停止操作、实时状态和日志
- 汇总用例、断言、截图、网络证据与诊断信息
- 通过 SDK、JSON Schema、Runner 和 Project Provider 扩展项目能力
- 管理测试产物的保留、清理、磁盘空间与审计记录

## 环境

- Node.js `>=18.20.0`
- pnpm `10.x`
- Android：`adb` 在 PATH 中
- iOS：macOS + `xcrun simctl`；真机发现需要 `xcrun devicectl`
- HarmonyOS：`hdc` 在 PATH 中
- 微信小程序：项目侧准备 Node、包管理器、微信开发者工具和测试环境

## 启动

安装依赖：

```bash
pnpm install
```

开发模式同时启动 API 和 Vite 页面：

```bash
pnpm dev
```

`pnpm dev` 固定启动 MTC 平台服务和项目接入中心，启动阶段不会加载项目构建、设备准备、生命周期或测试脚本。用户在后台选择项目并点击“切换运行项目”后，控制台才进入该项目的运行环境；也可以使用 `pnpm dev -- --config /path/to/app/qa/mobile-test.config.cjs` 显式调试项目。

浏览器访问 `http://127.0.0.1:4311`。生产构建使用 4310 端口：

开发启动器在 API 与页面进程之外持有当前运行项目的生命周期：平台模式不会执行项目生命周期，切换运行项目或使用 `--config` 后执行一次 `lifecycle.startup`，服务端源码热更新只重启 API，退出时执行一次 `lifecycle.shutdown`。因此重型项目准备不会阻塞每次服务端热更新。

启动器会在项目准备前检查 4310/4311。健康检查确认已有控制台时会提示现有地址并成功退出；端口被其他程序占用时返回错误。该检查避免 Vite 自动切换端口后与固定 API 端口失配。

```bash
pnpm build
pnpm start -- --config /path/to/app/qa/mobile-test.config.cjs --open
```

仓库包含一个只运行本机短任务的示例配置：

```bash
pnpm start -- --config examples/demo.config.cjs --port 4312
```

服务默认只监听 `127.0.0.1`。可以通过 `--host`、`--port` 和 `--open` 调整启动行为。

## App 与小程序接入引导

首次打开一个没有运行记录的项目时，控制台会进入“接入引导”工作区。引导页会复用设备快照检查 Android、iOS、HarmonyOS 工具链和设备状态，展示项目已注册的 Provider 能力，并提供最小配置复制入口。完成一次检查后仍可从顶部的“接入引导”入口重新打开。

通用 Lynx App 接入结构已经整理为 [Lynx App 接入指南](docs/lynx-app-onboarding.md) 和 [Lynx App Starter](examples/lynx-app-starter)。Starter 的 Provider、Runner 和结果转换脚本可以直接复制到新的 Lynx App，再替换项目构建、安装、页面驱动和原始报告转换逻辑。`examples/com.shanjing.example` 提供了可直接选择的最小完整示例。

小程序项目通过 `testing.targets` 声明开发者工具等运行环境，通过 `tests[].targetKeys` 绑定测试入口。MTC 执行目标 health check、调度项目 Runner，并将项目 Provider 生成的 Result Bundle 纳入统一任务详情。项目仓库继续管理构建、开发者工具生命周期、测试数据和资源清理。

## 项目接入中心

“项目”工作区用于登记多个本机项目并跟踪接入步骤。添加项目后可以直接点击“选择配置文件”，系统文件选择器确认 `mobile-test.config.cjs` 后自动填入配置路径和 `project.root` 项目目录；也可以点击“打开项目目录并扫描”，MTC 会在选中目录内查找配置文件并自动回填。MTC 从配置读取项目 ID、名称、`integrationType` 和 `deviceProviders`，点击“验证接入”后先检查目标平台需要的 adb、Xcode 或 hdc 工具链，再检测设备连接、授权、设备准备项和 Project Provider 能力。MTC 会把自动解析到的工具目录传给项目 Runner；特殊安装目录可通过 `ANDROID_ADB_PATH`、`ANDROID_SDK_ROOT`、`ANDROID_HOME`、`HARMONY_HDC_PATH`、`HARMONY_SDK_HOME` 或 `DEVECO_SDK_HOME` 声明。项目目录记录项目元数据与上次选择状态。用户在平台中选择项目，完成目录、配置和环境验收后，再切换为运行项目。

项目目录默认保存到 `~/.mobile-test-console/projects.json`，可以通过 `--project-catalog <path>` 或 `MTC_PROJECT_CATALOG` 指定其他位置。目录只保存项目元数据和验证结果，测试任务与账号、页面、业务脚本状态继续保存到各项目自己的 `stateDir`。

非当前运行项目可以从项目卡片移除登记。该操作只更新项目目录文件，项目源码、`mobile-test.config.cjs` 与项目自己的 `stateDir` 均保留。

登记项目完成配置验收后，可以在“项目”工作区点击“切换运行项目”。切换前 MTC 会阻止仍有活动任务的请求，校验目标配置并自动重启控制台；重启后 `--config` 指向目标项目，原项目的任务状态仍保存在原 `stateDir`。

项目完成度会自动推进：任一测试任务首次通过时，“基础 Smoke”记录该次运行；任务返回 `resultUri` 或通过 HTTP 推送 Result Bundle 时，“结果分析”记录运行 ID 和受控结果 URI。每份运行证据都会绑定项目配置摘要和 Provider 能力版本摘要，MTC 启动或重新验证时发现摘要变化会将 Smoke 与结果分析恢复为待验证状态。

当前运行项目的过期步骤会显示“重跑 Smoke”或“重跑分析”。点击后控制台预选兼容测试入口并进入测试执行页，开发者确认设备和参数后启动；结果分析通过项目 Provider 的 `collectResult()` 生成新的 Result Bundle。

## 项目配置

项目可声明 iOS Simulator 的 Xcode workspace 与 scheme。控制台会把 `simctl` 设备和 `xcodebuild -showdestinations` 结果合并，展示已启动、可启动和当前工程不可用三种状态：

```js
iosSimulator: {
  workspace: "apps/ios/Demo.xcworkspace",
  scheme: "Demo",
},
```

`workspace` 相对项目根目录解析。网页启动关机模拟器时，服务端依次执行 `simctl boot`、打开 Simulator 和 `simctl bootstatus -b`。

被测项目在自己的仓库中维护 `mobile-test.config.cjs`，控制台通过 `--config` 加载。配置协议为 `mobile-test-console.config.v1`。App 项目示例：

```js
module.exports = {
  schemaVersion: "mobile-test-console.config.v1",
  project: { id: "demo", name: "Demo App", root: ".", integrationType: "app" },
  deviceProviders: ["android", "ios", "harmony"],
  testing: {
    environments: [{ id: "qa", label: "QA", description: "QA 测试环境" }],
    capabilities: [],
  },
  lifecycle: {
    startup: { executable: "node", args: ["qa/prepare.cjs", "--pid", "{{process.pid}}"] },
    shutdown: { executable: "node", args: ["qa/prepare.cjs", "--cleanup", "--pid", "{{process.pid}}"] },
  },
  taskResults: {
    schemaVersion: "test-analysis.run.v1",
    artifactsRoot: "qa/history/artifacts",
    provider: {
      executable: "node",
      args: ["qa/result.cjs", "--run-id", "{{task.runId}}", "--root", "{{results.artifactsRoot}}"],
    },
  },
  artifactRetention: {
    enabled: true,
    autoCleanup: false,
    artifactsRoot: "qa/history/artifacts",
    policy: { maxAgeDays: 7, maxRuns: 20, maxBytes: 10 * 1024 ** 3 },
    cleanup: {
      executable: "node",
      args: ["qa/artifact-cleanup.cjs", "--request", "{{cleanup.requestPath}}", "--artifacts-root", "{{results.artifactsRoot}}"],
    },
  },
  tests: [{
    id: "smoke",
    label: "Smoke",
    kind: "general",
    runnerId: "legacy-command-runner",
    platforms: ["android", "ios"],
    parameters: [{
      id: "suite",
      label: "测试套件",
      type: "select",
      defaultValue: "smoke",
      options: [{ value: "smoke", label: "Smoke" }],
    }],
    commands: {
      default: {
        executable: "pnpm",
        args: ["test", "--suite", "{{params.suite}}", "--device", "{{device.id}}"],
      },
    },
  }],
};
```

小程序项目使用运行目标和默认命令：

```js
module.exports = {
  schemaVersion: "mobile-test-console.config.v1",
  project: {
    id: "demo-mini-program",
    name: "Demo 小程序",
    root: ".",
    integrationType: "mini-program",
  },
  deviceProviders: [],
  testing: {
    targets: [{
      key: "wechat-devtools",
      label: "微信开发者工具",
      kind: "mini-program",
      platform: "wechat",
      runtime: "wechat-devtools",
      appId: "wx0000000000000000",
      concurrencyKey: "demo-mini-program-wechat",
      healthCheck: {
        executable: "node",
        args: ["tests/mtc/check-runtime.mjs", "--app-id", "{{target.appId}}"],
      },
    }],
  },
  artifactRetention: {
    enabled: true,
    autoCleanup: false,
    artifactsRoot: ".test",
    cleanup: {
      executable: "node",
      args: [
        "tests/mtc/cleanup-run.mjs",
        "--request", "{{cleanup.requestPath}}",
        "--artifacts-root", "{{results.artifactsRoot}}",
      ],
    },
  },
  tests: [{
    id: "wechat-smoke",
    label: "Smoke",
    targetKeys: ["wechat-devtools"],
    commands: {
      default: {
        executable: "pnpm",
        args: ["test:e2e:smoke"],
        env: { E2E_RUN_ID: "{{task.runId}}" },
      },
    },
  }],
};
```

`testing` 是项目测试能力的声明入口：项目在这里列出运行环境和 Provider 能力；每个 `tests[]` 通过 `kind`、`providerId` 与 `requiredCapabilities` 声明自己的执行依赖；`taskResults.schemaVersion` 和 `artifactsRoot` 声明结果结构与存放位置。`artifactRetention` 独立声明产物根目录、保留策略和项目清理适配器，Project Provider 项目可以直接使用该字段。MTC 会把配置声明与运行时 Provider manifest 对照，缺少能力的测试保持不可执行。

### 测试产物治理

MTC 在项目概览展示产物占用、磁盘剩余空间、实际挂载点和清理预览。默认策略保留最近 20 次运行、7 天内运行、各平台最近成功与失败运行、活动任务、活动修复任务以及用户标记为长期保留的运行。点击“选择清理”会扫描项目适配器提供的运行清单，用户勾选具体运行后确认调用项目适配器；适配器成功返回后，MTC 才同步移除任务索引并记录审计结果。

项目适配器接收 `mobile-test-console.artifact-cleanup-request.v1`，支持 `plan` 与 `apply`，并返回 `mobile-test-console.artifact-cleanup-result.v1`。请求设置 `discoverCandidates: true` 时，适配器返回可选运行清单；项目负责把 `runId` 映射到自身的报告、截图、录屏和诊断目录，并执行路径边界检查；MTC 负责候选计算、保护集合、后台触发和用户确认。Starter 的 `qa/artifact-cleanup.cjs` 可以作为实现模板。

`artifactRetention.artifactsRoot` 支持项目目录、外接磁盘和已挂载 NAS。MTC 在启动测试前检查可写权限与 `minimumFreeBytes` 安全水位。内置磁盘上的另一个目录仍写入同一设备；外接磁盘或 NAS 可以迁移测试证据的实际写入压力。

页面测试使用 `kind: "page"` 和 `page-selection` 参数。预设只包含通用筛选条件，页面 ID、优先级、标签、平台和测试范围由项目的页面目录 Provider 返回。流程测试使用 `kind: "flow"`，流程分组及其执行命令继续由项目配置和 Runner 解释。

命令使用 `executable + args` 启动。`lifecycle.startup` 在 HTTP 服务监听前执行一次，`lifecycle.shutdown` 在任务停止和服务关闭后执行一次；准备命令失败会终止服务启动。生命周期命令可使用 `{{projectRoot}}`、`{{configPath}}` 和 `{{process.pid}}`。设备测试命令支持 `{{device.id}}`、`{{device.platform}}`、`{{device.type}}`；运行目标命令支持 `{{target.key}}`、`{{target.platform}}`、`{{target.runtime}}`、`{{target.appId}}`。全部测试命令支持 `{{task.id}}`、`{{task.runId}}` 和 `{{params.<id>}}`，结果提供器额外支持 `{{results.artifactsRoot}}`。页面提交的测试 ID、目标和参数都必须在配置中声明。

失败结果的用例诊断区提供“复制错误”操作。复制内容包含脱敏后的错误摘要、失败日志、页面、参数、缺失事件、失败接口、失败交互和截图引用，可直接用于人工诊断或交给外部编程工具处理。控制台启动过程不依赖 Codex。

### 项目适配器清单

`adapter` 集中声明项目领域语义。平台核心通过该清单读取页面默认路由、运行时事件、结果诊断规则、账号画像能力和修复任务文案：

```js
adapter: {
  workspaces: ["page-parameters", "business-scripts", "account-profiles"],
  pageParameters: {
    defaultRoute: "demo://page",
    templateParameter: "bundle",
    pageReadyEvent: "page_ready",
    actionSucceededEvent: "action_succeeded",
  },
  resultAnalysis: {
    pageOpenedEvents: ["page_opened", "page_ready"],
  },
  accountProfiles: {
    providers: {
      wechat: {
        label: "账号登录",
        recordingLabel: "账号登录录制",
        defaultProfileId: "qa-account",
        defaultAccountLabel: "QA 账号",
        requiredCapability: "login",
        crossPlatformCapability: "login",
        requiredCaptureKinds: ["native", "graphql"],
        requiredResultFields: ["uid", "session_key"],
        capabilityRules: [],
      },
    },
  },
  repair: {
    displayName: "项目修复任务",
    threadNamePrefix: "项目修复",
    fixingMessage: "Codex 正在修复",
  },
},
```

`loadProjectConfig()` 在配置省略 `adapter` 时生成平台中立清单，包括空工作台、空路由事件和空账号 Provider。服务端、共享层和浏览器运行时也使用 `EMPTY_PROJECT_ADAPTER` 处理绕过配置加载边界的内部对象。项目通过显式 `adapter` 保存自己的领域字符串。

迁移期内，旧版项目可以保留 v1 兼容开关：

```js
compatibility: {
  v1ProjectAdapterDefaults: true,
},
```

该开关只在配置省略 `adapter` 时生效，并返回平台中立的空清单。项目路由、事件、账号 Provider 和修复文案需要在 `adapter` 中显式声明，完成迁移后应关闭兼容开关。

`adapter.workspaces` 注册项目工具入口，可选值为 `page-parameters`、`business-scripts` 和 `account-profiles`。平台测试执行与结果分析入口始终存在；项目可以使用空数组构建纯分析控制台。兼容开关也使用空工作台，项目工具始终由项目显式注册。

## 状态与数据

任务状态依次为 `queued`、`preparing`、`running`、`passed`、`failed`、`cancelled`、`interrupted`。状态文件默认保存到 `~/.mobile-test-console/<project-id>/state.json`，可以在项目配置中设置 `stateDir`。

终态任务会按需调用 `taskResults.provider` 读取 `mobile-test-console.task-result.v1`。运行详情提供概览、截图、接口、证据和日志视图；截图通过任务范围内的附件 API 加载，请求与响应展示项目提供器输出的脱敏 JSON。结果正文和图片不进入每秒轮询的 `/api/snapshot`。

```text
GET /api/tasks/:taskId/result
GET /api/tasks/:taskId/artifacts/:artifactId
```

结果接口默认复用终态任务缓存；传入 `?refresh=1` 会重新执行结果提供器。页面右上角的刷新按钮使用该参数读取最新落盘产物。

附件服务只读取 `taskResults.artifactsRoot` 下真实存在的 PNG、JPEG 和 WebP 文件，并拒绝目录穿越与符号链接越界。

## Result Bundle 摄取

平台通用结果协议使用 `test-analysis.run.v1`，统一表达 App 与小程序目标、运行、用例、步骤、断言和证据引用。项目适配器负责将原始测试结果转换为 Result Bundle，平台负责协议校验、幂等摄取、状态存储和分析查询。

通过 HTTP push 导入：

```bash
curl -X POST http://127.0.0.1:4310/api/result-bundles \
  -H 'Content-Type: application/json' \
  --data-binary @examples/result-bundle.mini-program.json
```

通过本地文件导入：

```bash
pnpm result:import -- \
  --config examples/demo.config.cjs \
  --file examples/result-bundle.mini-program.json
```

摄取结果保存在项目 `stateDir/result-bundles/<runId>.json`。相同 `runId` 与相同内容返回 `duplicate`；相同 `runId` 与不同内容返回 `RESULT_BUNDLE_CONFLICT`。查询接口：

```text
GET  /api/result-bundles
GET  /api/result-bundles/:runId
POST /api/result-bundles
```

Result Bundle 的 artifact 使用 URI 和可选摘要描述证据。项目适配器在边界内完成绝对路径归一化，平台接口接收稳定的 `project://`、对象存储或受控附件 URI。

## Runner SDK 与连接器

公开包通过 `mobile-test-console/sdk` 暴露 Runner、Project Provider、Connector 与 Result Bundle 类型和运行时校验器。`mobile-test-console/runner` 在 `0.1.x` 中继续作为兼容入口。

```bash
pnpm add -D mobile-test-console@beta
```

项目配置可以直接获得 TypeScript 提示：

```js
/** @type {import("mobile-test-console/sdk").ProjectConfigInput} */
module.exports = {
  schemaVersion: "mobile-test-console.config.v1",
  // ...
};
```

编辑器和外部工具可以读取 `mobile-test-console/schemas/mobile-test.config.v1.json` 与 `mobile-test-console/schemas/test-analysis.run.v1.json`。这两个文件由 Zod 契约生成，并由 CI 校验同步状态。

`RunPlan`、`RunnerEvent` 和 `RunnerResult` 描述一次执行，`DeviceConnector` 负责设备发现与厂商能力，`InProcessConnectorRegistry` 根据平台、目标类型、设备类型和能力集合选择连接器。Android、iOS、HarmonyOS 的命令与输出解析位于 `src/runner/app-device-connectors.ts`；`DeviceDiscoveryService` 只负责缓存、排序、并发控制和 Connector 调度。快照的 `connectors` 和设备的 `connectorId/capabilities` 字段提供能力观测。

App connector 能力覆盖 Android、iOS、HarmonyOS 的设备发现、启动、安装、截图、录屏、网络、日志和结果导出。小程序 connector 使用独立的 `mini-program` 目标模型，要求声明 `appId`、运行时和 attach/launch/reload 能力；真实开发者工具可以在后续通过同一接口接入。

每个测试通过 `runnerId` 选择 Runner。省略该字段时使用 `legacy-command-runner`，继续执行 `mobile-test-console.config.v1` 的 `executable + args` 命令并保留 stdout/stderr、退出码和取消语义。CLI 在服务启动前创建 Runner Registry 并校验全部测试引用；未注册的 ID 会返回 `CONFIG_INVALID`。SDK 集成方可以注册额外的进程内 Runner，再由同一 Registry 按任务解析。

项目可以通过 `runnerPlugins` 为 CLI 注册自定义 Runner。模块路径相对配置文件解析，包名从项目依赖中解析；CJS 与 ESM 模块都使用版本化插件协议：

```js
// 项目配置 mobile-test.config.cjs
module.exports = {
  // ...
  runnerPlugins: [{
    module: "./qa/mobile-runner.mjs",
    options: { environment: "qa" },
  }],
  tests: [{
    id: "sdk-smoke",
    label: "SDK Smoke",
    runnerId: "project-runner",
    platforms: ["android", "ios"],
  }],
};
```

```js
// 项目 Runner 插件 qa/mobile-runner.mjs
import {
  RUNNER_PLUGIN_API_VERSION,
  createRunnerEvent,
  defineRunnerPlugin,
} from "mobile-test-console/sdk";

export default defineRunnerPlugin({
  apiVersion: RUNNER_PLUGIN_API_VERSION,
  createRunners(context) {
    return [{
      id: "project-runner",
      async run(plan, runnerContext) {
        runnerContext.emit(createRunnerEvent(plan.runId, "status", {
          source: "runner",
          message: `执行 ${context.project.id}/${plan.testId}`,
        }));
        return { runId: plan.runId, status: "passed", exitCode: 0 };
      },
    }];
  },
});
```

插件接收只读的项目路径、状态目录、`options` 和平台提供的 Runner 服务。项目可以通过 `services.createCommandRunner(id)` 复用统一命令执行语义，再在插件中声明项目 Runner ID。自定义 Runner 可以直接消费 `RunPlan`，`commands` 字段仅由 `legacy-command-runner` 强制要求。协议版本、模块加载、导出结构、Runner ID、重复注册和测试引用都会在项目生命周期启动前校验。

项目还可以通过 `projectProviderPlugins` 注册版本化能力清单。Provider 清单用目标类型、runtime、平台和 capability 描述项目拥有的构建、安装、账号前置、页面参数与结果分析边界。Runner 插件调用 `services.requireProjectProvider(id, capabilities)` 绑定这些能力；需要在任务前执行项目准备时，调用 `services.createProviderCommandRunner(id, providerId, capabilities)`，平台会执行 Provider `prepareRun()` 返回的命令，再执行测试命令。声明 `result.analysis` 时还需要实现 `collectResult()`；缺失 Provider、capability、生命周期方法或无效命令会在启动或任务准备阶段给出明确错误。

```js
projectProviderPlugins: [{ module: "./qa/project-provider.cjs" }],
runnerPlugins: [{ module: "./qa/mobile-runner.cjs" }],
```

```js
// 项目 Provider 插件：qa/project-provider.cjs
module.exports = {
  apiVersion: "mobile-test-console.project-provider-plugin.v1",
  createProviders() {
    return [{
      id: "project-app",
      manifest: {
        schemaVersion: "mobile-test-console.project-provider.v1",
        providerId: "project-app",
        scope: { targetKinds: ["app"], runtimes: ["project-runtime"] },
        capabilities: [
          { id: "app.build", version: 1 },
          { id: "app.install", version: 1 },
          { id: "result.analysis", version: 1 },
        ],
      },
      prepareRun(request) {
        return {
          commands: [{
            executable: process.execPath,
            args: ["qa/app-prepare.cjs", "--platform", request.plan.device.platform],
          }],
        };
      },
      collectResult(request) {
        const { buildResultBundle } = require("./qa/result-bundle.cjs");
        return { bundle: buildResultBundle(request) };
      },
    }];
  },
};
```

iOS 模拟器的 boot/open/bootstatus 通过 Connector `start` 生命周期 port 执行；项目设备准备命令由 v1 adapter 包装为 Connector `prepare` port，保留检查、安装、复检和错误码。迁移期间新 Runner 可以按测试逐步接入，默认命令路径继续生效。

## 开发检查

```bash
pnpm test:integrations
pnpm schema:check
pnpm check:open-source
pnpm check
```

`pnpm check` 覆盖 lint、全量测试、Schema 一致性、开源安全扫描、TypeScript、Web/Server/SDK 构建和 npm 发布包内容检查。CI 在 Node.js 18.20.7 与当前 LTS 上执行同一套门禁。

开源协作与发布规则参见 [CONTRIBUTING.md](CONTRIBUTING.md)、[SECURITY.md](SECURITY.md)、[版本兼容策略](docs/versioning.md) 和 [发布清单](docs/publishing.md)。
