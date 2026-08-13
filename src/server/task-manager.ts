import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  ACTIVE_TASK_STATUSES,
  TERMINAL_TASK_STATUSES,
  appRunTargetOf,
  type Device,
  type MiniProgramRunTarget,
  type RunTarget,
  type StartTasksRequest,
  type TaskRetrySource,
  type TestTask,
} from "../shared/contracts.js";
import {
  resolveTargetCommand,
  resolveTaskDeletionCommand,
  validateParameters,
  type LoadedProjectConfig,
  type ResolvedCommand,
  type TestDefinition,
} from "./config.js";
import { ConsoleError } from "./errors.js";
import { StateStore } from "./state-store.js";
import {
  LegacyTaskRunner,
} from "../runner/legacy-task-runner.js";
import {
  createRunPlan,
  LEGACY_COMMAND_RUNNER_ID,
  type InProcessRunner,
  type RunnerEvent,
  type RunnerResolver,
} from "../runner/sdk.js";

const ACTIVE_STATUSES = new Set(ACTIVE_TASK_STATUSES);
const TERMINAL_STATUSES = new Set(TERMINAL_TASK_STATUSES);
const MAX_TASKS = 100;
const MAX_LOG_LINES = 500;
const MAX_LOG_LINE_LENGTH = 4_000;

export type TaskCompletionListener = (task: TestTask) => void | Promise<void>;

