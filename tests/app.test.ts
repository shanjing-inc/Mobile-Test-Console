import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { TaskStatus } from "../src/shared/contracts.js";
import { createApp } from "../src/server/app.js";
import type { CommandRunner } from "../src/server/command-runner.js";
import type { LoadedProjectConfig } from "../src/server/config.js";
import { DeviceDiscoveryService } from "../src/server/devices.js";
import { StateStore } from "../src/server/state-store.js";
import { TaskManager } from "../src/server/task-manager.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true })));
});

describe("HTTP API", () => {
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
    });

    const snapshot = await app.inject({ method: "GET", url: "/api/snapshot?refresh=1" });
    expect(snapshot.statusCode).toBe(200);
    expect(snapshot.json()).toMatchObject({
      project: { id: "demo" },
      devices: expect.arrayContaining([expect.objectContaining({ key: "android:device-1" })]),
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
