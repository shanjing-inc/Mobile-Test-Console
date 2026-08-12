import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import type {
  AccountProfile,
  AccountProfileCapture,
  AccountProfileProvider,
  AccountProfileProviderEntry,
  AccountProfileProviderEntrySummary,
  AccountProfileRecording,
  AccountProfileReplay,
  AccountProfileCaptureSummary,
  AccountProfileRecordingSummary,
  AccountProfileSourceResponse,
  AccountProfileSummary,
  AccountProfilesResponse,
  Device,
  StartAccountProfileRecordingRequest,
} from "../shared/contracts.js";
import { resolveAccountProfileProviderCommand, type LoadedProjectConfig, type ResolvedCommand } from "./config.js";
import { ConsoleError } from "./errors.js";
import { AccountProfileStore } from "./account-profile-store.js";
import { accountProfileCapabilities, resolveAccountProfileProviderAdapter, resolveProjectAdapter, supportsAccountProfileProviderAdapter, isCompleteAccountProfileRecording } from "./project-adapter.js";

const PROVIDER_SCHEMA = "mobile-test-console.account-profile-provider.v1";
const ACTIVE_RECORDING_STATUSES: readonly AccountProfileRecording["status"][] = ["starting", "recording"];

const timestampSchema = z.string().refine(value => Number.isFinite(Date.parse(value)), "时间字段无效");
const accountProfileCaptureSchema = z.object({
  captureId: z.string().min(1),
  kind: z.enum(["native", "graphql"]),
  provider: z.string().regex(/^[a-z][a-z0-9-]*$/),
  module: z.string().min(1).optional(),
  method: z.string().min(1).optional(),
  operationName: z.string().min(1).optional(),
  params: z.record(z.unknown()),
  result: z.record(z.unknown()),
  capturedAt: timestampSchema,
}).strict().superRefine((capture, context) => {
  if (capture.kind === "native" && (!capture.module || !capture.method)) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "Native capture 缺少 module/method" });
  }
  if (capture.kind === "graphql" && !capture.operationName) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "GraphQL capture 缺少 operationName" });
  }
});
const recordingPayloadSchema = z.object({
  schemaVersion: z.literal(PROVIDER_SCHEMA),
  status: z.enum(["starting", "recording", "stopped", "failed"]),
  captures: z.array(accountProfileCaptureSchema).optional(),
  error: z.string().optional(),
}).strict();
const replayPayloadSchema = z.object({
  schemaVersion: z.literal(PROVIDER_SCHEMA),
  status: z.enum(["passed", "failed"]),
  output: z.string().optional(),
  error: z.string().optional(),
}).strict();

type RecordingPayload = z.infer<typeof recordingPayloadSchema>;
type ReplayPayload = z.infer<typeof replayPayloadSchema>;

export class AccountProfileService {
  constructor(
    private readonly config: LoadedProjectConfig,
    private readonly store: AccountProfileStore,
  ) {}

  async snapshot(): Promise<AccountProfilesResponse> {
    const state = await this.store.load();
    const profiles = state.profiles.map(normalizeAccountProfile);
    return {
      schemaVersion: "mobile-test-console.account-profiles.v1",
      providers: resolveProjectAdapter(this.config).accountProfiles.providers,
      profiles: profiles.sort((left, right) => latestRecordedAt(right).localeCompare(latestRecordedAt(left))).map(toAccountProfileSummary),
      recordings: [...state.recordings].sort((left, right) => right.startedAt.localeCompare(left.startedAt)).map(toAccountProfileRecordingSummary),
      warnings: this.config.accountProfiles ? [] : ["当前项目未配置账号画像 provider"],
    };
  }

