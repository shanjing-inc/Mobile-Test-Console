import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { TaskResult, TaskStatus } from "../src/shared/contracts.js";
import { createApp, expandPageSelectionParameters } from "../src/server/app.js";
import type { CommandRunner } from "../src/server/command-runner.js";
import type { LoadedProjectConfig } from "../src/server/config.js";
import { DeviceDiscoveryService } from "../src/server/devices.js";
import { StateStore } from "../src/server/state-store.js";
import { TaskManager } from "../src/server/task-manager.js";
import type { TaskResultService } from "../src/server/task-results.js";
import { TEST_PROJECT_ADAPTER } from "./fixtures/project-adapter.js";
import { ProjectCatalogService, ProjectCatalogStore } from "../src/server/project-catalog.js";
import { DirectoryPicker } from "../src/server/directory-picker.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true })));
});

describe("HTTP API", () => {
  it("创建页面任务时将全部页面预设展开为冻结的页面 ID 列表", async () => {
    const parameters = { pages: "all-pages" };
    const test = {
      parameters: [{
        id: "pages",
        label: "页面范围",
        type: "page-selection" as const,
        source: "page-parameters" as const,
        defaultValue: "all-pages",
        presets: [{ value: "all-pages", label: "全部页面", description: "", filter: { testScopes: ["user-facing"] } }],
      }],
    } as unknown as LoadedProjectConfig["tests"][number];
    const pageParameters = {
      isEnabled: () => true,
      snapshot: async () => ({ pages: [
        { pageId: "pageHome", platforms: ["android"], testScope: "user-facing" },
        { pageId: "pageInternal", platforms: ["android"], testScope: "internal" },
      ] }),
    } as unknown as Parameters<typeof expandPageSelectionParameters>[2];

    await expandPageSelectionParameters(test, parameters, pageParameters, [{ platform: "android" } as never]);
    expect(parameters.pages).toBe("pageHome");
  });

  it("登记项目并返回持久化接入步骤", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mtc-api-projects-"));
    tempDirs.push(dir);
    const config = createConfig(dir);
    const candidateRoot = path.join(dir, "candidate");
    const initializationRoot = path.join(dir, "new-api-lynx");
    await fs.mkdir(candidateRoot);
    await fs.mkdir(initializationRoot);
    await fs.writeFile(path.join(candidateRoot, "mobile-test.config.cjs"), `module.exports = {
      schemaVersion: "mobile-test-console.config.v1",
      project: { id: "candidate-lynx", name: "Candidate Lynx", root: ".", integrationType: "lynx-app" },
      deviceProviders: ["android"],
      tests: [{ id: "smoke", label: "Smoke", platforms: ["android"], commands: { default: { executable: "node", args: ["--version"] } } }],
    };\n`);
    const catalog = new ProjectCatalogService(new ProjectCatalogStore(path.join(dir, "projects.json")));
    await catalog.initialize(config);
    const tasks = new TaskManager(config, new StateStore(dir));
    await tasks.initialize();
    const app = await createApp({
      config,
      devices: new DeviceDiscoveryService({ async capture() { return { code: 0, stdout: "", stderr: "" }; } }, ["android"]),
      tasks,
      projectCatalog: catalog,
      directoryPicker: new DirectoryPicker({
        async capture(_executable, args) {
          const selectingFile = args.some(argument => argument.includes("choose file"));
          return { code: 0, stdout: `${selectingFile ? path.join(candidateRoot, "mobile-test.config.cjs") : candidateRoot}\n`, stderr: "" };
        },
      }, "darwin"),
    });

    try {
      const selected = await app.inject({ method: "POST", url: "/api/projects/select-directory" });
      expect(selected.statusCode).toBe(200);
      expect(selected.json()).toMatchObject({ projectDirectory: candidateRoot, configFile: "mobile-test.config.cjs", configFound: true });

      const selectedConfig = await app.inject({ method: "POST", url: "/api/projects/select-config" });
      expect(selectedConfig.statusCode).toBe(200);
      expect(selectedConfig.json()).toMatchObject({ projectDirectory: candidateRoot, configFile: "mobile-test.config.cjs", configFound: true });

      const created = await app.inject({
        method: "POST",
        url: "/api/projects",
        payload: {
          projectDirectory: candidateRoot,
          configFile: "mobile-test.config.cjs",
        },
      });
      expect(created.statusCode).toBe(200);
      expect(created.json()).toMatchObject({
        activeProjectId: "demo",
        projects: expect.arrayContaining([
          expect.objectContaining({
            id: "candidate-lynx",
            name: "Candidate Lynx",
            integrationType: "lynx-app",
            platforms: ["android"],
            active: false,
            onboarding: expect.arrayContaining([expect.objectContaining({ id: "project", status: "verified" })]),
          }),
        ]),
      });

      const verified = await app.inject({
        method: "POST",
        url: "/api/projects/candidate-lynx/onboarding/verify",
      });
      expect(verified.statusCode).toBe(200);
      expect(verified.json().projects.find((project: { id: string }) => project.id === "candidate-lynx").onboarding)
        .toEqual(expect.arrayContaining([expect.objectContaining({ id: "template", status: "verified" })]));

      const detail = await app.inject({
        method: "GET",
        url: "/api/projects/candidate-lynx/detail",
      });
      expect(detail.statusCode).toBe(200);
      expect(detail.json()).toMatchObject({
        project: { id: "candidate-lynx", name: "Candidate Lynx" },
        tests: [{ id: "smoke", label: "Smoke", platforms: ["android"] }],
        executionReady: false,
      });

      const initializationPreview = await app.inject({
        method: "POST",
        url: "/api/projects/setup/preview",
        payload: { projectDirectory: initializationRoot, platforms: ["android"] },
      });
      expect(initializationPreview.statusCode).toBe(200);
      expect(initializationPreview.json()).toMatchObject({ step: "config", canApply: true });
      await expect(fs.stat(path.join(initializationRoot, "mobile-test.config.cjs"))).rejects.toMatchObject({ code: "ENOENT" });

      const initializationApply = await app.inject({
        method: "POST",
        url: "/api/projects/setup/apply",
        payload: {
          projectDirectory: initializationRoot,
          platforms: ["android"],
          planId: initializationPreview.json().planId,
        },
      });
      expect(initializationApply.statusCode).toBe(200);
      expect(initializationApply.json().catalog.projects).toEqual(expect.arrayContaining([
        expect.objectContaining({ id: "new-api-lynx" }),
      ]));

      const capabilityPreview = await app.inject({
        method: "POST",
        url: "/api/projects/new-api-lynx/setup/preview",
        payload: { step: "capabilities" },
      });
      expect(capabilityPreview.statusCode).toBe(200);
      expect(capabilityPreview.json().actions).toEqual(expect.arrayContaining([
        expect.objectContaining({ kind: "write-file" }),
        expect.objectContaining({ kind: "manual" }),
      ]));

      const initializedDeleted = await app.inject({ method: "DELETE", url: "/api/projects/new-api-lynx" });
      expect(initializedDeleted.statusCode).toBe(200);

      const deleted = await app.inject({ method: "DELETE", url: "/api/projects/candidate-lynx" });
      expect(deleted.statusCode).toBe(200);
      expect(deleted.json().projects).not.toEqual(expect.arrayContaining([expect.objectContaining({ id: "candidate-lynx" })]));

      const activeDelete = await app.inject({ method: "DELETE", url: "/api/projects/demo" });
      expect(activeDelete.statusCode).toBe(200);
      expect(activeDelete.json()).toMatchObject({ activeProjectId: "demo", projects: [] });
    } finally {
      await app.close();
    }
  });

  it("活动任务存在时阻止项目切换", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mtc-api-project-switch-"));
    tempDirs.push(dir);
    const config = createConfig(dir);
    const candidateRoot = path.join(dir, "candidate");
    await fs.mkdir(candidateRoot);
    const catalog = new ProjectCatalogService(new ProjectCatalogStore(path.join(dir, "projects.json")));
    await catalog.initialize(config);
    await fs.writeFile(path.join(candidateRoot, "mobile-test.config.cjs"), `module.exports = {
      schemaVersion: "mobile-test-console.config.v1",
      project: { id: "candidate", name: "Candidate", root: ".", integrationType: "app" },
      deviceProviders: ["android"],
      tests: [{ id: "smoke", label: "Smoke", platforms: ["android"], commands: { default: { executable: "node", args: ["--version"] } } }],
    };\n`);
    await catalog.register({ projectDirectory: candidateRoot, configFile: "mobile-test.config.cjs" });
    const tasks = new TaskManager(config, new StateStore(dir));
    await tasks.initialize();
    const app = await createApp({
      config,
      devices: new DeviceDiscoveryService({ async capture() { return { code: 0, stdout: "", stderr: "" }; } }, ["android"]),
      tasks,
      projectCatalog: catalog,
    });
    const task = await tasks.start({ testId: "long", deviceKeys: ["android:device-1"], parameters: {} }, [{
      key: "android:device-1", id: "device-1", name: "Pixel", platform: "android", type: "physical", connectionState: "available", osVersion: "", detail: "", controlState: "ready", controlReason: "",
    }]);
    try {
      const response = await app.inject({ method: "POST", url: "/api/projects/candidate/activate" });
      expect(response.statusCode).toBe(409);
      expect(response.json().error.code).toBe("PROJECT_SWITCH_TASK_ACTIVE");
    } finally {
      await tasks.stop(task[0].id);
      await tasks.waitForTerminal(task[0].id);
      await tasks.shutdown();
      await app.close();
    }
  });

  it("项目切换响应完成后触发重启回调", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mtc-api-project-switch-response-"));
    tempDirs.push(dir);
    const config = createConfig(dir);
    const candidateRoot = path.join(dir, "candidate");
    await fs.mkdir(candidateRoot);
    await fs.writeFile(path.join(candidateRoot, "mobile-test.config.cjs"), `module.exports = {
      schemaVersion: "mobile-test-console.config.v1",
      project: { id: "candidate", name: "Candidate", root: ".", integrationType: "app" },
      deviceProviders: ["android"],
      tests: [{ id: "smoke", label: "Smoke", platforms: ["android"], commands: { default: { executable: "node", args: ["--version"] } } }],
    };\n`);
    const catalog = new ProjectCatalogService(new ProjectCatalogStore(path.join(dir, "projects.json")));
    await catalog.initialize(config);
    await catalog.register({ projectDirectory: candidateRoot, configFile: "mobile-test.config.cjs" });
    const tasks = new TaskManager(config, new StateStore(dir));
    await tasks.initialize();
    let switchedTo = "";
    const app = await createApp({
      config,
      devices: new DeviceDiscoveryService({ async capture() { return { code: 0, stdout: "", stderr: "" }; } }, ["android"]),
      tasks,
      projectCatalog: catalog,
      onProjectSwitch: async configPath => { switchedTo = configPath; },
    });

    try {
      const response = await app.inject({ method: "POST", url: "/api/projects/candidate/activate" });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({ projectId: "candidate", restartRequired: true });
      await new Promise(resolve => setTimeout(resolve, 0));
      expect(switchedTo).toBe(path.join(candidateRoot, "mobile-test.config.cjs"));
    } finally {
      await app.close();
    }
  });

  it("返回统一快照并拒绝未知测试", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mtc-api-"));
    tempDirs.push(dir);
    const config = createConfig(dir);
    const runner: CommandRunner = {
      async capture() {
        return { code: 0, stdout: "device-1 device model:Pixel_8\n", stderr: "" };
      },
    };
    const tasks = new TaskManager(config, new StateStore(dir));
    await tasks.initialize();
    const app = await createApp({
      config,
      devices: new DeviceDiscoveryService(runner, ["android"]),
      tasks,
      projectProviders: [{
        schemaVersion: "mobile-test-console.project-provider.v1",
        providerId: "demo-app",
        scope: { targetKinds: ["app"], runtimes: ["lynx"], platforms: ["android"] },
        capabilities: [{ id: "app.build", version: 1 }],
      }],
    });

    const snapshot = await app.inject({ method: "GET", url: "/api/snapshot?refresh=1" });
    expect(snapshot.statusCode).toBe(200);
    expect(snapshot.json()).toMatchObject({
      project: { id: "demo" },
      adapter: { workspaces: [] },
      connectors: [expect.objectContaining({ connectorId: "android-app" })],
      projectProviders: [expect.objectContaining({ providerId: "demo-app" })],
      devices: expect.arrayContaining([expect.objectContaining({
        key: "android:device-1",
        connectorId: "android-app",
        capabilities: expect.arrayContaining(["device.discover"]),
      })]),
      tests: expect.arrayContaining([expect.objectContaining({ id: "pass" })]),
    });

    const invalid = await app.inject({
      method: "POST",
      url: "/api/tasks",
      payload: { testId: "missing", deviceKeys: ["android:device-1"], parameters: {} },
    });
    expect(invalid.statusCode).toBe(404);
    expect(invalid.json().error.code).toBe("TEST_UNKNOWN");
    await app.close();
  });

  it("返回小程序运行目标并通过 targetKeys 启动任务", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mtc-api-mini-program-"));
    tempDirs.push(dir);
    const config = createMiniProgramConfig(dir);
    const tasks = new TaskManager(config, new StateStore(dir));
    await tasks.initialize();
    const app = await createApp({
      config,
      devices: new DeviceDiscoveryService({ async capture() { return { code: 0, stdout: "", stderr: "" }; } }, []),
      tasks,
    });

    try {
      const snapshot = await app.inject({ method: "GET", url: "/api/snapshot" });
      expect(snapshot.statusCode).toBe(200);
      expect(snapshot.json()).toMatchObject({
        project: { id: "mini-demo", integrationType: "mini-program" },
        devices: [],
        targets: [{
          key: "wechat-devtools",
          kind: "mini-program",
          platform: "wechat",
          runtime: "wechat-devtools",
          appId: "wx-test",
        }],
        tests: [expect.objectContaining({ id: "smoke", targetKeys: ["wechat-devtools"], platforms: [] })],
      });

      const response = await app.inject({
        method: "POST",
        url: "/api/tasks",
        payload: { testId: "smoke", targetKeys: ["wechat-devtools"], parameters: {} },
      });
      expect(response.statusCode).toBe(200);
      const [task] = response.json().tasks;
      expect(task).toMatchObject({
        testId: "smoke",
        target: { key: "wechat-devtools", kind: "mini-program", runtime: "wechat-devtools" },
        device: { key: "wechat-devtools" },
      });
      await tasks.waitForTerminal(task.id);
      expect(tasks.get(task.id)).toMatchObject({ status: "passed", target: { key: "wechat-devtools" } });

      const mixed = await app.inject({
        method: "POST",
        url: "/api/tasks",
        payload: { testId: "smoke", deviceKeys: ["android:device-1"], targetKeys: ["wechat-devtools"], parameters: {} },
      });
      expect(mixed.statusCode).toBe(400);
      expect(mixed.json().error.code).toBe("REQUEST_INVALID");
    } finally {
      await tasks.shutdown();
      await app.close();
    }
  });

  it("拒绝空的设备或运行目标选择", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mtc-api-empty-selection-"));
    tempDirs.push(dir);
    const config = createConfig(dir);
    const tasks = new TaskManager(config, new StateStore(dir));
    await tasks.initialize();
    const app = await createApp({
      config,
      devices: new DeviceDiscoveryService({ async capture() { return { code: 0, stdout: "", stderr: "" }; } }, ["android"]),
      tasks,
    });
    try {
      const response = await app.inject({ method: "POST", url: "/api/tasks", payload: { testId: "pass", deviceKeys: [], targetKeys: [], parameters: {} } });
      expect(response.statusCode).toBe(400);
      expect(response.json().error.code).toBe("REQUEST_INVALID");
    } finally {
      await app.close();
    }
  });

  it("从失败结果创建定向重试任务并校验用例范围", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mtc-api-retry-"));
    tempDirs.push(dir);
    const config = createMiniProgramConfig(dir);
    config.tests[0].commands = { default: { executable: process.execPath, args: ["-e", "process.exit(1)"] } };
    const tasks = new TaskManager(config, new StateStore(dir));
    await tasks.initialize();
    const taskResult: TaskResult = {
      schemaVersion: "mobile-test-console.task-result.v1",
      generatedAt: "2026-08-13T00:00:00.000Z",
      taskId: "",
      runId: "",
      total: 2,
      caseRunCount: 2,
      passed: 1,
      failed: 1,
      warnings: [],
      runs: [
        createRetryResultRun("failed-case-run", "failed-case", "failed"),
        createRetryResultRun("passed-case-run", "passed-case", "passed"),
      ],
    };
    const taskResults = {
      async load(taskId: string) {
        const source = tasks.get(taskId);
        return { ...taskResult, taskId, runId: source?.runId ?? "" };
      },
      invalidate() {},
    } as unknown as TaskResultService;
    const app = await createApp({
      config,
      devices: new DeviceDiscoveryService({ async capture() { return { code: 0, stdout: "", stderr: "" }; } }, []),
      tasks,
      taskResults,
    });

    try {
      const sourceResponse = await app.inject({
        method: "POST",
        url: "/api/tasks",
        payload: { testId: "smoke", targetKeys: ["wechat-devtools"], parameters: {} },
      });
      const [source] = sourceResponse.json().tasks;
      const activeRetry = await app.inject({ method: "POST", url: `/api/tasks/${source.id}/retry`, payload: {} });
      expect(activeRetry.statusCode).toBe(409);
      expect(activeRetry.json().error.code).toBe("TASK_NOT_RETRYABLE");
      await tasks.waitForTerminal(source.id);

      const unknown = await app.inject({ method: "POST", url: "/api/tasks/missing-task/retry", payload: {} });
      expect(unknown.statusCode).toBe(404);
      expect(unknown.json().error.code).toBe("TASK_UNKNOWN");

      const response = await app.inject({
        method: "POST",
        url: `/api/tasks/${source.id}/retry`,
        payload: { caseRunIds: ["failed-case-run"] },
      });
      expect(response.statusCode).toBe(200);
      const [retry] = response.json().tasks;
      expect(retry).toMatchObject({
        retryOf: {
          taskId: source.id,
          runId: source.runId,
          scope: "cases",
          attempt: 1,
          caseRunIds: ["failed-case-run"],
          caseIds: ["failed-case"],
          targetPages: ["pages/demo/index"],
          caseRuns: [{ caseRunId: "failed-case-run", targetPage: "pages/demo/index", launchPage: "pages/demo/index" }],
        },
      });
      expect(retry.id).not.toBe(source.id);
      expect(retry.runId).not.toBe(source.runId);
      expect(tasks.get(source.id)?.retained).toBe(true);

      const busy = await app.inject({
        method: "POST",
        url: `/api/tasks/${source.id}/retry`,
        payload: {},
      });
      expect(busy.statusCode).toBe(409);
      expect(busy.json().error.code).toBe("TARGET_BUSY");

      await tasks.waitForTerminal(retry.id);
      expect(tasks.get(source.id)?.id).toBe(source.id);
      const wholeTask = await app.inject({
        method: "POST",
        url: `/api/tasks/${source.id}/retry`,
        payload: {},
      });
      expect(wholeTask.statusCode).toBe(200);
      expect(wholeTask.json().tasks[0]).toMatchObject({
        retryOf: { taskId: source.id, scope: "task", attempt: 1 },
      });
      await tasks.waitForTerminal(wholeTask.json().tasks[0].id);

      const passed = await app.inject({
        method: "POST",
        url: `/api/tasks/${source.id}/retry`,
        payload: { caseRunIds: ["passed-case-run"] },
      });
      expect(passed.statusCode).toBe(200);
      expect(passed.json().tasks[0]).toMatchObject({ retryOf: { scope: "cases", caseRunIds: ["passed-case-run"] } });
      await tasks.waitForTerminal(passed.json().tasks[0].id);

      const unknownCase = await app.inject({
        method: "POST",
        url: `/api/tasks/${source.id}/retry`,
        payload: { caseRunIds: ["missing-case-run"] },
      });
      expect(unknownCase.statusCode).toBe(404);
      expect(unknownCase.json().error.code).toBe("RETRY_CASE_UNKNOWN");

      const duplicate = await app.inject({
        method: "POST",
        url: `/api/tasks/${source.id}/retry`,
        payload: { caseRunIds: ["failed-case-run", "failed-case-run"] },
      });
      expect(duplicate.statusCode).toBe(400);
      expect(duplicate.json().error.code).toBe("RETRY_CASE_DUPLICATE");
    } finally {
      await tasks.shutdown();
      await app.close();
    }
  });

  it("默认快照立即返回运行状态并在后台发现设备", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mtc-api-swr-"));
    tempDirs.push(dir);
    const config = createConfig(dir);
    const gate = deferred<void>();
    const runner: CommandRunner = {
      async capture() {
        await gate.promise;
        return { code: 0, stdout: "device-1 offline model:Pixel_8\n", stderr: "" };
      },
    };
    const tasks = new TaskManager(config, new StateStore(dir));
    await tasks.initialize();
    const app = await createApp({
      config,
      devices: new DeviceDiscoveryService(runner, ["android"]),
      tasks,
    });

    const initial = await app.inject({ method: "GET", url: "/api/snapshot" });
    expect(initial.statusCode).toBe(200);
    expect(initial.json()).toMatchObject({
      devices: [],
      deviceDiscoveryPending: true,
      tasks: [],
    });

    const refreshed = app.inject({ method: "GET", url: "/api/snapshot?refresh=1" });
    gate.resolve();
    await expect(refreshed).resolves.toMatchObject({ statusCode: 200 });
    expect((await refreshed).json()).toMatchObject({
      devices: [expect.objectContaining({ key: "android:device-1" })],
      deviceDiscoveryPending: false,
    });
    await app.close();
  });

  it("通过设备启动接口重新校验并启动 iOS 模拟器", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mtc-api-ios-start-"));
    tempDirs.push(dir);
    const config = createConfig(dir);
    let state = "Shutdown";
    const runner: CommandRunner = {
      async capture(executable, args) {
        if (executable === "xcodebuild") {
          return { code: 0, stdout: "{ platform:iOS Simulator, id:SIM-1, OS:18.5, name:iPhone 16 }", stderr: "" };
        }
        if (executable === "xcrun" && args[0] === "simctl" && args[1] === "list") {
          return { code: 0, stdout: JSON.stringify({ devices: { runtime: [{ udid: "SIM-1", name: "iPhone 16", state, isAvailable: true }] } }), stderr: "" };
        }
        if (executable === "xcrun" && args[0] === "devicectl") {
          return { code: 1, stdout: "", stderr: "devicectl unavailable" };
        }
        if (executable === "xcrun" && args[0] === "simctl" && args[1] === "boot") state = "Booted";
        return { code: 0, stdout: "", stderr: "" };
      },
    };
    const tasks = new TaskManager(config, new StateStore(dir));
    await tasks.initialize();
    const app = await createApp({
      config,
      devices: new DeviceDiscoveryService(runner, ["ios"], { workspace: "/tmp/Demo.xcworkspace", scheme: "Demo" }),
      tasks,
    });

    try {
      const response = await app.inject({
        method: "POST",
        url: "/api/devices/start",
        payload: { deviceKey: "ios:SIM-1" },
      });
      expect(response.statusCode).toBe(200);
      expect(response.json().device).toMatchObject({ key: "ios:SIM-1", controlState: "ready", detail: "已启动" });

      const invalid = await app.inject({ method: "POST", url: "/api/devices/start", payload: { deviceKey: "" } });
      expect(invalid.statusCode).toBe(400);
      expect(invalid.json().error.code).toBe("REQUEST_INVALID");
    } finally {
      await app.close();
    }
  });

  it("通过设备准备接口安装并复检项目声明的依赖", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mtc-api-device-preparation-"));
    tempDirs.push(dir);
    const config = createConfig(dir);
    config.devicePreparations = [{
      id: "maestro-driver",
      label: "Maestro 驱动",
      platforms: ["android"],
      blocksTests: false,
      readyDetail: "已就绪",
      requiredDetail: "需要安装",
      check: { executable: "driver", args: ["check"] },
      install: { executable: "driver", args: ["install"] },
    }];
    let installed = false;
    const runner: CommandRunner = {
      async capture(executable, args) {
        if (executable === "adb" && args[0] === "devices") {
          return { code: 0, stdout: "redmi-1 device model:Redmi_K20\n", stderr: "" };
        }
        if (executable === "adb") return { code: 0, stdout: "Xiaomi\n", stderr: "" };
        if (args[0] === "check") return { code: installed ? 0 : 1, stdout: "", stderr: "" };
        installed = true;
        return { code: 0, stdout: "installed", stderr: "" };
      },
    };
    const tasks = new TaskManager(config, new StateStore(dir));
    await tasks.initialize();
    const devices = new DeviceDiscoveryService(runner, ["android"], undefined, config);
    const app = await createApp({ config, devices, tasks });

    try {
      const before = await app.inject({ method: "GET", url: "/api/snapshot?refresh=1" });
      expect(before.json().devices[0].preparations[0].status).toBe("required");
      const response = await app.inject({
        method: "POST",
        url: "/api/devices/preparations/install",
        payload: { deviceKey: "android:redmi-1", preparationId: "maestro-driver" },
      });
      expect(response.statusCode).toBe(200);
      expect(response.json().preparation).toMatchObject({ id: "maestro-driver", status: "ready" });
    } finally {
      await app.close();
    }
  });

  it("通过删除接口保护活动任务并清理终态记录", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mtc-api-delete-"));
    tempDirs.push(dir);
    const config = createConfig(dir);
    const runner: CommandRunner = {
      async capture() {
        return { code: 0, stdout: "device-1 device model:Pixel_8\n", stderr: "" };
      },
    };
    const devices = new DeviceDiscoveryService(runner, ["android"]);
    const tasks = new TaskManager(config, new StateStore(dir));
    await tasks.initialize();
    const app = await createApp({ config, devices, tasks });

    try {
      const discovery = await devices.discover();
      const [created] = await tasks.start({
        testId: "long",
        deviceKeys: ["android:device-1"],
        parameters: {},
      }, discovery.devices);
      await waitForStatus(tasks, created.id, "running");

      const active = await app.inject({ method: "DELETE", url: `/api/tasks/${created.id}` });
      expect(active.statusCode).toBe(409);
      expect(active.json().error.code).toBe("TASK_ACTIVE");
      expect(tasks.list().find(task => task.id === created.id)?.status).toBe("running");

      await tasks.stop(created.id);
      await waitForStatus(tasks, created.id, "cancelled");
      const deleted = await app.inject({ method: "DELETE", url: `/api/tasks/${created.id}` });
      expect(deleted.statusCode).toBe(200);
      expect(deleted.json().task).toMatchObject({ id: created.id, status: "cancelled" });

      const snapshot = await app.inject({ method: "GET", url: "/api/snapshot" });
      expect(snapshot.json().tasks).toEqual([]);
      const stored = JSON.parse(await fs.readFile(path.join(dir, "state.json"), "utf8")) as { tasks: unknown[] };
      expect(stored.tasks).toEqual([]);

      const unknown = await app.inject({ method: "DELETE", url: "/api/tasks/missing-task" });
      expect(unknown.statusCode).toBe(404);
      expect(unknown.json().error.code).toBe("TASK_UNKNOWN");
    } finally {
      await tasks.shutdown();
      await app.close();
    }
  });

  it("启动任务前严格校验显式账号画像有效期", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mtc-api-account-profile-"));
    tempDirs.push(dir);
    const config = createConfig(dir);
    config.tests[0].parameters = [
      {
        id: "environment",
        label: "测试环境",
        type: "select",
        defaultValue: "qa",
        options: [{ value: "qa", label: "QA", description: "" }],
      },
      {
        id: "account-profile",
        label: "测试账号",
        type: "account-profile",
        defaultValue: "current-session",
        capability: "login",
      },
    ];
    await fs.writeFile(path.join(dir, "account-profiles.json"), JSON.stringify({
      schemaVersion: "mobile-test-console.account-profile-state.v1",
      profiles: [{
        schemaVersion: "mobile-test-console.account-profile.v2",
        profileId: "missing-expiry",
        accountLabel: "缺少有效期",
        platform: "ios",
        environment: "qa",
        version: 2,
        providerEntries: [{
          provider: "wechat",
          accountUid: "uid-1",
          sourceDeviceKey: "ios:1",
          capabilities: ["login"],
          captures: [],
          recordedAt: "2026-08-01T00:00:00.000Z",
          validatedAt: "",
          expiresAt: "",
        }],
      }],
      recordings: [],
    }));
    const runner: CommandRunner = {
      async capture() {
        return { code: 0, stdout: "device-1 device model:Pixel_8\n", stderr: "" };
      },
    };
    const tasks = new TaskManager(config, new StateStore(dir));
    await tasks.initialize();
    const app = await createApp({
      config,
      devices: new DeviceDiscoveryService(runner, ["android"]),
      tasks,
    });

    try {
      const response = await app.inject({
        method: "POST",
        url: "/api/tasks",
        payload: {
          testId: "pass",
          deviceKeys: ["android:device-1"],
          parameters: { environment: "qa", "account-profile": "missing-expiry:wechat" },
        },
      });

      expect(response.statusCode).toBe(409);
      expect(response.json().error.code).toBe("ACCOUNT_PROFILE_EXPIRED");
      expect(tasks.list()).toEqual([]);
    } finally {
      await app.close();
    }
  });

  it("账号录制 API 在 Provider 调用前拒绝 Redmi 上的华为登录", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mtc-api-huawei-recording-"));
    tempDirs.push(dir);
    const config = createConfig(dir);
    config.adapter = TEST_PROJECT_ADAPTER;
    const runner: CommandRunner = {
      async capture(executable, args) {
        if (executable === "adb" && args[0] === "devices") {
          return { code: 0, stdout: "redmi-1 device model:Redmi_Note_13\n", stderr: "" };
        }
        return { code: 0, stdout: "Xiaomi\n", stderr: "" };
      },
    };
    const tasks = new TaskManager(config, new StateStore(dir));
    await tasks.initialize();
    const app = await createApp({ config, devices: new DeviceDiscoveryService(runner, ["android"]), tasks });

    try {
      const response = await app.inject({
        method: "POST",
        url: "/api/account-profile-recordings",
        payload: {
          deviceKey: "android:redmi-1",
          profileId: "redmi-huawei",
          accountLabel: "Redmi 华为登录",
          provider: "huawei",
          environment: "qa",
        },
      });

      expect(response.statusCode).toBe(409);
      expect(response.json().error.code).toBe("ACCOUNT_PROFILE_DEVICE_MISMATCH");
    } finally {
      await app.close();
    }
  });
});

