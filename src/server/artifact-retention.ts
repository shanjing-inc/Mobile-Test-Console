import { randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import {
  ACTIVE_TASK_STATUSES,
  ARTIFACT_RUN_ID_PATTERN,
  TERMINAL_TASK_STATUSES,
  type ArtifactCleanupPlan,
  type ArtifactCleanupPlanItem,
  type ArtifactRetentionSnapshot,
  type ArtifactStorageSnapshot,
  type RepairJob,
  type TestTask,
} from "../shared/contracts.js";
import { resolveArtifactCleanupCommand, type LoadedProjectConfig, type ResolvedCommand } from "./config.js";
import type { CommandRunner } from "./command-runner.js";
import { SystemCommandRunner } from "./command-runner.js";
import { ConsoleError } from "./errors.js";
import type { TaskManager } from "./task-manager.js";

const REQUEST_SCHEMA = "mobile-test-console.artifact-cleanup-request.v1";
const RESULT_SCHEMA = "mobile-test-console.artifact-cleanup-result.v1";
const PLAN_SCHEMA = "mobile-test-console.artifact-cleanup-plan.v1";
const RETENTION_SCHEMA = "mobile-test-console.artifact-retention.v1";
const ACTIVE_REPAIR_STATUSES = new Set(["queued", "investigating", "fixing", "verifying", "waiting_device"]);

interface StoredArtifactRetentionState {
  schemaVersion: typeof RETENTION_SCHEMA;
  latestPlan: ArtifactCleanupPlan | null;
  latestCleanup: ArtifactCleanupPlan | null;
}

interface ProjectCleanupResultItem {
  runId: string;
  relativePaths: string[];
  files: number;
  bytes: number;
  status: ArtifactCleanupPlanItem["status"];
  reason: string;
}

interface ProjectCleanupResult {
  schemaVersion: typeof RESULT_SCHEMA;
  ok: boolean;
  items: ProjectCleanupResultItem[];
  files: number;
  bytes: number;
  filesRemoved: number;
  bytesFreed: number;
  errors: string[];
}

export interface RepairRetentionManager {
  list(): RepairJob[];
  cleanupExpiredWorktrees?(maxAgeDays: number): Promise<{ removed: number; bytesFreed: number; errors: string[] }>;
}

export class ArtifactRetentionStore {
  private readonly filePath: string;
  private writeQueue = Promise.resolve();

  constructor(stateDir: string) {
    this.filePath = path.join(stateDir, "artifact-retention.json");
  }

  async load(): Promise<StoredArtifactRetentionState> {
    try {
      const parsed = JSON.parse(await fs.readFile(this.filePath, "utf8")) as Partial<StoredArtifactRetentionState>;
      if (parsed.schemaVersion !== RETENTION_SCHEMA) return emptyStoredState();
      return {
        schemaVersion: RETENTION_SCHEMA,
        latestPlan: parsed.latestPlan ?? null,
        latestCleanup: parsed.latestCleanup ?? null,
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return emptyStoredState();
      throw error;
    }
  }

  async save(state: StoredArtifactRetentionState): Promise<void> {
    const snapshot = structuredClone(state);
    this.writeQueue = this.writeQueue.then(async () => {
      await fs.mkdir(path.dirname(this.filePath), { recursive: true });
      const nextPath = `${this.filePath}.next`;
      await fs.writeFile(nextPath, `${JSON.stringify(snapshot, null, 2)}\n`);
      await fs.rename(nextPath, this.filePath);
    });
    await this.writeQueue;
  }
}

export class ArtifactRetentionService {
  private state: StoredArtifactRetentionState = emptyStoredState();
  private readonly runner: CommandRunner;
  private operationQueue = Promise.resolve();
  private startupTimer: NodeJS.Timeout | null = null;
  private removeCompletionListener: (() => void) | null = null;

  constructor(
    private readonly config: LoadedProjectConfig,
    private readonly tasks: TaskManager,
    private readonly store: ArtifactRetentionStore,
    private readonly repairs?: RepairRetentionManager,
    runner?: CommandRunner,
  ) {
    this.runner = runner ?? new SystemCommandRunner();
  }

  async initialize(): Promise<void> {
    this.state = await this.store.load();
    if (!this.config.artifactRetention?.enabled) return;
    this.removeCompletionListener = this.tasks.addCompletionListener(() => {
      this.schedule();
    });
    this.startupTimer = setTimeout(() => this.schedule(), 1_000);
    this.startupTimer.unref?.();
  }

  async shutdown(): Promise<void> {
    if (this.startupTimer) clearTimeout(this.startupTimer);
    this.startupTimer = null;
    this.removeCompletionListener?.();
    this.removeCompletionListener = null;
    await this.operationQueue;
  }

  async snapshot(): Promise<ArtifactRetentionSnapshot> {
    return {
      schemaVersion: RETENTION_SCHEMA,
      enabled: Boolean(this.config.artifactRetention?.enabled),
      autoCleanup: Boolean(this.config.artifactRetention?.autoCleanup),
      policy: this.policy(),
      storage: await this.inspectStorage(),
      retainedRunIds: unique(this.tasks.list().filter(task => task.retained).map(task => task.runId)).sort(),
      latestPlan: this.state.latestPlan ? structuredClone(this.state.latestPlan) : null,
      latestCleanup: this.state.latestCleanup ? structuredClone(this.state.latestCleanup) : null,
    };
  }

  async preview(): Promise<ArtifactCleanupPlan> {
    return this.runExclusive(async () => {
      const plan = await this.createPlan("plan");
      this.state.latestPlan = structuredClone(plan);
      await this.store.save(this.state);
      return plan;
    });
  }

  async inventory(): Promise<ArtifactCleanupPlan> {
    return this.runExclusive(async () => {
      const storage = await this.inspectStorage();
      const tasks = this.tasks.list();
      const protectedRunIds = this.hardProtectedRunIds(tasks);
      if (!this.config.artifactRetention?.cleanup || !this.artifactsRoot()) {
        return this.emptyPlan("plan", storage, protectedRunIds, ["项目尚未配置测试产物清理适配器"]);
      }
      const result = await this.invokeAdapter("plan", [], protectedRunIds, true);
      return this.toPlan("plan", result, storage, protectedRunIds, tasks, "可手动清理");
    });
  }

  async apply(selectedRunIds?: string[]): Promise<ArtifactCleanupPlan> {
    return this.runExclusive(async () => {
      const preview = selectedRunIds
        ? await this.createSelectionPlan(selectedRunIds)
        : await this.createPlan("plan");
      if (!preview.supported) {
        throw new ConsoleError("ARTIFACT_CLEANUP_UNSUPPORTED", "项目尚未配置测试产物清理适配器", 409);
      }
      const candidateRunIds = preview.items.map(item => item.runId);
      let applied = preview;
      try {
        if (candidateRunIds.length > 0) {
          const projectResult = await this.invokeAdapter("apply", candidateRunIds, preview.protectedRunIds);
          applied = this.toPlan("apply", projectResult, preview.storage, preview.protectedRunIds, this.tasks.list());
          if (projectResult.ok) await this.tasks.forgetRuns(completedRunIds(projectResult));
        } else {
          applied = { ...preview, mode: "apply", generatedAt: new Date().toISOString() };
        }
      } catch (error) {
        applied = failedApplyPlan(preview, error);
        await this.appendRepairCleanup(applied);
        this.state.latestPlan = structuredClone(preview);
        this.state.latestCleanup = structuredClone(applied);
        await this.store.save(this.state);
        throw error;
      }
      await this.appendRepairCleanup(applied);
      this.state.latestPlan = structuredClone(preview);
      this.state.latestCleanup = structuredClone(applied);
      await this.store.save(this.state);
      return applied;
    });
  }

  async setTaskRetained(taskId: string, retained: boolean): Promise<TestTask> {
    return this.tasks.setRetained(taskId, retained);
  }

  async assertCanStart(): Promise<void> {
    const retention = this.config.artifactRetention;
    if (!retention?.enabled) return;
    const storage = await this.inspectStorage(false);
    if (!storage.available || !storage.writable) {
      throw new ConsoleError("ARTIFACT_STORAGE_UNAVAILABLE", storage.issue || "测试产物目录当前不可用", 409);
    }
    if (storage.freeBytes < retention.policy.minimumFreeBytes) {
      throw new ConsoleError(
        "ARTIFACT_STORAGE_LOW_SPACE",
        `测试产物磁盘剩余 ${formatBytes(storage.freeBytes)}，安全水位为 ${formatBytes(retention.policy.minimumFreeBytes)}`,
        409,
      );
    }
  }

  async inspectStorage(includeUsage = true): Promise<ArtifactStorageSnapshot> {
    const artifactRoot = this.artifactsRoot();
    const checkedAt = new Date().toISOString();
    if (!artifactRoot) return unavailableStorage("项目尚未声明 taskResults.artifactsRoot", checkedAt);
    try {
      const probePath = await nearestExistingPath(artifactRoot);
      await fs.access(probePath, fsConstants.W_OK);
      const [stats, usage, mount] = await Promise.all([
        fs.statfs(probePath),
        includeUsage ? this.directoryUsage(artifactRoot) : Promise.resolve(0),
        this.mountInfo(probePath),
      ]);
      const totalBytes = Number(stats.blocks) * Number(stats.bsize);
      const freeBytes = Number(stats.bavail) * Number(stats.bsize);
      return {
        artifactRoot,
        available: true,
        writable: true,
        totalBytes,
        usedBytes: usage,
        freeBytes,
        mountPoint: mount.mountPoint,
        fileSystem: mount.fileSystem,
        checkedAt,
        issue: freeBytes < this.policy().minimumFreeBytes
          ? `磁盘剩余空间低于 ${formatBytes(this.policy().minimumFreeBytes)} 安全水位`
          : "",
      };
    } catch (error) {
      return {
        ...unavailableStorage(error instanceof Error ? error.message : String(error), checkedAt),
        artifactRoot,
      };
    }
  }

  private schedule(): void {
    void this.runExclusive(async () => {
      const plan = await this.createPlan("plan");
      this.state.latestPlan = structuredClone(plan);
      await this.store.save(this.state);
      if (this.config.artifactRetention?.autoCleanup) {
        let attemptedProjectCleanup = false;
        let applied: ArtifactCleanupPlan = { ...plan, mode: "apply", generatedAt: new Date().toISOString() };
        if (plan.items.length > 0) {
          attemptedProjectCleanup = true;
          try {
            const result = await this.invokeAdapter("apply", plan.items.map(item => item.runId), plan.protectedRunIds);
            applied = this.toPlan("apply", result, plan.storage, plan.protectedRunIds, this.tasks.list());
            if (result.ok) await this.tasks.forgetRuns(completedRunIds(result));
          } catch (error) {
            applied = failedApplyPlan(plan, error);
          }
        }
        const repaired = await this.appendRepairCleanup(applied);
        if (!attemptedProjectCleanup && !repaired) return;
        this.state.latestCleanup = structuredClone(applied);
        await this.store.save(this.state);
      }
    }).catch(error => console.error("[artifact-retention] 后台清理检查失败", error));
  }

  private async appendRepairCleanup(plan: ArtifactCleanupPlan): Promise<boolean> {
    if (!this.repairs?.cleanupExpiredWorktrees) return false;
    try {
      const cleanup = await this.repairs.cleanupExpiredWorktrees(this.policy().repairWorktreeMaxAgeDays);
      if (cleanup.errors.length > 0) plan.errors.push(...cleanup.errors);
      if (cleanup.bytesFreed > 0) plan.bytesFreed += cleanup.bytesFreed;
      return cleanup.removed > 0 || cleanup.errors.length > 0;
    } catch (error) {
      plan.errors.push(`修复工作目录清理失败: ${errorMessage(error)}`);
      return true;
    }
  }

  private async createPlan(mode: "plan"): Promise<ArtifactCleanupPlan> {
    const storage = await this.inspectStorage();
    const cleanupCommand = this.config.artifactRetention?.cleanup;
    const tasks = this.tasks.list();
    const protectedRunIds = this.protectedRunIds(tasks);
    const terminalRunIds = unique(tasks
      .filter(task => TERMINAL_TASK_STATUSES.includes(task.status))
      .map(task => task.runId));
    const candidateRunIds = terminalRunIds.filter(runId => !protectedRunIds.includes(runId));
    if (!cleanupCommand || !this.artifactsRoot()) {
      return this.emptyPlan(mode, storage, protectedRunIds, ["项目尚未配置测试产物清理适配器"]);
    }
    if (candidateRunIds.length === 0) {
      const warnings = storage.usedBytes > this.policy().maxBytes
        ? ["当前占用超过空间软上限，受保护运行仍会完整保留"]
        : [];
      return this.emptyPlan(mode, storage, protectedRunIds, warnings, true);
    }
    const result = await this.invokeAdapter("plan", candidateRunIds, protectedRunIds);
    const plan = this.toPlan(mode, result, storage, protectedRunIds, tasks);
    if (storage.usedBytes > this.policy().maxBytes && plan.estimatedBytes < storage.usedBytes - this.policy().maxBytes) {
      plan.warnings.push("清理全部候选后仍可能超过空间软上限，受保护运行继续保留");
    }
    return plan;
  }

  private async createSelectionPlan(selectedRunIds: string[]): Promise<ArtifactCleanupPlan> {
    const runIds = unique(selectedRunIds);
    if (runIds.length === 0) {
      throw new ConsoleError("ARTIFACT_CLEANUP_SELECTION_REQUIRED", "请至少选择一个要清理的运行", 400);
    }
    const invalidRunId = runIds.find(runId => !ARTIFACT_RUN_ID_PATTERN.test(runId));
    if (invalidRunId) {
      throw new ConsoleError("ARTIFACT_CLEANUP_SELECTION_INVALID", `运行记录 ID 无效: ${invalidRunId}`, 400);
    }
    const tasks = this.tasks.list();
    const protectedRunIds = this.hardProtectedRunIds(tasks);
    const protectedSelection = runIds.find(runId => protectedRunIds.includes(runId));
    if (protectedSelection) {
      throw new ConsoleError("ARTIFACT_CLEANUP_RUN_PROTECTED", `运行处于保护范围: ${protectedSelection}`, 409);
    }
    const storage = await this.inspectStorage();
    if (!this.config.artifactRetention?.cleanup || !this.artifactsRoot()) {
      throw new ConsoleError("ARTIFACT_CLEANUP_UNSUPPORTED", "项目尚未配置测试产物清理适配器", 409);
    }
    const result = await this.invokeAdapter("plan", runIds, protectedRunIds);
    return this.toPlan("plan", result, storage, protectedRunIds, tasks, "用户选择清理");
  }

  private protectedRunIds(tasks: TestTask[]): string[] {
    const policy = this.policy();
    const protectedIds = new Set(this.hardProtectedRunIds(tasks));
    const terminal = tasks
      .filter(task => TERMINAL_TASK_STATUSES.includes(task.status))
      .sort((left, right) => taskTimestamp(right) - taskTimestamp(left));
    for (const task of terminal.slice(0, policy.maxRuns)) protectedIds.add(task.runId);
    const recentCutoff = Date.now() - policy.maxAgeDays * 24 * 60 * 60 * 1_000;
    for (const task of terminal) if (taskTimestamp(task) >= recentCutoff) protectedIds.add(task.runId);
    for (const platform of new Set(terminal.map(task => task.target?.platform ?? task.device.platform))) {
      const platformTasks = terminal.filter(task => (task.target?.platform ?? task.device.platform) === platform);
      for (const task of platformTasks.filter(task => task.status === "passed").slice(0, policy.keepSuccessfulPerPlatform)) {
        protectedIds.add(task.runId);
      }
      for (const task of platformTasks.filter(task => task.status !== "passed").slice(0, policy.keepFailedPerPlatform)) {
        protectedIds.add(task.runId);
      }
    }
    return [...protectedIds].sort();
  }

  private hardProtectedRunIds(tasks: TestTask[]): string[] {
    const protectedIds = new Set(tasks
      .filter(task => ACTIVE_TASK_STATUSES.includes(task.status) || task.retained)
      .map(task => task.runId));
    for (const job of this.repairs?.list() ?? []) {
      if (ACTIVE_REPAIR_STATUSES.has(job.status)) protectedIds.add(job.runId);
    }
    return [...protectedIds].sort();
  }

  private async invokeAdapter(
    mode: "plan" | "apply",
    candidateRunIds: string[],
    protectedRunIds: string[],
    discoverCandidates = false,
  ): Promise<ProjectCleanupResult> {
    const requestDir = path.join(this.config.stateDir, "artifact-cleanup", "requests");
    await fs.mkdir(requestDir, { recursive: true });
    const requestPath = path.join(requestDir, `${Date.now()}-${randomUUID()}.json`);
    const artifactsRoot = this.artifactsRoot();
    await fs.writeFile(requestPath, `${JSON.stringify({
      schemaVersion: REQUEST_SCHEMA,
      mode,
      projectId: this.config.project.id,
      artifactsRoot,
      candidateRunIds,
      protectedRunIds,
      discoverCandidates,
      policy: this.policy(),
    }, null, 2)}\n`, { mode: 0o600 });
    try {
      const command = resolveArtifactCleanupCommand(this.config, requestPath);
      if (!command) throw new ConsoleError("ARTIFACT_CLEANUP_UNSUPPORTED", "项目尚未配置测试产物清理适配器", 409);
      const output = await this.capture(command);
      if (output.code !== 0) {
        throw new ConsoleError("ARTIFACT_CLEANUP_FAILED", output.stderr.trim() || `产物清理适配器退出码 ${output.code}`, 500);
      }
      return parseProjectCleanupResult(output.stdout, candidateRunIds, discoverCandidates);
    } finally {
      await fs.rm(requestPath, { force: true });
    }
  }

  private capture(command: ResolvedCommand) {
    return this.runner.capture(command.executable, command.args, 10 * 60_000, {
      cwd: command.cwd,
      env: command.env,
    });
  }

  private toPlan(
    mode: "plan" | "apply",
    result: ProjectCleanupResult,
    storage: ArtifactStorageSnapshot,
    protectedRunIds: string[],
    tasks: TestTask[],
    candidateReason = "超过保留周期和最近运行数量",
  ): ArtifactCleanupPlan {
    const taskIdsByRun = new Map<string, string[]>();
    for (const task of tasks) taskIdsByRun.set(task.runId, [...(taskIdsByRun.get(task.runId) ?? []), task.id]);
    return {
      schemaVersion: PLAN_SCHEMA,
      projectId: this.config.project.id,
      mode,
      generatedAt: new Date().toISOString(),
      supported: true,
      protectedRunIds,
      items: result.items.map(item => {
        const protectedRun = protectedRunIds.includes(item.runId);
        return {
          ...item,
          taskIds: taskIdsByRun.get(item.runId) ?? [],
          status: protectedRun ? "skipped" : item.status,
          reason: protectedRun || item.status === "skipped" ? "protected" : candidateReason,
        };
      }),
      estimatedBytes: result.bytes,
      estimatedFiles: result.files,
      bytesFreed: result.bytesFreed,
      filesRemoved: result.filesRemoved,
      storage,
      warnings: [],
      errors: unique([
        ...(!result.ok ? ["项目清理适配器报告执行失败，任务索引已保留"] : []),
        ...result.errors,
      ]),
    };
  }

  private emptyPlan(
    mode: "plan" | "apply",
    storage: ArtifactStorageSnapshot,
    protectedRunIds: string[],
    warnings: string[],
    supported = false,
  ): ArtifactCleanupPlan {
    return {
      schemaVersion: PLAN_SCHEMA,
      projectId: this.config.project.id,
      mode,
      generatedAt: new Date().toISOString(),
      supported,
      protectedRunIds,
      items: [],
      estimatedBytes: 0,
      estimatedFiles: 0,
      bytesFreed: 0,
      filesRemoved: 0,
      storage,
      warnings,
      errors: [],
    };
  }

  private policy() {
    return this.config.artifactRetention?.policy ?? {
      maxAgeDays: 7,
      maxRuns: 20,
      maxBytes: 10 * 1024 * 1024 * 1024,
      minimumFreeBytes: 5 * 1024 * 1024 * 1024,
      keepSuccessfulPerPlatform: 1,
      keepFailedPerPlatform: 3,
      repairWorktreeMaxAgeDays: 7,
    };
  }

  private artifactsRoot(): string {
    return this.config.artifactRetention?.artifactsRoot ?? this.config.taskResults?.artifactsRoot ?? "";
  }

  private async directoryUsage(directory: string): Promise<number> {
    try {
      const stat = await fs.stat(directory);
      if (!stat.isDirectory()) return 0;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0;
      throw error;
    }
    const result = await this.runner.capture("du", ["-sk", directory], 120_000);
    if (result.code !== 0) return 0;
    const kibibytes = Number.parseInt(result.stdout.trim().split(/\s+/)[0] ?? "0", 10);
    return Number.isFinite(kibibytes) ? kibibytes * 1024 : 0;
  }

  private async mountInfo(directory: string): Promise<{ mountPoint: string; fileSystem: string }> {
    const result = await this.runner.capture("df", ["-Pk", directory], 15_000);
    if (result.code !== 0) return { mountPoint: "", fileSystem: "" };
    const line = result.stdout.trim().split(/\r?\n/).at(-1) ?? "";
    const fields = line.trim().split(/\s+/);
    return fields.length >= 6
      ? { fileSystem: fields[0], mountPoint: fields.slice(5).join(" ") }
      : { mountPoint: "", fileSystem: "" };
  }

  private runExclusive<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.operationQueue.then(operation, operation);
    this.operationQueue = next.then(() => undefined, () => undefined);
    return next;
  }
}

function parseProjectCleanupResult(
  stdout: string,
  candidateRunIds: string[],
  discoverCandidates = false,
): ProjectCleanupResult {
  const lines = stdout.trim().split(/\r?\n/).filter(Boolean).reverse();
  let value: unknown;
  for (const line of lines) {
    try {
      value = JSON.parse(line);
      break;
    } catch {
      // 项目脚本可以在结构化结果前输出有限的诊断日志。
    }
  }
  if (!isRecord(value) || value.schemaVersion !== RESULT_SCHEMA || !Array.isArray(value.items)) {
    throw new ConsoleError("ARTIFACT_CLEANUP_RESULT_INVALID", "产物清理适配器未返回 v1 结构化结果", 500);
  }
  const candidates = new Set(candidateRunIds);
  const seenRunIds = new Set<string>();
  const items = value.items.map((item, index) => {
    if (!isRecord(item) || typeof item.runId !== "string" || !Array.isArray(item.relativePaths)) {
      throw new ConsoleError("ARTIFACT_CLEANUP_RESULT_INVALID", `产物清理结果 items[${index}] 无效`, 500);
    }
    if (!ARTIFACT_RUN_ID_PATTERN.test(item.runId)) {
      throw new ConsoleError("ARTIFACT_CLEANUP_RESULT_INVALID", `产物清理结果包含无效运行记录: ${item.runId}`, 500);
    }
    if (!discoverCandidates && !candidates.has(item.runId)) {
      throw new ConsoleError("ARTIFACT_CLEANUP_RESULT_INVALID", `产物清理结果包含请求外的运行记录: ${item.runId}`, 500);
    }
    if (seenRunIds.has(item.runId)) {
      throw new ConsoleError("ARTIFACT_CLEANUP_RESULT_INVALID", `产物清理结果包含重复运行记录: ${item.runId}`, 500);
    }
    seenRunIds.add(item.runId);
    const status = String(item.status);
    if (!["planned", "deleted", "missing", "skipped", "partial", "failed"].includes(status)) {
      throw new ConsoleError("ARTIFACT_CLEANUP_RESULT_INVALID", `产物清理结果 items[${index}].status 无效`, 500);
    }
    return {
      runId: item.runId,
      relativePaths: item.relativePaths.filter((entry): entry is string => typeof entry === "string"),
      files: finiteNonnegative(item.files),
      bytes: finiteNonnegative(item.bytes),
      status: status as ProjectCleanupResultItem["status"],
      reason: typeof item.reason === "string" ? item.reason : "",
    };
  });
  if (!discoverCandidates && seenRunIds.size !== candidates.size) {
    const missingRunId = candidateRunIds.find(runId => !seenRunIds.has(runId));
    throw new ConsoleError("ARTIFACT_CLEANUP_RESULT_INVALID", `产物清理结果缺少运行记录: ${missingRunId}`, 500);
  }
  return {
    schemaVersion: RESULT_SCHEMA,
    ok: value.ok !== false,
    items,
    files: finiteNonnegative(value.files),
    bytes: finiteNonnegative(value.bytes),
    filesRemoved: finiteNonnegative(value.filesRemoved ?? value.deletedFiles),
    bytesFreed: finiteNonnegative(value.bytesFreed),
    errors: Array.isArray(value.errors) ? value.errors.filter((entry): entry is string => typeof entry === "string") : [],
  };
}

function completedRunIds(result: ProjectCleanupResult): string[] {
  return result.items
    .filter(item => item.status === "deleted" || item.status === "missing")
    .map(item => item.runId);
}

function failedApplyPlan(preview: ArtifactCleanupPlan, error: unknown): ArtifactCleanupPlan {
  return {
    ...preview,
    mode: "apply",
    generatedAt: new Date().toISOString(),
    items: preview.items.map(item => ({ ...item, status: "failed", reason: "adapter-error" })),
    bytesFreed: 0,
    filesRemoved: 0,
    errors: unique([...preview.errors, errorMessage(error)]),
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function finiteNonnegative(value: unknown): number {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function taskTimestamp(task: TestTask): number {
  return Date.parse(task.finishedAt || task.startedAt || task.createdAt) || 0;
}

async function nearestExistingPath(target: string): Promise<string> {
  let current = path.resolve(target);
  while (true) {
    try {
      await fs.stat(current);
      return current;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const parent = path.dirname(current);
      if (parent === current) throw error;
      current = parent;
    }
  }
}

function unavailableStorage(issue: string, checkedAt: string): ArtifactStorageSnapshot {
  return {
    artifactRoot: "",
    available: false,
    writable: false,
    totalBytes: 0,
    usedBytes: 0,
    freeBytes: 0,
    mountPoint: "",
    fileSystem: "",
    checkedAt,
    issue,
  };
}

function emptyStoredState(): StoredArtifactRetentionState {
  return { schemaVersion: RETENTION_SCHEMA, latestPlan: null, latestCleanup: null };
}

function formatBytes(bytes: number): string {
  const gibibytes = bytes / (1024 * 1024 * 1024);
  return `${gibibytes.toFixed(gibibytes >= 10 ? 0 : 1)} GiB`;
}
