import { spawn, type ChildProcess } from "node:child_process";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import os from "node:os";
import type { DeviceDiscoveryService } from "./devices.js";
import type { CommandRunner } from "./command-runner.js";
import { SystemCommandRunner } from "./command-runner.js";
import {
  type RepairJob,
  type RepairJobPreview,
  type RepairJobStatus,
  type RepairReplaySnapshot,
  type TaskResult,
  type TestTask,
} from "../shared/contracts.js";
import { resolveRepairReplayCommand, type LoadedProjectConfig } from "./config.js";
import { ConsoleError } from "./errors.js";
import { RepairJobStore } from "./repair-job-store.js";
import type { TaskManager } from "./task-manager.js";
import type { TaskResultService } from "./task-results.js";
import { WorktreeManager } from "./worktree-manager.js";

const MAX_LOG_LINES = 600;
const MAX_LOG_LINE_LENGTH = 8_000;
const DEVICE_WAIT_TIMEOUT_MS = 60_000;
const DEVICE_WAIT_INTERVAL_MS = 2_000;

export function resolveCodexExecutable(configured: string): string {
  const value = configured.trim();
  if (value !== "codex") return value;
  const candidates = [
    process.env.CODEX_CLI_PATH,
    "/Applications/ChatGPT.app/Contents/Resources/codex",
    "/Applications/Codex.app/Contents/Resources/codex",
  ].filter((candidate): candidate is string => Boolean(candidate));
  return candidates.find(candidate => {
    try { return fsSync.existsSync(candidate); } catch { return false; }
  }) || value;
}

const outputSchema = {
  type: "object",
  additionalProperties: false,
  required: ["status", "summary", "rootCause", "changedFiles", "verificationCommand", "notes"],
  properties: {
    status: { type: "string", enum: ["fixed", "blocked", "failed"] },
    summary: { type: "string" },
    rootCause: { type: "string" },
    changedFiles: { type: "array", items: { type: "string" } },
    verificationCommand: { type: "string" },
    notes: { type: "string" },
  },
} as const;

interface CodexResult {
  status: "fixed" | "blocked" | "failed";
  summary: string;
  rootCause: string;
  changedFiles: string[];
  verificationCommand: string;
  notes: string;
}

export class RepairJobManager {
  private readonly jobs = new Map<string, RepairJob>();
  private readonly processes = new Map<string, ChildProcess>();
  private readonly waitTimers = new Map<string, NodeJS.Timeout>();
  private readonly worktrees = new Map<string, WorktreeManager>();
  private readonly runner: CommandRunner;
  private createQueue: Promise<void> = Promise.resolve();

  constructor(
    private readonly config: LoadedProjectConfig,
    private readonly store: RepairJobStore,
    private readonly tasks: TaskManager,
    private readonly taskResults: TaskResultService,
    private readonly devices: DeviceDiscoveryService,
    runner?: CommandRunner,
  ) {
    this.runner = runner ?? new SystemCommandRunner();
  }

  async initialize(): Promise<void> {
    for (const job of await this.store.load()) {
      if (job.verificationStatus === "failed" && !job.verificationFailureKind) {
        const preconditionFailure = summarizePreconditionFailure(job.latestVerificationResult || null);
        job.verificationFailureKind = preconditionFailure ? "precondition" : "assertion";
      }
      if (job.verificationStatus === "failed" && job.verificationFailureKind === "precondition") {
        const preconditionFailure = summarizePreconditionFailure(job.latestVerificationResult || null);
        job.status = "blocked";
        if (preconditionFailure) job.error = `复测前置条件失败：${preconditionFailure}`;
      }
      this.jobs.set(job.repairJobId, job);
    }
    await this.persist();
  }

  list(): RepairJob[] {
    return [...this.jobs.values()]
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
      .map(job => structuredClone(job));
  }

  get(repairJobId: string): RepairJob | null {
    const job = this.jobs.get(repairJobId);
    return job ? structuredClone(job) : null;
  }

  async openTask(repairJobId: string): Promise<RepairJob> {
    const job = this.requireJob(repairJobId);
    const threadId = job.codexThreadId?.trim();
    if (!threadId) throw new ConsoleError("REPAIR_CODEX_THREAD_UNKNOWN", "Codex 修复任务尚未创建完成", 409);
    if (process.platform !== "darwin") {
      throw new ConsoleError("REPAIR_CODEX_OPEN_UNSUPPORTED", "当前系统不支持打开 ChatGPT 工作台任务", 409);
    }
    const result = await this.runner.capture("open", [`codex://threads/${encodeURIComponent(threadId)}`], 10_000);
    if (result.code !== 0) {
      throw new ConsoleError("REPAIR_CODEX_OPEN_FAILED", result.stderr.trim() || "无法打开 ChatGPT 工作台任务", 502);
    }
    return structuredClone(job);
  }

  async create(taskId: string, caseRunId?: string, projectDirectory?: string): Promise<RepairJob> {
    const operation = this.createQueue.then(() => this.createInternal(taskId, caseRunId, projectDirectory));
    this.createQueue = operation.then(() => undefined, () => undefined);
    return operation;
  }

