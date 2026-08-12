/** @type {import("mobile-test-console/sdk").ProjectConfigInput} */
module.exports = {
  schemaVersion: "mobile-test-console.config.v1",
  project: {
    id: "lynx-app-starter",
    name: "Lynx App Starter",
    root: ".",
    integrationType: "lynx-app",
  },
  stateDir: "./.mtc-state",
  adapter: {
    workspaces: [],
    pageParameters: {
      defaultRoute: "demo://lynx",
      templateParameter: "bundle",
      pageReadyEvent: "page_ready",
      actionSucceededEvent: "action_succeeded",
    },
    resultAnalysis: {
      pageOpenedEvents: ["page_opened", "page_ready"],
    },
    accountProfiles: { providers: {} },
    repair: {
      displayName: "Lynx App 测试任务",
      threadNamePrefix: "Lynx App 修复",
      fixingMessage: "Codex 正在修复 Lynx App",
    },
  },
  deviceProviders: ["android", "ios", "harmony"],
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
    label: "Lynx Smoke",
    description: "验证项目准备、页面运行和 Result Bundle 摄取链路。",
    runnerId: "lynx-app-starter-runner",
    platforms: ["android", "ios", "harmony"],
    parameters: [
      {
        id: "environment",
        label: "环境",
        type: "select",
        defaultValue: "qa",
        options: [
          { value: "qa", label: "QA" },
          { value: "staging", label: "Staging" },
        ],
      },
      {
        id: "outcome",
        label: "示例结果",
        type: "select",
        defaultValue: "passed",
        options: [
          { value: "passed", label: "通过" },
          { value: "failed", label: "失败" },
        ],
      },
    ],
    commands: {
      default: {
        executable: "node",
        args: [
          "qa/lynx-suite.cjs",
          "--platform", "{{device.platform}}",
          "--device", "{{device.id}}",
          "--run-id", "{{task.runId}}",
          "--environment", "{{params.environment}}",
          "--outcome", "{{params.outcome}}",
        ],
      },
    },
  }],
};
