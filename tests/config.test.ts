import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Device } from "../src/shared/contracts.js";
import { V1_PROJECT_ADAPTER_DEFAULTS } from "../src/compat/v1-project-adapter.js";
import { EMPTY_PROJECT_ADAPTER } from "../src/shared/project-adapter-defaults.js";
import {
  loadProjectConfig,
  resolveCommand,
  resolveDevicePreparationCommand,
  resolveLifecycleCommand,
  resolveAccountProfileProviderCommand,
  resolveArtifactCleanupCommand,
  resolvePageParameterProviderCommand,
  resolveTaskDeletionCommand,
  resolveTaskResultCommand,
  resolveTargetCommand,
  resolveTargetHealthCheckCommand,
  toPublicTests,
  validateParameters,
  type LoadedProjectConfig,
} from "../src/server/config.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true })));
});

describe("项目配置", () => {
  it("加载小程序运行目标并解析 target 命令模板", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mtc-mini-target-"));
    tempDirs.push(dir);
    const configPath = path.join(dir, "mobile-test.config.cjs");
    await fs.writeFile(configPath, `module.exports = {
      schemaVersion: "mobile-test-console.config.v1",
      project: { id: "mini-demo", name: "Mini Demo", root: ".", integrationType: "mini-program" },
      deviceProviders: [],
      testing: { targets: [{
        key: "wechat-devtools", label: "微信开发者工具", kind: "mini-program",
        platform: "wechat", runtime: "wechat-devtools", appId: "wx-demo",
        concurrencyKey: "mini-demo-wechat",
        healthCheck: { executable: "node", args: ["check.mjs", "{{target.runtime}}"] }
      }] },
      tests: [{
        id: "smoke", label: "Smoke", targetKeys: ["wechat-devtools"],
        commands: { default: { executable: "pnpm", args: ["test:smoke", "--run", "{{task.runId}}", "--target", "{{target.key}}", "--app-id", "{{target.appId}}"] } }
      }]
    };`);

    const config = await loadProjectConfig(configPath);
    const target = config.testing?.targets?.[0];
    if (!target) throw new Error("缺少运行目标");
    expect(toPublicTests(config.tests)[0]).toMatchObject({ platforms: [], targetKeys: ["wechat-devtools"] });
    expect(resolveTargetHealthCheckCommand(config, target.key)?.args).toEqual(["check.mjs", "wechat-devtools"]);
    expect(resolveTargetCommand(config, config.tests[0], {
      key: target.key,
      kind: "mini-program",
      label: target.label,
      platform: target.platform,
      runtime: target.runtime,
      appId: target.appId,
      concurrencyKey: target.concurrencyKey,
    }, { id: "task-1", runId: "run-1" }, {})?.args).toEqual([
      "test:smoke", "--run", "run-1", "--target", "wechat-devtools", "--app-id", "wx-demo",
    ]);
  });

  it("校验运行目标唯一性与测试引用", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mtc-mini-target-invalid-"));
    tempDirs.push(dir);
    const configPath = path.join(dir, "mobile-test.config.cjs");
    await fs.writeFile(configPath, `module.exports = {
      schemaVersion: "mobile-test-console.config.v1",
      project: { id: "mini-demo", name: "Mini Demo", root: ".", integrationType: "mini-program" },
      deviceProviders: [],
      testing: { targets: [
        { key: "wechat", label: "微信一", kind: "mini-program", platform: "wechat", runtime: "devtools", appId: "wx-1", concurrencyKey: "wechat" },
        { key: "wechat", label: "微信二", kind: "mini-program", platform: "wechat", runtime: "devtools", appId: "wx-2", concurrencyKey: "wechat" }
      ] },
      tests: [{ id: "smoke", label: "Smoke", targetKeys: ["missing"], commands: { default: { executable: "node" } } }]
    };`);

    await expect(loadProjectConfig(configPath)).rejects.toMatchObject({ code: "CONFIG_INVALID" });
  });

  it("从单一配置读取环境、能力、测试类型和结果契约", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mtc-testing-manifest-"));
    tempDirs.push(dir);
    const configPath = path.join(dir, "mobile-test.config.cjs");
    await fs.writeFile(configPath, `module.exports = {
      schemaVersion: "mobile-test-console.config.v1",
      project: { id: "demo", name: "Demo", root: "." },
      testing: {
        environments: [{ id: "qa", label: "QA", description: "QA 环境" }],
        capabilities: [{ id: "page.execute", label: "页面执行", providerId: "demo-provider", description: "执行页面测试" }]
      },
      taskResults: {
        schemaVersion: "test-analysis.run.v1",
        artifactsRoot: "qa/results",
        provider: { executable: "node", args: ["result.cjs"] }
      },
      tests: [{
        id: "pages", label: "页面测试", kind: "page", runnerId: "demo-runner",
        providerId: "demo-provider", requiredCapabilities: ["page.execute"], platforms: ["android"],
        parameters: [{ id: "pages", label: "页面", type: "page-selection", source: "page-parameters", defaultValue: "all", presets: [{ value: "all", label: "全部", filter: {} }] }]
      }]
    };`);

    const config = await loadProjectConfig(configPath);
    expect(config.testing).toMatchObject({
      environments: [{ id: "qa", label: "QA", description: "QA 环境" }],
      capabilities: [{ id: "page.execute", providerId: "demo-provider", required: true }],
      result: { schemaVersion: "test-analysis.run.v1", artifactsRoot: path.join(dir, "qa/results") },
    });
    expect(toPublicTests(config.tests)[0]).toMatchObject({
      kind: "page",
      providerId: "demo-provider",
      requiredCapabilities: ["page.execute"],
    });
    expect(validateParameters(config.tests[0], { pages: "pageHome,pageOrders" })).toEqual({
      pages: "pageHome,pageOrders",
    });
  });

  it("重新读取修改后的 CJS 配置元数据", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mtc-config-reload-"));
    tempDirs.push(dir);
    const configPath = path.join(dir, "mobile-test.config.cjs");
    const write = (name: string, integrationType: string, providers: string[]) => fs.writeFile(configPath, `module.exports = {
      schemaVersion: "mobile-test-console.config.v1",
      project: { id: "reload-app", name: "${name}", root: ".", integrationType: "${integrationType}" },
      deviceProviders: ${JSON.stringify(providers)},
      tests: [{ id: "smoke", label: "Smoke", platforms: ["android"], commands: { default: { executable: "node", args: ["--version"] } } }],
    };\n`);

    await write("Reload v1", "app", ["android"]);
    expect(await loadProjectConfig(configPath)).toMatchObject({
      project: { name: "Reload v1", integrationType: "app" },
      deviceProviders: ["android"],
    });

    await write("Reload v2", "lynx-app", ["ios", "harmony"]);
    expect(await loadProjectConfig(configPath)).toMatchObject({
      project: { name: "Reload v2", integrationType: "lynx-app" },
      deviceProviders: ["ios", "harmony"],
    });
  });

  it("加载独立 CJS 配置并解析相对项目路径", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mtc-config-"));
    tempDirs.push(dir);
    const configPath = path.join(dir, "mobile-test.config.cjs");
    await fs.writeFile(configPath, `module.exports = {
      schemaVersion: "mobile-test-console.config.v1",
      project: { id: "demo", name: "Demo App", root: "../app" },
      deviceProviders: ["android"],
      iosSimulator: { workspace: "ios/Demo.xcworkspace", scheme: "Demo" },
      lifecycle: {
        startup: { executable: "node", args: ["prepare.cjs", "--pid", "{{process.pid}}"] }
      },
      taskDeletion: {
        cleanup: { executable: "node", args: ["cleanup.cjs", "--run-id", "{{task.runId}}"] }
      },
      taskResults: {
        artifactsRoot: "artifacts",
        provider: { executable: "node", args: ["result.cjs", "--root", "{{results.artifactsRoot}}"] }
      },
      pageParameters: {
        provider: { executable: "node", args: ["page-parameters.cjs"] }
      },
      accountProfiles: {
        provider: { executable: "node", args: ["account-profiles.cjs", "--profiles", "{{accountProfiles.statePath}}"] }
      },
      codexRepair: {
        enabled: true,
        mode: "confirm",
        executable: "codex",
        maxAttempts: 2,
        sandbox: "workspace-write",
        approvalPolicy: "never",
        worktreeRoot: ".repair-worktrees"
      },
      tests: [{
        id: "smoke",
        label: "Smoke",
        platforms: ["android"],
        parameters: [{
          id: "suite",
          label: "测试套件",
          type: "select",
          defaultValue: "smoke",
          options: [{ value: "smoke", label: "Smoke", description: "核心页面快速检查" }, { value: "p0", label: "P0" }]
        }, {
          id: "account-profile",
          label: "测试账号",
          type: "account-profile",
          defaultValue: "current-session",
          capability: "login"
        }],
        commands: { default: { executable: "node", args: ["--version"] } }
      }]
    };`);

    const config = await loadProjectConfig(configPath);
    expect(config.project.integrationType).toBe("app");
    expect(config.project.root).toBe(path.resolve(dir, "../app"));
    expect(config.iosSimulator).toEqual({
      workspace: path.resolve(dir, "../app/ios/Demo.xcworkspace"),
      scheme: "Demo",
    });
    expect(config.tests[0].description).toBe("");
    expect(config.tests[0].runnerId).toBe("legacy-command-runner");
    expect(toPublicTests(config.tests)[0].runnerId).toBe("legacy-command-runner");
    const suiteParameter = config.tests[0].parameters[0];
    expect(suiteParameter.type).toBe("select");
    if (suiteParameter.type !== "select") throw new Error("测试套件参数类型错误");
    expect(suiteParameter.options).toEqual([
      { value: "smoke", label: "Smoke", description: "核心页面快速检查" },
      { value: "p0", label: "P0", description: "" },
    ]);
    expect(config.tests[0].parameters[1]).toEqual({
      id: "account-profile",
      label: "测试账号",
      type: "account-profile",
      defaultValue: "current-session",
      capability: "login",
    });
    expect(resolveLifecycleCommand(config, "startup", 1234)?.args).toEqual(["prepare.cjs", "--pid", "1234"]);
    expect(resolveTaskDeletionCommand(config, createTask())?.args).toEqual([
      "cleanup.cjs",
      "--run-id",
      "run-1",
    ]);
    expect(config.taskResults?.artifactsRoot).toBe(path.resolve(dir, "../app/artifacts"));
    expect(resolveTaskResultCommand(config, createTask())?.args).toEqual([
      "result.cjs",
      "--root",
      path.resolve(dir, "../app/artifacts"),
    ]);
    expect(resolveTaskResultCommand(config, {
      ...createTask(),
      workspaceRoot: path.join(dir, "repair-worktree"),
    })).toMatchObject({
      cwd: path.join(dir, "repair-worktree"),
      args: ["result.cjs", "--root", path.join(dir, "repair-worktree/artifacts")],
    });
    expect(resolvePageParameterProviderCommand(config, "catalog")?.args).toEqual([
      "page-parameters.cjs",
      "catalog",
    ]);
    expect(resolveAccountProfileProviderCommand(config, "recording-start")?.args).toEqual([
      "account-profiles.cjs",
      "--profiles",
      path.join(config.stateDir, "account-profiles.json"),
      "recording-start",
    ]);
    expect(config.codexRepair).toEqual({
      enabled: true,
      appServer: true,
      mode: "confirm",
      executable: "codex",
      maxAttempts: 2,
      sandbox: "workspace-write",
      approvalPolicy: "never",
      worktreeRoot: path.resolve(dir, "../app/.repair-worktrees"),
      worktreeLinks: [],
    });
    expect(config.adapter).toEqual(EMPTY_PROJECT_ADAPTER);
    expect(config.compatibility).toEqual({ v1ProjectAdapterDefaults: false });
    expect(config.runnerPlugins).toEqual([]);
    expect(config.projectProviderPlugins).toEqual([]);
  });

  it("显式兼容开关返回平台中立的 v1 适配器清单", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mtc-v1-adapter-"));
    tempDirs.push(dir);
    const configPath = path.join(dir, "mobile-test.config.cjs");
    await fs.writeFile(configPath, `module.exports = {
      schemaVersion: "mobile-test-console.config.v1",
      project: { id: "legacy", name: "Legacy App", root: "." },
      compatibility: { v1ProjectAdapterDefaults: true },
      tests: [{ id: "smoke", label: "Smoke", platforms: ["android"], commands: { default: { executable: "node", args: ["--version"] } } }]
    };`);

    const config = await loadProjectConfig(configPath);

    expect(config.compatibility).toEqual({ v1ProjectAdapterDefaults: true });
    expect(config.adapter).toEqual(V1_PROJECT_ADAPTER_DEFAULTS);
    expect(config.adapter).toEqual(EMPTY_PROJECT_ADAPTER);
  });

  it("加载项目适配器清单并保留平台默认值", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mtc-adapter-"));
    tempDirs.push(dir);
    const configPath = path.join(dir, "mobile-test.config.cjs");
    await fs.writeFile(configPath, `module.exports = {
      schemaVersion: "mobile-test-console.config.v1",
      project: { id: "demo", name: "Demo", root: "." },
      compatibility: { v1ProjectAdapterDefaults: true },
      adapter: {
        workspaces: ["account-profiles"],
        pageParameters: { defaultRoute: "demo://page", templateParameter: "bundle", pageReadyEvent: "page_ready", actionSucceededEvent: "action_ok" },
        resultAnalysis: { pageOpenedEvents: ["page_opened", "page_ready"] },
        accountProfiles: { providers: { "demo-auth": {
          label: "Demo 登录", recordingLabel: "Demo 登录录制", defaultProfileId: "demo-account",
          defaultAccountLabel: "Demo 账号", requiredCapability: "login", crossPlatformCapability: "login",
          requiredCaptureKinds: ["native"], requiredResultFields: [], capabilityRules: []
        } } },
        repair: { displayName: "Demo 修复", threadNamePrefix: "Demo", fixingMessage: "Demo 修复中" }
      },
      tests: [{ id: "smoke", label: "Smoke", runnerId: "demo-runner", platforms: ["android"], commands: { default: { executable: "node", args: ["--version"] } } }]
    };`);

    const config = await loadProjectConfig(configPath);
    expect(config.adapter).toMatchObject({
      workspaces: ["account-profiles"],
      pageParameters: { defaultRoute: "demo://page", templateParameter: "bundle", pageReadyEvent: "page_ready" },
      resultAnalysis: { pageOpenedEvents: ["page_opened", "page_ready"] },
      repair: { threadNamePrefix: "Demo" },
    });
    expect(config.adapter?.accountProfiles.providers["demo-auth"]?.requiredCaptureKinds).toEqual(["native"]);
    expect(config.adapter?.accountProfiles.providers.wechat).toBeUndefined();
    expect(config.tests[0].runnerId).toBe("demo-runner");
  });

  it("显式空适配器使用平台中立默认值", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mtc-empty-adapter-"));
    tempDirs.push(dir);
    const configPath = path.join(dir, "mobile-test.config.cjs");
    await fs.writeFile(configPath, `module.exports = {
      schemaVersion: "mobile-test-console.config.v1",
      project: { id: "demo", name: "Demo", root: "." },
      adapter: {},
      tests: [{ id: "smoke", label: "Smoke", platforms: ["android"], commands: { default: { executable: "node", args: ["--version"] } } }]
    };`);

    const config = await loadProjectConfig(configPath);

    expect(config.adapter).toEqual({
      workspaces: [],
      pageParameters: { defaultRoute: "", templateParameter: "", pageReadyEvent: "", actionSucceededEvent: "" },
      resultAnalysis: { pageOpenedEvents: [] },
      accountProfiles: { providers: {} },
      repair: { displayName: "修复任务", threadNamePrefix: "修复", fixingMessage: "修复任务执行中" },
    });
  });

  it("拒绝无效 Runner ID", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mtc-runner-id-"));
    tempDirs.push(dir);
    const configPath = path.join(dir, "mobile-test.config.cjs");
    await fs.writeFile(configPath, `module.exports = {
      schemaVersion: "mobile-test-console.config.v1",
      project: { id: "demo", name: "Demo", root: "." },
      tests: [{ id: "smoke", label: "Smoke", runnerId: "Bad Runner", platforms: ["android"], commands: { default: { executable: "node", args: ["--version"] } } }]
    };`);

    await expect(loadProjectConfig(configPath)).rejects.toMatchObject({ code: "CONFIG_INVALID" });
  });

  it("允许自定义 Runner 省略 legacy 命令", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mtc-custom-runner-config-"));
    tempDirs.push(dir);
    const configPath = path.join(dir, "mobile-test.config.cjs");
    await fs.writeFile(configPath, `module.exports = {
      schemaVersion: "mobile-test-console.config.v1",
      project: { id: "demo", name: "Demo", root: "." },
      tests: [{ id: "smoke", label: "Smoke", runnerId: "custom-runner", platforms: ["android"] }]
    };`);

    const config = await loadProjectConfig(configPath);
    expect(config.tests[0].commands).toEqual({});
  });

  it("legacy Runner 仍要求至少一条命令", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mtc-legacy-command-config-"));
    tempDirs.push(dir);
    const configPath = path.join(dir, "mobile-test.config.cjs");
    await fs.writeFile(configPath, `module.exports = {
      schemaVersion: "mobile-test-console.config.v1",
      project: { id: "demo", name: "Demo", root: "." },
      tests: [{ id: "smoke", label: "Smoke", platforms: ["android"] }]
    };`);

    await expect(loadProjectConfig(configPath)).rejects.toMatchObject({ code: "CONFIG_INVALID" });
  });

  it("校验枚举参数并解析命令模板", () => {
    const config = createConfig();
    const test = config.tests[0];
    const parameters = validateParameters(test, { suite: "p0", "account-profile": "qa-account-wechat:wechat" });
    const command = resolveCommand(config, test, { ...createDevice(), manufacturer: "Huawei" }, { id: "task-1", runId: "run-1" }, parameters);

    expect(command.args).toEqual([
      "--suite",
      "p0",
      "--device",
      "android-1",
      "--manufacturer",
      "Huawei",
      "--run",
      "run-1",
      "--profiles",
      "/tmp/state/page-parameters.json",
      "--accounts",
      "/tmp/state/account-profiles.json",
      "--account-profile",
      "qa-account-wechat:wechat",
    ]);
    expect(() => validateParameters(test, { suite: "custom" })).toThrow("测试套件 的值无效");
    expect(() => validateParameters(test, { unknown: "x" })).toThrow("测试参数未声明");
    expect(() => validateParameters(test, { suite: "p0", "account-profile": "invalid profile" })).toThrow("账号画像格式无效");
  });

  it("解析删除清理命令的任务变量并拒绝未知变量", () => {
    const config = createConfig();
    config.taskDeletion.cleanup = {
      executable: "cleanup",
      args: [
        "{{task.id}}",
        "{{task.runId}}",
        "{{task.testId}}",
        "{{device.platform}}",
        "{{params.suite}}",
      ],
    };

    expect(resolveTaskDeletionCommand(config, createTask())?.args).toEqual([
      "task-1",
      "run-1",
      "suite",
      "android",
      "p0",
    ]);
    config.taskDeletion.cleanup.args = ["{{task.unknown}}"];
    expect(() => resolveTaskDeletionCommand(config, createTask())).toThrow("命令模板变量未定义");
  });

  it("加载产物保留策略并解析平台中立清理请求命令", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mtc-artifact-config-"));
    tempDirs.push(dir);
    const configPath = path.join(dir, "mobile-test.config.cjs");
    await fs.writeFile(configPath, `module.exports = {
      schemaVersion: "mobile-test-console.config.v1",
      project: { id: "demo", name: "Demo", root: "." },
      taskResults: {
        artifactsRoot: "qa/artifacts",
        provider: { executable: "node", args: ["result.cjs"] }
      },
      artifactRetention: {
        cleanup: { executable: "node", args: ["cleanup.cjs", "--request", "{{cleanup.requestPath}}", "--root", "{{results.artifactsRoot}}"] },
        policy: { maxAgeDays: 14, maxRuns: 30 }
      },
      tests: [{ id: "smoke", label: "Smoke", platforms: ["android"], commands: { default: { executable: "node", args: ["--version"] } } }]
    };`);

    const config = await loadProjectConfig(configPath);
    const command = resolveArtifactCleanupCommand(config, path.join(dir, "request.json"));

    expect(config.artifactRetention).toMatchObject({
      enabled: true,
      autoCleanup: false,
      policy: { maxAgeDays: 14, maxRuns: 30, keepSuccessfulPerPlatform: 1 },
    });
    expect(command?.args).toEqual([
      "cleanup.cjs",
      "--request", path.join(dir, "request.json"),
      "--root", path.join(dir, "qa/artifacts"),
    ]);
  });

  it("项目任务命令可透传设备厂商", () => {
    const config = createConfig();
    const test = config.tests[0];
    test.commands.default = {
      executable: "runner",
      args: ["--device-manufacturer", "{{device.manufacturer}}"],
    };

    expect(resolveCommand(
      config,
      test,
      { ...createDevice(), manufacturer: "Huawei" },
      { id: "task-1", runId: "run-1" },
      validateParameters(test, { suite: "smoke" }),
    ).args).toEqual(["--device-manufacturer", "Huawei"]);
  });

  it("设备准备命令使用设备模板变量", () => {
    const config = createConfig();
    config.devicePreparations = [{
      id: "maestro-driver",
      label: "Maestro 驱动",
      platforms: ["android"],
      blocksTests: true,
      readyDetail: "已就绪",
      requiredDetail: "需要安装",
      check: { executable: "driver", args: ["check", "{{device.id}}"] },
      install: { executable: "driver", args: ["install", "{{device.key}}"] },
    }];

    expect(resolveDevicePreparationCommand(config, config.devicePreparations[0], "check", createDevice())?.args)
      .toEqual(["check", "android-1"]);
    expect(resolveDevicePreparationCommand(config, config.devicePreparations[0], "install", createDevice())?.args)
      .toEqual(["install", "android:android-1"]);
  });
});