  async preview(taskId: string, caseRunId?: string): Promise<RepairJobPreview> {
    const { task, result, failedRun } = await this.loadRepairInput(taskId, caseRunId);
    const context = buildFailureContext({
      caseRunId: failedRun.caseRunId,
      targetPage: failedRun.targetPage,
      snapshot: { result },
    });
    return {
      schemaVersion: "mobile-test-console.repair-preview.v1",
      taskId: task.id,
      caseRunId: failedRun.caseRunId,
      targetPage: failedRun.targetPage,
      launchPage: failedRun.launchPage,
      platform: task.device.platform,
      device: {
        id: task.device.id,
        name: task.device.name,
        type: task.device.type,
        manufacturer: task.device.manufacturer,
      },
      parameters: { ...task.parameters },
      failureContext: context,
      prompt: buildRepairPrompt({
        targetPage: failedRun.targetPage,
        platform: task.device.platform,
        attempt: 1,
        maxAttempts: this.config.codexRepair?.maxAttempts ?? 2,
        worktreePath: "(确认后创建隔离修复工作目录)",
        deviceName: task.device.name,
        parameters: task.parameters,
        failureContext: context,
      }),
    };
  }

  async selectProjectDirectory(): Promise<string> {
    const selected = await this.openDirectoryPicker();
    if (!selected) throw new ConsoleError("REPAIR_DIRECTORY_SELECTION_CANCELLED", "已取消选择项目目录", 409);
    return this.resolveProjectDirectory(selected);
  }

  private async createInternal(taskId: string, caseRunId?: string, projectDirectory?: string): Promise<RepairJob> {
    const { task, result, failedRun } = await this.loadRepairInput(taskId, caseRunId);
    const workspace = await this.resolveProjectDirectory(projectDirectory);
    const worktrees = this.worktreeManager(workspace);
    const baseline = await worktrees.inspectBaseline();
    const duplicate = this.list().find(job => job.taskId === taskId
      && job.caseRunId === failedRun.caseRunId
      && job.snapshot.workspace === workspace
      && job.dirtyFingerprint === baseline.dirtyFingerprint
      && (!this.shouldUseAppServer() || Boolean(job.codexThreadId))
      && !["failed", "blocked", "cancelled"].includes(job.status));
    if (duplicate) return duplicate;

    const repairJobId = randomUUID();
    const worktree = await worktrees.create(repairJobId, baseline);
    const createdAt = new Date().toISOString();
    const snapshot: RepairReplaySnapshot = {
      schemaVersion: "mobile-test-console.replay-snapshot.v1",
      projectId: task.projectId,
      workspace,
      baselineCommit: worktree.baselineCommit,
      dirtyFingerprint: worktree.dirtyFingerprint,
      taskId: task.id,
      runId: task.runId,
      caseRunId: failedRun.caseRunId,
      testId: task.testId,
      testLabel: task.testLabel,
      targetPage: failedRun.targetPage,
      launchPage: failedRun.launchPage,
      platform: task.device.platform,
      device: structuredClone(task.device),
      parameters: { ...task.parameters },
      taskError: task.error,
      taskLogs: [...task.logs],
      result: structuredClone(result),
      createdAt,
    };
    const job: RepairJob = {
      repairJobId,
      projectId: task.projectId,
      taskId: task.id,
      runId: task.runId,
      caseRunId: failedRun.caseRunId,
      testId: task.testId,
      testLabel: task.testLabel,
      targetPage: failedRun.targetPage,
      platform: task.device.platform,
      status: "queued",
      verificationStatus: "pending",
      attempt: 0,
      maxAttempts: this.config.codexRepair?.maxAttempts ?? 2,
      createdAt,
      updatedAt: createdAt,
      baselineCommit: worktree.baselineCommit,
      dirtyFingerprint: worktree.dirtyFingerprint,
      worktreePath: worktree.worktreePath,
      patchPath: worktree.patchPath,
      diff: "",
      replayTaskId: "",
      error: "",
      logs: [],
      events: [],
      snapshot,
    };
    await this.snapshotProtectedState(job);
    await this.writeRepairInputs(job, worktree.baselinePatch);
    this.jobs.set(repairJobId, job);
    this.addEvent(job, "queued", "已创建 Codex 修复任务，等待启动");
    await this.persist();
    queueMicrotask(() => this.runDetached(repairJobId, () => this.runAttempt(repairJobId), "执行 Codex 修复"));
    return structuredClone(job);
  }

  private async loadRepairInput(taskId: string, caseRunId?: string) {
    this.assertEnabled();
    const task = this.requireTask(taskId);
    if (!["failed", "interrupted"].includes(task.status)) {
      throw new ConsoleError("REPAIR_TASK_NOT_FAILED", "只有失败或中断的任务可以交给 Codex 修复", 409);
    }
    const result = await this.taskResults.load(taskId);
    const failedRun = caseRunId
      ? result.runs.find(run => run.caseRunId === caseRunId && run.status === "failed")
      : result.runs.find(run => run.status === "failed") || (task.status === "interrupted" ? result.runs[0] : undefined);
    if (caseRunId && !failedRun) {
      throw new ConsoleError("REPAIR_CASE_UNKNOWN", `失败用例不存在或当前不可修复: ${caseRunId}`, 404);
    }
    if (!failedRun) throw new ConsoleError("REPAIR_EVIDENCE_EMPTY", "任务没有可修复的失败用例", 409);
    return { task, result, failedRun };
  }

  async cancel(repairJobId: string): Promise<RepairJob> {
    const job = this.requireJob(repairJobId);
    const process = this.processes.get(repairJobId);
    if (process?.pid) this.killProcessTree(process.pid, "SIGTERM");
    if (job.replayTaskId) {
      const replay = this.tasks.get(job.replayTaskId);
      if (replay && ["queued", "preparing", "running"].includes(replay.status)) await this.tasks.stop(replay.id);
    }
    this.clearWaitTimer(repairJobId);
    job.status = "cancelled";
    job.verificationStatus = "pending";
    job.error = "已由开发者取消";
    this.addEvent(job, "cancelled", job.error);
    await this.persist();
    return structuredClone(job);
  }

