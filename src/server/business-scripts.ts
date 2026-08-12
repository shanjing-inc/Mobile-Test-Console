import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import type {
  BusinessScenario,
  BusinessScriptDraft,
  BusinessScriptRecording,
  BusinessScriptReplay,
  BusinessScriptsResponse,
  BusinessSuite,
  Device,
  PublishedBusinessScript,
  SaveBusinessScriptDraftRequest,
} from "../shared/contracts.js";
import { resolveBusinessScriptProviderCommand, type LoadedProjectConfig, type ResolvedCommand } from "./config.js";
import { ConsoleError } from "./errors.js";
import { BusinessScriptStore } from "./business-script-store.js";

interface ProviderPayload {
  schemaVersion: "mobile-test-console.business-script-provider.v1";
  status: "recording" | "stopped" | "failed" | "planned" | "passed";
  draft?: BusinessScriptDraft;
  error?: string;
}

export class BusinessScriptService {
  constructor(private readonly config: LoadedProjectConfig, private readonly store: BusinessScriptStore) {}

  async snapshot(): Promise<BusinessScriptsResponse> {
    const state = await this.store.load();
    return {
      schemaVersion: "mobile-test-console.business-scripts.v1",
      recordings: state.recordings,
      drafts: state.drafts,
      scripts: state.scripts,
      suites: state.suites,
    };
  }

  async startRecording(device: Device, environment: string, appBuild: string): Promise<BusinessScriptRecording> {
    if (!this.config.businessScripts) throw new ConsoleError("BUSINESS_SCRIPTS_UNAVAILABLE", "项目未配置业务脚本 provider", 404);
    const recording = await this.store.update(state => {
      const active = state.recordings.find(item => item.deviceKey === device.key && isActiveRecording(item));
      if (active) throw new ConsoleError("BUSINESS_SCRIPT_RECORDING_ACTIVE", `${device.name} 已有业务录制会话`, 409);
      const next: BusinessScriptRecording = {
        recordingId: randomUUID(), deviceKey: device.key, deviceId: device.id, platform: device.platform,
        environment, appBuild, status: "starting", startedAt: new Date().toISOString(), stoppedAt: "", error: "", draftId: "",
      };
      state.recordings.unshift(next);
      return next;
    });
    let payload: ProviderPayload | undefined;
    let providerError = "";
    try {
      payload = await this.callProvider("recording-start", recording);
    } catch (error) {
      providerError = error instanceof Error ? error.message : String(error);
    }
    return this.store.update(state => {
      const current = findRecording(state.recordings, recording.recordingId);
      if (!isActiveRecording(current)) return current;
      current.status = payload?.status === "recording" ? "recording" : "failed";
      current.error = payload?.error ?? providerError;
      return current;
    });
  }

  async refreshRecording(recordingId: string): Promise<BusinessScriptRecording> {
    const state = await this.store.load();
    const recording = findRecording(state.recordings, recordingId);
    if (!isActiveRecording(recording)) return recording;
    const payload = await this.callProvider("recording-status", recording);
    return this.store.update(latest => {
      const current = findRecording(latest.recordings, recordingId);
      if (!isActiveRecording(current)) return current;
      current.status = payload.status === "recording" ? "recording" : payload.status === "stopped" ? "stopped" : "failed";
      current.error = payload.error ?? "";
      if (payload.draft) upsertDraft(latest.drafts, payload.draft, current);
      return current;
    });
  }

  async stopRecording(recordingId: string): Promise<{ recording: BusinessScriptRecording; draft?: BusinessScriptDraft }> {
    const state = await this.store.load();
    const recording = findRecording(state.recordings, recordingId);
    if (!isActiveRecording(recording)) {
      return { recording, draft: state.drafts.find(item => item.draftId === recording.draftId) };
    }
    const payload = await this.callProvider("recording-stop", recording);
    return this.store.update(latest => {
      const current = findRecording(latest.recordings, recordingId);
      if (isActiveRecording(current)) {
        current.status = payload.status === "stopped" ? "stopped" : "failed";
        current.error = payload.error ?? "";
        current.stoppedAt = new Date().toISOString();
        if (payload.draft) upsertDraft(latest.drafts, payload.draft, current);
      }
      return { recording: current, draft: latest.drafts.find(item => item.draftId === current.draftId) };
    });
  }

  async saveDraft(draftId: string, input: SaveBusinessScriptDraftRequest): Promise<BusinessScriptDraft> {
    validateDraft(input, false);
    return this.store.update(state => {
      const draft = state.drafts.find(item => item.draftId === draftId);
      if (!draft) throw new ConsoleError("BUSINESS_SCRIPT_DRAFT_UNKNOWN", `脚本草稿不存在: ${draftId}`, 404);
      Object.assign(draft, input, { updatedAt: new Date().toISOString() });
      return draft;
    });
  }

