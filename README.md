# Mobile Test Console

Mobile Test Console 是一个运行在开发机上的跨 App 移动测试控制台。它发现 Android、iOS、HarmonyOS 设备，按项目配置展示测试入口，支持多设备并行启动、停止任务、查看运行状态和日志。

## 环境

- Node.js `>=18.20.0`
- pnpm `10.x`
- Android：`adb` 在 PATH 中
- iOS：macOS + `xcrun simctl`；真机发现需要 `xcrun devicectl`
- HarmonyOS：`hdc` 在 PATH 中

## 启动

安装依赖：

```bash
pnpm install
```

开发模式同时启动 API 和 Vite 页面：

```bash
pnpm dev -- --config /path/to/app/qa/mobile-test.config.cjs
```

浏览器访问 `http://127.0.0.1:4311`。生产构建使用 4310 端口：

开发启动器在 API 与页面进程之外持有项目生命周期：启动 `pnpm dev` 时执行一次 `lifecycle.startup`，服务端源码热更新只重启 API，退出 `pnpm dev` 时执行一次 `lifecycle.shutdown`。因此重型项目准备不会阻塞每次服务端热更新。

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

## 项目配置

项目可声明 iOS Simulator 的 Xcode workspace 与 scheme。控制台会把 `simctl` 设备和 `xcodebuild -showdestinations` 结果合并，展示已启动、可启动和当前工程不可用三种状态：

```js
iosSimulator: {
  workspace: "apps/ios/Demo.xcworkspace",
  scheme: "Demo",
},
```

`workspace` 相对项目根目录解析。网页启动关机模拟器时，服务端依次执行 `simctl boot`、打开 Simulator 和 `simctl bootstatus -b`。

目标 App 在自己的仓库中维护 `mobile-test.config.cjs`，控制台通过 `--config` 加载。配置协议为 `mobile-test-console.config.v1`：

```js
module.exports = {
  schemaVersion: "mobile-test-console.config.v1",
  project: { id: "demo", name: "Demo App", root: "." },
  deviceProviders: ["android", "ios", "harmony"],
  lifecycle: {
    startup: { executable: "node", args: ["qa/prepare.cjs", "--pid", "{{process.pid}}"] },
    shutdown: { executable: "node", args: ["qa/prepare.cjs", "--cleanup", "--pid", "{{process.pid}}"] },
  },
  taskResults: {
    artifactsRoot: "qa/history/artifacts",
    provider: {
      executable: "node",
      args: ["qa/result.cjs", "--run-id", "{{task.runId}}", "--root", "{{results.artifactsRoot}}"],
    },
  },
  tests: [{
    id: "smoke",
    label: "Smoke",
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

命令使用 `executable + args` 启动。`lifecycle.startup` 在 HTTP 服务监听前执行一次，`lifecycle.shutdown` 在任务停止和服务关闭后执行一次；准备命令失败会终止服务启动。生命周期命令可使用 `{{projectRoot}}`、`{{configPath}}` 和 `{{process.pid}}`，设备测试命令还可使用 `{{device.id}}`、`{{device.platform}}`、`{{device.type}}`、`{{task.id}}`、`{{task.runId}}` 和 `{{params.<id>}}`。结果提供器额外支持 `{{results.artifactsRoot}}`。页面提交的测试 ID、平台和参数都必须在配置中声明。

失败结果的用例诊断区提供“复制错误”操作。复制内容包含脱敏后的错误摘要、失败日志、页面、参数、缺失事件、失败接口、失败交互和截图引用，可直接用于人工诊断或交给外部编程工具处理。控制台启动过程不依赖 Codex。

## 状态与数据

任务状态依次为 `queued`、`preparing`、`running`、`passed`、`failed`、`cancelled`、`interrupted`。状态文件默认保存到 `~/.mobile-test-console/<project-id>/state.json`，可以在项目配置中设置 `stateDir`。

终态任务会按需调用 `taskResults.provider` 读取 `mobile-test-console.task-result.v1`。运行详情提供概览、截图、接口、证据和日志视图；截图通过任务范围内的附件 API 加载，请求与响应展示项目提供器输出的脱敏 JSON。结果正文和图片不进入每秒轮询的 `/api/snapshot`。

```text
GET /api/tasks/:taskId/result
GET /api/tasks/:taskId/artifacts/:artifactId
```

结果接口默认复用终态任务缓存；传入 `?refresh=1` 会重新执行结果提供器。页面右上角的刷新按钮使用该参数读取最新落盘产物。

附件服务只读取 `taskResults.artifactsRoot` 下真实存在的 PNG、JPEG 和 WebP 文件，并拒绝目录穿越与符号链接越界。

## 开发检查

```bash
pnpm test
pnpm typecheck
pnpm build
```