  async startRecording(device: Device, input: StartAccountProfileRecordingRequest): Promise<AccountProfileRecording> {
    assertProviderDevice(input.provider, device, resolveAccountProfileProviderAdapter(this.config, input.provider));
    const recording = await this.store.update(state => {
      const active = state.recordings.find(item => item.deviceKey === device.key && isActiveRecording(item));
      if (active) throw new ConsoleError("ACCOUNT_RECORDING_ACTIVE", `${device.name} 已有账号录制会话`, 409);
      const existing = state.profiles.find(item => item.profileId === input.profileId);
      if (existing) assertProfileScope(normalizeAccountProfile(existing), device, input.environment);
      const next: AccountProfileRecording = {
        recordingId: randomUUID(),
        profileId: input.profileId,
        accountLabel: input.accountLabel,
        provider: input.provider,
        deviceKey: device.key,
        deviceId: device.id,
        deviceType: device.type,
        deviceManufacturer: device.manufacturer ?? "",
        platform: device.platform,
        environment: input.environment,
        status: "starting",
        startedAt: new Date().toISOString(),
        stoppedAt: "",
        error: "",
        captures: [],
      };
      state.recordings.unshift(next);
      return next;
    });

    let payload: RecordingPayload | undefined;
    let providerError = "";
    try {
      payload = await this.callProvider("recording-start", recording);
    } catch (error) {
      providerError = error instanceof Error ? error.message : String(error);
    }
    return this.store.update(state => {
      const current = findRecording(state.recordings, recording.recordingId);
      if (!isActiveRecording(current)) return current;
      if (payload) applyRecordingPayload(current, payload);
      else {
        current.status = "failed";
        current.error = providerError;
      }
      return current;
    });
  }

  async refreshRecording(recordingId: string): Promise<AccountProfileRecording> {
    const state = await this.store.load();
    const recording = findRecording(state.recordings, recordingId);
    if (!isActiveRecording(recording)) return recording;
    const payload = await this.callProvider("recording-status", recording);
    return this.store.update(latest => {
      const current = findRecording(latest.recordings, recordingId);
      if (!isActiveRecording(current)) return current;
      applyRecordingPayload(current, payload);
      return current;
    });
  }

  async stopRecording(recordingId: string): Promise<{ recording: AccountProfileRecording; profile?: AccountProfile }> {
    const state = await this.store.load();
    const recording = findRecording(state.recordings, recordingId);
    if (!isActiveRecording(recording)) {
      return {
        recording,
        ...(recording.status === "stopped"
          ? { profile: state.profiles.find(item => item.profileId === recording.profileId) && normalizeAccountProfile(state.profiles.find(item => item.profileId === recording.profileId)!) }
          : {}),
      };
    }
    const payload = await this.callProvider("recording-stop", recording);
    return this.store.update(latest => {
      const current = findRecording(latest.recordings, recordingId);
      if (!isActiveRecording(current)) return { recording: current };
      applyRecordingPayload(current, payload);
      current.status = payload.status === "failed" ? "failed" : "stopped";
      current.stoppedAt = new Date().toISOString();

      const definition = resolveAccountProfileProviderAdapter(this.config, current.provider);
      const validationError = validateSuccessfulRecording(current, definition);
      let profile: AccountProfile | undefined;
      if (!validationError) {
        const existing = latest.profiles.find(item => item.profileId === current.profileId);
        profile = mergeAccountProfile(existing ? normalizeAccountProfile(existing) : undefined, current, definition);
        latest.profiles = latest.profiles.filter(item => item.profileId !== profile!.profileId);
        latest.profiles.push(profile);
      } else if (current.status !== "failed") {
        current.status = "failed";
        current.error = validationError;
      }
      return { recording: current, profile };
    });
  }

  async terminateRecording(recordingId: string): Promise<AccountProfileRecording> {
    return this.store.update(state => {
      const recording = findRecording(state.recordings, recordingId);
      if (isActiveRecording(recording)) {
        recording.status = "failed";
        recording.error = "用户终止录制会话";
        recording.stoppedAt = new Date().toISOString();
      }
      return recording;
    });
  }