  async publish(draftId: string): Promise<PublishedBusinessScript> {
    return this.store.update(state => {
      const draft = state.drafts.find(item => item.draftId === draftId);
      if (!draft) throw new ConsoleError("BUSINESS_SCRIPT_DRAFT_UNKNOWN", `脚本草稿不存在: ${draftId}`, 404);
      validateDraft(draft, true);
      const scriptId = slug(draft.name) || draft.draftId.replace(/^draft-/, "script-");
      const version = Math.max(
        state.versionCounters[scriptId] || 0,
        ...state.scripts.filter(item => item.scriptId === scriptId).map(item => item.version),
      ) + 1;
      state.versionCounters[scriptId] = version;
      const script: PublishedBusinessScript = {
        schemaVersion: "mobile-test-console.business-script.v1", scriptId, version, sourceDraftId: draftId,
        name: draft.name, platformScope: draft.platformScope, startPage: draft.startPage,
        expectedFinalPage: draft.expectedFinalPage, variables: structuredClone(draft.variables), steps: structuredClone(draft.steps),
        assertions: structuredClone(draft.assertions), scenarios: structuredClone(draft.scenarios),
        createdAt: draft.createdAt, publishedAt: new Date().toISOString(),
      };
      state.scripts.push(script);
      return script;
    });
  }

  async deletePublishedVersion(scriptId: string, version: number): Promise<{
    script: PublishedBusinessScript;
    removedSuiteReferenceCount: number;
    removedSuiteCount: number;
  }> {
    return this.store.update(state => {
      const index = state.scripts.findIndex(item => item.scriptId === scriptId && item.version === version);
      if (index < 0) throw new ConsoleError("BUSINESS_SCRIPT_VERSION_UNKNOWN", `已发布脚本不存在: ${scriptId}@${version}`, 404);
      const [script] = state.scripts.splice(index, 1);
      state.versionCounters[scriptId] = Math.max(state.versionCounters[scriptId] || 0, version);
      let removedSuiteReferenceCount = 0;
      let removedSuiteCount = 0;
      state.suites = state.suites.filter(suite => {
        const previousCount = suite.scenarioRefs.length;
        suite.scenarioRefs = suite.scenarioRefs.filter(reference => (
          reference.scriptId !== scriptId || reference.version !== version
        ));
        removedSuiteReferenceCount += previousCount - suite.scenarioRefs.length;
        if (previousCount > 0 && suite.scenarioRefs.length === 0) {
          removedSuiteCount += 1;
          return false;
        }
        return true;
      });
      return { script, removedSuiteReferenceCount, removedSuiteCount };
    });
  }

  async saveSuite(suiteId: string, input: Omit<BusinessSuite, "suiteId" | "updatedAt">): Promise<BusinessSuite> {
    return this.store.update(state => {
      for (const reference of input.scenarioRefs) {
        const { script } = findPublishedScenario(state.scripts, reference);
        const unsupported = input.platformMatrix.find(platform => !script.platformScope.includes(platform));
        if (unsupported) throw new ConsoleError("BUSINESS_SCRIPT_PLATFORM_MISMATCH", `${reference.scriptId}@${reference.version} 未发布 ${unsupported} 版本`, 409);
      }
      const suite = { suiteId, ...input, updatedAt: new Date().toISOString() };
      state.suites = state.suites.filter(item => item.suiteId !== suiteId);
      state.suites.push(suite);
      return suite;
    });
  }

  async replayScenario(scriptId: string, version: number, scenarioId: string, device: Device): Promise<BusinessScriptReplay> {
    const state = await this.store.load();
    const { script } = findPublishedScenario(state.scripts, { scriptId, version, scenarioId });
    if (!script.platformScope.includes(device.platform)) throw new ConsoleError("BUSINESS_SCRIPT_PLATFORM_MISMATCH", `${scriptId}@${version} 未发布 ${device.platform} 版本`, 409);
    const replayId = randomUUID();
    const startedAt = new Date().toISOString();
    try {
      const payload = await this.callProvider("replay", undefined, [
        "--script-id", scriptId, "--version", String(version), "--scenario-id", scenarioId,
        "--device", device.id, "--platform", device.platform, "--run-id", replayId,
      ]);
      return { replayId, scriptId, version, scenarioId, platform: device.platform, status: payload.status === "passed" ? "passed" : payload.status === "planned" ? "planned" : "failed", startedAt, finishedAt: new Date().toISOString(), output: JSON.stringify(payload), error: payload.error ?? "" };
    } catch (error) {
      return { replayId, scriptId, version, scenarioId, platform: device.platform, status: "failed", startedAt, finishedAt: new Date().toISOString(), output: "", error: error instanceof Error ? error.message : String(error) };
    }
  }

