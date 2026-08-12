import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { ConsoleError } from "./errors.js";
import {
  parseResultBundle,
  summarizeResultBundle,
  type ResultBundle,
  type ResultBundleSummary,
} from "../shared/result-bundle.js";

export type ResultBundleIngestStatus = "created" | "duplicate";

export interface ResultBundleIngestResponse {
  status: ResultBundleIngestStatus;
  fingerprint: string;
  resultUri: string;
  summary: ResultBundleSummary;
}

export interface ResultBundleExpectedContext {
  runId: string;
  projectId: string;
  status: "passed" | "failed";
}

const RESULT_BUNDLE_URI_PREFIX = "result-bundle://runs/";

export class ResultBundleStore {
  private readonly bundleDir: string;
  private readonly writeQueue = new Map<string, Promise<void>>();

  constructor(stateDir: string) {
    this.bundleDir = path.join(stateDir, "result-bundles");
  }

  async ingest(
    input: unknown,
    source = "unknown",
    expected?: ResultBundleExpectedContext,
  ): Promise<ResultBundleIngestResponse> {
    let bundle: ResultBundle;
    try {
      bundle = parseResultBundle(input);
    } catch (error) {
      throw new ConsoleError(
        "RESULT_BUNDLE_INVALID",
        `${source} 返回的 Result Bundle 无效: ${error instanceof Error ? error.message : String(error)}`,
        400,
      );
    }
    if (expected && (
      bundle.run.runId !== expected.runId
      || bundle.project.id !== expected.projectId
      || bundle.run.status !== expected.status
    )) {
      throw new ConsoleError(
        "RESULT_BUNDLE_CONTEXT_MISMATCH",
        `${source} 返回的 Result Bundle 与任务上下文不匹配: `
          + `runId=${bundle.run.runId}, projectId=${bundle.project.id}, status=${bundle.run.status}`,
        400,
      );
    }

    const fingerprint = fingerprintResultBundle(bundle);
    const targetPath = this.pathForRun(bundle.run.runId);
    const existing = await this.readExisting(targetPath);
    if (existing) {
      const existingFingerprint = fingerprintResultBundle(existing);
      if (existingFingerprint !== fingerprint) {
        throw new ConsoleError(
          "RESULT_BUNDLE_CONFLICT",
          `runId ${bundle.run.runId} 已存在内容不同的 Result Bundle`,
          409,
        );
      }
      return {
        status: "duplicate",
        fingerprint,
        resultUri: resultBundleUri(bundle.run.runId),
        summary: summarizeResultBundle(existing),
      };
    }

    const previous = this.writeQueue.get(bundle.run.runId) ?? Promise.resolve();
    let createdByThisCall = true;
    const write = previous.then(async () => {
      const raced = await this.readExisting(targetPath);
      if (raced) {
        const racedFingerprint = fingerprintResultBundle(raced);
        if (racedFingerprint !== fingerprint) {
          throw new ConsoleError(
            "RESULT_BUNDLE_CONFLICT",
            `runId ${bundle.run.runId} 已存在内容不同的 Result Bundle`,
            409,
          );
        }
        createdByThisCall = false;
        return;
      }
      await fs.mkdir(this.bundleDir, { recursive: true });
      const tempPath = `${targetPath}.${process.pid}.${Date.now()}.next`;
      await fs.writeFile(tempPath, `${JSON.stringify(bundle, null, 2)}\n`, { mode: 0o600 });
      await fs.rename(tempPath, targetPath);
    });
    const tracked = write.catch(() => undefined);
    this.writeQueue.set(bundle.run.runId, tracked);
    try {
      await write;
    } finally {
      if (this.writeQueue.get(bundle.run.runId) === tracked) this.writeQueue.delete(bundle.run.runId);
    }
    return {
      status: createdByThisCall ? "created" : "duplicate",
      fingerprint,
      resultUri: resultBundleUri(bundle.run.runId),
      summary: summarizeResultBundle(bundle),
    };
  }

  async ingestFile(filePath: string): Promise<ResultBundleIngestResponse> {
    let payload: unknown;
    try {
      payload = JSON.parse(await fs.readFile(path.resolve(filePath), "utf8"));
    } catch (error) {
      throw new ConsoleError(
        "RESULT_BUNDLE_FILE_INVALID",
        `读取 Result Bundle 文件失败: ${error instanceof Error ? error.message : String(error)}`,
        400,
      );
    }
    return this.ingest(payload, `文件 ${path.resolve(filePath)}`);
  }

  async get(runId: string): Promise<ResultBundle | null> {
    return this.readExisting(this.pathForRun(runId));
  }

  async getByUri(resultUri: string): Promise<ResultBundle | null> {
    return this.get(resultBundleRunId(resultUri));
  }

  async list(): Promise<ResultBundleSummary[]> {
    let entries;
    try {
      entries = await fs.readdir(this.bundleDir, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    const summaries: ResultBundleSummary[] = [];
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
      const bundle = await this.readExisting(path.join(this.bundleDir, entry.name));
      if (bundle) summaries.push(summarizeResultBundle(bundle));
    }
    return summaries.sort((left, right) => right.generatedAt.localeCompare(left.generatedAt));
  }

  private pathForRun(runId: string): string {
    if (!/^[A-Za-z0-9._-]+$/.test(runId)) {
      throw new ConsoleError("RESULT_BUNDLE_RUN_ID_INVALID", `Result Bundle runId 非法: ${runId}`, 400);
    }
    return path.join(this.bundleDir, `${runId}.json`);
  }

  private async readExisting(filePath: string): Promise<ResultBundle | null> {
    try {
      return parseResultBundle(JSON.parse(await fs.readFile(filePath, "utf8")));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      if (error instanceof SyntaxError) {
        throw new ConsoleError("RESULT_BUNDLE_STATE_INVALID", `Result Bundle 状态文件无效: ${filePath}`, 500);
      }
      if (error instanceof ConsoleError) throw error;
      throw new ConsoleError("RESULT_BUNDLE_STATE_INVALID", `读取 Result Bundle 状态失败: ${filePath}`, 500);
    }
  }
}

export function resultBundleUri(runId: string): string {
  if (!/^[A-Za-z0-9._-]+$/.test(runId)) {
    throw new ConsoleError("RESULT_BUNDLE_RUN_ID_INVALID", `Result Bundle runId 非法: ${runId}`, 400);
  }
  return `${RESULT_BUNDLE_URI_PREFIX}${encodeURIComponent(runId)}`;
}

export function resultBundleRunId(resultUri: string): string {
  if (!resultUri.startsWith(RESULT_BUNDLE_URI_PREFIX)) {
    throw new ConsoleError("RESULT_BUNDLE_URI_INVALID", `Result Bundle URI 无效: ${resultUri}`, 400);
  }
  let runId = "";
  try {
    runId = decodeURIComponent(resultUri.slice(RESULT_BUNDLE_URI_PREFIX.length));
  } catch {
    throw new ConsoleError("RESULT_BUNDLE_URI_INVALID", `Result Bundle URI 无效: ${resultUri}`, 400);
  }
  if (!/^[A-Za-z0-9._-]+$/.test(runId)) {
    throw new ConsoleError("RESULT_BUNDLE_URI_INVALID", `Result Bundle URI 无效: ${resultUri}`, 400);
  }
  return runId;
}

function fingerprintResultBundle(bundle: ResultBundle): string {
  return createHash("sha256").update(stableStringify(bundle)).digest("hex");
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableStringify(entry)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}
