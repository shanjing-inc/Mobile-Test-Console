import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createRunnerEvent,
  type InProcessRunner,
  type RunPlan,
  type RunnerResolver,
  type RunnerResult,
} from "../src/runner/sdk.js";
import type { Device, MiniProgramRunTarget, TaskStatus, TestTask } from "../src/shared/contracts.js";
import type { LoadedProjectConfig } from "../src/server/config.js";
import { ConsoleError } from "../src/server/errors.js";
import { StateStore } from "../src/server/state-store.js";
import { TaskManager } from "../src/server/task-manager.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true })));
});

describe("任务管理器", () => {
  it("默认使用 legacy runner 执行白名单命令并保存通过状态和日志", async () => {
    const { manager, dir } = await createManager();
    const [created] = await manager.start({ testId: "pass", deviceKeys: [device.key], parameters: {} }, [device]);
    const finished = await waitForStatus(manager, created.id, "passed");

    expect(created.runnerId).toBe("legacy-command-runner");
    expect(finished.exitCode).toBe(0);
    expect(finished.logs.join("\n")).toContain("runner output");
    const stored = JSON.parse(await fs.readFile(path.join(dir, "state.json"), "utf8")) as {
      tasks: Array<{ runnerId?: string }>;
    };
    expect(stored.tasks[0].runnerId).toBe("legacy-command-runner");
    await manager.shutdown();
  });

  it("通过 resolver 将 RunPlan 交给自定义 runner 并映射日志事件", async () => {
    const dir = await createTempDir("mtc-task-resolver-");
    const resolverPlans: RunPlan[] = [];
    const runnerPlans: RunPlan[] = [];
    const fallbackShutdown = vi.fn();
    const fallbackRunner: InProcessRunner = {
      id: "fallback-runner",
      async run(plan) {
        throw new Error(`不应调用 fallback runner: ${plan.runId}`);
      },
      shutdown: fallbackShutdown,
    };
    const customRunner: InProcessRunner = {
      id: "custom-runner",
      async run(plan, context) {
        runnerPlans.push(plan);
        context.emit(createRunnerEvent(plan.runId, "log", {
          source: "stdout",
          message: "custom runner output",
        }));
        context.emit(createRunnerEvent(plan.runId, "log", {
          source: "stderr",
          message: "custom runner warning",
        }));
        return { runId: plan.runId, status: "passed", exitCode: 0 };
      },
    };
    const resolver: RunnerResolver = {
      resolve(plan) {
        resolverPlans.push(plan);
        return customRunner;
      },
    };
    const manager = new TaskManager(createConfig(dir), new StateStore(dir), fallbackRunner, resolver);
    await manager.initialize();

    const [created] = await manager.start({ testId: "pass", deviceKeys: [device.key], parameters: {} }, [device]);
    const finished = await waitForStatus(manager, created.id, "passed");

    expect(resolverPlans).toHaveLength(1);
    expect(runnerPlans).toHaveLength(1);
    expect(runnerPlans[0]).toBe(resolverPlans[0]);
    expect(runnerPlans[0]).toMatchObject({
      runId: created.runId,
      projectId: "demo",
      testId: "pass",
      runnerId: "legacy-command-runner",
      device: { key: device.key },
      command: {
        executable: process.execPath,
        args: ["-e", "console.log('runner output')"],
      },
      metadata: { taskId: created.id, parameters: {} },
    });
    expect(finished.logs).toContain("custom runner output");
    expect(finished.logs).toContain("[stderr] custom runner warning");
    await manager.shutdown();
    expect(fallbackShutdown).not.toHaveBeenCalled();
  });

  it("持久化手动重试来源并传入 Runner metadata", async () => {
    const dir = await createTempDir("mtc-task-retry-");
    const plans: RunPlan[] = [];
    const runner: InProcessRunner = {
      id: "retry-runner",
      async run(plan) {
        plans.push(plan);
        return { runId: plan.runId, status: "passed", exitCode: 0 };
      },
    };
    const manager = new TaskManager(createConfig(dir), new StateStore(dir), runner, { resolve: () => runner });
    await manager.initialize();
    const retryOf = {
      taskId: "source-task",
      runId: "source-run",
      scope: "failed-cases" as const,
      attempt: 2,
      caseRunIds: ["case-run-one"],
      caseIds: ["case-one"],
      targetPages: ["pages/demo/index"],
    };

    const [created] = await manager.start(
      { testId: "pass", deviceKeys: [device.key], parameters: {} },
      [device],
      undefined,
      undefined,
      undefined,
      [],
      retryOf,
    );
    await waitForStatus(manager, created.id, "passed");

    expect(created.retryOf).toEqual(retryOf);
    expect(plans[0].metadata).toMatchObject({ taskId: created.id, retry: retryOf });
    expect(plans[0].command?.env).toMatchObject({
      MTC_RETRY_CASE_IDS: "case-one",
      MTC_RETRY_TARGET_PAGES: "pages/demo/index",
    });
    const stored = JSON.parse(await fs.readFile(path.join(dir, "state.json"), "utf8")) as {
      tasks: Array<{ retryOf?: typeof retryOf }>;
    };
    expect(stored.tasks[0].retryOf).toEqual(retryOf);
    await manager.shutdown();
  });

  it("复测计划生成失败时保留来源任务原状态", async () => {
    const dir = await createTempDir("mtc-task-retry-plan-failure-");
    const manager = new TaskManager(createConfig(dir), new StateStore(dir));
    await manager.initialize();
    const [source] = await manager.start({ testId: "pass", deviceKeys: [device.key], parameters: {} }, [device]);
    await waitForStatus(manager, source.id, "passed");

    await expect(manager.start(
      { testId: "pass", deviceKeys: [device.key], parameters: {} },
      [device], undefined, undefined,
      () => { throw new Error("计划生成失败"); },
      [],
      { taskId: source.id, runId: source.runId, scope: "task", attempt: 1 },
    )).rejects.toThrow("计划生成失败");

    expect(manager.get(source.id)?.retained).toBeUndefined();
    expect(manager.list()).toHaveLength(1);
    await manager.shutdown();
  });

  it("自定义 Runner 可以在没有 legacy 命令时直接接收运行计划", async () => {
    const dir = await createTempDir("mtc-task-plugin-only-");
    const config = createConfig(dir);
    config.tests.push({
      id: "plugin-only",
      label: "Plugin Only",
      description: "",
      runnerId: "custom-runner",
      platforms: ["android"],
      parameters: [],
      commands: {},
    });
    let receivedPlan: RunPlan | undefined;
    const runner: InProcessRunner = {
      id: "custom-runner",
      async run(plan) {
        receivedPlan = plan;
        return { runId: plan.runId, status: "passed", exitCode: 0 };
      },
    };
    const manager = new TaskManager(config, new StateStore(dir), runner, { resolve: () => runner });
    await manager.initialize();

    const [created] = await manager.start({ testId: "plugin-only", deviceKeys: [device.key], parameters: {} }, [device]);
    await expect(waitForStatus(manager, created.id, "passed")).resolves.toMatchObject({ runnerId: "custom-runner" });
    expect(receivedPlan).toMatchObject({ runnerId: "custom-runner", testId: "plugin-only" });
    expect(receivedPlan?.command).toBeUndefined();
    await manager.shutdown();
  });

  it("保留第三构造参数的单 runner 注入行为", async () => {
    const dir = await createTempDir("mtc-task-runner-compat-");
    const plans: RunPlan[] = [];
    const runner: InProcessRunner = {
      id: "injected-runner",
      async run(plan) {
        plans.push(plan);
        return { runId: plan.runId, status: "passed", exitCode: 0 };
      },
    };
    const manager = new TaskManager(createConfig(dir), new StateStore(dir), runner);
    await manager.initialize();

    const [created] = await manager.start({ testId: "pass", deviceKeys: [device.key], parameters: {} }, [device]);
    await waitForStatus(manager, created.id, "passed");

    expect(plans).toHaveLength(1);
    expect(plans[0].runId).toBe(created.runId);
    await manager.shutdown();
  });

  it("映射自定义 runner 的失败结果、退出码和错误", async () => {
    const dir = await createTempDir("mtc-task-runner-failure-");
    const runner: InProcessRunner = {
      id: "failing-runner",
      async run(plan) {
        return {
          runId: plan.runId,
          status: "failed",
          exitCode: 23,
          error: "custom runner failure",
        };
      },
    };
    const manager = new TaskManager(
      createConfig(dir),
      new StateStore(dir),
      runner,
      { resolve: () => runner },
    );
    await manager.initialize();

    const [created] = await manager.start({ testId: "pass", deviceKeys: [device.key], parameters: {} }, [device]);
    const finished = await waitForStatus(manager, created.id, "failed");

    expect(finished).toMatchObject({
      status: "failed",
      phase: "测试失败",
      exitCode: 23,
      error: "custom runner failure",
    });
    expect(finished.logs).toContain("[console] custom runner failure");
    await manager.shutdown();
  });

  it("保存 Runner 返回的结果 URI", async () => {
    const dir = await createTempDir("mtc-task-result-uri-");
    const runner: InProcessRunner = {
      id: "result-runner",
      async run(plan) {
        return {
          runId: plan.runId,
          status: "passed",
          exitCode: 0,
          resultUri: `result-bundle://runs/${plan.runId}`,
        };
      },
    };
    const manager = new TaskManager(createConfig(dir), new StateStore(dir), runner, { resolve: () => runner });
    await manager.initialize();

    const [created] = await manager.start({ testId: "pass", deviceKeys: [device.key], parameters: {} }, [device]);
    const finished = await waitForStatus(manager, created.id, "passed");

    expect(finished.resultUri).toBe(`result-bundle://runs/${created.runId}`);
    const stored = JSON.parse(await fs.readFile(path.join(dir, "state.json"), "utf8")) as {
      tasks: Array<{ resultUri?: string }>;
    };
    expect(stored.tasks[0].resultUri).toBe(finished.resultUri);
    await manager.shutdown();
  });

  it("任务终态持久化后通知接入进度监听器", async () => {
    const dir = await createTempDir("mtc-task-completion-listener-");
    const completed: Array<{ status: TaskStatus; resultUri?: string }> = [];
    const runner: InProcessRunner = {
      id: "result-runner",
      async run(plan) {
        return { runId: plan.runId, status: "passed", exitCode: 0, resultUri: `result-bundle://runs/${plan.runId}` };
      },
    };
    const manager = new TaskManager(
      createConfig(dir),
      new StateStore(dir),
      runner,
      { resolve: () => runner },
      task => { completed.push({ status: task.status, resultUri: task.resultUri }); },
    );
    await manager.initialize();

    const [created] = await manager.start({ testId: "pass", deviceKeys: [device.key], parameters: {} }, [device]);
    await waitForStatus(manager, created.id, "passed");
    expect(completed).toEqual([{ status: "passed", resultUri: `result-bundle://runs/${created.runId}` }]);
    await manager.shutdown();
  });

  it("resolver 抛错时仅将对应任务标记为失败", async () => {
    const dir = await createTempDir("mtc-task-resolver-failure-");
    const successfulRunner: InProcessRunner = {
      id: "successful-runner",
      async run(plan) {
        return { runId: plan.runId, status: "passed", exitCode: 0 };
      },
    };
    const resolver: RunnerResolver = {
      resolve(plan) {
        if (plan.device.key === device.key) throw new Error("runner selection failed");
        return successfulRunner;
      },
    };
    const manager = new TaskManager(createConfig(dir), new StateStore(dir), successfulRunner, resolver);
    await manager.initialize();

    const created = await manager.start({
      testId: "pass",
      deviceKeys: [device.key, secondDevice.key],
      parameters: {},
    }, [device, secondDevice]);
    const failedTask = created.find(task => task.device.key === device.key)!;
    const passedTask = created.find(task => task.device.key === secondDevice.key)!;

    await expect(waitForStatus(manager, failedTask.id, "failed")).resolves.toMatchObject({
      exitCode: null,
      error: "runner selection failed",
    });
    await expect(waitForStatus(manager, passedTask.id, "passed")).resolves.toMatchObject({
      exitCode: 0,
      error: "",
    });
    await manager.shutdown();
  });

  it("按任务选择不同 runner 并将停止请求发给对应实例", async () => {
    const dir = await createTempDir("mtc-task-multi-runner-");
    const firstRunner = createControlledRunner("first-runner");
    const secondRunner = createControlledRunner("second-runner");
    const resolver: RunnerResolver = {
      resolve(plan) {
        return plan.device.key === device.key ? firstRunner.runner : secondRunner.runner;
      },
    };
    const manager = new TaskManager(createConfig(dir), new StateStore(dir), firstRunner.runner, resolver);
    await manager.initialize();

    const created = await manager.start({
      testId: "long",
      deviceKeys: [device.key, secondDevice.key],
      parameters: {},
    }, [device, secondDevice]);
    const firstTask = created.find(task => task.device.key === device.key)!;
    const secondTask = created.find(task => task.device.key === secondDevice.key)!;
    await Promise.all(created.map(task => waitForStatus(manager, task.id, "running")));

    await manager.stop(firstTask.id);
    await waitForStatus(manager, firstTask.id, "cancelled");
    expect(firstRunner.cancelledRunIds).toEqual([firstTask.runId]);
    expect(secondRunner.cancelledRunIds).toEqual([]);

    await manager.stop(secondTask.id);
    await waitForStatus(manager, secondTask.id, "cancelled");
    expect(secondRunner.cancelledRunIds).toEqual([secondTask.runId]);
    await manager.shutdown();
  });

  it("shutdown 对多任务共享 runner 只调用一次", async () => {
    const dir = await createTempDir("mtc-task-shared-runner-");
    const shutdown = vi.fn();
    const sharedRunner: InProcessRunner = {
      id: "shared-runner",
      async run(plan) {
        return { runId: plan.runId, status: "passed", exitCode: 0 };
      },
      shutdown,
    };
    const resolver: RunnerResolver = { resolve: () => sharedRunner };
    const manager = new TaskManager(createConfig(dir), new StateStore(dir), sharedRunner, resolver);
    await manager.initialize();

    const created = await manager.start({
      testId: "pass",
      deviceKeys: [device.key, secondDevice.key],
      parameters: {},
    }, [device, secondDevice]);
    await Promise.all(created.map(task => waitForStatus(manager, task.id, "passed")));
    await manager.shutdown();

    expect(shutdown).toHaveBeenCalledTimes(1);
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

    expect(manager.list()[0]).toMatchObject({
      status: "interrupted",
      phase: "服务重启，任务已中断",
      target: { key: device.key, kind: "app", label: device.name },
    });
    await manager.shutdown();
  });

  it("按小程序运行目标创建任务、冻结 target 并使用并发锁", async () => {
    const dir = await createTempDir("mtc-mini-target-task-");
    const config = createConfig(dir);
    config.project.integrationType = "mini-program";
    config.deviceProviders = [];
    config.tests = [{
      id: "mini-long",
      label: "小程序 Smoke",
      description: "",
      platforms: [],
      targetKeys: ["wechat-devtools", "wechat-devtools-secondary"],
      parameters: [],
      commands: {
        default: {
          executable: process.execPath,
          args: ["-e", "setInterval(() => {}, 1000)", "{{target.runtime}}"],
        },
      },
    }];
    const target: MiniProgramRunTarget = {
      key: "wechat-devtools",
      kind: "mini-program",
      label: "微信开发者工具",
      platform: "wechat",
      runtime: "wechat-devtools",
      appId: "wx-demo",
      concurrencyKey: "mini-wechat",
    };
    const sameRuntimeTarget: MiniProgramRunTarget = {
      ...target,
      key: "wechat-devtools-secondary",
      label: "微信开发者工具备用入口",
    };
    const manager = new TaskManager(config, new StateStore(dir));
    await manager.initialize();

    await expect(manager.start(
      { testId: "mini-long", targetKeys: [target.key, sameRuntimeTarget.key], parameters: {} },
      [],
      undefined,
      undefined,
      undefined,
      [target, sameRuntimeTarget],
    )).rejects.toMatchObject({ code: "TARGET_BUSY" });

    const [created] = await manager.start(
      { testId: "mini-long", targetKeys: [target.key], parameters: {} },
      [],
      undefined,
      undefined,
      undefined,
      [target],
    );
    const running = await waitForStatus(manager, created.id, "running");
    expect(running).toMatchObject({
      target,
      device: { key: target.key, name: target.label },
    });
    await expect(manager.start(
      { testId: "mini-long", targetKeys: [target.key], parameters: {} },
      [],
      undefined,
      undefined,
      undefined,
      [target],
    )).rejects.toMatchObject({ code: "TARGET_BUSY" });
    await manager.stop(created.id);
    await expect(waitForStatus(manager, created.id, "cancelled")).resolves.toMatchObject({ target });
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

  it("删除来源任务时一次清理整条重试链", async () => {
    const dir = await createTempDir("mtc-task-delete-retries-");
    const manager = new TaskManager(createConfig(dir), new StateStore(dir));
    await manager.initialize();
    const [source] = await manager.start({ testId: "pass", deviceKeys: [device.key], parameters: {} }, [device]);
    await waitForStatus(manager, source.id, "passed");
    const [retry] = await manager.start(
      { testId: "pass", deviceKeys: [device.key], parameters: {} },
      [device], undefined, undefined, undefined, [],
      { taskId: source.id, runId: source.runId, scope: "cases", attempt: 1, caseRunIds: ["case-one"] },
    );
    await waitForStatus(manager, retry.id, "passed");
    const [retryAgain] = await manager.start(
      { testId: "pass", deviceKeys: [device.key], parameters: {} },
      [device], undefined, undefined, undefined, [],
      { taskId: retry.id, runId: retry.runId, scope: "cases", attempt: 2, caseRunIds: ["case-one"] },
    );
    await waitForStatus(manager, retryAgain.id, "passed");

    await manager.delete(source.id);

    expect(manager.list()).toEqual([]);
    const stored = JSON.parse(await fs.readFile(path.join(dir, "state.json"), "utf8")) as { tasks: unknown[] };
    expect(stored.tasks).toEqual([]);
    await manager.shutdown();
  });

  it("运行列表达到上限时保留可见复测的来源任务", async () => {
    const dir = await createTempDir("mtc-task-list-retry-root-");
    const storedTasks = Array.from({ length: 101 }, (_, index) => ({
      ...createStoredTask(`task-${index}`, new Date(Date.UTC(2026, 7, 13) + index * 60_000).toISOString()),
      ...(index === 100 ? {
        retryOf: { taskId: "task-0", runId: "run-task-0", scope: "task" as const, attempt: 1 },
      } : {}),
    }));
    await new StateStore(dir).save(storedTasks);
    const manager = new TaskManager(createConfig(dir), new StateStore(dir));
    await manager.initialize();

    expect(manager.listVisible().some(task => task.id === "task-0")).toBe(true);
    expect(manager.listVisible().some(task => task.id === "task-100")).toBe(true);
    expect(manager.list()).toHaveLength(101);
    const stored = JSON.parse(await fs.readFile(path.join(dir, "state.json"), "utf8")) as { tasks: TestTask[] };
    expect(stored.tasks).toHaveLength(101);
    expect(stored.tasks.some(task => task.id === "task-1")).toBe(true);
    await manager.shutdown();
  });

  it("活动重试期间锁定来源测试组删除", async () => {
    const dir = await createTempDir("mtc-task-delete-active-retry-");
    const manager = new TaskManager(createConfig(dir), new StateStore(dir));
    await manager.initialize();
    const [source] = await manager.start({ testId: "pass", deviceKeys: [device.key], parameters: {} }, [device]);
    await waitForStatus(manager, source.id, "passed");
    const [retry] = await manager.start(
      { testId: "long", deviceKeys: [device.key], parameters: {} },
      [device], undefined, undefined, undefined, [],
      { taskId: source.id, runId: source.runId, scope: "cases", attempt: 1, caseRunIds: ["case-one"] },
    );
    expect(manager.get(source.id)?.retained).toBe(true);
    await waitForStatus(manager, retry.id, "running");

    await expect(manager.delete(source.id)).rejects.toMatchObject({
      code: "TASK_ACTIVE",
      statusCode: 409,
    } satisfies Partial<ConsoleError>);
    await expect(manager.setRetained(source.id, false)).rejects.toMatchObject({
      code: "TASK_ACTIVE",
      statusCode: 409,
    } satisfies Partial<ConsoleError>);
    expect(manager.list().map(task => task.id)).toEqual(expect.arrayContaining([source.id, retry.id]));

    await manager.stop(retry.id);
    await waitForStatus(manager, retry.id, "cancelled");
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

const secondDevice: Device = {
  ...device,
  key: "android:device-2",
  id: "device-2",
  name: "Device 2",
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

function createStoredTask(id: string, createdAt: string): TestTask {
  return {
    id,
    runId: `run-${id}`,
    projectId: "demo",
    testId: "pass",
    testLabel: "Pass",
    device: structuredClone(device),
    parameters: {},
    status: "passed",
    phase: "测试通过",
    createdAt,
    startedAt: createdAt,
    finishedAt: createdAt,
    exitCode: 0,
    error: "",
    logs: [],
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

function createControlledRunner(id: string): {
  runner: InProcessRunner;
  cancelledRunIds: string[];
} {
  const pending = new Map<string, (result: RunnerResult) => void>();
  const cancelledRuns = new Set<string>();
  const cancelledRunIds: string[] = [];
  return {
    cancelledRunIds,
    runner: {
      id,
      run(plan) {
        if (cancelledRuns.has(plan.runId)) {
          return Promise.resolve({ runId: plan.runId, status: "cancelled", exitCode: null });
        }
        return new Promise(resolve => pending.set(plan.runId, resolve));
      },
      cancel(runId) {
        cancelledRuns.add(runId);
        cancelledRunIds.push(runId);
        pending.get(runId)?.({ runId, status: "cancelled", exitCode: null });
        pending.delete(runId);
      },
    },
  };
}
