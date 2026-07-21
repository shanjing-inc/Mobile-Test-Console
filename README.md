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

目标 App 在自己的仓库中维护 `mobile-test.config.cjs`，控制台通过 `--config` 加载。配置协议为 `mobile-test-console.config.v1`：

```js
module.exports = {
  schemaVersion: "mobile-test-console.config.v1",
  project: { id: "demo", name: "Demo App", root: "." },
  deviceProviders: ["android", "ios", "harmony"],
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

命令使用 `executable + args` 启动。可用模板变量包括 `{{projectRoot}}`、`{{device.id}}`、`{{device.platform}}`、`{{device.type}}`、`{{task.id}}`、`{{task.runId}}` 和 `{{params.<id>}}`。页面提交的测试 ID、平台和参数都必须在配置中声明。

## 状态与数据

任务状态依次为 `queued`、`preparing`、`running`、`passed`、`failed`、`cancelled`、`interrupted`。状态文件默认保存到 `~/.mobile-test-console/<project-id>/state.json`，可以在项目配置中设置 `stateDir`。

## 开发检查

```bash
pnpm test
pnpm typecheck
pnpm build
```