function createConfig(): LoadedProjectConfig {
  return {
    schemaVersion: "mobile-test-console.config.v1",
    configPath: "/tmp/config.cjs",
    project: { id: "demo", name: "Demo", root: "/tmp/demo" },
    stateDir: "/tmp/state",
    deviceProviders: ["android"],
    lifecycle: {},
    taskDeletion: {},
    tests: [{
      id: "suite",
      label: "Suite",
      description: "",
      platforms: ["android"],
      parameters: [{
        id: "suite",
        label: "测试套件",
        type: "select",
        defaultValue: "smoke",
        options: [{ value: "smoke", label: "Smoke", description: "核心页面快速检查" }, { value: "p0", label: "P0", description: "" }],
      }, {
        id: "account-profile",
        label: "测试账号",
        type: "account-profile",
        defaultValue: "current-session",
        capability: "login",
      }],
      commands: {
        default: {
          executable: "runner",
          args: [
            "--suite", "{{params.suite}}",
            "--device", "{{device.id}}",
            "--manufacturer", "{{device.manufacturer}}",
            "--run", "{{task.runId}}",
            "--profiles", "{{pageParameters.statePath}}",
            "--accounts", "{{accountProfiles.statePath}}",
            "--account-profile", "{{params.account-profile}}",
          ],
        },
      },
    }],
  };
}

function createTask() {
  return {
    id: "task-1",
    runId: "run-1",
    projectId: "demo",
    testId: "suite",
    testLabel: "Suite",
    device: createDevice(),
    parameters: { suite: "p0" },
    status: "passed" as const,
    phase: "测试通过",
    createdAt: "2026-07-21T00:00:00.000Z",
    startedAt: "2026-07-21T00:00:00.000Z",
    finishedAt: "2026-07-21T00:00:01.000Z",
    exitCode: 0,
    error: "",
    logs: [],
  };
}

function createDevice(): Device {
  return {
    key: "android:android-1",
    id: "android-1",
    name: "Android 1",
    platform: "android",
    type: "physical",
    connectionState: "available",
    controlState: "ready",
    controlReason: "",
    osVersion: "14",
    detail: "",
  };
}
