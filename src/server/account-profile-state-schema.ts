import { z } from "zod";
import { PLATFORMS } from "../shared/contracts.js";
import { ConsoleError } from "./errors.js";

const capture = z.object({
  captureId: z.string().min(1), kind: z.enum(["native", "graphql"]), provider: z.string().min(1),
  module: z.string().optional(), method: z.string().optional(), operationName: z.string().optional(),
  params: z.record(z.unknown()), result: z.record(z.unknown()), capturedAt: z.string(),
}).passthrough();
const entry = z.object({
  provider: z.string().min(1), accountUid: z.string(), sourceDeviceKey: z.string(),
  capabilities: z.array(z.string()), captures: z.array(capture),
  recordedAt: z.string(), validatedAt: z.string(), expiresAt: z.string(),
}).passthrough();
const base = z.object({
  profileId: z.string().min(1), accountLabel: z.string(), platform: z.enum(PLATFORMS), environment: z.string(),
});
const profile = base.extend({
  schemaVersion: z.literal("mobile-test-console.account-profile.v2"), version: z.literal(2),
  providerEntries: z.array(entry),
}).passthrough();
const legacy = base.merge(entry).extend({
  schemaVersion: z.literal("mobile-test-console.account-profile.v1"), version: z.literal(1),
}).passthrough();
const recording = z.object({
  recordingId: z.string().min(1), profileId: z.string().min(1), accountLabel: z.string(),
  provider: z.string().min(1), deviceKey: z.string(), deviceId: z.string(),
  deviceType: z.enum(["physical", "emulator", "simulator"]), deviceManufacturer: z.string().optional(),
  platform: z.enum(PLATFORMS), environment: z.string(),
  status: z.enum(["starting", "recording", "stopped", "failed"]),
  startedAt: z.string(), stoppedAt: z.string(), error: z.string(), captures: z.array(capture),
}).passthrough();
const state = z.object({
  schemaVersion: z.literal("mobile-test-console.account-profile-state.v1"),
  profiles: z.array(z.union([profile, legacy])), recordings: z.array(recording),
  migratedPaths: z.array(z.string()).optional(), notices: z.array(z.string()).optional(),
}).strict();

export function parseAccountProfileState(value: unknown) {
  const parsed = state.safeParse(value);
  if (!parsed.success) {
    // 错误响应只包含字段路径，避免把画像中的凭据带入日志或页面。
    throw new ConsoleError("ACCOUNT_PROFILE_STATE_INVALID", `账号画像文件格式无效：${parsed.error.issues.map(item => item.path.join(".")).join(", ")}`, 409);
  }
  for (const items of [parsed.data.profiles.map(item => item.profileId), parsed.data.recordings.map(item => item.recordingId)]) {
    if (new Set(items).size !== items.length) throw new ConsoleError("ACCOUNT_PROFILE_STATE_INVALID", "账号画像文件包含重复标识", 409);
  }
  return parsed.data;
}
