import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import {
  ACTIVE_TASK_STATUSES,
  type TaskResult,
  type TaskResultApiCall,
  type TaskResultArtifact,
  type TaskResultRun,
  type TestTask,
} from "../shared/contracts.js";
import { resolveTaskArtifactsRoot, resolveTaskResultCommand, type LoadedProjectConfig, type ResolvedCommand } from "./config.js";
import { ConsoleError } from "./errors.js";
import type { TaskManager } from "./task-manager.js";

const MAX_PROVIDER_OUTPUT_BYTES = 16 * 1024 * 1024;
const MAX_PROVIDER_ERROR_LENGTH = 4_000;
const ACTIVE_STATUSES = new Set(ACTIVE_TASK_STATUSES);
const IMAGE_MIME_TYPES: Record<string, string> = {
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
};

const artifactReferenceSchema = z.object({
  path: z.string().min(1),
  label: z.string().optional(),
});

const apiCallSchema = z.object({
  index: z.number().int().nonnegative().default(0),
  ts: z.string().default(""),
  eventType: z.string().default(""),
  page: z.string().default(""),
  apiType: z.string().default(""),
  method: z.string().default(""),
  url: z.string().default(""),
  host: z.string().default(""),
  path: z.string().default(""),
  endpoint: z.string().default(""),
  operationName: z.string().default(""),
  status: z.union([z.string(), z.number()]).default(""),
  result: z.string().default(""),
  durationMs: z.number().nonnegative().nullable().default(null),
  request: z.unknown().default({}),
  response: z.unknown().default({}),
  network: z.object({
    dnsType: z.string().default(""),
    dnsIps: z.string().default(""),
    connectIp: z.string().default(""),
    protocol: z.string().default(""),
  }).default({}),
});

const providerRunSchema = z.object({
  runId: z.string().min(1),
  caseRunId: z.string().default(""),
  caseRunCount: z.number().int().positive().default(1),
  caseId: z.string().default(""),
  executionKind: z.string().default("scenario"),
  targetPage: z.string().default(""),
  launchPage: z.string().default(""),
  routeParams: z.record(z.unknown()).optional(),
  parameterProfileId: z.string().optional(),
  expectedFinalPage: z.string().default(""),
  actualFinalPage: z.string().default(""),
  pageSequence: z.array(z.object({
    page: z.string(), bundleName: z.string().optional(), events: z.array(z.string()).default([]),
    startedAt: z.string().optional(), finishedAt: z.string().optional(),
  })).default([]),
  assertions: z.array(z.record(z.unknown())).default([]),
  passBasis: z.array(z.object({ kind: z.string(), passed: z.boolean(), description: z.string() })).default([]),
  scenario: z.string().default(""),
  fixture: z.string().default(""),
  platform: z.string().default(""),
  device: z.string().default(""),
  status: z.string().default("unknown"),
  errorSummary: z.string().default(""),
  requiredEvents: z.array(z.string()).default([]),
  missingEvents: z.array(z.string()).default([]),
  runtimeEventCount: z.number().int().nonnegative().default(0),
  uiActionCount: z.number().int().nonnegative().default(0),
  apiCalls: z.array(apiCallSchema).default([]),
  screenshots: z.array(artifactReferenceSchema).default([]),
  evidenceFiles: z.array(z.string()).default([]),
  failureLogExcerpt: z.string().default(""),
});

const providerPreconditionSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  status: z.enum(["passed", "failed"]),
  action: z.enum(["reused-session", "account-profile-replay", "failed"]),
  profileId: z.string().optional(),
  provider: z.string().optional(),
  detail: z.string(),
  checkedAt: z.string().min(1),
});

const providerResultSchema = z.object({
  schemaVersion: z.literal("mobile-test-console.task-result.v1"),
  generatedAt: z.string().min(1),
  runId: z.string().min(1),
  total: z.number().int().nonnegative(),
  caseRunCount: z.number().int().nonnegative().default(0),
  passed: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(),
  warnings: z.array(z.string()).default([]),
  preconditions: z.array(providerPreconditionSchema).default([]),
  runs: z.array(providerRunSchema),
});

type ProviderResult = z.infer<typeof providerResultSchema>;

export interface ResolvedTaskArtifact extends TaskResultArtifact {
  absolutePath: string;
}

interface CachedTaskResult {
  fingerprint: string;
  result: TaskResult;
  artifacts: Map<string, ResolvedTaskArtifact>;
}

export class TaskResultService {
  private readonly cache = new Map<string, CachedTaskResult>();

  constructor(
    private readonly config: LoadedProjectConfig,
    private readonly tasks: TaskManager,
  ) {}

  async load(taskId: string, options: { refresh?: boolean } = {}): Promise<TaskResult> {
    const task = this.requireTerminalTask(taskId);
    const command = resolveTaskResultCommand(this.config, task);
    if (!command || !this.config.taskResults) {
      throw new ConsoleError("TASK_RESULT_UNAVAILABLE", "当前项目未配置测试结果分析", 404);
    }

    const fingerprint = `${task.runId}:${task.finishedAt}:${task.status}`;
    const cached = this.cache.get(task.id);
    if (!options.refresh && cached?.fingerprint === fingerprint) return structuredClone(cached.result);

    const parsed = providerResultSchema.safeParse(await runProvider(command));
    if (!parsed.success) {
      throw new ConsoleError(
        "TASK_RESULT_INVALID",
        `测试结果协议无效: ${parsed.error.issues.map(issue => `${issue.path.join(".")}: ${issue.message}`).join("; ")}`,
        500,
      );
    }
    const provider = parsed.data;
    if (provider.runId !== task.runId) {
      throw new ConsoleError("TASK_RESULT_INVALID", `结果 runId 与任务不匹配: ${provider.runId}`, 500);
    }

    const hydrated = await this.hydrate(task, provider);
    this.cache.set(task.id, { fingerprint, ...hydrated });
    return structuredClone(hydrated.result);
  }

