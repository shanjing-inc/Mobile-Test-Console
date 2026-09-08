import { z } from "zod";
import { PAGE_PARAMETER_PLATFORMS } from "../shared/contracts.js";
import { ConsoleError } from "./errors.js";

const navigation = z.object({ route: z.string(), params: z.record(z.string()) }).passthrough();
const assertion = z.object({
  type: z.enum(["runtimeEvent", "visible", "text", "selected"]),
  target: z.string().optional(), event: z.string().optional(), value: z.string().optional(),
}).passthrough();
const action = z.object({
  type: z.enum(["tap", "input", "select", "submit", "waitFor", "screenshot"]),
  target: z.string(), value: z.string().optional(), timeoutMs: z.number().optional(),
  assertions: z.array(assertion).optional(),
}).passthrough();
const profile = z.object({
  profileId: z.string().min(1), pageId: z.string().min(1), scenario: z.string(),
  platform: z.enum(PAGE_PARAMETER_PLATFORMS), isDefault: z.boolean().optional(),
  environment: z.string(), accountLabel: z.string(),
  values: z.record(z.object({
    strategy: z.enum(["literal", "secretRef", "runtimeResolver"]), value: z.string(),
  }).passthrough()),
  navigation: navigation.optional(), actions: z.array(action).optional(), assertions: z.array(assertion).optional(),
  source: z.enum(["recording", "manual", "manifest"]),
  recordedAt: z.string(), validatedAt: z.string(), expiresAt: z.string(), version: z.literal(1),
}).passthrough();
const observation = z.object({
  observationId: z.string().min(1), pageId: z.string(), bundle: z.string(), previousPageId: z.string(),
  values: z.record(z.string()), navigation: navigation.optional(), capturedAt: z.string(), rawData: z.string().optional(),
}).passthrough();
const recording = z.object({
  recordingId: z.string().min(1), deviceKey: z.string(), deviceId: z.string(),
  targetKey: z.string().optional(), targetKind: z.enum(["app", "mini-program"]).optional(),
  targetLabel: z.string().optional(), targetRuntime: z.string().optional(),
  targetAppId: z.string().optional(), targetPlatform: z.string().optional(),
  platform: z.enum(PAGE_PARAMETER_PLATFORMS), environment: z.string(),
  status: z.enum(["starting", "recording", "stopped", "failed"]),
  startedAt: z.string(), stoppedAt: z.string(), error: z.string(), observations: z.array(observation),
}).passthrough();
const state = z.object({
  schemaVersion: z.literal("mobile-test-console.page-parameter-state.v1"),
  profiles: z.array(profile), recordings: z.array(recording),
  migratedPaths: z.array(z.string()).optional(), notices: z.array(z.string()).optional(),
}).passthrough();

export function parsePageParameterState(value: unknown) {
  const parsed = state.safeParse(value);
  if (!parsed.success) {
    // 仅返回字段路径，保留页面参数与启动参数的私密性。
    throw new ConsoleError("PAGE_PARAMETER_STATE_INVALID", `页面参数文件格式无效：${parsed.error.issues.map(item => item.path.join(".")).join(", ")}`, 409);
  }
  const keys = [parsed.data.profiles.map(item => JSON.stringify([item.pageId, item.profileId])), parsed.data.recordings.map(item => item.recordingId)];
  for (const items of keys) {
    if (new Set(items).size !== items.length) throw new ConsoleError("PAGE_PARAMETER_STATE_INVALID", "页面参数文件包含重复标识", 409);
  }
  return parsed.data;
}