  async replaySuite(suiteId: string, device: Device): Promise<BusinessScriptReplay[]> {
    const state = await this.store.load();
    const suite = state.suites.find(item => item.suiteId === suiteId);
    if (!suite) throw new ConsoleError("BUSINESS_SUITE_UNKNOWN", `业务套件不存在: ${suiteId}`, 404);
    if (!suite.platformMatrix.includes(device.platform)) throw new ConsoleError("BUSINESS_SCRIPT_PLATFORM_MISMATCH", `${suiteId} 未声明 ${device.platform}`, 409);
    for (const reference of suite.scenarioRefs) {
      const { script } = findPublishedScenario(state.scripts, reference);
      if (!script.platformScope.includes(device.platform)) {
        throw new ConsoleError("BUSINESS_SCRIPT_PLATFORM_MISMATCH", `${reference.scriptId}@${reference.version} 未发布 ${device.platform} 版本`, 409);
      }
    }
    const results = [];
    for (const reference of suite.scenarioRefs) results.push(await this.replayScenario(reference.scriptId, reference.version, reference.scenarioId, device));
    return results;
  }

  private callProvider(action: "recording-start" | "recording-status" | "recording-stop" | "replay", recording?: BusinessScriptRecording, extra: string[] = []): Promise<ProviderPayload> {
    const command = resolveBusinessScriptProviderCommand(this.config, action);
    if (!command) throw new ConsoleError("BUSINESS_SCRIPTS_UNAVAILABLE", "项目未配置业务脚本 provider", 404);
    const args = recording ? ["--recording-id", recording.recordingId, "--device", recording.deviceId, "--platform", recording.platform, "--environment", recording.environment, "--app-build", recording.appBuild] : extra;
    return capture(command, args);
  }
}

function upsertDraft(drafts: BusinessScriptDraft[], draft: BusinessScriptDraft, recording: BusinessScriptRecording) {
  const index = drafts.findIndex(item => item.draftId === draft.draftId);
  if (index >= 0) drafts[index] = draft;
  else drafts.unshift(draft);
  recording.draftId = draft.draftId;
}

function findRecording(items: BusinessScriptRecording[], recordingId: string) {
  const recording = items.find(item => item.recordingId === recordingId);
  if (!recording) throw new ConsoleError("BUSINESS_SCRIPT_RECORDING_UNKNOWN", `业务录制会话不存在: ${recordingId}`, 404);
  return recording;
}

function validateDraft(input: Pick<BusinessScriptDraft, "name" | "steps" | "assertions" | "scenarios"> & Partial<Pick<BusinessScriptDraft, "variables">>, forPublish: boolean) {
  if (!input.name.trim()) throw new ConsoleError("BUSINESS_SCRIPT_NAME_REQUIRED", "脚本名称不能为空");
  const stepIds = new Set(input.steps.map(item => item.stepId));
  const assertionIds = new Set(input.assertions.map(item => item.assertionId));
  if (stepIds.size !== input.steps.length) throw new ConsoleError("BUSINESS_SCRIPT_STEP_DUPLICATE", "脚本步骤 ID 重复");
  const scenarioIds = new Set(input.scenarios.map(item => item.scenarioId));
  if (scenarioIds.size !== input.scenarios.length) throw new ConsoleError("BUSINESS_SCENARIO_DUPLICATE", "业务场景 ID 重复");
  for (const scenario of input.scenarios) {
    if (scenario.stepIds.some(id => !stepIds.has(id))) throw new ConsoleError("BUSINESS_SCENARIO_STEP_UNKNOWN", `${scenario.scenarioId} 引用了未知步骤`);
    if (scenario.assertionIds.some(id => !assertionIds.has(id))) throw new ConsoleError("BUSINESS_SCENARIO_ASSERTION_UNKNOWN", `${scenario.scenarioId} 引用了未知断言`);
    if (scenario.setupRef && !scenarioIds.has(scenario.setupRef)) throw new ConsoleError("BUSINESS_SCENARIO_SETUP_UNKNOWN", `${scenario.scenarioId} 引用了未知前置场景`);
  }
  validateScenarioSetupGraph(input.scenarios);
  if (!forPublish) return;
  if (input.scenarios.length === 0) throw new ConsoleError("BUSINESS_SCENARIO_REQUIRED", "发布前至少需要一个业务场景");
  const variables = new Map((input.variables || []).map(item => [item.name, item]));
  if (variables.size !== (input.variables || []).length) throw new ConsoleError("BUSINESS_SCRIPT_VARIABLE_DUPLICATE", "脚本变量名称重复");
  for (const step of input.steps) {
    if (step.status !== "resolved") throw new ConsoleError("BUSINESS_SCRIPT_STEP_NEEDS_REVIEW", `步骤 ${step.stepId} 仍需校正`);
    if (["tap", "input"].includes(step.actionType)) {
      const stableTarget = step.semanticTarget?.status === "resolved"
        && ["accessibilityId", "text"].includes(step.semanticTarget.strategy)
        && Boolean(step.semanticTarget.value);
      const approvedPoint = step.semanticTarget?.status === "resolved"
        && step.semanticTarget.strategy === "point"
        && Number.isFinite(step.rawPoint?.x)
        && Number.isFinite(step.rawPoint?.y);
      if (!stableTarget && !approvedPoint) throw new ConsoleError("BUSINESS_SCRIPT_TARGET_REQUIRED", `步骤 ${step.stepId} 缺少稳定 target`);
    }
    if (step.actionType === "input") {
      const binding = step.inputBinding;
      if (!binding || !["literal", "secretRef", "runtimeResolver"].includes(binding.strategy)) {
        throw new ConsoleError("BUSINESS_SCRIPT_INPUT_BINDING_REQUIRED", `输入步骤 ${step.stepId} 缺少输入值或变量引用`);
      }
      if (binding.strategy === "literal") continue;
      if (!binding.value) throw new ConsoleError("BUSINESS_SCRIPT_INPUT_BINDING_REQUIRED", `输入步骤 ${step.stepId} 缺少变量引用`);
      const variable = variables.get(binding.value);
      if (!variable) throw new ConsoleError("BUSINESS_SCRIPT_VARIABLE_UNKNOWN", `输入步骤 ${step.stepId} 引用了未知变量`);
      if (variable.strategy !== binding.strategy) {
        throw new ConsoleError("BUSINESS_SCRIPT_VARIABLE_STRATEGY_MISMATCH", `输入步骤 ${step.stepId} 的变量解析策略不一致`);
      }
    }
  }
}