  async retryTest(repairJobId: string): Promise<RepairJob> {
    const job = this.requireJob(repairJobId);
    if (!["failed", "blocked", "waiting_device"].includes(job.status)
      && !(job.status === "fixed" && job.verificationStatus === "failed")) {
      throw new ConsoleError("REPAIR_RETRY_UNAVAILABLE", "当前修复任务尚未进入可复测状态", 409);
    }
    job.error = "";
    job.verificationStatus = "pending";
    job.verificationFailureKind = undefined;
    this.clearWaitTimer(repairJobId);
    this.setStatus(job, "verifying", "开发者已请求重新执行同参数复测");
    await this.persist();
    this.runDetached(job.repairJobId, () => this.startReplayWhenReady(job.repairJobId, 0), "启动定向复测");
    return structuredClone(job);
  }

  async shutdown(): Promise<void> {
    for (const process of this.processes.values()) {
      if (process.pid) this.killProcessTree(process.pid, "SIGTERM");
    }
    for (const timer of this.waitTimers.values()) clearTimeout(timer);
    this.waitTimers.clear();
    await this.persist();
  }

  private async runAttempt(repairJobId: string): Promise<void> {
    const job = this.jobs.get(repairJobId);
    if (!job || job.status === "cancelled") return;
    if (job.attempt >= job.maxAttempts) {
      job.status = "blocked";
      job.error = "已达到最大自动修复轮次";
      this.addEvent(job, "blocked", job.error);
      await this.persist();
      return;
    }
    job.attempt += 1;
    this.setStatus(job, "investigating", `开始第 ${job.attempt}/${job.maxAttempts} 轮分析`);
    await this.persist();
    this.setStatus(job, "fixing", `Codex 正在第 ${job.attempt} 轮修复`);
    await this.persist();
    if (this.shouldUseAppServer()) {
      await this.runAppServerAttempt(job);
      return;
    }

    const outputSchemaPath = path.join(job.worktreePath, ".codex-repair", "output-schema.json");
    const outputPath = path.join(job.worktreePath, ".codex-repair", `codex-result-${job.attempt}.json`);
    await fs.writeFile(outputSchemaPath, `${JSON.stringify(outputSchema, null, 2)}\n`);
    const args = [
      "exec",
      "--json",
      "--sandbox", this.config.codexRepair?.sandbox ?? "workspace-write",
      "-c", `approval_policy="${this.config.codexRepair?.approvalPolicy ?? "never"}"`,
      "-C", job.worktreePath,
      "--output-schema", outputSchemaPath,
      "--output-last-message", outputPath,
      "--color", "never",
      this.buildPrompt(job),
    ];
    const executable = resolveCodexExecutable(this.config.codexRepair?.executable ?? "codex");
    const child = spawn(executable, args, {
      cwd: job.worktreePath,
      env: { ...process.env },
      shell: false,
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
    });
    this.processes.set(repairJobId, child);
    const completion = this.consumeCodexOutput(job, child);
    const result = await waitForProcess(child);
    await completion;
    this.processes.delete(repairJobId);
    const exported = await this.worktreeManager(job.snapshot.workspace).exportPatch(job.worktreePath, job.patchPath).catch(error => ({
      diff: job.diff,
      patchPath: job.patchPath,
      error,
    }));
    job.diff = exported.diff;
    if (this.jobs.get(repairJobId)?.status === "cancelled") {
      await this.persist();
      return;
    }
    if (result.error || result.code !== 0) {
      job.status = "failed";
      job.error = result.error ? `Codex 启动失败: ${result.error.message}` : `Codex 进程退出码: ${result.code ?? "unknown"}`;
      this.addEvent(job, "failed", job.error);
      await this.persist();
      return;
    }
    const codexResult = await readCodexResult(outputPath);
    if (!codexResult) {
      job.status = "failed";
      job.error = "Codex 未返回符合约束的修复结果";
      this.addEvent(job, "failed", job.error);
      await this.persist();
      return;
    }
    this.appendLog(job, `[codex] ${codexResult.summary}`);
    if (codexResult.status === "blocked") {
      job.status = "blocked";
      job.error = codexResult.notes || codexResult.summary;
      this.addEvent(job, "blocked", job.error);
      await this.persist();
      return;
    }
    if (codexResult.status === "failed") {
      job.status = "failed";
      job.error = codexResult.notes || codexResult.summary;
      this.addEvent(job, "failed", job.error);
      await this.persist();
      return;
    }
    this.setStatus(job, "verifying", `第 ${job.attempt} 轮修复完成，开始同参数复测`);
    await this.persist();
    this.runDetached(job.repairJobId, () => this.startReplayWhenReady(job.repairJobId, 0), "启动定向复测");
  }