  async artifact(taskId: string, artifactId: string): Promise<ResolvedTaskArtifact> {
    await this.load(taskId);
    const artifact = this.cache.get(taskId)?.artifacts.get(artifactId);
    if (!artifact) throw new ConsoleError("TASK_ARTIFACT_UNKNOWN", "测试附件不存在", 404);
    return { ...artifact };
  }

  invalidate(taskId: string): void {
    this.cache.delete(taskId);
  }

  private requireTerminalTask(taskId: string): TestTask {
    const task = this.tasks.get(taskId);
    if (!task) throw new ConsoleError("TASK_UNKNOWN", `任务不存在: ${taskId}`, 404);
    if (ACTIVE_STATUSES.has(task.status)) {
      throw new ConsoleError("TASK_RESULT_ACTIVE", "测试完成后才能读取分析结果", 409);
    }
    return task;
  }

  private async hydrate(task: TestTask, provider: ProviderResult): Promise<{
    result: TaskResult;
    artifacts: Map<string, ResolvedTaskArtifact>;
  }> {
    const warnings = [...provider.warnings];
    const artifacts = new Map<string, ResolvedTaskArtifact>();
    const runs: TaskResultRun[] = [];

    for (const providerRun of provider.runs) {
      if (providerRun.runId !== task.runId && !providerRun.runId.startsWith(`${task.runId}-`)) {
        warnings.push(`忽略不属于当前任务的结果: ${providerRun.runId}`);
        continue;
      }
      const screenshots: TaskResultArtifact[] = [];
      for (const reference of providerRun.screenshots) {
        const artifact = await resolveImageArtifact(this.config, task, reference, warnings);
        if (!artifact) continue;
        artifacts.set(artifact.id, artifact);
        screenshots.push(publicArtifact(artifact));
      }
      runs.push({
        ...providerRun,
        apiCalls: providerRun.apiCalls as TaskResultApiCall[],
        screenshots,
      });
    }

    return {
      result: {
        schemaVersion: provider.schemaVersion,
        generatedAt: provider.generatedAt,
        taskId: task.id,
        runId: task.runId,
        total: runs.length,
        caseRunCount: runs.length,
        passed: runs.filter(run => run.status === "passed").length,
        failed: runs.filter(run => run.status !== "passed").length,
        warnings,
        preconditions: provider.preconditions,
        runs,
      },
      artifacts,
    };
  }
}

async function runProvider(command: ResolvedCommand): Promise<unknown> {
  const output = await new Promise<{ stdout: string; stderr: string; code: number }>(resolve => {
    execFile(command.executable, command.args, {
      cwd: command.cwd,
      env: { ...process.env, ...command.env },
      encoding: "utf8",
      maxBuffer: MAX_PROVIDER_OUTPUT_BYTES,
      timeout: 30_000,
    }, (error, stdout, stderr) => {
      const code = typeof (error as NodeJS.ErrnoException & { code?: number })?.code === "number"
        ? Number((error as NodeJS.ErrnoException & { code?: number }).code)
        : error ? 1 : 0;
      resolve({ stdout: String(stdout || ""), stderr: String(stderr || error?.message || ""), code });
    });
  });
  if (output.code !== 0) {
    const reason = output.stderr.trim().slice(-MAX_PROVIDER_ERROR_LENGTH) || `退出码 ${output.code}`;
    throw new ConsoleError("TASK_RESULT_PROVIDER_FAILED", `读取测试结果失败: ${reason}`, 500);
  }
  try {
    return JSON.parse(output.stdout);
  } catch {
    throw new ConsoleError("TASK_RESULT_INVALID", "测试结果提供器返回了无效 JSON", 500);
  }
}

async function resolveImageArtifact(
  config: LoadedProjectConfig,
  task: TestTask,
  reference: z.infer<typeof artifactReferenceSchema>,
  warnings: string[],
): Promise<ResolvedTaskArtifact | null> {
  const root = resolveTaskArtifactsRoot(config, task);
  const workspaceRoot = task.workspaceRoot || config.project.root;
  const candidate = path.isAbsolute(reference.path)
    ? path.resolve(reference.path)
    : path.resolve(workspaceRoot, reference.path);
  try {
    const [realRoot, realCandidate] = await Promise.all([fs.realpath(root), fs.realpath(candidate)]);
    const relativePath = path.relative(realRoot, realCandidate);
    if (!relativePath || relativePath.startsWith(`..${path.sep}`) || path.isAbsolute(relativePath)) {
      warnings.push(`忽略产物目录外的截图: ${reference.path}`);
      return null;
    }
    const mimeType = IMAGE_MIME_TYPES[path.extname(realCandidate).toLowerCase()];
    if (!mimeType) {
      warnings.push(`忽略不支持的截图格式: ${reference.path}`);
      return null;
    }
    const stat = await fs.stat(realCandidate);
    if (!stat.isFile()) return null;
    return {
      id: createHash("sha256").update(relativePath).digest("hex").slice(0, 24),
      label: reference.label || path.basename(realCandidate),
      mimeType,
      sizeBytes: stat.size,
      absolutePath: realCandidate,
    };
  } catch {
    warnings.push(`截图不存在或无法读取: ${reference.path}`);
    return null;
  }
}

function publicArtifact(artifact: ResolvedTaskArtifact): TaskResultArtifact {
  return {
    id: artifact.id,
    label: artifact.label,
    mimeType: artifact.mimeType,
    sizeBytes: artifact.sizeBytes,
  };
}