  async replayProfile(profileId: string, provider: AccountProfileProvider, device: Device): Promise<AccountProfileReplay> {
    const state = await this.store.load();
    const storedProfile = state.profiles.find(item => item.profileId === profileId);
    if (!storedProfile) throw new ConsoleError("ACCOUNT_PROFILE_UNKNOWN", `账号画像不存在: ${profileId}`, 404);
    const profile = normalizeAccountProfile(storedProfile);
    const providerEntry = profile.providerEntries.find(item => item.provider === provider);
    if (!providerEntry) {
      throw new ConsoleError("ACCOUNT_PROFILE_PROVIDER_UNKNOWN", `账号画像 ${profileId} 未录制 ${provider} 分支`, 404);
    }
    assertProviderReplayScope(profile, providerEntry, device, resolveAccountProfileProviderAdapter(this.config, provider));
    assertProviderExpiry(profile, providerEntry);
    const startedAt = new Date().toISOString();
    const payload = await this.callReplayProvider(profile, provider, device);
    if (payload.status === "passed") {
      await this.store.update(latest => {
        const index = latest.profiles.findIndex(item => item.profileId === profileId);
        if (index < 0) return;
        const current = normalizeAccountProfile(latest.profiles[index]);
        const currentEntry = current.providerEntries.find(item => item.provider === provider);
        if (currentEntry) currentEntry.validatedAt = new Date().toISOString();
        latest.profiles[index] = current;
      });
    }
    return {
      replayId: randomUUID(),
      profileId,
      provider,
      platform: device.platform,
      sourcePlatform: profile.platform,
      environment: profile.environment,
      status: payload.status,
      startedAt,
      finishedAt: new Date().toISOString(),
      output: payload.output ?? "",
      error: payload.error ?? "",
    };
  }

  async validateTaskSelection(
    profileId: string,
    provider: AccountProfileProvider,
    capability: string,
    environment: string,
    devices: Device[],
  ): Promise<void> {
    const state = await this.store.load();
    const storedProfile = state.profiles.find(item => item.profileId === profileId);
    if (!storedProfile) throw new ConsoleError("ACCOUNT_PROFILE_UNKNOWN", `账号画像不存在: ${profileId}`, 404);
    const profile = normalizeAccountProfile(storedProfile);
    const providerEntry = profile.providerEntries.find(item => item.provider === provider);
    if (!providerEntry) {
      throw new ConsoleError("ACCOUNT_PROFILE_PROVIDER_UNKNOWN", `账号画像 ${profileId} 未录制 ${provider} 分支`, 404);
    }
    if (profile.environment !== environment) {
      throw new ConsoleError(
        "ACCOUNT_PROFILE_SCOPE_MISMATCH",
        `账号画像 ${profileId}/${provider} 属于 ${profile.environment} 环境，目标环境为 ${environment}`,
        409,
      );
    }
    if (!providerEntry.capabilities.includes(capability)) {
      throw new ConsoleError(
        "ACCOUNT_PROFILE_CAPABILITY_MISMATCH",
        `账号画像 ${profileId}/${provider} 缺少 ${capability} 能力`,
        409,
      );
    }
    assertProviderExpiry(profile, providerEntry);
    const definition = resolveAccountProfileProviderAdapter(this.config, provider);
    devices.forEach(device => assertProviderReplayScope(profile, providerEntry, device, definition));
  }

  async source(profileId: string, provider: AccountProfileProvider): Promise<AccountProfileSourceResponse> {
    const state = await this.store.load();
    const storedProfile = state.profiles.find(item => item.profileId === profileId);
    if (!storedProfile) throw new ConsoleError("ACCOUNT_PROFILE_UNKNOWN", `账号画像不存在: ${profileId}`, 404);
    const profile = normalizeAccountProfile(storedProfile);
    const providerEntry = profile.providerEntries.find(item => item.provider === provider);
    if (!providerEntry) {
      throw new ConsoleError("ACCOUNT_PROFILE_PROVIDER_UNKNOWN", `账号画像 ${profileId} 未录制 ${provider} 分支`, 404);
    }
    return {
      schemaVersion: "mobile-test-console.account-profile-source.v1",
      profileId: profile.profileId,
      accountLabel: profile.accountLabel,
      platform: profile.platform,
      environment: profile.environment,
      version: profile.version,
      providerEntry,
    };
  }