  private async startReplayWhenReady(repairJobId: string, waitedMs: number): Promise<void> {
    const job = this.jobs.get(repairJobId);
    if (!job || job.status === "cancelled") return;
    const discovery = await this.devices.discover();
    const device = discovery.devices.find(item => item.key === job.snapshot.device.key);
    if (!device || device.connectionState !== "available") {
      if (waitedMs >= DEVICE_WAIT_TIMEOUT_MS) {
        job.status = "blocked";
        job.error = "原测试设备在等待窗口内未恢复连接";
        this.addEvent(job, "blocked", job.error);
        await this.persist();
        return;
      }
      job.status = "waiting_device";
      job.error = `等待原设备 ${job.snapshot.device.name} 连接`;
      this.addEvent(job, "waiting_device", job.error);
      await this.persist();
      this.clearWaitTimer(repairJobId);
      this.waitTimers.set(repairJobId, setTimeout(() => {
        this.runDetached(repairJobId, () => this.startReplayWhenReady(repairJobId, waitedMs + DEVICE_WAIT_INTERVAL_MS), "等待设备复测");
      }, DEVICE_WAIT_INTERVAL_MS));
      return;
    }
    const active = this.tasks.list().find(task => task.device.key === device.key && ["queued", "preparing", "running"].includes(task.status));
    if (active) {
      job.status = "waiting_device";
      job.error = `${device.name} 正在执行其他任务`;
      await this.persist();
      this.clearWaitTimer(repairJobId);
      this.waitTimers.set(repairJobId, setTimeout(() => {
        this.runDetached(repairJobId, () => this.startReplayWhenReady(repairJobId, waitedMs), "等待设备空闲");
      }, DEVICE_WAIT_INTERVAL_MS));
      return;
    }
    this.clearWaitTimer(repairJobId);
    job.status = "verifying";
    job.error = "";
    this.addEvent(job, "verifying", "已获得原设备，开始定向复测");
    if (!this.config.codexRepair?.replay) {
      job.status = "blocked";
      job.error = "项目未配置 Codex 定向复测命令";
      this.addEvent(job, "blocked", job.error);
      await this.persist();
      return;
    }
    const [replay] = await this.tasks.start({
      testId: job.snapshot.testId,
      deviceKeys: [device.key],
      parameters: job.snapshot.parameters,
    }, [device], job.worktreePath, job.repairJobId, task => resolveRepairReplayCommand(this.config, job, task));
    job.replayTaskId = replay.id;
    await this.persist();
    const finished = await this.tasks.waitForTerminal(replay.id).catch(() => null);
    if (this.jobs.get(repairJobId)?.status === "cancelled") return;
    if (!finished) {
      job.status = "blocked";
      job.error = "定向复测等待超时，请人工重试";
      this.addEvent(job, "blocked", job.error);
      await this.persist();
      return;
    }
    const replayResult = await this.taskResults.load(replay.id).catch(() => null);
    job.latestVerificationResult = replayResult || undefined;
    if (finished.status === "passed") {
      job.status = "fixed";
      job.verificationStatus = "passed";
      job.verificationFailureKind = undefined;
      job.error = "";
      this.addEvent(job, "fixed", "同参数复测通过，修复完成");
      await this.persist();
      return;
    }
    const preconditionFailure = summarizePreconditionFailure(replayResult);
    if (preconditionFailure) {
      job.status = "blocked";
      job.verificationStatus = "failed";
      job.verificationFailureKind = "precondition";
      job.error = `复测前置条件失败：${preconditionFailure}`;
      this.addEvent(job, "blocked", job.error);
      await this.persist();
      return;
    }
    job.verificationStatus = "failed";
    job.verificationFailureKind = "assertion";
    if (job.attempt < job.maxAttempts && finished.status === "failed") {
      this.setStatus(job, "fixing", `第 ${job.attempt} 轮复测失败，准备第 ${job.attempt + 1} 轮修复`);
      await this.writeVerificationEvidence(job, replayResult);
      await this.persist();
      this.runDetached(job.repairJobId, () => this.runAttempt(job.repairJobId), "执行下一轮 Codex 修复");
      return;
    }
    job.status = "failed";
    job.error = "第二轮同参数复测仍失败，转人工处理";
    this.addEvent(job, "failed", job.error);
    await this.persist();
  }

  private async writeRepairInputs(job: RepairJob, baselinePatch: string): Promise<void> {
    const directory = path.join(job.worktreePath, ".codex-repair");
    await fs.mkdir(directory, { recursive: true });
    await fs.writeFile(path.join(directory, "input.json"), `${JSON.stringify({
      snapshot: job.snapshot,
      baselinePatch,
      failureLogs: buildCompleteFailureLogs(job),
    }, null, 2)}\n`);
    await fs.writeFile(path.join(directory, "failure-logs.txt"), `${buildCompleteFailureLogs(job)}\n`);
  }

