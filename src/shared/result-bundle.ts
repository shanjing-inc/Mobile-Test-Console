import { z } from "zod";

export const RESULT_BUNDLE_SCHEMA_VERSION = "test-analysis.run.v1" as const;

const targetSchema = z.object({
  kind: z.enum(["app", "mini-program"]),
  runtime: z.string().min(1).optional(),
  platform: z.string().min(1),
  appId: z.string().min(1).optional(),
  version: z.string().min(1).optional(),
}).passthrough();

const runSchema = z.object({
  runId: z.string().regex(/^[A-Za-z0-9._-]+$/),
  status: z.enum(["queued", "running", "passed", "failed", "cancelled", "interrupted", "unknown"]),
  environment: z.string().default(""),
  startedAt: z.string().default(""),
  finishedAt: z.string().default(""),
}).passthrough();

const artifactSchema = z.object({
  id: z.string().min(1),
  uri: z.string().min(1),
  label: z.string().default(""),
  role: z.enum(["screenshot", "recording", "log", "trace", "network", "evidence", "other"]).default("other"),
  mimeType: z.string().default("application/octet-stream"),
  sizeBytes: z.number().int().nonnegative().nullable().default(null),
  sha256: z.string().regex(/^[a-f0-9]{64}$/).nullable().default(null),
}).passthrough();

const stepSchema = z.object({
  stepId: z.string().min(1),
  name: z.string().default(""),
  status: z.string().default("unknown"),
  startedAt: z.string().default(""),
  finishedAt: z.string().default(""),
  durationMs: z.number().nonnegative().nullable().default(null),
  evidenceRefs: z.array(z.string()).default([]),
}).passthrough();

const assertionSchema = z.object({
  assertionId: z.string().min(1),
  kind: z.string().min(1),
  passed: z.boolean(),
  description: z.string().default(""),
  evidenceRefs: z.array(z.string()).default([]),
}).passthrough();

const caseSchema = z.object({
  caseRunId: z.string().min(1),
  caseId: z.string().default(""),
  title: z.string().default(""),
  status: z.string().default("unknown"),
  targetPage: z.string().default(""),
  scenario: z.string().default(""),
  steps: z.array(stepSchema).default([]),
  assertions: z.array(assertionSchema).default([]),
  evidenceRefs: z.array(z.string()).default([]),
  logs: z.array(z.string()).default([]),
  apiCalls: z.array(z.record(z.unknown())).default([]),
  errorSummary: z.string().default(""),
}).passthrough();

export const resultBundleSchema = z.object({
  schemaVersion: z.literal(RESULT_BUNDLE_SCHEMA_VERSION),
  project: z.object({
    id: z.string().regex(/^[a-z][a-z0-9-]*$/),
    name: z.string().min(1),
  }).passthrough(),
  target: targetSchema,
  run: runSchema,
  cases: z.array(caseSchema).default([]),
  artifacts: z.array(artifactSchema).default([]),
  warnings: z.array(z.string()).default([]),
  provenance: z.object({
    adapter: z.string().default(""),
    adapterVersion: z.string().default(""),
    sourceRevision: z.string().default(""),
    generatedAt: z.string().default(""),
  }).passthrough().default({}),
  metadata: z.record(z.unknown()).default({}),
}).passthrough();

export type ResultBundle = z.infer<typeof resultBundleSchema>;
export type ResultBundleArtifact = ResultBundle["artifacts"][number];
export type ResultBundleCase = ResultBundle["cases"][number];

export interface ResultBundleSummary {
  schemaVersion: typeof RESULT_BUNDLE_SCHEMA_VERSION;
  projectId: string;
  targetKind: ResultBundle["target"]["kind"];
  platform: string;
  runId: string;
  status: ResultBundle["run"]["status"];
  caseCount: number;
  passed: number;
  failed: number;
  artifactCount: number;
  generatedAt: string;
}

export function parseResultBundle(input: unknown): ResultBundle {
  const parsed = resultBundleSchema.safeParse(input);
  if (!parsed.success) {
    throw new Error(`Result Bundle 协议无效: ${parsed.error.issues.map(issue => `${issue.path.join(".")}: ${issue.message}`).join("; ")}`);
  }
  return parsed.data;
}

export function summarizeResultBundle(bundle: ResultBundle): ResultBundleSummary {
  return {
    schemaVersion: bundle.schemaVersion,
    projectId: bundle.project.id,
    targetKind: bundle.target.kind,
    platform: bundle.target.platform,
    runId: bundle.run.runId,
    status: bundle.run.status,
    caseCount: bundle.cases.length,
    passed: bundle.cases.filter(item => item.status === "passed").length,
    failed: bundle.cases.filter(item => item.status === "failed").length,
    artifactCount: bundle.artifacts.length,
    generatedAt: bundle.provenance.generatedAt || bundle.run.finishedAt || bundle.run.startedAt,
  };
}
