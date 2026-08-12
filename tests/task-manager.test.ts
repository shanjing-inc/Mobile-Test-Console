import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Device, TaskStatus } from "../src/shared/contracts.js";
import type { LoadedProjectConfig } from "../src/server/config.js";
import { ConsoleError } from "../src/server/errors.js";
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

  it("删除终态任务并立即持久化结果", async () => {
    const dir = await createTempDir("mtc-task-delete-");
    const config = createConfig(dir);
    config.taskDeletion.cleanup = {
      executable: process.execPath,
      args: [
        "-e",
        "require('node:fs').writeFileSync('deleted-run.txt', process.argv[1])",
        "{{task.runId}}",
      ],
    };
    const manager = new TaskManager(config, new StateStore(dir));
    await manager.initialize();
    const [created] = await manager.start({ testId: "pass", deviceKeys: [device.key], parameters: {} }, [device]);
    await waitForStatus(manager, created.id, "passed");

    await expect(manager.delete(created.id)).resolves.toMatchObject({ id: created.id, status: "passed" });
    expect(await fs.readFile(path.join(dir, "deleted-run.txt"), "utf8")).toBe(created.runId);
    expect(manager.list()).toEqual([]);
    const stored = JSON.parse(await fs.readFile(path.join(dir, "state.json"), "utf8")) as { tasks: unknown[] };
    expect(stored.tasks).toEqual([]);

    const restored = new TaskManager(createConfig(dir), new StateStore(dir));
    await restored.initialize();
    expect(restored.list()).toEqual([]);
    await restored.shutdown();
    await manager.shutdown();
  });

  it("本地文件清理失败时保留任务记录", async () => {
    const dir = await createTempDir("mtc-task-delete-failure-");
    const config = createConfig(dir);
    config.taskDeletion.cleanup = {
      executable: process.execPath,
      args: ["-e", "process.stderr.write('cleanup failed'); process.exit(7)"],
    };
    const manager = new TaskManager(config, new StateStore(dir));
    await manager.initialize();
    const [created] = await manager.start({ testId: "pass", deviceKeys: [device.key], parameters: {} }, [device]);
    await waitForStatus(manager, created.id, "passed");

    await expect(manager.delete(created.id)).rejects.toMatchObject({
      code: "TASK_DELETE_CLEANUP_FAILED",
      statusCode: 500,
    } satisfies Partial<ConsoleError>);
    expect(manager.list()).toContainEqual(expect.objectContaining({ id: created.id, status: "passed" }));
    const stored = JSON.parse(await fs.readFile(path.join(dir, "state.json"), "utf8")) as { tasks: Array<{ id: string }> };
    expect(stored.tasks.map(task => task.id)).toContain(created.id);
    await manager.shutdown();
  });

  it("保护活动任务并拒绝未知任务删除", async () => {
    const { manager } = await createManager();
    const [created] = await manager.start({ testId: "long", deviceKeys: [device.key], parameters: {} }, [device]);
    const running = await waitForStatus(manager, created.id, "running");

    await expect(manager.delete(created.id)).rejects.toMatchObject({
      code: "TASK_ACTIVE",
      statusCode: 409,
    } satisfies Partial<ConsoleError>);
    expect(manager.list().find(task => task.id === created.id)).toMatchObject({
      status: running.status,
      phase: running.phase,
    });
    await expect(manager.delete("missing-task")).rejects.toMatchObject({
      code: "TASK_UNKNOWN",
      statusCode: 404,
    } satisfies Partial<ConsoleError>);

    await manager.stop(created.id);
    await waitForStatus(manager, created.id, "cancelled");
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
  controlState: "ready",
  controlReason: "",
  osVersion: "14",
  detail: "",
};

async function createManager() {
  const dir = await createTempDir("mtc-task-");
  const manager = new TaskManager(createConfig(dir), new StateStore(dir));
  await manager.initialize();
  return { manager, dir };
}

async function createTempDir(prefix: string) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

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