  async deleteProfile(profileId: string): Promise<void> {
    await this.store.update(state => {
      const profileExists = state.profiles.some(item => item.profileId === profileId);
      if (!profileExists) throw new ConsoleError("ACCOUNT_PROFILE_UNKNOWN", `账号画像不存在: ${profileId}`, 404);
      if (state.recordings.some(item => item.profileId === profileId && isActiveRecording(item))) {
        throw new ConsoleError("ACCOUNT_PROFILE_RECORDING_ACTIVE", `账号画像仍在录制，请先停止或终止会话: ${profileId}`, 409);
      }
      state.profiles = state.profiles.filter(item => item.profileId !== profileId);
      state.recordings = state.recordings.filter(item => item.profileId !== profileId);
    });
  }

  private async callProvider(action: "recording-start" | "recording-status" | "recording-stop", recording: AccountProfileRecording): Promise<RecordingPayload> {
    const command = resolveAccountProfileProviderCommand(this.config, action);
    if (!command) throw new ConsoleError("ACCOUNT_PROFILE_UNAVAILABLE", "当前项目未配置账号画像 provider", 404);
    const result = await capture(command, [
      "--recording-id", recording.recordingId,
      "--profile-id", recording.profileId,
      "--account-label", recording.accountLabel,
      "--provider", recording.provider,
      "--device", recording.deviceId,
      "--device-type", recording.deviceType,
      "--platform", recording.platform,
      "--device-manufacturer", recording.deviceManufacturer ?? "",
      "--environment", recording.environment,
    ]);
    return parseRecordingPayload(result, action, recording.provider);
  }

  private async callReplayProvider(profile: AccountProfile, provider: AccountProfileProvider, device: Device): Promise<ReplayPayload> {
    const command = resolveAccountProfileProviderCommand(this.config, "replay");
    if (!command) throw new ConsoleError("ACCOUNT_PROFILE_UNAVAILABLE", "当前项目未配置账号画像 provider", 404);
    const result = await capture(command, [
      "--profile-id", profile.profileId,
      "--provider", provider,
      "--device", device.id,
      "--device-type", device.type,
      "--platform", device.platform,
      "--device-manufacturer", device.manufacturer ?? "",
      "--environment", profile.environment,
      "--run-id", `account-replay-${randomUUID()}`,
    ], 10 * 60_000);
    return parseReplayPayload(result);
  }
}

function latestRecordedAt(profile: AccountProfile): string {
  return profile.providerEntries.reduce((latest, item) => item.recordedAt.localeCompare(latest) > 0 ? item.recordedAt : latest, "");
}

export function toAccountProfileSummary(profile: AccountProfile): AccountProfileSummary {
  const normalized = normalizeAccountProfile(profile);
  const { providerEntries, ...metadata } = normalized;
  return {
    ...metadata,
    providerEntries: providerEntries.map(toAccountProfileProviderEntrySummary),
  };
}

function toAccountProfileProviderEntrySummary(entry: AccountProfileProviderEntry): AccountProfileProviderEntrySummary {
  const { accountUid, captures, ...metadata } = entry;
  return {
    ...metadata,
    accountUidMasked: maskIdentifier(accountUid),
    captureSummaries: captures.map(toCaptureSummary),
  };
}

export function toAccountProfileRecordingSummary(recording: AccountProfileRecording): AccountProfileRecordingSummary {
  const { captures, ...metadata } = recording;
  return { ...metadata, captureSummaries: captures.map(toCaptureSummary) };
}