  private async snapshotProtectedState(job: RepairJob): Promise<void> {
    const directory = path.join(this.config.stateDir, "repair-snapshots", job.repairJobId);
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    for (const fileName of ["page-parameters.json", "account-profiles.json"]) {
      const source = path.join(this.config.stateDir, fileName);
      const target = path.join(directory, fileName);
      try {
        await fs.copyFile(source, target);
        await fs.chmod(target, 0o600);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
  }

  private async writeVerificationEvidence(job: RepairJob, result: TaskResult | null): Promise<void> {
    if (!result) return;
    await fs.writeFile(path.join(job.worktreePath, ".codex-repair", `verification-${job.attempt}.json`), `${JSON.stringify(result, null, 2)}\n`);
  }

  private buildPrompt(job: RepairJob): string {
    const verification = job.attempt > 1 ? `另请阅读 .codex-repair/verification-${job.attempt - 1}.json，分析上一轮复测的新证据。` : "";
    const failureContext = buildFailureContext(job);
    return buildRepairPrompt({
      targetPage: job.targetPage,
      platform: job.platform,
      attempt: job.attempt,
      maxAttempts: job.maxAttempts,
      worktreePath: job.worktreePath,
      deviceName: job.snapshot.device.name,
      parameters: job.snapshot.parameters,
      failureContext,
      verification,
    });
  }

  private shouldUseAppServer(): boolean {
    return this.config.codexRepair?.appServer !== false
      && path.basename(resolveCodexExecutable(this.config.codexRepair?.executable ?? "codex")) === "codex";
  }

  private async runAppServerAttempt(job: RepairJob): Promise<void> {
    const executable = resolveCodexExecutable(this.config.codexRepair?.executable ?? "codex");
    const child = spawn(executable, [
      "app-server",
      "--stdio",
      // 修复工作台只需要本地代码和模型，关闭用户配置的 MCP，避免过期
      // 登录态或远程 MCP 403 让 App Server 工作进程提前退出。
      "-c", "mcp_servers.mcpServers.enabled=false",
      "-c", "mcp_servers.mcpServers-1.enabled=false",
      "-c", "mcp_servers.openaiDeveloperDocs.enabled=false",
      "-c", "mcp_servers.node_repl.enabled=false",
    ], {
      cwd: job.snapshot.workspace,
      env: { ...process.env },
      shell: false,
      detached: process.platform !== "win32",
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.processes.set(job.repairJobId, child);
    const result = await this.driveAppServer(child, job);
    this.processes.delete(job.repairJobId);
    if (this.jobs.get(job.repairJobId)?.status === "cancelled") return;
    const exported = await this.worktreeManager(job.snapshot.workspace).exportPatch(job.worktreePath, job.patchPath).catch(error => ({ diff: job.diff, patchPath: job.patchPath, error }));
    job.diff = exported.diff;
    if (result.error) {
      job.status = "failed";
      job.error = `Codex 工作台失败: ${result.error}`;
      this.addEvent(job, "failed", job.error);
      await this.persist();
      return;
    }
    if (!job.diff.trim()) {
      job.status = "blocked";
      job.error = "Codex 工作台未产生代码改动";
      this.addEvent(job, "blocked", job.error);
      await this.persist();
      return;
    }
    this.setStatus(job, "verifying", `第 ${job.attempt} 轮修复完成，开始同参数复测`);
    await this.persist();
    this.runDetached(job.repairJobId, () => this.startReplayWhenReady(job.repairJobId, 0), "启动定向复测");
  }

  private async driveAppServer(child: ChildProcess, job: RepairJob): Promise<{ error: string }> {
    return new Promise(resolve => {
      let buffer = "";
      let nextId = 1;
      let settled = false;
      let finalError = "";
      let forceKillTimer: NodeJS.Timeout | undefined;
      let initializeRequestId = 0;
      let threadStartRequestId = 0;
      let turnStartRequestId = 0;
      const finish = (error = "") => {
        if (settled) return;
        settled = true;
        finalError = error;
        // turn/completed 表示请求已完成，先关闭 stdin 让 app-server 正常退出。
        child.stdin?.end();
        forceKillTimer = setTimeout(() => {
          if (child.exitCode === null && child.signalCode === null && child.pid) {
            this.killProcessTree(child.pid, "SIGTERM");
          }
        }, 2_000);
      };
      const send = (method: string, params: Record<string, unknown>): number => {
        const id = nextId++;
        child.stdin?.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
        return id;
      };
      const notify = (method: string) => {
        child.stdin?.write(`${JSON.stringify({ jsonrpc: "2.0", method })}\n`);
      };
      const handle = (payload: Record<string, unknown>) => {
        const method = String(payload.method || "");
        const params = (payload.params || {}) as Record<string, unknown>;
        const responseId = typeof payload.id === "number" ? payload.id : 0;
        if (payload.error) {
          finish(String((payload.error as { message?: string }).message || "Codex App Server 请求失败"));
          return;
        }
        if (responseId === initializeRequestId && payload.result) {
          notify("initialized");
          threadStartRequestId = send("thread/start", {
            cwd: job.snapshot.workspace,
            runtimeWorkspaceRoots: [job.worktreePath],
            sandbox: "workspace-write",
            approvalPolicy: "never",
            ephemeral: false,
            threadSource: "mobile-test-console",
          });
          return;
        }
        if (responseId === threadStartRequestId && payload.result) {
          const thread = (payload.result as { thread?: { id?: string } }).thread;
          if (thread?.id) {
            job.codexThreadId = thread.id;
            this.appendLog(job, `[codex app-server] Fanli 工作台任务 ${thread.id}`);
            void this.persist();
            send("thread/name/set", { threadId: thread.id, name: `Fanli 修复 · ${job.targetPage} · ${job.caseRunId}` });
            const prompt = this.buildPrompt(job);
            turnStartRequestId = send("turn/start", {
              threadId: thread.id,
              cwd: job.snapshot.workspace,
              runtimeWorkspaceRoots: [job.worktreePath],
              input: [{ type: "text", text: prompt }],
            });
            this.appendLog(job, `[codex app-server] 已提交任务摘要和证据路径，字符数 ${prompt.length}`);
          }
          return;
        }
        if (responseId === turnStartRequestId && payload.result) {
          this.appendLog(job, "[codex app-server] Codex 已接收任务正文");
          void this.persist();
          return;
        }
        if (method === "thread/started") {
          const thread = (params.thread || {}) as { id?: string };
          if (thread.id && !job.codexThreadId) {
            job.codexThreadId = thread.id;
            void this.persist();
          }
        } else if (method === "turn/started") {
          this.setStatus(job, "fixing", "Codex 正在 Fanli 工作台中修复");
          void this.persist();
        } else if (method === "item/agentMessage/delta") {
          const delta = String(params.delta || "");
          if (delta) this.appendLog(job, `[codex] ${delta}`);
        } else if (method === "turn/completed") {
          const turn = (params.turn || {}) as { status?: string; error?: { message?: string } };
          finish(turn.status === "failed" ? String(turn.error?.message || "Codex 工作台修复失败") : "");
        }
      };
      child.stdout?.on("data", chunk => {
        buffer += String(chunk);
        const lines = buffer.replace(/\r/g, "").split("\n");
        buffer = lines.pop() || "";
        for (const line of lines.filter(Boolean)) {
          try { handle(JSON.parse(line) as Record<string, unknown>); } catch { this.appendLog(job, `[codex app-server] ${line}`); }
        }
      });
      child.stderr?.on("data", chunk => this.appendLog(job, `[codex app-server stderr] ${String(chunk)}`));
      child.once("error", error => {
        finish(error.message);
      });
      child.once("close", code => {
        if (forceKillTimer) clearTimeout(forceKillTimer);
        if (!settled) {
          resolve({ error: code === 0 ? "Codex 工作台提前结束" : `Codex 工作台退出码: ${code ?? "unknown"}` });
          return;
        }
        resolve({ error: finalError });
      });
      initializeRequestId = send("initialize", {
        clientInfo: { name: "mobile-test-console", version: "1.0.0" },
        capabilities: { experimentalApi: true },
      });
    });
  }

  private async consumeCodexOutput(job: RepairJob, child: ChildProcess): Promise<void> {
    const buffers = { stdout: "", stderr: "" };
    const consumeLine = (line: string, source: keyof typeof buffers) => {
      if (!line) return;
      this.appendLog(job, source === "stderr" ? `[codex stderr] ${line}` : `[codex] ${line}`);
      if (job.status === "cancelled") return;
      try {
        const event = JSON.parse(line) as { type?: string; item?: { type?: string }; message?: string };
        if (event.type === "thread.started") this.setStatus(job, "investigating", "Codex 已开始分析");
        else if (event.type === "turn.started" || event.item?.type === "command_execution") this.setStatus(job, "fixing", "Codex 正在修改代码");
        else if (event.type === "turn.completed") this.setStatus(job, "verifying", "Codex 已返回结果，准备复测");
      } catch {
        // 保留原始 JSONL，最终结构由 output-last-message 校验。
      }
    };
    const consume = (chunk: string, source: keyof typeof buffers) => {
      buffers[source] += chunk;
      const lines = buffers[source].replace(/\r/g, "").split("\n");
      buffers[source] = lines.pop() || "";
      for (const line of lines.filter(Boolean)) {
        consumeLine(line, source);
      }
    };
    child.stdout?.on("data", chunk => consume(String(chunk), "stdout"));
    child.stderr?.on("data", chunk => consume(String(chunk), "stderr"));
    await new Promise<void>(resolve => child.once("close", () => resolve()));
    consumeLine(buffers.stdout.replace(/\r/g, ""), "stdout");
    consumeLine(buffers.stderr.replace(/\r/g, ""), "stderr");
  }

  private runDetached(repairJobId: string, operation: () => Promise<void>, context: string): void {
    void operation()
      .catch(error => this.recordUnexpectedFailure(repairJobId, context, error))
      .catch(error => process.stderr.write(`[repair] 持久化异常失败: ${error instanceof Error ? error.message : String(error)}\n`));
  }

  private async recordUnexpectedFailure(repairJobId: string, context: string, error: unknown): Promise<void> {
    const job = this.jobs.get(repairJobId);
    if (!job || job.status === "cancelled") return;
    const processHandle = this.processes.get(repairJobId);
    if (processHandle?.pid) this.killProcessTree(processHandle.pid, "SIGTERM");
    this.processes.delete(repairJobId);
    this.clearWaitTimer(repairJobId);
    job.error = `${context}失败: ${error instanceof Error ? error.message : String(error)}`;
    this.addEvent(job, "failed", job.error);
    await this.persist();
  }

  private setStatus(job: RepairJob, status: RepairJobStatus, message: string): void {
    const previous = job.events[job.events.length - 1];
    if (previous?.status === status && previous.message === message) {
      job.status = status;
      job.updatedAt = new Date().toISOString();
      return;
    }
    job.status = status;
    job.updatedAt = new Date().toISOString();
    this.addEvent(job, status, message);
  }

  private addEvent(job: RepairJob, status: RepairJobStatus, message: string): void {
    const at = new Date().toISOString();
    job.status = status;
    job.updatedAt = at;
    job.events.push({ at, status, message });
    this.appendLog(job, `[${status}] ${message}`);
  }

  private appendLog(job: RepairJob, line: string): void {
    job.logs.push(String(line).slice(0, MAX_LOG_LINE_LENGTH));
    if (job.logs.length > MAX_LOG_LINES) job.logs.splice(0, job.logs.length - MAX_LOG_LINES);
    job.updatedAt = new Date().toISOString();
  }

  private requireTask(taskId: string): TestTask {
    const task = this.tasks.get(taskId);
    if (!task) throw new ConsoleError("TASK_UNKNOWN", `任务不存在: ${taskId}`, 404);
    return task;
  }

  private requireJob(repairJobId: string): RepairJob {
    const job = this.jobs.get(repairJobId);
    if (!job) throw new ConsoleError("REPAIR_JOB_UNKNOWN", `修复任务不存在: ${repairJobId}`, 404);
    return job;
  }

  private assertEnabled(): void {
    if (!this.config.codexRepair?.enabled) throw new ConsoleError("CODEX_REPAIR_DISABLED", "项目未启用 Codex 修复", 409);
  }

  private worktreeManager(projectRoot: string): WorktreeManager {
    const existing = this.worktrees.get(projectRoot);
    if (existing) return existing;
    const worktreeRoot = this.config.codexRepair?.worktreeRoot || path.join(this.config.stateDir, "repair-worktrees");
    const manager = new WorktreeManager(
      projectRoot,
      worktreeRoot,
      this.runner,
      this.config.codexRepair?.worktreeLinks ?? [],
    );
    this.worktrees.set(projectRoot, manager);
    return manager;
  }

  private async resolveProjectDirectory(input?: string): Promise<string> {
    const candidate = path.resolve(String(input || this.config.project.root || "").trim());
    const stat = await fs.stat(candidate).catch(() => null);
    if (!stat?.isDirectory()) {
      throw new ConsoleError("REPAIR_PROJECT_DIRECTORY_REQUIRED", "请选择 Codex 修复使用的 Git 项目目录", 409);
    }
    const result = await this.runner.capture("git", ["rev-parse", "--show-toplevel"], 15_000, { cwd: candidate });
    if (result.code !== 0 || !result.stdout.trim()) {
      throw new ConsoleError("REPAIR_PROJECT_DIRECTORY_REQUIRED", "所选目录不是有效的 Git 项目，请重新选择", 409);
    }
    return path.resolve(result.stdout.trim());
  }

  private async openDirectoryPicker(): Promise<string> {
    if (process.platform === "darwin") {
      const result = await this.runner.capture("osascript", [
        "-e",
        'POSIX path of (choose folder with prompt "选择 Codex 修复项目目录")',
      ], 120_000);
      return result.code === 0 ? result.stdout.trim() : "";
    }
    if (process.platform === "win32") {
      const script = [
        "Add-Type -AssemblyName System.Windows.Forms",
        "$dialog = New-Object System.Windows.Forms.FolderBrowserDialog",
        '$dialog.Description = "选择 Codex 修复项目目录"',
        "if ($dialog.ShowDialog() -eq 'OK') { $dialog.SelectedPath }",
      ].join("; " );
      const result = await this.runner.capture("powershell", ["-NoProfile", "-Command", script], 120_000);
      return result.code === 0 ? result.stdout.trim() : "";
    }
    const result = await this.runner.capture("zenity", ["--file-selection", "--directory", "--title=选择 Codex 修复项目目录"], 120_000);
    if (result.code !== 0 && /ENOENT|not found/i.test(result.stderr)) {
      throw new ConsoleError("REPAIR_DIRECTORY_PICKER_UNAVAILABLE", `当前系统缺少目录选择器，请安装 zenity。${os.platform()}`, 500);
    }
    return result.code === 0 ? result.stdout.trim() : "";
  }

  private clearWaitTimer(repairJobId: string): void {
    const timer = this.waitTimers.get(repairJobId);
    if (timer) clearTimeout(timer);
    this.waitTimers.delete(repairJobId);
  }

  private async persist(): Promise<void> {
    await this.store.save(this.list());
  }

  private killProcessTree(pid: number, signal: NodeJS.Signals): void {
    try {
      if (process.platform === "win32") {
        const killer = spawn("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore" });
        killer.unref();
      } else {
        process.kill(-pid, signal);
      }
    } catch {
      try { process.kill(pid, signal); } catch { /* 进程已结束。 */ }
    }
  }
}

const MAX_FAILURE_CONTEXT_LENGTH = 12_000;
const MAX_FAILURE_FIELD_LENGTH = 3_000;

function buildRepairPrompt(input: {
  targetPage: string;
  platform: string;
  attempt: number;
  maxAttempts: number;
  worktreePath: string;
  deviceName: string;
  parameters: Record<string, string>;
  failureContext: string;
  verification?: string;
}): string {
  return [
    "你正在执行 Mobile Test Console 的本地页面测试修复任务。",
    `项目页面：${input.targetPage}，平台：${input.platform}，修复轮次：${input.attempt}/${input.maxAttempts}。`,
    `修复工作目录：${input.worktreePath}。所有代码读取、修改和验证都必须在该目录执行。`,
    `原始复测设备：${input.deviceName}。`,
    `原始复测参数：${JSON.stringify(input.parameters)}。`,
    "以下是当前选中失败用例的错误摘要。请基于摘要定位问题，并按需读取工作目录内的完整证据文件。",
    input.failureContext,
    "完整测试日志路径：.codex-repair/failure-logs.txt。",
    "失败证据、原始设备和参数快照路径：.codex-repair/input.json。",
    "请先读取上述文件；文件内容保留未截断的完整证据。",
    input.verification,
    "在当前 worktree 中定位并修复代码问题，保留现有开发者工作区改动的意图。运行最小相关验证命令，完成后按 output-schema 返回结构化结果。",
    "status=fixed 仅表示代码修复完成且已准备好由控制台使用同一快照复测；无法定位或需要人工决策时返回 blocked。",
  ].filter(Boolean).join("\n");
}

export function buildCompleteFailureLogs(job: RepairJob): string {
  const runLog = job.snapshot.result.runs.find(item => item.caseRunId === job.caseRunId)?.failureLogExcerpt || "";
  const taskLogs = Array.isArray(job.snapshot.taskLogs) ? job.snapshot.taskLogs.join("\n") : "";
  const evidenceLogs = readSelectedEvidenceLogs(job);
  return [
    job.snapshot.taskError ? `# task error\n${job.snapshot.taskError}` : "",
    taskLogs ? `# console task logs\n${taskLogs}` : "",
    runLog ? `# case failure logs\n${runLog}` : "",
    evidenceLogs ? `# complete evidence files\n${evidenceLogs}` : "",
  ].filter(Boolean).join("\n\n") || "(未采集到测试日志)";
}

function readSelectedEvidenceLogs(job: RepairJob): string {
  const run = job.snapshot.result.runs.find(item => item.caseRunId === job.caseRunId);
  const artifactsRoot = job.snapshot.result && job.snapshot.result.runId
    ? path.resolve(job.snapshot.workspace, "qa/history/artifacts")
    : "";
  const configuredRoot = artifactsRoot && fsSync.existsSync(artifactsRoot)
    ? artifactsRoot
    : "";
  if (!run || !configuredRoot || !Array.isArray(run.evidenceFiles)) return "";
  const textExtensions = new Set([".json", ".jsonl", ".log", ".txt", ".xml", ".yaml", ".yml"]);
  return run.evidenceFiles.map(relativePath => {
    const absolutePath = path.resolve(configuredRoot, relativePath);
    if (!absolutePath.startsWith(`${configuredRoot}${path.sep}`)
      || !textExtensions.has(path.extname(absolutePath).toLowerCase())
      || !fsSync.existsSync(absolutePath)
      || !fsSync.statSync(absolutePath).isFile()) return "";
    try {
      return `## ${relativePath}\n${fsSync.readFileSync(absolutePath, "utf8")}`;
    } catch {
      return "";
    }
  }).filter(Boolean).join("\n\n");
}

function truncateFailureText(value: unknown, maxLength = MAX_FAILURE_FIELD_LENGTH): string {
  const text = String(value ?? "").trim();
  if (text.length <= maxLength) return text;
  return `${text.slice(0, maxLength)}\n...[已截断，完整内容见 .codex-repair/input.json]`;
}

function summarizeFailedApiCall(call: Record<string, unknown>): string {
  const operation = String(call.operationName || call.endpoint || call.path || call.url || "未命名接口");
  const status = String(call.status || call.result || "unknown");
  const response = call.response && typeof call.response === "object"
    ? JSON.stringify(call.response)
    : String(call.response || "");
  return `${operation} (${status})${response ? `: ${truncateFailureText(response, 1_500)}` : ""}`;
}

export function buildFailureContext(job: Pick<RepairJob, "caseRunId" | "targetPage"> & {
  snapshot: Pick<RepairReplaySnapshot, "result">;
}): string {
  const run = job.snapshot.result.runs.find(item => item.caseRunId === job.caseRunId);
  if (!run) {
    const failedPreconditions = (job.snapshot.result.preconditions || [])
      .filter(item => item.status === "failed")
      .map(item => `${item.label}: ${item.detail}`);
    return failedPreconditions.length
      ? `failedPreconditions: ${failedPreconditions.map(item => truncateFailureText(item)).join(" | ")}`
      : "失败用例证据：未找到对应 caseRunId 的结果记录。";
  }
  const failedBasis = (run.passBasis || [])
    .filter(item => !item.passed)
    .map(item => `${item.kind}: ${item.description}`);
  const failedApiCalls = (run.apiCalls || [])
    .filter(call => {
      const result = String(call.result || "").toLowerCase();
      const status = Number(call.status);
      return (result && !["success", "passed", "ok"].includes(result)) || (Number.isFinite(status) && status >= 400);
    })
    .map(call => summarizeFailedApiCall(call as unknown as Record<string, unknown>));
  const lines = [
    `caseRunId: ${job.caseRunId}`,
    `targetPage: ${run.targetPage || job.targetPage}`,
    `errorSummary: ${truncateFailureText(run.errorSummary) || "(empty)"}`,
    `failureLogExcerpt: ${truncateFailureText(run.failureLogExcerpt) || "(empty)"}`,
    `missingEvents: ${run.missingEvents.length ? run.missingEvents.join(", ") : "(empty)"}`,
    `failedAssertions: ${failedBasis.length ? failedBasis.map(item => truncateFailureText(item)).join(" | ") : "(empty)"}`,
    `failedApiCalls: ${failedApiCalls.length ? failedApiCalls.map(item => truncateFailureText(item)).join(" | ") : "(empty)"}`,
  ];
  const failedPreconditions = (job.snapshot.result.preconditions || [])
    .filter(item => item.status === "failed")
    .map(item => `${item.label}: ${item.detail}`);
  if (failedPreconditions.length) {
    lines.push(`failedPreconditions: ${failedPreconditions.map(item => truncateFailureText(item)).join(" | ")}`);
  }
  return truncateFailureText(lines.join("\n"), MAX_FAILURE_CONTEXT_LENGTH);
}

function summarizePreconditionFailure(result: TaskResult | null): string {
  const failure = result?.preconditions?.find(item => item.status === "failed");
  if (!failure) return "";
  const detail = failure.detail.trim();
  const jsonStart = detail.indexOf("{");
  if (jsonStart >= 0) {
    try {
      const payload = JSON.parse(detail.slice(jsonStart)) as { errorSummary?: unknown };
      if (typeof payload.errorSummary === "string" && payload.errorSummary.trim()) {
        return `${failure.label}：${payload.errorSummary.trim()}`;
      }
    } catch {
      // 兼容仅包含纯文本的项目级前置检查结果。
    }
  }
  return `${failure.label}：${detail.split("\n", 1)[0] || "未通过"}`;
}

async function readCodexResult(outputPath: string): Promise<CodexResult | null> {
  try {
    const payload = JSON.parse(await fs.readFile(outputPath, "utf8")) as Partial<CodexResult>;
    if (!payload || !["fixed", "blocked", "failed"].includes(String(payload.status))) return null;
    if (typeof payload.summary !== "string" || typeof payload.rootCause !== "string" || !Array.isArray(payload.changedFiles)) return null;
    return {
      status: payload.status as CodexResult["status"],
      summary: payload.summary,
      rootCause: payload.rootCause,
      changedFiles: payload.changedFiles.map(String),
      verificationCommand: String(payload.verificationCommand || ""),
      notes: String(payload.notes || ""),
    };
  } catch {
    return null;
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
