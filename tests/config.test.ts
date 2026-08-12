import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Device } from "../src/shared/contracts.js";
import {
  loadProjectConfig,
  resolveCommand,
  resolveDevicePreparationCommand,
  resolveLifecycleCommand,
  resolveAccountProfileProviderCommand,
  resolvePageParameterProviderCommand,
  resolveTaskDeletionCommand,
  resolveTaskResultCommand,
  validateParameters,
  type LoadedProjectConfig,
} from "../src/server/config.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true })));
});

describe("项目配置", () => {
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
    expect(config.project.root).toBe(path.resolve(dir, "../app"));
    expect(config.iosSimulator).toEqual({
      workspace: path.resolve(dir, "../app/ios/Demo.xcworkspace"),
      scheme: "Demo",
    });
    expect(config.tests[0].description).toBe("");
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

  it("Fanli 任务命令可透传设备厂商", () => {
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