export class TaskManager {
  private readonly tasks = new Map<string, TestTask>();
  private readonly runnerControllers = new Map<string, AbortController>();
  private readonly taskRunners = new Map<string, InProcessRunner>();
  private readonly managedRunners = new Set<InProcessRunner>();
  private readonly commandOverrides = new Map<string, ResolvedCommand>();
  private readonly cancelRequests = new Set<string>();
  private readonly completionListeners = new Set<TaskCompletionListener>();
  private readonly runnerResolver: RunnerResolver;
  private persistTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly config: LoadedProjectConfig,
    private readonly store: StateStore,
    runner: InProcessRunner = new LegacyTaskRunner(),
    runnerResolver?: RunnerResolver,
    onTaskCompleted?: TaskCompletionListener,
  ) {
    this.runnerResolver = runnerResolver ?? { resolve: () => runner };
    if (!runnerResolver) this.managedRunners.add(runner);
    if (onTaskCompleted) this.completionListeners.add(onTaskCompleted);
  }

  async initialize(): Promise<void> {
    for (const task of await this.store.load()) {
      if (!task.target) task.target = appRunTargetOf(task.device);
      this.tasks.set(task.id, task);
    }
    await this.persistNow();
  }

  list(): TestTask[] {
    return [...this.tasks.values()]
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
      .slice(0, MAX_TASKS)
      .map(task => structuredClone(task));
  }

  get(taskId: string): TestTask | null {
    const task = this.tasks.get(taskId);
    return task ? structuredClone(task) : null;
  }

  addCompletionListener(listener: TaskCompletionListener): () => void {
    this.completionListeners.add(listener);
    return () => this.completionListeners.delete(listener);
  }

  async start(
    request: StartTasksRequest,
    devices: Device[],
    workspaceRoot?: string,
    repairJobId?: string,
    commandFactory?: (task: TestTask) => ResolvedCommand | null,
    targets: RunTarget[] = [],
    retryOf?: TaskRetrySource,
  ): Promise<TestTask[]> {
    const test = this.config.tests.find(item => item.id === request.testId);
    if (!test) throw new ConsoleError("TEST_UNKNOWN", `测试不存在: ${request.testId}`, 404);
    const parameters = validateParameters(test, request.parameters ?? {});
    const targetKeys = [...new Set(request.targetKeys ?? [])];
    const deviceKeys = [...new Set(request.deviceKeys ?? [])];
    if (targetKeys.length > 0 && deviceKeys.length > 0) {
      throw new ConsoleError("TARGET_SELECTION_INVALID", "运行目标和设备不能同时选择");
    }
    if (targetKeys.length > 0) {
      const declaredKeys = new Set(test.targetKeys ?? []);
      const selectedConcurrencyKeys = new Set<string>();
      const selectedTargets = targetKeys.map(key => {
        if (!declaredKeys.has(key)) throw new ConsoleError("TARGET_UNSUPPORTED", `${test.label} 未声明运行目标: ${key}`);
        const target = targets.find(item => item.key === key);
        if (!target || target.kind !== "mini-program") {
          throw new ConsoleError("TARGET_UNKNOWN", `运行目标不存在: ${key}`, 404);
        }
        if (selectedConcurrencyKeys.has(target.concurrencyKey)) {
          throw new ConsoleError("TARGET_BUSY", `${target.label} 与本次选择的其他运行目标共享执行环境`, 409);
        }
        selectedConcurrencyKeys.add(target.concurrencyKey);
        const active = this.list().find(task => task.target?.concurrencyKey === target.concurrencyKey && ACTIVE_STATUSES.has(task.status));
        if (active) throw new ConsoleError("TARGET_BUSY", `${target.label} 正在执行 ${active.testLabel}`, 409);
        return target;
      });
      const createdAt = new Date().toISOString();
      const tasks = selectedTargets.map(target => this.createTask(test, target, parameters, createdAt, workspaceRoot, repairJobId, retryOf));
      await this.enqueueTasks(tasks, test, commandFactory);
      return tasks.map(task => structuredClone(task));
    }
    if (deviceKeys.length === 0) throw new ConsoleError("DEVICE_REQUIRED", "请至少选择一台设备");

    const selected = deviceKeys.map(key => {
      const device = devices.find(item => item.key === key);
      if (!device) throw new ConsoleError("DEVICE_UNKNOWN", `设备当前未连接: ${key}`, 404);
      if (device.connectionState !== "available") {
        throw new ConsoleError("DEVICE_UNAVAILABLE", `设备当前不可用: ${device.name}`, 409);
      }
      if (!test.platforms.includes(device.platform)) {
        throw new ConsoleError("PLATFORM_UNSUPPORTED", `${test.label} 不支持 ${device.platform}`);
      }
      const active = this.list().find(task => task.device.key === key && ACTIVE_STATUSES.has(task.status));
      if (active) throw new ConsoleError("DEVICE_BUSY", `${device.name} 正在执行 ${active.testLabel}`, 409);
      return device;
    });

    const createdAt = new Date().toISOString();
    const tasks = selected.map(device => this.createTask(test, appRunTargetOf(device), parameters, createdAt, workspaceRoot, repairJobId, retryOf));
    await this.enqueueTasks(tasks, test, commandFactory);
    return tasks.map(task => structuredClone(task));
  }

  private async enqueueTasks(
    tasks: TestTask[],
    test: TestDefinition,
    commandFactory?: (task: TestTask) => ResolvedCommand | null,
  ): Promise<void> {
    for (const task of tasks) {
      this.tasks.set(task.id, task);
      const override = commandFactory?.(structuredClone(task));
      if (override) this.commandOverrides.set(task.id, override);
    }
    await this.persistNow();
    for (const task of tasks) queueMicrotask(() => void this.execute(task.id, test));
  }

  async waitForTerminal(taskId: string, timeoutMs = 120_000): Promise<TestTask> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const task = this.tasks.get(taskId);
      if (!task) throw new ConsoleError("TASK_UNKNOWN", `任务不存在: ${taskId}`, 404);
      if (!ACTIVE_STATUSES.has(task.status)) return structuredClone(task);
      await new Promise(resolve => setTimeout(resolve, 250));
    }
    throw new ConsoleError("TASK_WAIT_TIMEOUT", `等待任务完成超时: ${taskId}`, 504);
  }

  async stop(taskId: string): Promise<TestTask> {
    const task = this.tasks.get(taskId);
    if (!task) throw new ConsoleError("TASK_UNKNOWN", `任务不存在: ${taskId}`, 404);
    if (!ACTIVE_STATUSES.has(task.status)) return structuredClone(task);

    this.cancelRequests.add(taskId);
    task.phase = "正在停止";
    this.appendLog(task, "[console] 收到停止请求");
    this.runnerControllers.get(taskId)?.abort();
    await this.taskRunners.get(taskId)?.cancel?.(task.runId);
    await this.persistNow();
    return structuredClone(task);
  }

  async delete(taskId: string): Promise<TestTask> {
    const task = this.tasks.get(taskId);
    if (!task) throw new ConsoleError("TASK_UNKNOWN", `任务不存在: ${taskId}`, 404);
    if (!TERMINAL_STATUSES.has(task.status)) {
      throw new ConsoleError("TASK_ACTIVE", `活动任务不能删除，请先停止任务: ${taskId}`, 409);
    }

    const relatedTasks = this.retryLineage(taskId);
    for (const related of relatedTasks) {
      if (!TERMINAL_STATUSES.has(related.status)) {
        throw new ConsoleError("TASK_ACTIVE", `重试链中存在活动任务，暂时不能删除: ${related.id}`, 409);
      }
    }
    for (const related of relatedTasks) {
      const cleanupCommand = resolveTaskDeletionCommand(this.config, related);
      if (cleanupCommand) await this.runTaskDeletionCleanup(related, cleanupCommand);
    }
    for (const related of relatedTasks) this.tasks.delete(related.id);
    await this.persistNow();
    return structuredClone(task);
  }

  private retryLineage(taskId: string): TestTask[] {
    const related = new Map<string, TestTask>();
    const queue = [taskId];
    while (queue.length > 0) {
      const currentId = queue.shift()!;
      if (related.has(currentId)) continue;
      const current = this.tasks.get(currentId);
      if (!current) continue;
      related.set(current.id, current);
      for (const candidate of this.tasks.values()) {
        if (candidate.retryOf?.taskId === current.id) queue.push(candidate.id);
      }
    }
    return [...related.values()];
  }

  async setRetained(taskId: string, retained: boolean): Promise<TestTask> {
    const task = this.tasks.get(taskId);
    if (!task) throw new ConsoleError("TASK_UNKNOWN", `任务不存在: ${taskId}`, 404);
    if (!TERMINAL_STATUSES.has(task.status)) {
      throw new ConsoleError("TASK_ACTIVE", `活动任务暂不支持修改保留状态: ${taskId}`, 409);
    }
    task.retained = retained;
    await this.persistNow();
    return structuredClone(task);
  }

  async forgetRuns(runIds: string[]): Promise<TestTask[]> {
    const selected = new Set(runIds);
    const removed: TestTask[] = [];
    for (const task of this.tasks.values()) {
      if (!selected.has(task.runId)) continue;
      if (!TERMINAL_STATUSES.has(task.status)) {
        throw new ConsoleError("TASK_ACTIVE", `活动任务不能从清理索引移除: ${task.id}`, 409);
      }
      removed.push(structuredClone(task));
    }
    for (const task of removed) this.tasks.delete(task.id);
    if (removed.length > 0) await this.persistNow();
    return removed;
  }

  async shutdown(): Promise<void> {
    const activeIds = [...this.runnerControllers.keys()];
    await Promise.all(activeIds.map(taskId => this.stop(taskId)));
    const deadline = Date.now() + 3_500;
    while (this.runnerControllers.size > 0 && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    await Promise.all([...this.managedRunners].map(runner => runner.shutdown?.()));
    await this.persistNow();
  }

  private createTask(
    test: TestDefinition,
    target: RunTarget,
    parameters: Record<string, string>,
    createdAt: string,
    workspaceRoot?: string,
    repairJobId?: string,
    retryOf?: TaskRetrySource,
  ): TestTask {
    const id = randomUUID();
    const compactTime = createdAt.replace(/[-:.TZ]/g, "").slice(0, 14);
    return {
      id,
      runId: `${this.config.project.id}-${compactTime}-${id.slice(0, 8)}`,
      projectId: this.config.project.id,
      testId: test.id,
      testLabel: test.label,
      runnerId: test.runnerId ?? LEGACY_COMMAND_RUNNER_ID,
      target,
      device: target.kind === "app" ? target.device : createVirtualDevice(target),
      parameters: { ...parameters },
      status: "queued",
      phase: "等待执行",
      createdAt,
      startedAt: "",
      finishedAt: "",
      exitCode: null,
      error: "",
      logs: [],
      ...(workspaceRoot ? { workspaceRoot } : {}),
      ...(repairJobId ? { repairJobId } : {}),
      ...(retryOf ? { retryOf: structuredClone(retryOf) } : {}),
    };
  }

  private async execute(taskId: string, test: TestDefinition): Promise<void> {
    const task = this.tasks.get(taskId);
    if (!task || this.cancelRequests.has(taskId)) {
      if (task) await this.finalize(task, "cancelled", null, "");
      return;
    }

    task.status = "preparing";
    task.phase = "准备运行计划";
    task.startedAt = new Date().toISOString();
    this.appendLog(task, `[console] 开始 ${task.testLabel} · ${task.target?.label ?? task.device.name}`);
    this.schedulePersist();

    try {
      const command = this.commandOverrides.get(taskId)
        ?? resolveTargetCommand(this.config, test, task.target ?? appRunTargetOf(task.device), task, task.parameters, task.workspaceRoot);
      this.appendLog(task, `[console] runner: ${task.runnerId ?? LEGACY_COMMAND_RUNNER_ID}`);
      if (command) {
        this.appendLog(task, `[console] cwd: ${command.cwd}`);
        this.appendLog(task, `[console] command: ${formatCommand(command.executable, command.args)}`);
      }
      if (this.cancelRequests.has(taskId)) {
        await this.finalize(task, "cancelled", null, "");
        return;
      }

      const controller = new AbortController();
      const plan = createRunPlan(task, command ?? undefined);
      const runner = this.runnerResolver.resolve(plan);
      this.runnerControllers.set(taskId, controller);
      this.taskRunners.set(taskId, runner);
      this.managedRunners.add(runner);
      task.status = "running";
      task.phase = "执行中";
      await this.persistNow();

      const result = await runner.run(plan, {
        signal: controller.signal,
        emit: event => this.handleRunnerEvent(task, event),
      });
      if (result.resultUri && result.status !== "cancelled" && !this.cancelRequests.has(taskId)) {
        task.resultUri = result.resultUri;
      }
      this.runnerControllers.delete(taskId);
      this.taskRunners.delete(taskId);
      this.commandOverrides.delete(taskId);
      if (this.cancelRequests.has(taskId)) {
        await this.finalize(task, "cancelled", result.exitCode, "");
      } else if (result.status === "cancelled") {
        await this.finalize(task, "cancelled", result.exitCode, "");
      } else if (result.status === "passed") {
        await this.finalize(task, "passed", 0, "");
      } else {
        await this.finalize(task, "failed", result.exitCode, result.error ?? `测试进程退出码: ${result.exitCode ?? "unknown"}`);
      }
    } catch (error) {
      this.runnerControllers.delete(taskId);
      this.taskRunners.delete(taskId);
      this.commandOverrides.delete(taskId);
      const message = error instanceof Error ? error.message : String(error);
      await this.finalize(task, this.cancelRequests.has(taskId) ? "cancelled" : "failed", null, message);
    }
  }

  private handleRunnerEvent(task: TestTask, event: RunnerEvent): void {
    if (event.type !== "log" || !event.message) return;
    this.appendLog(task, event.source === "stderr" ? `[stderr] ${event.message}` : event.message);
    this.schedulePersist();
  }

  private async runTaskDeletionCleanup(task: TestTask, command: ResolvedCommand): Promise<void> {
    const child = spawn(command.executable, command.args, {
      cwd: command.cwd,
      env: { ...process.env, ...command.env },
      shell: false,
      stdio: ["ignore", "ignore", "pipe"],
    });
    let stderr = "";
    child.stderr?.on("data", chunk => {
      stderr = `${stderr}${String(chunk)}`.slice(-MAX_LOG_LINE_LENGTH);
    });
    const result = await waitForProcess(child);
    if (!result.error && result.code === 0) return;

    const reason = result.error?.message || stderr.trim() || `退出码 ${result.code ?? "unknown"}`;
    throw new ConsoleError(
      "TASK_DELETE_CLEANUP_FAILED",
      `清理 ${task.runId} 本地文件失败: ${reason}`,
      500,
    );
  }

  private appendLog(task: TestTask, line: string): void {
    task.logs.push(String(line).slice(0, MAX_LOG_LINE_LENGTH));
    if (task.logs.length > MAX_LOG_LINES) task.logs.splice(0, task.logs.length - MAX_LOG_LINES);
  }

  private async finalize(
    task: TestTask,
    status: "passed" | "failed" | "cancelled",
    exitCode: number | null,
    error: string,
  ): Promise<void> {
    const next = structuredClone(task);
    next.status = status;
    next.phase = status === "passed" ? "测试通过" : status === "cancelled" ? "已取消" : "测试失败";
    next.finishedAt = new Date().toISOString();
    next.exitCode = exitCode;
    next.error = error;
    if (error) this.appendLog(next, `[console] ${error}`);
    this.appendLog(next, `[console] 任务结束: ${status}`);
    this.cancelRequests.delete(task.id);
    await this.persistNow(next);
    Object.assign(task, next);
    for (const listener of this.completionListeners) {
      try {
        await listener(structuredClone(next));
      } catch (listenerError) {
        console.error("[task] 任务完成监听器执行失败", listenerError);
      }
    }
  }

  private schedulePersist(): void {
    if (this.persistTimer) return;
    this.persistTimer = setTimeout(() => {
      this.persistTimer = null;
      void this.persistNow();
    }, 100);
  }

  private async persistNow(override?: TestTask): Promise<void> {
    if (this.persistTimer) {
      clearTimeout(this.persistTimer);
      this.persistTimer = null;
    }
    const tasks = this.list();
    if (override) {
      const index = tasks.findIndex(task => task.id === override.id);
      if (index >= 0) tasks[index] = structuredClone(override);
    }
    await this.store.save(tasks);
  }

}

function waitForProcess(child: ChildProcess): Promise<{ code: number | null; error: Error | null }> {
  return new Promise(resolve => {
    let settled = false;
    const finish = (code: number | null, error: Error | null) => {
      if (settled) return;
      settled = true;
      resolve({ code, error });
    };
    child.once("error", error => finish(null, error));
    child.once("close", code => finish(code, null));
  });
}

function formatCommand(executable: string, args: string[]): string {
  return [executable, ...args].map(value => /^[A-Za-z0-9_./:@%+=,-]+$/.test(value) ? value : JSON.stringify(value)).join(" ");
}

function createVirtualDevice(target: MiniProgramRunTarget): Device {
  return {
    key: target.key,
    id: target.key,
    name: target.label,
    platform: "android",
    type: "physical",
    connectionState: "available",
    osVersion: "",
    detail: `${target.platform} / ${target.runtime}`,
    controlState: "ready",
    controlReason: "",
    connectorId: target.runtime,
    capabilities: [],
  };
}
