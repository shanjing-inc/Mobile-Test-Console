import { createHash } from "node:crypto";
import {
  TERMINAL_TASK_STATUSES,
  type ScreenshotComparison,
  type ScreenshotComparisonCandidate,
  type ScreenshotComparisonImage,
  type ScreenshotComparisonPair,
  type ScreenshotComparisonRef,
  type ScreenshotComparisonSide,
  type TaskResult,
} from "../shared/contracts.js";
import {
  collectScreenshotComparisonItems,
  pairScreenshotComparisonItems,
  projectDirectoryName,
  type ScreenshotComparisonItemInput,
} from "../shared/screenshot-comparison.js";
import { ConsoleError } from "./errors.js";
import type { LoadedProjectConfig } from "./config.js";
import type { ResultBundleStore } from "./result-bundle-store.js";
import type { TaskManager } from "./task-manager.js";
import type { TaskResultService } from "./task-results.js";

const TERMINAL_STATUSES = new Set(TERMINAL_TASK_STATUSES);

export interface ScreenshotComparisonRuntime {
  config: LoadedProjectConfig;
  tasks: TaskManager;
  taskResults: TaskResultService;
  resultBundles?: ResultBundleStore;
}

export async function listScreenshotComparisonCandidates(
  runtime: ScreenshotComparisonRuntime,
): Promise<ScreenshotComparisonCandidate[]> {
  const tasks = runtime.tasks.listVisible().filter(task => TERMINAL_STATUSES.has(task.status));
  const candidates = await Promise.all(tasks.map(async task => {
    let screenshotCount = 0;
    let error = "";
    try {
      const result = await runtime.taskResults.load(task.id);
      screenshotCount = result.runs.reduce((total, run) => total + run.screenshots.length, 0);
    } catch (cause) {
      error = cause instanceof Error ? cause.message : String(cause);
    }
    return {
      projectId: runtime.config.project.id,
      projectName: runtime.config.project.name,
      directoryName: projectDirectoryName(runtime.config.project.root),
      taskId: task.id,
      runId: task.runId,
      testLabel: task.testLabel,
      status: task.status,
      createdAt: task.createdAt,
      finishedAt: task.finishedAt,
      screenshotCount,
      error,
    };
  }));
  return candidates.sort((left, right) => right.createdAt.localeCompare(left.createdAt) || left.taskId.localeCompare(right.taskId));
}

export async function createScreenshotComparison(
  leftRuntime: ScreenshotComparisonRuntime,
  rightRuntime: ScreenshotComparisonRuntime,
  request: { left: ScreenshotComparisonRef; right: ScreenshotComparisonRef },
): Promise<ScreenshotComparison> {
  if (request.left.projectId === request.right.projectId && request.left.taskId === request.right.taskId) {
    throw new ConsoleError("SCREENSHOT_COMPARISON_INVALID", "请选择两个不同的历史结果", 400);
  }
  if (leftRuntime.config.project.id !== request.left.projectId) {
    throw new ConsoleError("SCREENSHOT_COMPARISON_INVALID", `左侧项目 Runtime 不匹配: ${request.left.projectId}`, 400);
  }
  if (rightRuntime.config.project.id !== request.right.projectId) {
    throw new ConsoleError("SCREENSHOT_COMPARISON_INVALID", `右侧项目 Runtime 不匹配: ${request.right.projectId}`, 400);
  }

  const [left, right] = await Promise.all([
    loadSide(leftRuntime, request.left),
    loadSide(rightRuntime, request.right),
  ]);
  const pairs = pairScreenshotComparisonItems(left.items, right.items).map(pair => ({
    key: pair.key,
    caseId: pair.caseId,
    label: pair.label,
    title: pair.title,
    presence: pair.presence,
    left: toImage(request.left, pair.left),
    right: toImage(request.right, pair.right),
  } satisfies ScreenshotComparisonPair));

  return {
    comparisonId: comparisonIdOf(request.left, request.right),
    left: left.side,
    right: right.side,
    pairs,
  };
}

async function loadSide(
  runtime: ScreenshotComparisonRuntime,
  ref: ScreenshotComparisonRef,
): Promise<{ side: ScreenshotComparisonSide; items: ScreenshotComparisonItemInput[] }> {
  const project = runtime.config.project;
  const side: ScreenshotComparisonSide = {
    projectId: project.id,
    projectName: project.name,
    projectRoot: project.root,
    directoryName: projectDirectoryName(project.root),
    taskId: ref.taskId,
    runId: "",
    testLabel: "",
    createdAt: "",
    finishedAt: "",
    sourceRevision: "",
    error: "",
  };

  const task = runtime.tasks.get(ref.taskId);
  if (!task) {
    side.error = `任务不存在: ${ref.taskId}`;
    return { side, items: [] };
  }

  side.runId = task.runId;
  side.testLabel = task.testLabel;
  side.createdAt = task.createdAt;
  side.finishedAt = task.finishedAt;

  let result: TaskResult;
  try {
    result = await runtime.taskResults.load(task.id);
  } catch (cause) {
    side.error = cause instanceof Error ? cause.message : String(cause);
    return { side, items: [] };
  }

  if (task.resultUri && runtime.resultBundles) {
    try {
      const bundle = await runtime.resultBundles.getByUri(task.resultUri);
      side.sourceRevision = bundle?.provenance.sourceRevision ?? "";
    } catch {
      side.sourceRevision = "";
    }
  }

  const items = collectScreenshotComparisonItems(result);
  if (items.length === 0 && !side.error) {
    side.error = result.warnings.find(warning => warning.includes("截图")) || "该运行没有可对比的截图";
  }
  return { side, items };
}

function toImage(ref: ScreenshotComparisonRef, item: ScreenshotComparisonItemInput | null): ScreenshotComparisonImage | null {
  if (!item) return null;
  return {
    projectId: ref.projectId,
    taskId: ref.taskId,
    artifactId: item.artifactId,
    url: `/api/tasks/${encodeURIComponent(ref.taskId)}/artifacts/${encodeURIComponent(item.artifactId)}?projectId=${encodeURIComponent(ref.projectId)}`,
    available: Boolean(item.artifactId),
    missingReason: item.artifactId ? "" : "源截图已清理",
  };
}

function comparisonIdOf(left: ScreenshotComparisonRef, right: ScreenshotComparisonRef): string {
  return createHash("sha1")
    .update(`${left.projectId}:${left.taskId}|${right.projectId}:${right.taskId}`)
    .digest("hex")
    .slice(0, 16);
}