function toCaptureSummary(capture: AccountProfileCapture): AccountProfileCaptureSummary {
  return {
    captureId: capture.captureId,
    kind: capture.kind,
    provider: capture.provider,
    ...(capture.module ? { module: capture.module } : {}),
    ...(capture.method ? { method: capture.method } : {}),
    ...(capture.operationName ? { operationName: capture.operationName } : {}),
    parameterKeys: Object.keys(capture.params || {}).sort(),
    resultKeys: collectKeys(capture.result),
    digest: createHash("sha256").update(JSON.stringify(capture.result)).digest("hex").slice(0, 12),
    capturedAt: capture.capturedAt,
  };
}

function collectKeys(value: unknown, prefix = "", result = new Set<string>()): string[] {
  if (!value || typeof value !== "object") return [...result].sort();
  Object.entries(value as Record<string, unknown>).forEach(([key, item]) => {
    const path = prefix ? `${prefix}.${key}` : key;
    result.add(path);
    if (item && typeof item === "object" && !Array.isArray(item)) collectKeys(item, path, result);
  });
  return [...result].sort();
}

function maskIdentifier(value: string): string {
  const normalized = String(value || "").trim();
  if (!normalized) return "";
  return normalized.length <= 4 ? "****" : `${"*".repeat(Math.min(8, normalized.length - 4))}${normalized.slice(-4)}`;
}

function findRecording(recordings: AccountProfileRecording[], recordingId: string): AccountProfileRecording {
  const recording = recordings.find(item => item.recordingId === recordingId);
  if (!recording) throw new ConsoleError("ACCOUNT_RECORDING_UNKNOWN", `账号录制会话不存在: ${recordingId}`, 404);
  return recording;
}

function mergeCaptures(current: AccountProfileCapture[], incoming: AccountProfileCapture[]): AccountProfileCapture[] {
  const values = new Map(current.map(item => [item.captureId, item]));
  incoming.forEach(item => values.set(item.captureId, item));
  return [...values.values()].sort((left, right) => left.capturedAt.localeCompare(right.capturedAt));
}

function isActiveRecording(recording: AccountProfileRecording): boolean {
  return ACTIVE_RECORDING_STATUSES.includes(recording.status);
}

function applyRecordingPayload(recording: AccountProfileRecording, payload: RecordingPayload): void {
  recording.status = payload.status;
  recording.error = payload.error ?? "";
  recording.captures = mergeCaptures(recording.captures, payload.captures ?? []);
}

function validateSuccessfulRecording(recording: AccountProfileRecording, definition: ReturnType<typeof resolveAccountProfileProviderAdapter>): string {
  if (recording.captures.length === 0) return "录制期间未捕获账号授权数据";
  if (recording.captures.some(item => item.provider !== recording.provider)) {
    return `录制数据包含其他 Provider 分支: ${recording.provider}`;
  }
  const nativeSuccess = recording.captures.some(item => item.kind === "native" && readResultState(item.result) === "success");
  if (!nativeSuccess) return "录制期间未捕获成功的原生授权结果";
  if (!isCompleteAccountProfileRecording(definition, recording.captures)) {
    return definition?.requiredCaptureKinds.includes("graphql")
      ? "录制期间未捕获成功的 OAuth 登录结果"
      : "录制期间未捕获完整的账号授权结果";
  }
  return "";
}

function buildProviderEntry(recording: AccountProfileRecording, definition: ReturnType<typeof resolveAccountProfileProviderAdapter>): AccountProfileProviderEntry {
  const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
  const capabilities = accountProfileCapabilities(definition, recording.captures);
  const uid = recording.captures.map(item => findScalar(item.result, "uid")).find(Boolean) ?? "";
  return {
    provider: recording.provider,
    accountUid: uid,
    sourceDeviceKey: recording.deviceKey,
    capabilities,
    captures: recording.captures,
    recordedAt: recording.startedAt,
    validatedAt: "",
    expiresAt,
  };
}

