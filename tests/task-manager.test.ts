import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Device, TaskStatus } from "../src/shared/contracts.js";
import type { LoadedProjectConfig } from "../src/server/config.js";
import { StateStore } from "../src/server/state-store.js";
import { TaskManager } from "../src/server/task-manager.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true })));
});

describe("任务管理器", () => {
  it("执行白名单命令并保存通过状态和日志", async () => {
    const { manager } = await createManager();
    const [created] = await manager.start({ testId: "pass", deviceKeys: [device.key], parameters: {} }, [device]);
    const finished = await waitForStatus(manager, created.id, "passed");

    expect(finished.exitCode).toBe(0);
    expect(finished.logs.join("\n")).toContain("runner output");
    await manager.shutdown();
  });

  it("同一设备保持互斥并支持停止任务", async () => {
    const { manager } = await createManager();
    const [created] = await manager.start({ testId: "long", deviceKeys: [device.key], parameters: {} }, [device]);
    await waitForStatus(manager, created.id, "running");

    await expect(manager.start({ testId: "pass", deviceKeys: [device.key], parameters: {} }, [device]))
      .rejects.toThrow("正在执行");
    await manager.stop(created.id);
    const cancelled = await waitForStatus(manager, created.id, "cancelled");
    expect(cancelled.phase).toBe("已取消");
    await manager.shutdown();
  });

  it("服务恢复时将活动任务标记为中断", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mtc-state-"));
    tempDirs.push(dir);
    const store = new StateStore(dir);
    await store.save([{
      id: "old-task",
      runId: "old-run",
      projectId: "demo",
      testId: "long",
      testLabel: "Long",
      device,
      parameters: {},
      status: "running",
      phase: "执行中",
      createdAt: new Date().toISOString(),
      startedAt: new Date().toISOString(),
      finishedAt: "",
      exitCode: null,
      error: "",
      logs: [],
    }]);
    const manager = new TaskManager(createConfig(dir), store);
    await manager.initialize();

    expect(manager.list()[0]).toMatchObject({ status: "interrupted", phase: "服务重启，任务已中断" });
    await manager.shutdown();
  });
});

const device: Device = {
  key: "android:device-1",
  id: "device-1",
  name: "Device 1",
  platform: "android",
  type: "physical",
  connectionState: "available",
  osVersion: "14",
  detail: "",
};

async function createManager() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mtc-task-"));
  tempDirs.push(dir);
  const manager = new TaskManager(createConfig(dir), new StateStore(dir));
  await manager.initialize();
  return { manager, dir };
}

function createConfig(stateDir: string): LoadedProjectConfig {
  return {
    schemaVersion: "mobile-test-console.config.v1",
    configPath: path.join(stateDir, "config.cjs"),
    project: { id: "demo", name: "Demo", root: stateDir },
    stateDir,
    deviceProviders: ["android"],
    tests: [
      {
        id: "pass",
        label: "Pass",
        description: "",
        platforms: ["android"],
        parameters: [],
        commands: { default: { executable: process.execPath, args: ["-e", "console.log('runner output')"] } },
      },
      {
        id: "long",
        label: "Long",
        description: "",
        platforms: ["android"],
        parameters: [],
        commands: { default: { executable: process.execPath, args: ["-e", "setInterval(() => console.log('tick'), 20)"] } },
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
