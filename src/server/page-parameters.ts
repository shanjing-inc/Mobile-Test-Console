import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import path from "node:path";
import {
  PLATFORMS,
  type PageParameterPlatform,
  type Device,
  type PageParameterCatalogEntry,
  type PageParameterObservation,
  type PageParameterProfile,
  type PageParameterReplay,
  type PageParameterReplaySummary,
  type PageParameterRecording,
  type PageParametersResponse,
  type PageScenarioActionType,
  type PageScenarioTarget,
  type SavePageParameterProfileRequest,
  type MiniProgramRunTarget,
} from "../shared/contracts.js";
import { resolvePageParameterProviderCommand, type LoadedProjectConfig, type ResolvedCommand } from "./config.js";
import { ConsoleError } from "./errors.js";
import { PageParameterStore } from "./page-parameter-store.js";
import { resolveProjectAdapter } from "./project-adapter.js";

interface CatalogPayload {
  schemaVersion: "mobile-test-console.page-parameter-provider.v1";
  pages: PageParameterCatalogEntry[];
  warnings?: string[];
}

interface RecordingPayload {
  schemaVersion: "mobile-test-console.page-parameter-provider.v1";
  status: PageParameterRecording["status"];
  observations?: PageParameterObservation[];
  error?: string;
}

interface ReplayPayload {
  schemaVersion: "mobile-test-console.page-parameter-provider.v1";
  status: "passed" | "failed";
  output?: string;
  error?: string;
  summary?: PageParameterReplaySummary;
}

export class PageParameterService {
  constructor(
    private readonly config: LoadedProjectConfig,
    private readonly store: PageParameterStore,
  ) {}

  isEnabled(): boolean {
    return Boolean(this.config.pageParameters);
  }

  async snapshot(): Promise<PageParametersResponse> {
    const state = await this.store.load();
    const catalog = await this.callProvider<CatalogPayload>("catalog");
    const now = Date.now();
    return {
      schemaVersion: "mobile-test-console.page-parameters.v1",
      adapter: resolveProjectAdapter(this.config).pageParameters,
      pages: catalog.pages.map(page => {
        const profiles = state.profiles.filter(profile => profile.pageId === page.pageId);
        const expired = profiles.length > 0 && profiles.every(profile => profile.expiresAt && Date.parse(profile.expiresAt) <= now);
        return {
          ...page,
          status: profiles.length === 0 ? "missing" : expired ? "expired" : "recorded",
          profiles,
        };
      }),
      recordings: state.recordings,
      warnings: catalog.warnings ?? [],
    };
  }

  async startRecording(execution: Device | MiniProgramRunTarget, environment: string): Promise<PageParameterRecording> {
    const state = await this.store.load();
    const isTarget = isMiniProgramTarget(execution);
    const executionKey = execution.key;
    const active = state.recordings.find(item => (item.targetKey === executionKey || item.deviceKey === executionKey) && ["starting", "recording"].includes(item.status));
    if (active) throw new ConsoleError("PAGE_PARAMETER_RECORDING_ACTIVE", `${isTarget ? execution.label : execution.name} 已有录制会话`, 409);
    const recording: PageParameterRecording = {
      recordingId: randomUUID(),
      ...(isTarget ? {
        targetKey: execution.key,
        targetKind: execution.kind,
        targetLabel: execution.label,
        targetRuntime: execution.runtime,
        targetAppId: execution.appId,
        targetPlatform: execution.platform,
      } : {}),
      deviceKey: isTarget ? "" : execution.key,
      deviceId: isTarget ? "" : execution.id,
      platform: isTarget ? "all" : execution.platform,
      environment,
      status: "starting",
      startedAt: new Date().toISOString(),
      stoppedAt: "",
      error: "",
      observations: [],
    };
    state.recordings.unshift(recording);
    await this.store.save(state);
    try {
      const payload = await this.callRecordingProvider("recording-start", recording);
      Object.assign(recording, {
        status: payload.status,
        observations: payload.observations ?? [],
        error: payload.error ?? "",
      });
    } catch (error) {
      recording.status = "failed";
      recording.error = error instanceof Error ? error.message : String(error);
    }
    await this.store.save(state);
    return recording;
  }