function createConfig(stateDir: string): LoadedProjectConfig {
  return {
    schemaVersion: "mobile-test-console.config.v1",
    configPath: path.join(stateDir, "config.cjs"),
    project: { id: "demo", name: "Demo", root: stateDir },
    stateDir,
    deviceProviders: ["android"],
    lifecycle: {},
    taskDeletion: {},
    tests: [
      {
        id: "pass",
        label: "Pass",
        description: "",
        platforms: ["android"],
        parameters: [],
        commands: { default: { executable: process.execPath, args: ["-e", "process.exit(0)"] } },
      },
      {
        id: "long",
        label: "Long",
        description: "",
        platforms: ["android"],
        parameters: [],
        commands: { default: { executable: process.execPath, args: ["-e", "setInterval(() => {}, 20)"] } },
      },
    ],
  };
}

function createMiniProgramConfig(stateDir: string): LoadedProjectConfig {
  return {
    schemaVersion: "mobile-test-console.config.v1",
    configPath: path.join(stateDir, "config.cjs"),
    project: { id: "mini-demo", name: "Mini Demo", root: stateDir, integrationType: "mini-program" },
    stateDir,
    deviceProviders: [],
    testing: {
      environments: [{ id: "qa", label: "QA", description: "" }],
      capabilities: [],
      targets: [{
        key: "wechat-devtools",
        label: "微信开发者工具",
        kind: "mini-program",
        platform: "wechat",
        runtime: "wechat-devtools",
        appId: "wx-test",
        concurrencyKey: "mini-demo-wechat",
      }],
    },
    lifecycle: {},
    taskDeletion: {},
    tests: [{
      id: "smoke",
      label: "Smoke",
      description: "",
      platforms: [],
      targetKeys: ["wechat-devtools"],
      parameters: [],
      commands: { default: { executable: process.execPath, args: ["-e", "process.exit(0)"] } },
    }],
  };
}

function createRetryResultRun(caseRunId: string, caseId: string, status: "passed" | "failed") {
  return {
    runId: caseRunId,
    caseRunId,
    caseRunCount: 1,
    caseId,
    targetPage: "pages/demo/index",
    launchPage: "pages/demo/index",
    scenario: "render",
    fixture: "fixture-v1",
    platform: "wechat",
    device: "微信开发者工具",
    status,
    errorSummary: status === "failed" ? "页面失败" : "",
    requiredEvents: [],
    missingEvents: [],
    runtimeEventCount: 0,
    uiActionCount: 0,
    apiCalls: [],
    screenshots: [],
    evidenceFiles: [],
    failureLogExcerpt: "",
  };
}

async function waitForStatus(manager: TaskManager, taskId: string, expected: TaskStatus) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const task = manager.list().find(item => item.id === taskId);
    if (task?.status === expected) return task;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error(`等待任务状态超时: ${expected}`);
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>(next => { resolve = next; });
  return { promise, resolve };
}
