import { spawn, type ChildProcess } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import {
  ACTIVE_TASK_STATUSES,
  TERMINAL_TASK_STATUSES,
  appRunTargetOf,
  type Device,
  type MiniProgramRunTarget,
  type RunTarget,
  type StartTasksRequest,
  type TaskRetrySource,
  type TaskLiveArtifact,
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
import { TaskExecutionCoordinator } from "./task-execution-coordinator.js";
import {
  LegacyTaskRunner,
} from "../runner/legacy-task-runner.js";
import {
  createRunPlan,
  LEGACY_COMMAND_RUNNER_ID,
  type InProcessRunner,
  type RunnerEvent,
  type RunnerResolver,
  validateRunnerArtifactEventData,
} from "../runner/sdk.js";

const ACTIVE_STATUSES = new Set(ACTIVE_TASK_STATUSES);
const TERMINAL_STATUSES = new Set(TERMINAL_TASK_STATUSES);
const MAX_TASKS = 100;
const MAX_LOG_LINES = 500;
const MAX_LOG_LINE_LENGTH = 4_000;
const MAX_LIVE_ARTIFACTS = 100;
const MAX_LIVE_ARTIFACT_BYTES = 20 * 1024 * 1024;
const IMAGE_MIME_BY_EXTENSION = new Map<string, TaskLiveArtifact["mimeType"]>([
  [".jpeg", "image/jpeg"],
  [".jpg", "image/jpeg"],
  [".png", "image/png"],
  [".webp", "image/webp"],
]);
export const RETRY_WATCHDOG_TIMEOUT_MS = 45 * 60 * 1_000;

export type TaskCompletionListener = (task: TestTask) => void | Promise<void>;

export class TaskManager {
  private readonly tasks = new Map<string, TestTask>();
  private readonly runnerControllers = new Map<string, AbortController>();
  private readonly taskRunners = new Map<string, InProcessRunner>();
  private readonly managedRunners = new Set<InProcessRunner>();
  private readonly commandOverrides = new Map<string, ResolvedCommand>();
  private readonly cancelRequests = new Set<string>();
  private readonly completionListeners = new Set<TaskCompletionListener>();
  private readonly retryWatchdogs = new Map<string, NodeJS.Timeout>();
  private readonly terminalFinalizations = new Map<string, Promise<void>>();
  private readonly runnerResolver: RunnerResolver;
  private persistTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly config: LoadedProjectConfig,
    private readonly store: StateStore,
    runner: InProcessRunner = new LegacyTaskRunner(),
    runnerResolver?: RunnerResolver,
    onTaskCompleted?: TaskCompletionListener,
    private readonly retryWatchdogTimeoutMs = RETRY_WATCHDOG_TIMEOUT_MS,
    private readonly executionCoordinator = new TaskExecutionCoordinator(),
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
      .map(task => structuredClone(task));
  }

  listVisible(): TestTask[] {
    const recent = [...this.tasks.values()]
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
      .slice(0, MAX_TASKS);
    const visible = new Map(recent.map(task => [task.id, task]));
    for (const task of recent) {
      let current = task;
      const visited = new Set<string>();
      while (current.retryOf && !visited.has(current.id)) {
        visited.add(current.id);
        const parent = this.tasks.get(current.retryOf.taskId);
        if (!parent) break;
        visible.set(parent.id, parent);
        current = parent;
      }
    }
    return [...visible.values()]
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
      .map(task => structuredClone(task));
  }

  listRetryDescendants(taskId: string): TestTask[] {
    return this.retryLineage(taskId)
      .filter(task => task.id !== taskId)
      .map(task => structuredClone(task));
  }

  nextRetryAttempt(taskId: string): number {
    const task = this.tasks.get(taskId);
    if (!task) throw new ConsoleError("TASK_UNKNOWN", `任务不存在: ${taskId}`, 404);
    const rootTaskId = this.retryRootTaskId(task);
    return Math.max(0, ...this.retryLineage(rootTaskId).map(item => item.retryOf?.attempt ?? 0)) + 1;
  }

  get(taskId: string): TestTask | null {
    const task = this.tasks.get(taskId);
    return task ? structuredClone(task) : null;
  }

  async artifact(taskId: string, artifactId: string): Promise<{
    absolutePath: string;
    mimeType: string;
    sizeBytes: number;
  }> {
    const task = this.tasks.get(taskId);
    if (!task) throw new ConsoleError("TASK_UNKNOWN", `任务不存在: ${taskId}`, 404);
    const artifact = task.artifacts?.find(item => item.id === artifactId);
    if (!artifact) throw new ConsoleError("TASK_ARTIFACT_UNKNOWN", `运行截图不存在: ${artifactId}`, 404);
    const prefix = `project://${task.projectId}/`;
    if (!artifact.uri.startsWith(prefix)) {
      throw new ConsoleError("TASK_ARTIFACT_INVALID", `运行截图 URI 与任务项目不一致: ${artifact.uri}`, 409);
    }
    const relativePath = artifact.uri.slice(prefix.length);
    if (!relativePath || path.isAbsolute(relativePath) || relativePath.split(/[\\/]/u).includes("..")) {
      throw new ConsoleError("TASK_ARTIFACT_INVALID", `运行截图路径无效: ${artifact.uri}`, 409);
    }
    const workspaceRoot = task.workspaceRoot ?? this.config.project.root;
    const candidate = path.resolve(workspaceRoot, relativePath);
    const lexicalRelative = path.relative(path.resolve(workspaceRoot), candidate);
    if (lexicalRelative.startsWith(`..${path.sep}`) || path.isAbsolute(lexicalRelative)) {
      throw new ConsoleError("TASK_ARTIFACT_INVALID", `运行截图超出项目目录: ${artifact.label}`, 409);
    }
    let realRoot: string;
    let realCandidate: string;
    try {
      [realRoot, realCandidate] = await Promise.all([fs.realpath(workspaceRoot), fs.realpath(candidate)]);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT" || code === "ENOTDIR") {
        throw new ConsoleError("TASK_ARTIFACT_MISSING", `运行截图文件缺失: ${artifact.label} (${relativePath})`, 404);
      }
      throw error;
    }
    const realRelative = path.relative(realRoot, realCandidate);
    if (realRelative.startsWith(`..${path.sep}`) || path.isAbsolute(realRelative)) {
      throw new ConsoleError("TASK_ARTIFACT_INVALID", `运行截图真实路径超出项目目录: ${artifact.label}`, 409);
    }
    const stat = await fs.stat(realCandidate);
    if (!stat.isFile()) throw new ConsoleError("TASK_ARTIFACT_MISSING", `运行截图不是文件: ${artifact.label}`, 404);
    try {
      validateImageArtifactMetadata(relativePath, artifact.mimeType, stat.size);
      const handle = await fs.open(realCandidate, "r");
      try {
        const header = Buffer.alloc(12);
        const { bytesRead } = await handle.read(header, 0, header.length, 0);
        validateImageArtifactSignature(header.subarray(0, bytesRead), artifact.mimeType);
      } finally {
        await handle.close();
      }
    } catch (error) {
      throw new ConsoleError(
        "TASK_ARTIFACT_INVALID",
        `运行截图文件无效: ${artifact.label} (${error instanceof Error ? error.message : String(error)})`,
        409,
      );
    }
    return { absolutePath: realCandidate, mimeType: artifact.mimeType, sizeBytes: stat.size };
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
    const resolvedRetryOf = retryOf && this.tasks.has(retryOf.taskId)
      ? { ...structuredClone(retryOf), attempt: this.nextRetryAttempt(retryOf.taskId) }
      : retryOf;
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
        const duplicate = [...this.tasks.values()].find(task => (
          task.target?.kind === "mini-program"
          && task.target.concurrencyKey === target.concurrencyKey
          && task.testId === test.id
          && ACTIVE_STATUSES.has(task.status)
        ));
        if (duplicate) {
          throw new ConsoleError("TARGET_BUSY", `${target.label} 已有 ${test.label} 任务在等待或执行`, 409);
        }
        return target;
      });
      const createdAt = new Date().toISOString();
      const tasks = selectedTargets.map(target => this.createTask(test, target, parameters, createdAt, workspaceRoot, repairJobId, resolvedRetryOf));
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
      const duplicate = [...this.tasks.values()].find(task => (
        task.target?.kind === "app"
        && task.device.key === device.key
        && task.testId === test.id
        && ACTIVE_STATUSES.has(task.status)
      ));
      if (duplicate) {
        throw new ConsoleError(
          "TASK_DUPLICATE",
          `${device.name} 已有 ${test.label} 任务在等待或执行`,
          409,
        );
      }
      return device;
    });

    const createdAt = new Date().toISOString();
    const tasks = selected.map(device => this.createTask(test, appRunTargetOf(device), parameters, createdAt, workspaceRoot, repairJobId, resolvedRetryOf));
    await this.enqueueTasks(tasks, test, commandFactory);
    return tasks.map(task => structuredClone(task));
  }

  private async enqueueTasks(
    tasks: TestTask[],
    test: TestDefinition,
    commandFactory?: (task: TestTask) => ResolvedCommand | null,
  ): Promise<void> {
    const preparedOverrides = tasks.map(task => commandFactory?.(structuredClone(task)) ?? null);
    const retrySourceTaskId = tasks[0]?.retryOf?.taskId;
    if (retrySourceTaskId) {
      const retrySource = this.tasks.get(retrySourceTaskId);
      if (retrySource && !TERMINAL_STATUSES.has(retrySource.status)) {
        throw new ConsoleError("TASK_NOT_RETRYABLE", "终态任务才支持重新测试", 409);
      }
      if (retrySource) retrySource.retained = true;
    }
    for (const [index, task] of tasks.entries()) {
      this.tasks.set(task.id, task);
      const override = preparedOverrides[index];
      if (override) this.commandOverrides.set(task.id, override);
    }
    await this.persistNow();
    for (const task of tasks) this.scheduleTask(task.id, test);
  }

  private scheduleTask(taskId: string, test: TestDefinition): void {
    const task = this.tasks.get(taskId);
    if (!task || task.status !== "queued") return;
    this.executionCoordinator.schedule(
      this.resourceKey(task),
      this.coordinatorTaskId(task.id),
      () => this.execute(task.id, test),
    );
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
    this.executionCoordinator.cancel(this.coordinatorTaskId(taskId));
    task.phase = "正在停止";
    this.appendLog(task, "[console] 收到停止请求");
    if (task.status === "queued") {
      await this.finalize(task, "cancelled", null, "");
      return structuredClone(task);
    }
    if (task.retryOf) {
      const finalization = this.finalize(task, "cancelled", null, "用户停止重试");
      this.runnerControllers.get(taskId)?.abort();
      this.cancelRunnerBestEffort(task, "停止重试 Runner 失败", finalization);
      await finalization;
      this.runnerControllers.delete(taskId);
      this.taskRunners.delete(taskId);
      this.commandOverrides.delete(taskId);
      return structuredClone(task);
    }

    this.clearRetryWatchdog(taskId);
    this.runnerControllers.get(taskId)?.abort();
    await this.taskRunners.get(taskId)?.cancel?.(task.runId);
    await this.persistNow();
    return structuredClone(task);
  }

  private resourceKey(task: TestTask): string {
    return task.target?.kind === "mini-program"
      ? `target:${task.target.concurrencyKey}`
      : `device:${task.device.key}`;
  }

  private coordinatorTaskId(taskId: string): string {
    return `${this.config.project.id}:${taskId}`;
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

  private retryRootTaskId(task: TestTask): string {
    let current = task;
    const visited = new Set<string>();
    while (current.retryOf && !visited.has(current.id)) {
      visited.add(current.id);
      const parent = this.tasks.get(current.retryOf.taskId);
      if (!parent) return current.retryOf.taskId;
      current = parent;
    }
    return current.id;
  }

  async setRetained(taskId: string, retained: boolean): Promise<TestTask> {
    const task = this.tasks.get(taskId);
    if (!task) throw new ConsoleError("TASK_UNKNOWN", `任务不存在: ${taskId}`, 404);
    if (!TERMINAL_STATUSES.has(task.status)) {
      throw new ConsoleError("TASK_ACTIVE", `活动任务暂不支持修改保留状态: ${taskId}`, 409);
    }
    const activeRetry = this.retryLineage(taskId)
      .find(related => related.id !== taskId && ACTIVE_STATUSES.has(related.status));
    if (activeRetry) {
      throw new ConsoleError("TASK_ACTIVE", `重试链中存在活动任务，暂时不能修改保留状态: ${activeRetry.id}`, 409);
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
    const activeIds = [...this.tasks.values()]
      .filter(task => ACTIVE_STATUSES.has(task.status))
      .map(task => task.id);
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
    if (!task || TERMINAL_STATUSES.has(task.status) || this.cancelRequests.has(taskId)) {
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
      this.scheduleRetryWatchdog(task);
      task.status = "running";
      task.phase = "执行中";
      await this.persistNow();

      const result = await runner.run(plan, {
        signal: controller.signal,
        emit: event => this.handleRunnerEvent(task, event),
      });
      if (TERMINAL_STATUSES.has(task.status)) {
        this.clearRetryWatchdog(taskId);
        this.runnerControllers.delete(taskId);
        this.taskRunners.delete(taskId);
        this.commandOverrides.delete(taskId);
        return;
      }
      if (result.resultUri && result.status !== "cancelled" && !this.cancelRequests.has(taskId)) {
        task.resultUri = result.resultUri;
      }
      this.runnerControllers.delete(taskId);
      this.taskRunners.delete(taskId);
      this.commandOverrides.delete(taskId);
      if (!ACTIVE_STATUSES.has(task.status)) return;
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
      if (TERMINAL_STATUSES.has(task.status)) {
        this.clearRetryWatchdog(taskId);
        this.runnerControllers.delete(taskId);
        this.taskRunners.delete(taskId);
        this.commandOverrides.delete(taskId);
        return;
      }
      this.runnerControllers.delete(taskId);
      this.taskRunners.delete(taskId);
      this.commandOverrides.delete(taskId);
      if (!ACTIVE_STATUSES.has(task.status)) return;
      const message = error instanceof Error ? error.message : String(error);
      await this.finalize(task, this.cancelRequests.has(taskId) ? "cancelled" : "failed", null, message);
    }
  }

  private handleRunnerEvent(task: TestTask, event: RunnerEvent): void {
    if (event.runId !== task.runId) {
      this.appendLog(task, `[console] 忽略 runId 不匹配的 Runner 事件: ${event.runId}`);
      this.schedulePersist();
      return;
    }
    if (event.type === "artifact") {
      try {
        if (!event.timestamp || Number.isNaN(Date.parse(event.timestamp))) {
          throw new Error("Runner artifact 事件时间无效");
        }
        validateRunnerArtifactEventData(event.data);
        const data = event.data;
        const prefix = `project://${task.projectId}/`;
        if (!data.uri.startsWith(prefix)) throw new Error(`截图 URI 与任务项目不一致: ${data.uri}`);
        const relativePath = data.uri.slice(prefix.length);
        if (!relativePath || path.isAbsolute(relativePath) || relativePath.split(/[\\/]/u).includes("..")) {
          throw new Error(`截图路径无效: ${data.uri}`);
        }
        const workspaceRoot = task.workspaceRoot ?? this.config.project.root;
        const realRoot = fsSync.realpathSync(workspaceRoot);
        const realCandidate = fsSync.realpathSync(path.resolve(workspaceRoot, relativePath));
        const realRelative = path.relative(realRoot, realCandidate);
        if (realRelative.startsWith(`..${path.sep}`) || path.isAbsolute(realRelative)) {
          throw new Error(`截图真实路径超出项目目录: ${data.label}`);
        }
        const stat = fsSync.statSync(realCandidate);
        if (!stat.isFile()) throw new Error(`截图不是文件: ${data.label}`);
        validateImageArtifactMetadata(relativePath, data.mimeType, stat.size);
        const descriptor = fsSync.openSync(realCandidate, "r");
        try {
          const header = Buffer.alloc(12);
          const bytesRead = fsSync.readSync(descriptor, header, 0, header.length, 0);
          validateImageArtifactSignature(header.subarray(0, bytesRead), data.mimeType);
        } finally {
          fsSync.closeSync(descriptor);
        }
        const artifacts = task.artifacts ?? (task.artifacts = []);
        if (artifacts.some(artifact => artifact.uri === data.uri)) return;
        const artifact: TaskLiveArtifact = {
          id: `live-${createHash("sha1").update(data.uri).digest("hex").slice(0, 12)}`,
          uri: data.uri,
          role: data.role,
          label: data.label.trim(),
          mimeType: data.mimeType,
          createdAt: event.timestamp,
        };
        artifacts.push(artifact);
        if (artifacts.length > MAX_LIVE_ARTIFACTS) artifacts.splice(0, artifacts.length - MAX_LIVE_ARTIFACTS);
        this.schedulePersist();
      } catch (error) {
        this.appendLog(task, `[console] 忽略无效截图事件: ${error instanceof Error ? error.message : String(error)}`);
        this.schedulePersist();
      }
      return;
    }
    if (event.type === "log" && event.message) {
      this.appendLog(task, event.source === "stderr" ? `[stderr] ${event.message}` : event.message);
      this.schedulePersist();
  }
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
    const pending = this.terminalFinalizations.get(task.id);
    if (pending) return pending;
    if (TERMINAL_STATUSES.has(task.status)) return;
    const finalization = Promise.resolve().then(() => this.commitTerminalState(task, status, exitCode, error));
    this.terminalFinalizations.set(task.id, finalization);
    try {
      await finalization;
    } finally {
      if (this.terminalFinalizations.get(task.id) === finalization) {
        this.terminalFinalizations.delete(task.id);
      }
    }
  }

  private async commitTerminalState(
    task: TestTask,
    status: "passed" | "failed" | "cancelled",
    exitCode: number | null,
    error: string,
  ): Promise<void> {
    this.clearRetryWatchdog(task.id);
    const next = structuredClone(task);
    next.status = status;
    next.phase = status === "passed" ? "测试通过" : status === "cancelled" ? "已取消" : "测试失败";
    next.finishedAt = new Date().toISOString();
    next.exitCode = exitCode;
    next.error = error;
    if (error) this.appendLog(next, `[console] ${error}`);
    this.appendLog(next, `[console] 任务结束: ${status}`);
    await this.persistNow(next);
    Object.assign(task, next);
    this.cancelRequests.delete(task.id);
    for (const listener of this.completionListeners) {
      try {
        await listener(structuredClone(next));
      } catch (listenerError) {
        console.error("[task] 任务完成监听器执行失败", listenerError);
      }
    }
  }

  private scheduleRetryWatchdog(task: TestTask): void {
    if (!task.retryOf || this.retryWatchdogTimeoutMs <= 0) return;
    this.clearRetryWatchdog(task.id);
    const timer = setTimeout(() => {
      void this.handleRetryTimeout(task.id);
    }, this.retryWatchdogTimeoutMs);
    timer.unref?.();
    this.retryWatchdogs.set(task.id, timer);
  }

  private clearRetryWatchdog(taskId: string): void {
    const timer = this.retryWatchdogs.get(taskId);
    if (!timer) return;
    clearTimeout(timer);
    this.retryWatchdogs.delete(taskId);
  }

  private async handleRetryTimeout(taskId: string): Promise<void> {
    const task = this.tasks.get(taskId);
    if (!task || !task.retryOf || !ACTIVE_STATUSES.has(task.status)) return;
    this.cancelRequests.add(taskId);
    task.phase = "重试超时";
    this.appendLog(task, `[console] 重试超过 ${Math.round(this.retryWatchdogTimeoutMs / 60_000)} 分钟，已终止执行`);
    const finalization = this.finalize(task, "failed", null, `重试超时（超过 ${Math.round(this.retryWatchdogTimeoutMs / 60_000)} 分钟）`);
    this.runnerControllers.get(taskId)?.abort();
    this.cancelRunnerBestEffort(task, "终止超时重试失败", finalization);
    await finalization;
    this.runnerControllers.delete(taskId);
    this.taskRunners.delete(taskId);
    this.commandOverrides.delete(taskId);
  }

  private cancelRunnerBestEffort(task: TestTask, failureLabel: string, finalization: Promise<void>): void {
    const runner = this.taskRunners.get(task.id);
    if (!runner?.cancel) return;
    const recordFailure = (error: unknown) => {
      void finalization.then(async () => {
        this.appendLog(task, `[console] ${failureLabel}: ${error instanceof Error ? error.message : String(error)}`);
        try {
          await this.persistNow();
        } catch (persistError) {
          console.error("[task] Runner 取消诊断日志持久化失败", persistError);
        }
      }).catch(() => undefined);
    };
    try {
      void Promise.resolve(runner.cancel(task.runId)).catch(recordFailure);
    } catch (error) {
      recordFailure(error);
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

function validateImageArtifactMetadata(relativePath: string, mimeType: TaskLiveArtifact["mimeType"], sizeBytes: number): void {
  const extension = path.extname(relativePath).toLowerCase();
  const expectedMimeType = IMAGE_MIME_BY_EXTENSION.get(extension);
  if (!expectedMimeType || expectedMimeType !== mimeType) {
    throw new Error(`截图扩展名与媒体类型不匹配: ${extension || "无扩展名"}/${mimeType}`);
  }
  if (sizeBytes <= 0 || sizeBytes > MAX_LIVE_ARTIFACT_BYTES) {
    throw new Error(`截图大小无效: ${sizeBytes} bytes`);
  }
}

function validateImageArtifactSignature(header: Buffer, mimeType: TaskLiveArtifact["mimeType"]): void {
  const valid = mimeType === "image/jpeg"
    ? header.length >= 3 && header[0] === 0xff && header[1] === 0xd8 && header[2] === 0xff
    : mimeType === "image/png"
      ? header.length >= 8 && header.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
      : header.length >= 12 && header.toString("ascii", 0, 4) === "RIFF" && header.toString("ascii", 8, 12) === "WEBP";
  if (!valid) throw new Error(`截图文件签名与媒体类型不匹配: ${mimeType}`);
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