  async refreshRecording(recordingId: string): Promise<PageParameterRecording> {
    const state = await this.store.load();
    const recording = findRecording(state.recordings, recordingId);
    if (["stopped", "failed"].includes(recording.status)) return recording;
    const payload = await this.callRecordingProvider("recording-status", recording);
    recording.status = payload.status;
    recording.error = payload.error ?? "";
    recording.observations = mergeObservations(recording.observations, payload.observations ?? []);
    await this.store.save(state);
    return recording;
  }

  async stopRecording(recordingId: string): Promise<PageParameterRecording> {
    const state = await this.store.load();
    const recording = findRecording(state.recordings, recordingId);
    if (!["stopped", "failed"].includes(recording.status)) {
      const payload = await this.callRecordingProvider("recording-stop", recording);
      recording.status = payload.status === "failed" ? "failed" : "stopped";
      recording.error = payload.error ?? "";
      recording.observations = mergeObservations(recording.observations, payload.observations ?? []);
      recording.stoppedAt = new Date().toISOString();
      await this.store.save(state);
    }
    return recording;
  }

  async replayProfile(pageId: string, profileId: string, execution: Device | MiniProgramRunTarget): Promise<PageParameterReplay> {
    const state = await this.store.load();
    const profile = state.profiles.find(item => item.pageId === pageId && item.profileId === profileId);
    if (!profile) throw new ConsoleError("PAGE_PARAMETER_PROFILE_UNKNOWN", `参数画像不存在: ${profileId}`, 404);
    if (!isMiniProgramTarget(execution) && profile.platform !== "all" && profile.platform !== execution.platform) {
      throw new ConsoleError(
        "PAGE_PARAMETER_REPLAY_PLATFORM_MISMATCH",
        `画像 ${profileId} 属于 ${profile.platform}，当前设备属于 ${execution.platform}`,
        409,
      );
    }

    const replayId = randomUUID();
    const startedAt = new Date().toISOString();
    try {
      const payload = await this.callProvider<ReplayPayload>("replay", [
        "--page", pageId,
        "--profile-id", profileId,
        "--profiles", path.join(this.config.stateDir, "page-parameters.json"),
        "--environment", profile.environment,
        "--run-id", replayId,
        ...isMiniProgramTarget(execution)
          ? targetProviderArgs(execution)
          : ["--device", execution.id, "--platform", execution.platform, "--device-type", execution.type],
      ]);
      return {
        replayId,
        pageId,
        profileId,
        platform: isMiniProgramTarget(execution) ? "all" : execution.platform,
        ...(isMiniProgramTarget(execution) ? {
          targetKey: execution.key,
          targetKind: execution.kind,
          targetPlatform: execution.platform,
        } : {}),
        environment: profile.environment,
        status: payload.status === "passed" ? "passed" : "failed",
        startedAt,
        finishedAt: new Date().toISOString(),
        output: payload.output ?? "",
        error: payload.error ?? "",
        summary: payload.summary,
      };
    } catch (error) {
      if (error instanceof ConsoleError && error.code === "PAGE_PARAMETERS_UNAVAILABLE") throw error;
      return {
        replayId,
        pageId,
        profileId,
        platform: isMiniProgramTarget(execution) ? "all" : execution.platform,
        ...(isMiniProgramTarget(execution) ? {
          targetKey: execution.key,
          targetKind: execution.kind,
          targetPlatform: execution.platform,
        } : {}),
        environment: profile.environment,
        status: "failed",
        startedAt,
        finishedAt: new Date().toISOString(),
        output: "",
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  async saveProfile(pageId: string, profileId: string, input: SavePageParameterProfileRequest): Promise<PageParameterProfile> {
    const catalog = await this.callProvider<CatalogPayload>("catalog");
    const page = catalog.pages.find(item => item.pageId === pageId);
    if (!page) throw new ConsoleError("PAGE_PARAMETER_PAGE_UNKNOWN", `页面不存在: ${pageId}`, 404);
    const capturedKeys = new Set(input.capturedKeys ?? []);
    const missing: string[] = [];
    const alternativeGroups = new Map<string, string[]>();
    const groupedKeys = new Set<string>();
    for (const field of page.fields) {
      const alternatives = [...new Set(field.alternatives ?? [])].filter(Boolean);
      if (alternatives.length > 1 && (field.required || field.requirement === "conditional")) {
        alternativeGroups.set([...alternatives].sort().join("\u0000"), alternatives);
        alternatives.forEach(key => groupedKeys.add(key));
      }
    }
    for (const field of page.fields.filter(item => item.required)) {
      if (groupedKeys.has(field.key)) continue;
      if (!hasProfileValue(input.values[field.key], capturedKeys, field.key)) missing.push(field.key);
    }
    for (const alternatives of alternativeGroups.values()) {
      if (!alternatives.some(key => hasProfileValue(input.values[key], capturedKeys, key))) {
        missing.push(alternatives.join(" / "));
      }
    }
    if (missing.length > 0) throw new ConsoleError("PAGE_PARAMETER_REQUIRED", `缺少必填参数: ${missing.join(", ")}`);
    for (const field of page.fields.filter(item => item.sensitive)) {
      if (input.values[field.key]?.strategy === "literal") {
        throw new ConsoleError("PAGE_PARAMETER_SENSITIVE_LITERAL", `敏感参数需使用 secretRef: ${field.key}`);
      }
    }
    const targetMap = new Map((page.targets ?? []).map(target => [target.id, target]));
    const assertionTargets = new Set(page.assertionTargets ?? []);
    const profileAssertions = ensurePageReadyAssertion(input.assertions, resolveProjectAdapter(this.config).pageParameters.pageReadyEvent);
    for (const action of input.actions ?? []) {
      if (action.type !== "screenshot") {
        const target = targetMap.get(action.target);
        if (!target && !(action.type === "waitFor" && assertionTargets.has(action.target))) {
          throw new ConsoleError("PAGE_SCENARIO_TARGET_UNKNOWN", `页面动作目标不存在: ${action.target}`);
        }
        if (target && action.type !== "waitFor" && !targetSupportsAction(target, action.type, input.platform ?? "all")) {
          throw new ConsoleError("PAGE_SCENARIO_ACTION_UNSUPPORTED", `${action.target} 不支持动作 ${action.type}`);
        }
        if (action.type === "input" && !String(action.value ?? "").trim()) {
          throw new ConsoleError("PAGE_SCENARIO_ACTION_VALUE_REQUIRED", `输入动作需要填写内容: ${action.target}`);
        }
        if ((action.assertions?.length ?? 0) === 0) {
          throw new ConsoleError("PAGE_SCENARIO_ACTION_ASSERTION_REQUIRED", `页面动作需要配置响应断言: ${action.target}`);
        }
      }
      this.validateAssertions(action.assertions, assertionTargets);
    }
    this.validateAssertions(profileAssertions, assertionTargets);
    const now = new Date().toISOString();
    const state = await this.store.load();
    const previous = state.profiles.find(item => item.pageId === pageId && item.profileId === profileId);
    const isDefault = input.isDefault ?? previous?.isDefault ?? false;
    const profile: PageParameterProfile = {
      profileId,
      pageId,
      scenario: input.scenario,
      platform: input.platform ?? "all",
      ...(isDefault ? { isDefault: true } : {}),
      environment: input.environment,
      accountLabel: input.accountLabel,
      values: input.values,
      navigation: input.navigation ?? page.navigation ?? buildDefaultNavigation(page.bundle || page.pageId, resolveProjectAdapter(this.config).pageParameters),
      actions: input.actions ?? [],
      assertions: profileAssertions,
      source: input.source ?? "manual",
      recordedAt: input.recordedAt ?? now,
      validatedAt: now,
      expiresAt: input.expiresAt ?? "",
      version: 1,
    };
    state.profiles = state.profiles
      .filter(item => !(item.pageId === pageId && item.profileId === profileId))
      .map(item => item.pageId === pageId && isDefault ? { ...item, isDefault: false } : item);
    state.profiles.push(profile);
    await this.store.save(state);
    return profile;
  }

  async setDefaultProfile(pageId: string, profileId: string, isDefault = true): Promise<PageParameterProfile> {
    const state = await this.store.load();
    const profile = state.profiles.find(item => item.pageId === pageId && item.profileId === profileId);
    if (!profile) throw new ConsoleError("PAGE_PARAMETER_PROFILE_UNKNOWN", `参数画像不存在: ${profileId}`, 404);
    state.profiles = state.profiles.map(item => item.pageId === pageId
      ? { ...item, isDefault: isDefault && item.profileId === profileId }
      : item);
    await this.store.save(state);
    return state.profiles.find(item => item.pageId === pageId && item.profileId === profileId)!;
  }

  private validateAssertions(
    assertions: SavePageParameterProfileRequest["assertions"],
    assertionTargets: Set<string>,
  ): void {
    for (const assertion of assertions ?? []) {
      if (assertion.type === "runtimeEvent") {
        if (!String(assertion.event ?? "").trim()) {
          throw new ConsoleError("PAGE_SCENARIO_ASSERTION_EVENT_REQUIRED", "runtimeEvent 断言需要事件名");
        }
        continue;
      }
      if (!assertion.target || !assertionTargets.has(assertion.target)) {
        throw new ConsoleError("PAGE_SCENARIO_ASSERTION_TARGET_UNKNOWN", `页面断言目标不存在: ${assertion.target ?? ""}`);
      }
      if (assertion.type === "text" && !String(assertion.value ?? "").trim()) {
        throw new ConsoleError("PAGE_SCENARIO_ASSERTION_VALUE_REQUIRED", `文本断言需要填写期望文本: ${assertion.target}`);
      }
    }
  }

  async deleteProfile(pageId: string, profileId: string): Promise<void> {
    const state = await this.store.load();
    const next = state.profiles.filter(item => !(item.pageId === pageId && item.profileId === profileId));
    if (next.length === state.profiles.length) throw new ConsoleError("PAGE_PARAMETER_PROFILE_UNKNOWN", `参数画像不存在: ${profileId}`, 404);
    state.profiles = next;
    await this.store.save(state);
  }

  private callRecordingProvider(action: "recording-start" | "recording-status" | "recording-stop", recording: PageParameterRecording) {
    return this.callProvider<RecordingPayload>(action, [
      "--recording-id", recording.recordingId,
      "--environment", recording.environment,
      ...(recording.targetKey ? targetProviderArgs({
        kind: "mini-program",
        key: recording.targetKey,
        label: recording.targetLabel ?? recording.targetKey,
        platform: recording.targetPlatform ?? "",
        runtime: recording.targetRuntime ?? "",
        appId: recording.targetAppId ?? "",
        concurrencyKey: recording.targetKey,
      }) : [
        "--device", recording.deviceId,
        "--platform", recording.platform,
      ]),
    ]);
  }

  private async callProvider<T>(action: "catalog" | "recording-start" | "recording-status" | "recording-stop" | "replay", extraArgs: string[] = []): Promise<T> {
    const command = resolvePageParameterProviderCommand(this.config, action);
    if (!command) throw new ConsoleError("PAGE_PARAMETERS_UNAVAILABLE", "项目未配置页面参数 provider", 404);
    const result = await capture(command, extraArgs, action === "replay" ? 15 * 60_000 : 120_000);
    if (result.code !== 0) throw new ConsoleError("PAGE_PARAMETER_PROVIDER_FAILED", result.stderr || result.stdout || `provider 退出码 ${result.code}`, 502);
    try {
      return JSON.parse(result.stdout) as T;
    } catch {
      throw new ConsoleError("PAGE_PARAMETER_PROVIDER_INVALID", "页面参数 provider 返回了无效 JSON", 502);
    }
  }
}

function targetSupportsAction(target: PageScenarioTarget, action: PageScenarioActionType, platform: PageParameterPlatform): boolean {
  const platforms = platform === "all" ? PLATFORMS : [platform];
  return platforms.every(currentPlatform => {
    if (target.platforms && !target.platforms.includes(currentPlatform)) return false;
    const actions = target.platformActions?.[currentPlatform] ?? target.actions;
    return actions.includes(action);
  });
}

function isMiniProgramTarget(execution: Device | MiniProgramRunTarget): execution is MiniProgramRunTarget {
  return "kind" in execution && execution.kind === "mini-program";
}

function targetProviderArgs(target: MiniProgramRunTarget): string[] {
  return [
    "--target-key", target.key,
    "--target-kind", target.kind,
    "--target-label", target.label,
    "--target-platform", target.platform,
    "--target-runtime", target.runtime,
    "--target-app-id", target.appId,
    "--target-concurrency-key", target.concurrencyKey,
  ];
}

// 允许录制到的空字符串作为存在的路由键，同时要求手工画像填写实际值。
function hasProfileValue(
  parameter: SavePageParameterProfileRequest["values"][string] | undefined,
  capturedKeys: Set<string>,
  key: string,
): boolean {
  if (!parameter) return false;
  if (String(parameter.value ?? "").length > 0) return true;
  return parameter.strategy === "literal" && capturedKeys.has(key);
}

function ensurePageReadyAssertion(
  assertions: SavePageParameterProfileRequest["assertions"],
  pageReadyEvent: string,
): NonNullable<SavePageParameterProfileRequest["assertions"]> {
  const next = [...(assertions ?? [])];
  if (pageReadyEvent && !next.some(assertion => assertion.type === "runtimeEvent" && assertion.event === pageReadyEvent)) {
    next.unshift({ type: "runtimeEvent", event: pageReadyEvent });
  }
  return next;
}

function buildDefaultNavigation(
  bundle: string,
  adapter: ReturnType<typeof resolveProjectAdapter>["pageParameters"],
): SavePageParameterProfileRequest["navigation"] {
  if (!adapter.defaultRoute) return undefined;
  return { route: adapter.defaultRoute, params: { [adapter.templateParameter]: bundle } };
}

function findRecording(recordings: PageParameterRecording[], recordingId: string): PageParameterRecording {
  const recording = recordings.find(item => item.recordingId === recordingId);
  if (!recording) throw new ConsoleError("PAGE_PARAMETER_RECORDING_UNKNOWN", `录制会话不存在: ${recordingId}`, 404);
  return recording;
}

function mergeObservations(previous: PageParameterObservation[], next: PageParameterObservation[]): PageParameterObservation[] {
  const values = new Map(previous.map(item => [observationKey(item), item]));
  for (const item of next) values.set(observationKey(item), item);
  return [...values.values()].sort((left, right) => left.capturedAt.localeCompare(right.capturedAt));
}

function observationKey(item: PageParameterObservation): string {
  return JSON.stringify([item.capturedAt, item.pageId, item.bundle, item.values]);
}

function capture(command: ResolvedCommand, extraArgs: string[], timeout: number): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise(resolve => {
    execFile(command.executable, [...command.args, ...extraArgs], {
      cwd: command.cwd,
      env: { ...process.env, ...command.env },
      encoding: "utf8",
      timeout,
      maxBuffer: 16 * 1024 * 1024,
    }, (error, stdout, stderr) => {
      const code = typeof (error as NodeJS.ErrnoException & { code?: number })?.code === "number"
        ? Number((error as NodeJS.ErrnoException & { code?: number }).code)
        : error ? 1 : 0;
      resolve({ code, stdout: String(stdout || ""), stderr: String(stderr || error?.message || "") });
    });
  });
}