function mergeAccountProfile(existing: AccountProfile | undefined, recording: AccountProfileRecording, definition: ReturnType<typeof resolveAccountProfileProviderAdapter>): AccountProfile {
  const entry = buildProviderEntry(recording, definition);
  if (!existing) {
    return {
      schemaVersion: "mobile-test-console.account-profile.v2",
      profileId: recording.profileId,
      accountLabel: recording.accountLabel,
      platform: recording.platform,
      environment: recording.environment,
      providerEntries: [entry],
      version: 2,
    };
  }
  assertProfileScope(existing, { platform: recording.platform }, recording.environment);
  return {
    ...existing,
    accountLabel: recording.accountLabel,
    providerEntries: [...existing.providerEntries.filter(item => item.provider !== recording.provider), entry]
      .sort((left, right) => left.provider.localeCompare(right.provider)),
  };
}

interface LegacyAccountProfile {
  schemaVersion: "mobile-test-console.account-profile.v1";
  profileId: string;
  accountLabel: string;
  accountUid: string;
  provider: AccountProfileProvider;
  platform: AccountProfile["platform"];
  environment: string;
  sourceDeviceKey: string;
  capabilities: string[];
  captures: AccountProfileCapture[];
  recordedAt: string;
  validatedAt: string;
  expiresAt: string;
}

function normalizeAccountProfile(profile: AccountProfile | LegacyAccountProfile): AccountProfile {
  if (Array.isArray((profile as AccountProfile).providerEntries)) return profile as AccountProfile;
  const legacy = profile as LegacyAccountProfile;
  return {
    schemaVersion: "mobile-test-console.account-profile.v2",
    profileId: legacy.profileId,
    accountLabel: legacy.accountLabel,
    platform: legacy.platform,
    environment: legacy.environment,
    providerEntries: [{
      provider: legacy.provider,
      accountUid: legacy.accountUid,
      sourceDeviceKey: legacy.sourceDeviceKey,
      capabilities: legacy.capabilities,
      captures: legacy.captures,
      recordedAt: legacy.recordedAt,
      validatedAt: legacy.validatedAt,
      expiresAt: legacy.expiresAt,
    }],
    version: 2,
  };
}

function assertProfileScope(profile: AccountProfile, device: Pick<Device, "platform">, environment: string): void {
  if (profile.platform !== device.platform || profile.environment !== environment) {
    throw new ConsoleError(
      "ACCOUNT_PROFILE_SCOPE_MISMATCH",
      `画像 ${profile.profileId} 已绑定 ${profile.platform}/${profile.environment}`,
      409,
    );
  }
}

function assertProviderReplayScope(
  profile: AccountProfile,
  entry: AccountProfileProviderEntry,
  device: Pick<Device, "platform" | "manufacturer" | "name" | "detail">,
  definition: ReturnType<typeof resolveAccountProfileProviderAdapter>,
): void {
  if (!supportsAccountProfileProviderAdapter(definition, device)) {
    throw new ConsoleError(
      "ACCOUNT_PROFILE_DEVICE_MISMATCH",
      `账号画像 ${profile.profileId}/${entry.provider} 不支持当前设备`,
      409,
    );
  }
  const requiredCapability = definition?.requiredCapability ?? "login";
  if (!entry.capabilities.includes(requiredCapability)) {
    throw new ConsoleError(
      "ACCOUNT_PROFILE_CAPABILITY_MISMATCH",
      `账号画像 ${profile.profileId}/${entry.provider} 缺少 ${requiredCapability} 能力`,
      409,
    );
  }
  const crossPlatformCapability = definition?.crossPlatformCapability ?? "login";
  if (profile.platform !== device.platform && !entry.capabilities.includes(crossPlatformCapability)) {
    throw new ConsoleError(
      "ACCOUNT_PROFILE_PLATFORM_MISMATCH",
      `账号画像 ${profile.profileId}/${entry.provider} 缺少跨平台 login 能力`,
      409,
    );
  }
}