function validateScenarioSetupGraph(scenarios: BusinessScenario[]) {
  const byId = new Map(scenarios.map(item => [item.scenarioId, item]));
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (scenario: BusinessScenario) => {
    if (visiting.has(scenario.scenarioId)) throw new ConsoleError("BUSINESS_SCENARIO_SETUP_CYCLE", `业务场景前置依赖存在循环: ${scenario.scenarioId}`);
    if (visited.has(scenario.scenarioId)) return;
    visiting.add(scenario.scenarioId);
    if (scenario.setupRef) visit(byId.get(scenario.setupRef)!);
    visiting.delete(scenario.scenarioId);
    visited.add(scenario.scenarioId);
  };
  scenarios.forEach(visit);
}

function isActiveRecording(recording: BusinessScriptRecording): boolean {
  return ["starting", "recording"].includes(recording.status);
}

function findPublishedScenario(scripts: PublishedBusinessScript[], reference: { scriptId: string; version: number; scenarioId: string }): { script: PublishedBusinessScript; scenario: BusinessScenario } {
  const script = scripts.find(item => item.scriptId === reference.scriptId && item.version === reference.version);
  const scenario = script?.scenarios.find(item => item.scenarioId === reference.scenarioId);
  if (!script || !scenario) throw new ConsoleError("BUSINESS_SCENARIO_UNKNOWN", `已发布场景不存在: ${reference.scriptId}@${reference.version}/${reference.scenarioId}`, 404);
  return { script, scenario };
}

function slug(value: string) {
  return value.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 64);
}

function capture(command: ResolvedCommand, extraArgs: string[]): Promise<ProviderPayload> {
  return new Promise((resolve, reject) => {
    execFile(command.executable, [...command.args, ...extraArgs], { cwd: command.cwd, env: { ...process.env, ...command.env }, encoding: "utf8", timeout: 300_000, maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) return reject(new ConsoleError("BUSINESS_SCRIPT_PROVIDER_FAILED", String(stderr || error.message), 502));
      try {
        const payload = JSON.parse(String(stdout)) as ProviderPayload;
        if (payload.schemaVersion !== "mobile-test-console.business-script-provider.v1" || !["recording", "stopped", "failed", "planned", "passed"].includes(payload.status)) {
          return reject(new ConsoleError("BUSINESS_SCRIPT_PROVIDER_INVALID", "业务脚本 provider 协议无效", 502));
        }
        resolve(payload);
      }
      catch { reject(new ConsoleError("BUSINESS_SCRIPT_PROVIDER_INVALID", "业务脚本 provider 返回了无效 JSON", 502)); }
    });
  });
}
