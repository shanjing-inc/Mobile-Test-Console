import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import {
  ACTIVE_TASK_STATUSES,
  type TaskResult,
  type TaskResultApiCall,
  type TaskResultArtifact,
  type TaskResultRun,
  type TestTask,
} from "../shared/contracts.js";
import type { ResultBundle, ResultBundleArtifact } from "../shared/result-bundle.js";
import { resolveTaskArtifactsRoot, resolveTaskResultCommand, type LoadedProjectConfig, type ResolvedCommand } from "./config.js";
import { ConsoleError } from "./errors.js";
import type { ResultBundleStore } from "./result-bundle-store.js";
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

const bundleCaseCompatibilityMetadataSchema = z.object({
  runId: z.string().default(""),
  caseRunCount: z.number().int().positive().default(1),
  executionKind: z.string().default("scenario"),
  launchPage: z.string().default(""),
  routeParams: z.record(z.unknown()).optional(),
  parameterProfileId: z.string().optional(),
  expectedFinalPage: z.string().default(""),
  actualFinalPage: z.string().default(""),
  assertions: z.array(z.record(z.unknown())).default([]),
  fixture: z.string().default(""),
  platform: z.string().default(""),
  device: z.string().default(""),
  requiredEvents: z.array(z.string()).default([]),
  missingEvents: z.array(z.string()).default([]),
  runtimeEventCount: z.number().int().nonnegative().default(0),
  uiActionCount: z.number().int().nonnegative().default(0),
  evidenceFiles: z.array(z.string()).default([]),
}).passthrough();