function assertProviderDevice(
  provider: AccountProfileProvider,
  device: Pick<Device, "platform" | "manufacturer" | "name" | "detail">,
  definition: ReturnType<typeof resolveAccountProfileProviderAdapter>,
): void {
  if (!supportsAccountProfileProviderAdapter(definition, device)) {
    throw new ConsoleError(
      "ACCOUNT_PROFILE_DEVICE_MISMATCH",
      `账号画像 ${provider} 不支持当前设备`,
      409,
    );
  }
}

function assertProviderExpiry(profile: AccountProfile, entry: AccountProfileProviderEntry): void {
  const expiresAt = Date.parse(String(entry.expiresAt || ""));
  if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) {
    throw new ConsoleError(
      "ACCOUNT_PROFILE_EXPIRED",
      `账号画像有效期无效或已过期，请重新录制: ${profile.profileId}/${entry.provider}`,
      409,
    );
  }
}

function readResultState(result: Record<string, unknown>): string {
  return String(result.result ?? "").trim().toLowerCase();
}

function findScalar(value: unknown, key: string): string {
  if (!value || typeof value !== "object") return "";
  if (!Array.isArray(value) && key in value) return String((value as Record<string, unknown>)[key] ?? "").trim();
  for (const item of Object.values(value as Record<string, unknown>)) {
    const found = findScalar(item, key);
    if (found) return found;
  }
  return "";
}

function parseRecordingPayload(
  result: { code: number; stdout: string; stderr: string },
  action: string,
  provider: AccountProfileProvider,
): RecordingPayload {
  const parsed = recordingPayloadSchema.safeParse(parseProviderJson(result, action));
  if (!parsed.success) throw invalidProviderPayload(action, parsed.error);
  if (parsed.data.captures?.some(capture => capture.provider !== provider)) {
    throw new ConsoleError("ACCOUNT_PROFILE_PROVIDER_INVALID", `${action} 返回了其他 Provider 的捕获数据`);
  }
  return parsed.data;
}

function parseReplayPayload(result: { code: number; stdout: string; stderr: string }): ReplayPayload {
  const parsed = replayPayloadSchema.safeParse(parseProviderJson(result, "replay"));
  if (!parsed.success) throw invalidProviderPayload("replay", parsed.error);
  return parsed.data;
}

function parseProviderJson(result: { code: number; stdout: string; stderr: string }, action: string): unknown {
  if (result.code !== 0) throw new ConsoleError("ACCOUNT_PROFILE_PROVIDER_FAILED", `${action} 执行失败: ${result.stderr || result.stdout}`);
  try {
    return JSON.parse(result.stdout) as unknown;
  } catch {
    throw new ConsoleError("ACCOUNT_PROFILE_PROVIDER_INVALID", `${action} 返回了无效 JSON`);
  }
}

function invalidProviderPayload(action: string, error: z.ZodError): ConsoleError {
  const paths = error.issues.slice(0, 3).map(issue => issue.path.join(".") || "payload").join(", ");
  return new ConsoleError("ACCOUNT_PROFILE_PROVIDER_INVALID", `${action} 返回的账号画像协议结构无效: ${paths}`);
}

function capture(command: ResolvedCommand, extraArgs: string[], timeout = 120_000): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise(resolve => {
    execFile(command.executable, [...command.args, ...extraArgs], {
      cwd: command.cwd,
      env: { ...process.env, ...command.env },
      encoding: "utf8",
      timeout,
      maxBuffer: 32 * 1024 * 1024,
    }, (error, stdout, stderr) => {
      const code = typeof (error as NodeJS.ErrnoException & { code?: number })?.code === "number"
        ? Number((error as NodeJS.ErrnoException & { code?: number }).code)
        : error ? 1 : 0;
      resolve({ code, stdout: String(stdout || ""), stderr: String(stderr || error?.message || "") });
    });
  });
}
