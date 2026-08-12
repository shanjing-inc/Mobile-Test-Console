/** @type {import("mobile-test-console/sdk").ProjectConfigInput} */
module.exports = {
  schemaVersion: "mobile-test-console.config.v1",
  project: {
    id: "shanjing-example",
    name: "com.shanjing.example",
    root: ".",
    integrationType: "lynx-app",
  },
  stateDir: "./.mtc-state",
  adapter: {
    workspaces: [],
    pageParameters: {
      defaultRoute: "example://lynx/main",
      templateParameter: "bundle",
      pageReadyEvent: "page_ready",
      actionSucceededEvent: "action_succeeded",
    },
    resultAnalysis: {
      pageOpenedEvents: ["page_opened", "page_ready"],
    },
    accountProfiles: { providers: {} },
    repair: {
      displayName: "示例项目测试任务",
      threadNamePrefix: "示例项目修复",
      fixingMessage: "正在修复示例项目",
    },
  },
  deviceProviders: ["android", "ios", "harmony"],
  iosSimulator: {
    workspace: "ios/Example.xcworkspace",
    scheme: "Example",
  },
  projectProviderPlugins: [{ module: "./qa/lynx-project-provider.cjs" }],
  runnerPlugins: [{ module: "./qa/lynx-runner.cjs" }],
  artifactRetention: {
    enabled: true,
    autoCleanup: false,
    artifactsRoot: "qa/artifacts",
    cleanup: {
      executable: "node",
      args: ["qa/artifact-cleanup.cjs", "--request", "{{cleanup.requestPath}}", "--artifacts-root", "{{results.artifactsRoot}}"],
    },
  },
  tests: [{
    id: "lynx-smoke",
    label: "Lynx 单页 Smoke",
    description: "构建并安装 Android、iOS 或 HarmonyOS QA App，打开单页 Bundle，验证 page_ready 与结果分析链路。",
    runnerId: "shanjing-example-runner",
    platforms: ["android", "ios", "harmony"],
    parameters: [{
      id: "environment",
      label: "环境",
      type: "select",
      defaultValue: "qa",
      options: [{ value: "qa", label: "QA" }],
    }],
    commands: {
      android: {
        executable: "node",
        args: [
          "qa/android-suite.cjs",
          "--platform", "{{device.platform}}",
          "--device", "{{device.id}}",
          "--run-id", "{{task.runId}}",
          "--environment", "{{params.environment}}",
          "--device-type", "{{device.type}}",
        ],
      },
      ios: {
        executable: "node",
        args: [
          "qa/ios-suite.cjs",
          "--platform", "{{device.platform}}",
          "--device", "{{device.id}}",
          "--run-id", "{{task.runId}}",
          "--environment", "{{params.environment}}",
          "--device-type", "{{device.type}}",
        ],
      },
      harmony: {
        executable: "node",
        args: [
          "qa/harmony-suite.cjs",
          "--platform", "{{device.platform}}",
          "--device", "{{device.id}}",
          "--run-id", "{{task.runId}}",
          "--environment", "{{params.environment}}",
          "--device-type", "{{device.type}}",
        ],
      },
    },
  }],
};