const bundleStepCompatibilityMetadataSchema = z.object({
  bundleName: z.string().optional(),
  events: z.array(z.string()).default([]),
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
    private readonly resultBundles?: ResultBundleStore,
  ) {}

  async load(taskId: string, options: { refresh?: boolean } = {}): Promise<TaskResult> {
    const task = this.requireTerminalTask(taskId);
    const retryTasks = task.retryOf ? [] : terminalRetryTasks(this.tasks.listRetryDescendants(task.id), task.id);
    if (retryTasks.length === 0) return this.loadSingle(task, options);

    const sourceFingerprint = taskResultFingerprint(task);
    const mergedFingerprint = `${sourceFingerprint}:retries:${retryTasks.map(retry => `${retry.runId}:${retry.finishedAt}:${retry.status}:${retry.resultUri ?? ""}`).join("|")}`;
    const cached = this.cache.get(task.id);
    if (!options.refresh && cached?.fingerprint === mergedFingerprint) return structuredClone(cached.result);
    if (cached?.fingerprint.includes(":retries:")) this.cache.delete(task.id);

    let merged = await this.loadSingle(task, options);
    const sourceCache = this.cache.get(task.id);
    const artifacts = new Map(sourceCache?.artifacts.entries() ?? []);
    for (const retryTask of retryTasks) {
      try {
        const retry = await this.loadSingle(retryTask, options);
        merged = mergeRetryTaskResult(task, merged, retry, retryTask.retryOf!);
        for (const [artifactId, artifact] of this.cache.get(retryTask.id)?.artifacts.entries() ?? []) {
          artifacts.set(artifactId, artifact);
        }
      } catch {
        merged = {
          ...merged,
          warnings: [...merged.warnings, `第 ${retryTask.retryOf!.attempt} 次重试结果不可用，保留原结果`],
        };
      }
    }
    if (sourceCache) this.cache.set(task.id, { fingerprint: mergedFingerprint, result: merged, artifacts });
    return structuredClone(merged);
  }

  private async loadSingle(task: TestTask, options: { refresh?: boolean } = {}): Promise<TaskResult> {
    const fingerprint = taskResultFingerprint(task);
    const cached = this.cache.get(task.id);
    if (!options.refresh && cached?.fingerprint === fingerprint) return structuredClone(cached.result);

    if (task.resultUri && this.resultBundles) {
      const bundle = await this.loadResultBundle(task);
      const hydrated = await this.hydrateBundle(task, bundle);
      this.cache.set(task.id, { fingerprint, ...hydrated });
      return structuredClone(hydrated.result);
    }

    const command = resolveTaskResultCommand(this.config, task);
    if (!command || !this.config.taskResults) {
      throw new ConsoleError("TASK_RESULT_UNAVAILABLE", "当前项目未配置测试结果分析", 404);
    }

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

  private async loadResultBundle(task: TestTask): Promise<ResultBundle> {
    let bundle: ResultBundle | null;
    try {
      bundle = await this.resultBundles!.getByUri(task.resultUri!);
    } catch (error) {
      throw new ConsoleError(
        "TASK_RESULT_INVALID",
        `任务 Result Bundle URI 无效: ${error instanceof Error ? error.message : String(error)}`,
        500,
      );
    }
    if (!bundle) {
      throw new ConsoleError("TASK_RESULT_INVALID", `任务 Result Bundle 不存在: ${task.resultUri}`, 500);
    }
    if (bundle.run.runId !== task.runId) {
      throw new ConsoleError("TASK_RESULT_INVALID", `Result Bundle runId 与任务不匹配: ${bundle.run.runId}`, 500);
    }
    if (bundle.project.id !== task.projectId) {
      throw new ConsoleError("TASK_RESULT_INVALID", `Result Bundle projectId 与任务不匹配: ${bundle.project.id}`, 500);
    }
    return bundle;
  }

  private async hydrateBundle(task: TestTask, bundle: ResultBundle): Promise<{
    result: TaskResult;
    artifacts: Map<string, ResolvedTaskArtifact>;
  }> {
    const warnings = [...bundle.warnings];
    const artifacts = new Map<string, ResolvedTaskArtifact>();
    const bundleArtifacts = new Map(bundle.artifacts.map(artifact => [artifact.id, artifact]));
    const bundleArtifactsRoot = this.config.taskResults
      ? resolveTaskArtifactsRoot(this.config, task)
      : task.workspaceRoot || this.config.project.root;
    const runs: TaskResultRun[] = [];

    for (const bundleCase of bundle.cases) {
      const parsedMetadata = bundleCaseCompatibilityMetadataSchema.safeParse(bundleCase.metadata ?? {});
      if (!parsedMetadata.success) {
        warnings.push(`Result Bundle 用例兼容字段无效，已使用默认值: ${bundleCase.caseRunId}`);
      }
      const metadata = parsedMetadata.success
        ? parsedMetadata.data
        : bundleCaseCompatibilityMetadataSchema.parse({});
      const screenshots: TaskResultArtifact[] = [];
      for (const artifactId of bundleCase.evidenceRefs) {
        const bundleArtifact = bundleArtifacts.get(artifactId);
        if (!bundleArtifact || bundleArtifact.role !== "screenshot") continue;
        const reference = bundleArtifactReference(this.config, task, bundleArtifact, warnings);
        if (!reference) continue;
        const artifact = await resolveImageArtifact(
          this.config,
          task,
          reference,
          warnings,
          bundleArtifactsRoot,
        );
        if (!artifact) continue;
        artifacts.set(artifact.id, artifact);
        screenshots.push(publicArtifact(artifact));
      }
      const apiCalls = bundleCase.apiCalls.flatMap((apiCall, index) => {
        const parsed = apiCallSchema.safeParse(apiCall);
        if (parsed.success) return [parsed.data];
        warnings.push(`Result Bundle 接口记录无效，已忽略: ${bundleCase.caseRunId}#${index}`);
        return [];
      });
      runs.push({
        runId: metadata.runId || bundleCase.caseRunId,
        caseRunId: bundleCase.caseRunId,
        caseRunCount: metadata.caseRunCount,
        caseId: bundleCase.caseId,
        executionKind: metadata.executionKind,
        targetPage: bundleCase.targetPage,
        launchPage: metadata.launchPage,
        ...(metadata.routeParams ? { routeParams: metadata.routeParams } : {}),
        ...(metadata.parameterProfileId ? { parameterProfileId: metadata.parameterProfileId } : {}),
        expectedFinalPage: metadata.expectedFinalPage,
        actualFinalPage: metadata.actualFinalPage,
        pageSequence: bundleCase.steps.map(step => {
          const parsedStepMetadata = bundleStepCompatibilityMetadataSchema.safeParse(step.metadata ?? {});
          if (!parsedStepMetadata.success) {
            warnings.push(`Result Bundle 步骤兼容字段无效，已使用默认值: ${step.stepId}`);
          }
          const stepMetadata = parsedStepMetadata.success
            ? parsedStepMetadata.data
            : bundleStepCompatibilityMetadataSchema.parse({});
          return {
            page: step.name,
            ...(stepMetadata.bundleName ? { bundleName: stepMetadata.bundleName } : {}),
            events: stepMetadata.events,
            ...(step.startedAt ? { startedAt: step.startedAt } : {}),
            ...(step.finishedAt ? { finishedAt: step.finishedAt } : {}),
          };
        }),
        assertions: metadata.assertions,
        passBasis: bundleCase.assertions.map(assertion => ({
          kind: assertion.kind,
          passed: assertion.passed,
          description: assertion.description,
        })),
        scenario: bundleCase.scenario,
        fixture: metadata.fixture,
        platform: metadata.platform || bundle.target.platform,
        device: metadata.device,
        status: bundleCase.status,
        errorSummary: bundleCase.errorSummary,
        requiredEvents: metadata.requiredEvents,
        missingEvents: metadata.missingEvents,
        runtimeEventCount: metadata.runtimeEventCount,
        uiActionCount: metadata.uiActionCount,
        apiCalls: apiCalls as TaskResultApiCall[],
        screenshots,
        evidenceFiles: metadata.evidenceFiles,
        failureLogExcerpt: bundleCase.logs.join("\n"),
      });
    }

    const preconditions = providerPreconditionSchema.array().safeParse(bundle.metadata.legacyPreconditions);
    if (!preconditions.success && bundle.metadata.legacyPreconditions !== undefined) {
      warnings.push("Result Bundle 的旧任务前置条件无效，已忽略");
    }
    return {
      result: {
        schemaVersion: "mobile-test-console.task-result.v1",
        generatedAt: bundle.provenance.generatedAt || bundle.run.finishedAt || bundle.run.startedAt,
        taskId: task.id,
        runId: task.runId,
        total: runs.length,
        caseRunCount: runs.length,
        passed: runs.filter(run => run.status === "passed").length,
        failed: runs.filter(run => run.status !== "passed").length,
        warnings,
        preconditions: preconditions.success ? preconditions.data : [],
        runs,
      },
      artifacts,
    };
  }
}

export function mergeRetryTaskResult(
  sourceTask: TestTask,
  source: TaskResult,
  retry: TaskResult,
  retryOf: NonNullable<TestTask["retryOf"]>,
): TaskResult {
  const passedRetryRuns = retry.runs.filter(run => run.status === "passed");
  const replacements = matchPassedRetryRuns(source.runs, passedRetryRuns, retryOf);
  if (replacements.size === 0) {
    return {
      ...source,
      warnings: [...source.warnings, ...retry.warnings, `第 ${retryOf.attempt} 次重试未通过，保留原结果`],
    };
  }
  const runs = source.runs.map(run => replacements.get(run.caseRunId) ?? run);
  return {
    ...source,
    generatedAt: retry.generatedAt,
    taskId: sourceTask.id,
    runId: sourceTask.runId,
    total: runs.length,
    caseRunCount: runs.length,
    passed: runs.filter(run => run.status === "passed").length,
    failed: runs.filter(run => run.status !== "passed").length,
    warnings: [...source.warnings, ...retry.warnings, `已合并第 ${retryOf.attempt} 次重试中通过的 ${replacements.size} 个结果`],
    preconditions: source.preconditions,
    runs,
  };
}

function matchPassedRetryRuns(
  sourceRuns: TaskResultRun[],
  passedRetryRuns: TaskResultRun[],
  retryOf: NonNullable<TestTask["retryOf"]>,
): Map<string, TaskResultRun> {
  const selectedIds = new Set(retryOf.caseRunIds ?? sourceRuns.map(run => run.caseRunId));
  const directlySelected = sourceRuns.filter(run => selectedIds.has(run.caseRunId));
  const candidates = directlySelected.length > 0
    ? directlySelected
    : retryScopeCandidates(sourceRuns, retryOf);
  const replacements = new Map<string, TaskResultRun>();
  const usedSourceIds = new Set<string>();
  for (const retryRun of passedRetryRuns) {
    const available = candidates.filter(run => !usedSourceIds.has(run.caseRunId));
    const sourceRun = available.find(run => run.caseRunId === retryRun.caseRunId)
      ?? uniqueMatchingRun(available, run => matchesInvocation(run, retryRun))
      ?? uniqueMatchingRun(available, run => Boolean(run.caseId) && run.caseId === retryRun.caseId
        && Boolean(run.targetPage) && run.targetPage === retryRun.targetPage)
      ?? uniqueMatchingRun(available, run => Boolean(run.caseId) && run.caseId === retryRun.caseId)
      ?? uniqueMatchingRun(available, run => Boolean(run.targetPage) && run.targetPage === retryRun.targetPage);
    if (!sourceRun) continue;
    usedSourceIds.add(sourceRun.caseRunId);
    replacements.set(sourceRun.caseRunId, { ...retryRun, caseRunId: sourceRun.caseRunId });
  }
  return replacements;
}

function retryScopeCandidates(
  sourceRuns: TaskResultRun[],
  retryOf: NonNullable<TestTask["retryOf"]>,
): TaskResultRun[] {
  if (retryOf.scope === "task") return sourceRuns;
  const caseIds = new Set(retryOf.caseIds ?? []);
  const targetPages = new Set(retryOf.targetPages ?? []);
  if (caseIds.size === 0 && targetPages.size === 0) return sourceRuns;
  return sourceRuns.filter(run => (
    (caseIds.size === 0 || caseIds.has(run.caseId))
    && (targetPages.size === 0 || targetPages.has(run.targetPage))
  ));
}

function matchesInvocation(source: TaskResultRun, retry: TaskResultRun): boolean {
  if (!source.caseId || source.caseId !== retry.caseId
    || !source.targetPage || source.targetPage !== retry.targetPage) return false;
  const hasProfile = Boolean(retry.parameterProfileId);
  const hasRouteParams = retry.routeParams !== undefined;
  if (!hasProfile && !hasRouteParams) return false;
  return (!hasProfile || source.parameterProfileId === retry.parameterProfileId)
    && (!hasRouteParams || isDeepStrictEqual(source.routeParams, retry.routeParams));
}

function uniqueMatchingRun(
  runs: TaskResultRun[],
  predicate: (run: TaskResultRun) => boolean,
): TaskResultRun | undefined {
  const matches = runs.filter(predicate);
  return matches.length === 1 ? matches[0] : undefined;
}

// 来源任务的全部终态重试按创建顺序累计合并，兄弟重试和多层重试都保留先前成功结果。
export function terminalRetryTasks(tasks: TestTask[], sourceTaskId: string): TestTask[] {
  const descendants: TestTask[] = [];
  const queue = [sourceTaskId];
  const visited = new Set<string>();
  while (queue.length > 0) {
    const currentId = queue.shift()!;
    if (visited.has(currentId)) continue;
    visited.add(currentId);
    for (const task of tasks) {
      if (task.retryOf?.taskId !== currentId) continue;
      queue.push(task.id);
      if (!ACTIVE_STATUSES.has(task.status)) descendants.push(task);
    }
  }
  return descendants.sort((left, right) => left.createdAt.localeCompare(right.createdAt));
}

function taskResultFingerprint(task: TestTask): string {
  return `${task.runId}:${task.finishedAt}:${task.status}:${task.resultUri ?? ""}`;
}

function bundleArtifactReference(
  config: LoadedProjectConfig,
  task: TestTask,
  artifact: ResultBundleArtifact,
  warnings: string[],
): z.infer<typeof artifactReferenceSchema> | null {
  const prefix = `project://${config.project.id}/`;
  if (!artifact.uri.startsWith(prefix)) {
    warnings.push(`忽略无法映射到项目产物的截图: ${artifact.uri}`);
    return null;
  }
  const encodedPath = artifact.uri.slice(prefix.length);
  if (!encodedPath || encodedPath.includes("?") || encodedPath.includes("#")) {
    warnings.push(`忽略路径无效的截图: ${artifact.uri}`);
    return null;
  }
  let segments: string[];
  try {
    segments = encodedPath.split("/").map(segment => decodeURIComponent(segment));
  } catch {
    warnings.push(`忽略路径编码无效的截图: ${artifact.uri}`);
    return null;
  }
  if (segments.some(segment => !segment || segment === "." || segment === ".." || segment.includes("/") || segment.includes("\\"))) {
    warnings.push(`忽略路径无效的截图: ${artifact.uri}`);
    return null;
  }
  return {
    path: path.resolve(task.workspaceRoot || config.project.root, ...segments),
    label: artifact.label || path.basename(segments.at(-1) ?? ""),
  };
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
  artifactsRoot = resolveTaskArtifactsRoot(config, task),
): Promise<ResolvedTaskArtifact | null> {
  const workspaceRoot = task.workspaceRoot || config.project.root;
  const candidate = path.isAbsolute(reference.path)
    ? path.resolve(reference.path)
    : path.resolve(workspaceRoot, reference.path);
  try {
    const [realRoot, realCandidate] = await Promise.all([fs.realpath(artifactsRoot), fs.realpath(candidate)]);
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
