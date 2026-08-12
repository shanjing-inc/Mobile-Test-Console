import fs from "node:fs";
import path from "node:path";
import fastifyStatic from "@fastify/static";
import Fastify, { type FastifyInstance } from "fastify";
import { z } from "zod";
import { ACTIVE_TASK_STATUSES, ARTIFACT_RUN_ID_PATTERN, PAGE_PARAMETER_PLATFORMS, PLATFORMS, type AccountProfileProvider, type ApplyProjectInitializationRequest, type ApplyProjectSetupRequest, type ArtifactCleanupApplyRequest, type BusinessSuite, type ConsoleSnapshot, type PreviewProjectInitializationRequest, type ProjectProviderManifestSummary, type RegisterProjectRequest, type SaveBusinessScriptDraftRequest, type SavePageParameterProfileRequest, type StartAccountProfileRecordingRequest, type StartBusinessScriptRecordingRequest, type StartPageParameterRecordingRequest, type StartTasksRequest, type RunTarget } from "../shared/contracts.js";
import { toPublicTests, validateParameters, type LoadedProjectConfig } from "./config.js";
import type { DeviceDiscoveryService } from "./devices.js";
import { ConsoleError } from "./errors.js";
import type { TaskManager } from "./task-manager.js";
import { TaskResultService } from "./task-results.js";
import { PageParameterStore } from "./page-parameter-store.js";
import { PageParameterService } from "./page-parameters.js";
import { AccountProfileStore } from "./account-profile-store.js";
import { AccountProfileService, toAccountProfileRecordingSummary, toAccountProfileSummary } from "./account-profiles.js";
import { resolveProjectAdapter } from "./project-adapter.js";
import { BusinessScriptStore } from "./business-script-store.js";
import { BusinessScriptService } from "./business-scripts.js";
import type { RepairJobManager } from "./repair-job-manager.js";
import type { TaskResultService as TaskResultServiceType } from "./task-results.js";
import type { ResultBundleStore } from "./result-bundle-store.js";
import { resolveProjectConfigSelection, scanProjectDirectory, type ProjectCatalogService } from "./project-catalog.js";
import { DirectoryPicker } from "./directory-picker.js";
import type { ArtifactRetentionService } from "./artifact-retention.js";

const startRequestSchema = z.object({
  testId: z.string().min(1),
  deviceKeys: z.array(z.string().min(1)).optional(),
  targetKeys: z.array(z.string().min(1)).optional(),
  parameters: z.record(z.string()).default({}),
}).refine(value => (value.deviceKeys?.length ?? 0) > 0 || (value.targetKeys?.length ?? 0) > 0, {
  message: "请至少选择一个设备或运行目标",
}).refine(value => !value.deviceKeys?.length || !value.targetKeys?.length, {
  message: "设备和运行目标只能选择其中一种",
});

const accountProfileProviderSchema = z.string().regex(/^[a-z][a-z0-9-]*$/);

const startDeviceRequestSchema = z.object({
  deviceKey: z.string().min(1),
});

const createRepairRequestSchema = z.object({
  caseRunId: z.string().min(1).optional(),
  projectDirectory: z.string().min(1).optional(),
});

const installDevicePreparationSchema = z.object({
  deviceKey: z.string().min(1),
  preparationId: z.string().min(1),
});

const startPageParameterRecordingSchema = z.object({
  deviceKey: z.string().min(1),
  environment: z.string().min(1),
});

const replayPageParameterProfileSchema = z.object({
  deviceKey: z.string().min(1),
});

const pageScenarioAssertionSchema = z.object({
  type: z.enum(["runtimeEvent", "visible", "text", "selected"]),
  target: z.string().optional(),
  event: z.string().optional(),
  value: z.string().optional(),
});

const savePageParameterProfileSchema = z.object({
  scenario: z.string().min(1),
  platform: z.enum(PAGE_PARAMETER_PLATFORMS).default("all"),
  isDefault: z.boolean().optional(),
  environment: z.string().min(1),
  accountLabel: z.string().default(""),
  values: z.record(z.object({
    strategy: z.enum(["literal", "secretRef", "runtimeResolver"]),
    value: z.string(),
  })),
  capturedKeys: z.array(z.string().min(1)).optional(),
  navigation: z.object({
    route: z.string().min(1),
    params: z.record(z.string()),
  }).optional(),
  actions: z.array(z.object({
    type: z.enum(["tap", "input", "select", "submit", "waitFor", "screenshot"]),
    target: z.string(),
    value: z.string().optional(),
    timeoutMs: z.number().int().positive().optional(),
    assertions: z.array(pageScenarioAssertionSchema).optional(),
  })).optional(),
  assertions: z.array(pageScenarioAssertionSchema).optional(),
  source: z.enum(["recording", "manual", "manifest"]).optional(),
  recordedAt: z.string().optional(),
  expiresAt: z.string().optional(),
});

const setDefaultPageParameterProfileSchema = z.object({
  isDefault: z.boolean().default(true),
}).default({});

const startAccountProfileRecordingSchema = z.object({
  deviceKey: z.string().min(1),
  profileId: z.string().regex(/^[A-Za-z0-9._-]+$/),
  accountLabel: z.string().min(1).max(80),
  provider: accountProfileProviderSchema,
  environment: z.string().min(1).max(40),
});

const replayAccountProfileSchema = z.object({
  deviceKey: z.string().min(1),
  provider: accountProfileProviderSchema,
});

const accountProfileSourceSchema = z.object({
  provider: accountProfileProviderSchema,
});

const startBusinessScriptRecordingSchema = z.object({
  deviceKey: z.string().min(1),
  environment: z.string().min(1),
  appBuild: z.string().default("qa-installed"),
});

const businessTargetSchema = z.object({
  strategy: z.enum(["accessibilityId", "text", "point", "system"]),
  value: z.string(),
  status: z.enum(["resolved", "needs-review"]),
});

const businessStepSchema = z.object({
  stepId: z.string().min(1), name: z.string().min(1), kind: z.enum(["action", "system", "pageTransition"]),
  actionType: z.enum(["tap", "input", "swipe", "back", "waitFor", "screenshot", "pageTransition"]),
  semanticTarget: businessTargetSchema.optional(),
  rawPoint: z.object({ x: z.number(), y: z.number() }).nullable().optional(),
  start: z.tuple([z.number(), z.number()]).nullable().optional(), end: z.tuple([z.number(), z.number()]).nullable().optional(),
  inputBinding: z.object({ strategy: z.enum(["literal", "secretRef", "runtimeResolver"]), value: z.string() }).optional(),
  timeoutMs: z.number().positive().optional(), pageId: z.string().optional(), beforePageInstanceId: z.string().optional(),
  afterPageInstanceId: z.string().optional(), screenshotRef: z.string().optional(), hierarchyRef: z.string().optional(),
  status: z.enum(["resolved", "needs-review"]), raw: z.record(z.unknown()).optional(),
});

const businessAssertionSchema = z.object({
  assertionId: z.string().min(1), type: z.enum(["page", "visible", "text", "runtimeEvent"]),
  page: z.string().optional(), target: z.string().optional(), value: z.string().optional(), event: z.string().optional(),
});

const businessScenarioSchema = z.object({
  scenarioId: z.string().min(1), name: z.string().min(1), setupRef: z.string().optional(), startPage: z.string(),
  expectedFinalPage: z.string(), tags: z.array(z.string()), stepIds: z.array(z.string()), assertionIds: z.array(z.string()),
});

const saveBusinessScriptDraftSchema = z.object({
  name: z.string().min(1), startPage: z.string(), expectedFinalPage: z.string(),
  variables: z.array(z.object({
    name: z.string().min(1),
    strategy: z.enum(["literal", "secretRef", "runtimeResolver"]),
    sensitive: z.boolean(),
  })).optional(),
  steps: z.array(businessStepSchema), assertions: z.array(businessAssertionSchema), scenarios: z.array(businessScenarioSchema),
});

const replayBusinessScriptSchema = z.object({ deviceKey: z.string().min(1) });
const saveBusinessSuiteSchema = z.object({
  name: z.string().min(1),
  scenarioRefs: z.array(z.object({ scriptId: z.string().min(1), version: z.number().int().positive(), scenarioId: z.string().min(1) })).min(1),
  platformMatrix: z.array(z.enum(PLATFORMS)).min(1),
});

const registerProjectSchema = z.object({
  projectDirectory: z.string().trim().min(1),
  configFile: z.string().trim().min(1).default("mobile-test.config.cjs"),
});

const previewProjectInitializationSchema = z.object({
  projectDirectory: z.string().trim().min(1),
  platforms: z.array(z.enum(PLATFORMS)).min(1),
});

const applyProjectInitializationSchema = previewProjectInitializationSchema.extend({
  planId: z.string().min(1),
});

const previewProjectSetupSchema = z.object({
  step: z.enum(["devices", "capabilities"]),
});

const applyProjectSetupSchema = previewProjectSetupSchema.extend({
  planId: z.string().min(1),
});

const taskRetentionSchema = z.object({ retained: z.boolean() });
const artifactCleanupApplySchema = z.object({
  runIds: z.array(z.string().regex(ARTIFACT_RUN_ID_PATTERN)).min(1).max(500).optional(),
}).strict();

export interface CreateAppOptions {
  config: LoadedProjectConfig;
  devices: DeviceDiscoveryService;
  tasks: TaskManager;
  repairs?: RepairJobManager;
  taskResults?: TaskResultServiceType;
  resultBundles?: ResultBundleStore;
  projectProviders?: ProjectProviderManifestSummary[];
  projectCatalog?: ProjectCatalogService;
  directoryPicker?: DirectoryPicker;
  artifacts?: ArtifactRetentionService;
  onProjectSwitch?: (configPath: string) => void | Promise<void>;
  staticDir?: string;
}

export async function createApp(options: CreateAppOptions): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  const directoryPicker = options.directoryPicker ?? new DirectoryPicker();
  const taskResults = options.taskResults
    ?? new TaskResultService(options.config, options.tasks, options.resultBundles);
  const pageParameters = new PageParameterService(
    options.config,
    new PageParameterStore(options.config.stateDir),
  );
  const accountProfiles = new AccountProfileService(
    options.config,
    new AccountProfileStore(options.config.stateDir, options.config.adapter),
  );
  const businessScripts = new BusinessScriptService(
    options.config,
    new BusinessScriptStore(options.config.stateDir),
  );

  app.addHook("onSend", async (_request, reply, payload) => {
    reply.header("Cache-Control", "no-store");
    return payload;
  });

  app.get("/api/health", async () => ({ ok: true }));

  app.get("/api/artifact-retention", async () => requireArtifactRetention(options).snapshot());

  app.post("/api/artifact-retention/preview", async () => requireArtifactRetention(options).preview());

  app.post("/api/artifact-retention/inventory", async () => requireArtifactRetention(options).inventory());

  app.post<{ Body: ArtifactCleanupApplyRequest }>("/api/artifact-retention/apply", async request => {
    const parsed = artifactCleanupApplySchema.safeParse(request.body ?? {});
    if (!parsed.success) throw invalidRequest(parsed.error);
    return requireArtifactRetention(options).apply(parsed.data.runIds);
  });

  app.get("/api/projects", async () => requireProjectCatalog(options).snapshot());

  app.get<{ Params: { projectId: string } }>("/api/projects/:projectId/detail", async request => (
    requireProjectCatalog(options).detail(request.params.projectId)
  ));

  app.post("/api/projects/select-directory", async () => {
    requireProjectCatalog(options);
    const selectedDirectory = await directoryPicker.pickDirectory("选择 Mobile Test Console 项目目录");
    if (!selectedDirectory) {
      throw new ConsoleError("PROJECT_DIRECTORY_SELECTION_CANCELLED", "已取消选择项目目录", 409);
    }
    return scanProjectDirectory(selectedDirectory);
  });

  app.post("/api/projects/select-config", async () => {
    requireProjectCatalog(options);
    const selectedConfig = await directoryPicker.pickFile("选择 mobile-test.config.cjs");
    if (!selectedConfig) {
      throw new ConsoleError("PROJECT_CONFIG_SELECTION_CANCELLED", "已取消选择项目配置", 409);
    }
    return resolveProjectConfigSelection(selectedConfig);
  });

  app.post<{ Body: RegisterProjectRequest }>("/api/projects", async request => {
    const parsed = registerProjectSchema.safeParse(request.body);
    if (!parsed.success) throw invalidRequest(parsed.error);
    return requireProjectCatalog(options).register(parsed.data);
  });

  app.post<{ Body: PreviewProjectInitializationRequest }>("/api/projects/setup/preview", async request => {
    const parsed = previewProjectInitializationSchema.safeParse(request.body);
    if (!parsed.success) throw invalidRequest(parsed.error);
    return requireProjectCatalog(options).previewInitialization(parsed.data);
  });

  app.post<{ Body: ApplyProjectInitializationRequest }>("/api/projects/setup/apply", async request => {
    const parsed = applyProjectInitializationSchema.safeParse(request.body);
    if (!parsed.success) throw invalidRequest(parsed.error);
    return requireProjectCatalog(options).applyInitialization(parsed.data);
  });

  app.post<{ Params: { projectId: string }; Body: ApplyProjectSetupRequest }>("/api/projects/:projectId/setup/preview", async request => {
    const parsed = previewProjectSetupSchema.safeParse(request.body);
    if (!parsed.success) throw invalidRequest(parsed.error);
    return requireProjectCatalog(options).previewSetup(request.params.projectId, parsed.data.step);
  });

  app.post<{ Params: { projectId: string }; Body: ApplyProjectSetupRequest }>("/api/projects/:projectId/setup/apply", async request => {
    const parsed = applyProjectSetupSchema.safeParse(request.body);
    if (!parsed.success) throw invalidRequest(parsed.error);
    return requireProjectCatalog(options).applySetup(request.params.projectId, parsed.data);
  });

  app.delete<{ Params: { projectId: string } }>("/api/projects/:projectId", async request => (
    requireProjectCatalog(options).remove(request.params.projectId)
  ));

  app.post<{ Params: { projectId: string } }>("/api/projects/:projectId/onboarding/verify", async request => (
    requireProjectCatalog(options).verify(request.params.projectId)
  ));

  app.post<{ Params: { projectId: string } }>("/api/projects/:projectId/activate", async (request, reply) => {
    const activeTaskCount = options.tasks.list().filter(task => ACTIVE_TASK_STATUSES.includes(task.status)).length;
    const activation = await requireProjectCatalog(options).activate(request.params.projectId, activeTaskCount);
    if (options.onProjectSwitch && activation.projectId !== options.config.project.id) {
      const switchProject = () => {
        void Promise.resolve(options.onProjectSwitch!(activation.configPath)).catch(error => {
          console.error("[server] 项目切换失败", error);
        });
      };
      // 等响应完成后再关闭 API，避免 Vite 代理收到半截响应并转换成 500。
      if (typeof reply.raw.once === "function") {
        reply.raw.once("finish", switchProject);
      } else {
        setTimeout(switchProject, 0).unref?.();
      }
    }
    return activation;
  });

  if (options.resultBundles) {
    app.get("/api/result-bundles", async () => ({
      schemaVersion: "test-analysis.result-bundles.v1" as const,
      bundles: await options.resultBundles!.list(),
    }));

    app.get<{ Params: { runId: string } }>("/api/result-bundles/:runId", async request => {
      const bundle = await options.resultBundles!.get(request.params.runId);
      if (!bundle) throw new ConsoleError("RESULT_BUNDLE_UNKNOWN", `Result Bundle 不存在: ${request.params.runId}`, 404);
      return bundle;
    });

    app.post<{ Body: unknown }>("/api/result-bundles", async request => {
      const ingestion = await options.resultBundles!.ingest(request.body, "HTTP push");
      return { ingestion };
    });
  }

  app.get<{ Querystring: { refresh?: string } }>("/api/snapshot", async (request): Promise<ConsoleSnapshot> => {
    const discovery = await options.devices.snapshot({ refresh: request.query.refresh === "1" });
    return {
      project: options.config.project,
      testing: options.config.testing ?? { environments: [], capabilities: [] },
      adapter: resolveProjectAdapter(options.config),
      ...(typeof options.devices.connectorManifests === "function"
        ? { connectors: options.devices.connectorManifests() }
        : {}),
      projectProviders: options.projectProviders ?? [],
      devices: discovery.devices,
      targets: configuredRunTargets(options.config),
      deviceErrors: discovery.errors,
      deviceDiscoveryPending: discovery.refreshing,
      tests: toPublicTests(options.config.tests),
      tasks: options.tasks.list(),
      codexRepairEnabled: options.config.codexRepair?.enabled === true,
      repairJobs: options.repairs?.list() ?? [],
      updatedAt: new Date().toISOString(),
    };
  });

  app.get("/api/page-parameters", async () => pageParameters.snapshot());

  app.get("/api/business-scripts", async () => businessScripts.snapshot());

  app.post<{ Body: StartBusinessScriptRecordingRequest }>("/api/business-script-recordings", async request => {
    const parsed = startBusinessScriptRecordingSchema.safeParse(request.body);
    if (!parsed.success) throw invalidRequest(parsed.error);
    const device = await findAvailableDevice(options, parsed.data.deviceKey);
    return { recording: await businessScripts.startRecording(device, parsed.data.environment, parsed.data.appBuild) };
  });

  app.get<{ Params: { recordingId: string } }>("/api/business-script-recordings/:recordingId", async request => ({
    recording: await businessScripts.refreshRecording(request.params.recordingId),
  }));

  app.post<{ Params: { recordingId: string } }>("/api/business-script-recordings/:recordingId/stop", async request => (
    businessScripts.stopRecording(request.params.recordingId)
  ));

  app.put<{ Params: { draftId: string }; Body: SaveBusinessScriptDraftRequest }>("/api/business-script-drafts/:draftId", async request => {
    const parsed = saveBusinessScriptDraftSchema.safeParse(request.body);
    if (!parsed.success) throw invalidRequest(parsed.error);
    return { draft: await businessScripts.saveDraft(request.params.draftId, parsed.data) };
  });

  app.post<{ Params: { draftId: string } }>("/api/business-script-drafts/:draftId/publish", async request => ({
    script: await businessScripts.publish(request.params.draftId),
  }));

  app.delete<{ Params: { scriptId: string; version: string } }>("/api/business-scripts/:scriptId/versions/:version", async request => {
    const version = Number(request.params.version);
    if (!Number.isInteger(version) || version <= 0) throw new ConsoleError("REQUEST_INVALID", "脚本版本必须为正整数");
    return businessScripts.deletePublishedVersion(request.params.scriptId, version);
  });

  app.put<{ Params: { suiteId: string }; Body: Omit<BusinessSuite, "suiteId" | "updatedAt"> }>("/api/business-suites/:suiteId", async request => {
    const parsed = saveBusinessSuiteSchema.safeParse(request.body);
    if (!parsed.success) throw invalidRequest(parsed.error);
    return { suite: await businessScripts.saveSuite(request.params.suiteId, parsed.data) };
  });

  app.post<{ Params: { scriptId: string; version: string; scenarioId: string }; Body: { deviceKey: string } }>(
    "/api/business-scripts/:scriptId/versions/:version/scenarios/:scenarioId/replay",
    async request => {
      const parsed = replayBusinessScriptSchema.safeParse(request.body);
      if (!parsed.success) throw invalidRequest(parsed.error);
      const device = await findAvailableDevice(options, parsed.data.deviceKey);
      const version = Number(request.params.version);
      if (!Number.isInteger(version) || version <= 0) throw new ConsoleError("REQUEST_INVALID", "脚本版本必须为正整数");
      return { replay: await businessScripts.replayScenario(request.params.scriptId, version, request.params.scenarioId, device) };
    },
  );

  app.post<{ Params: { suiteId: string }; Body: { deviceKey: string } }>("/api/business-suites/:suiteId/replay", async request => {
    const parsed = replayBusinessScriptSchema.safeParse(request.body);
    if (!parsed.success) throw invalidRequest(parsed.error);
    const device = await findAvailableDevice(options, parsed.data.deviceKey);
    return { replays: await businessScripts.replaySuite(request.params.suiteId, device) };
  });

  app.post<{ Body: StartPageParameterRecordingRequest }>("/api/page-parameter-recordings", async request => {
    const parsed = startPageParameterRecordingSchema.safeParse(request.body);
    if (!parsed.success) throw invalidRequest(parsed.error);
    const discovery = await options.devices.discover();
    const device = discovery.devices.find(item => item.key === parsed.data.deviceKey);
    if (!device) throw new ConsoleError("DEVICE_UNKNOWN", `设备不存在: ${parsed.data.deviceKey}`, 404);
    if (device.connectionState !== "available") throw new ConsoleError("DEVICE_UNAVAILABLE", `${device.name} 当前不可用`, 409);
    return { recording: await pageParameters.startRecording(device, parsed.data.environment) };
  });

  app.get<{ Params: { recordingId: string } }>("/api/page-parameter-recordings/:recordingId", async request => ({
    recording: await pageParameters.refreshRecording(request.params.recordingId),
  }));

  app.post<{ Params: { recordingId: string } }>("/api/page-parameter-recordings/:recordingId/stop", async request => ({
    recording: await pageParameters.stopRecording(request.params.recordingId),
  }));

  app.post<{ Params: { pageId: string; profileId: string }; Body: { deviceKey: string } }>(
    "/api/page-parameters/:pageId/profiles/:profileId/replay",
    async request => {
      const parsed = replayPageParameterProfileSchema.safeParse(request.body);
      if (!parsed.success) throw invalidRequest(parsed.error);
      const discovery = await options.devices.discover();
      const device = discovery.devices.find(item => item.key === parsed.data.deviceKey);
      if (!device) throw new ConsoleError("DEVICE_UNKNOWN", `设备不存在: ${parsed.data.deviceKey}`, 404);
      if (device.connectionState !== "available") throw new ConsoleError("DEVICE_UNAVAILABLE", `${device.name} 当前不可用`, 409);
      return { replay: await pageParameters.replayProfile(request.params.pageId, request.params.profileId, device) };
    },
  );

  app.put<{ Params: { pageId: string; profileId: string }; Body: SavePageParameterProfileRequest }>(
    "/api/page-parameters/:pageId/profiles/:profileId",
    async request => {
      const parsed = savePageParameterProfileSchema.safeParse(request.body);
      if (!parsed.success) throw invalidRequest(parsed.error);
      return { profile: await pageParameters.saveProfile(request.params.pageId, request.params.profileId, parsed.data) };
    },
  );

  app.post<{ Params: { pageId: string; profileId: string } }>(
    "/api/page-parameters/:pageId/profiles/:profileId/default",
    async request => {
      const parsed = setDefaultPageParameterProfileSchema.safeParse(request.body);
      if (!parsed.success) throw invalidRequest(parsed.error);
      return { profile: await pageParameters.setDefaultProfile(request.params.pageId, request.params.profileId, parsed.data.isDefault) };
    },
  );

  app.delete<{ Params: { pageId: string; profileId: string } }>(
    "/api/page-parameters/:pageId/profiles/:profileId/default",
    async request => ({ profile: await pageParameters.setDefaultProfile(request.params.pageId, request.params.profileId, false) }),
  );

  app.delete<{ Params: { pageId: string; profileId: string } }>("/api/page-parameters/:pageId/profiles/:profileId", async request => {
    await pageParameters.deleteProfile(request.params.pageId, request.params.profileId);
    return { ok: true };
  });

  app.get("/api/account-profiles", async () => accountProfiles.snapshot());

  app.get<{ Params: { profileId: string }; Querystring: { provider?: string } }>("/api/account-profiles/:profileId/source", async request => {
    const parsed = accountProfileSourceSchema.safeParse(request.query);
    if (!parsed.success) throw invalidRequest(parsed.error);
    return accountProfiles.source(request.params.profileId, parsed.data.provider);
  });

  app.post<{ Body: StartAccountProfileRecordingRequest }>("/api/account-profile-recordings", async request => {
    const parsed = startAccountProfileRecordingSchema.safeParse(request.body);
    if (!parsed.success) throw invalidRequest(parsed.error);
    const device = await findAvailableDevice(options, parsed.data.deviceKey);
    const recording = await accountProfiles.startRecording(device, parsed.data);
    return { recording: toAccountProfileRecordingSummary(recording) };
  });

  app.get<{ Params: { recordingId: string } }>("/api/account-profile-recordings/:recordingId", async request => ({
    recording: toAccountProfileRecordingSummary(await accountProfiles.refreshRecording(request.params.recordingId)),
  }));

  app.post<{ Params: { recordingId: string } }>("/api/account-profile-recordings/:recordingId/stop", async request => {
    const result = await accountProfiles.stopRecording(request.params.recordingId);
    return {
      recording: toAccountProfileRecordingSummary(result.recording),
      ...(result.profile ? { profile: toAccountProfileSummary(result.profile) } : {}),
    };
  });

  app.post<{ Params: { recordingId: string } }>("/api/account-profile-recordings/:recordingId/terminate", async request => ({
    recording: toAccountProfileRecordingSummary(await accountProfiles.terminateRecording(request.params.recordingId)),
  }));

  app.post<{ Params: { profileId: string }; Body: { deviceKey: string; provider: AccountProfileProvider } }>("/api/account-profiles/:profileId/replay", async request => {
    const parsed = replayAccountProfileSchema.safeParse(request.body);
    if (!parsed.success) throw invalidRequest(parsed.error);
    const device = await findAvailableDevice(options, parsed.data.deviceKey);
    return { replay: await accountProfiles.replayProfile(request.params.profileId, parsed.data.provider, device) };
  });

  app.delete<{ Params: { profileId: string } }>("/api/account-profiles/:profileId", async request => {
    await accountProfiles.deleteProfile(request.params.profileId);
    return { ok: true };
  });

  app.post<{ Body: StartTasksRequest }>("/api/tasks", async request => {
    const parsed = startRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      throw new ConsoleError(
        "REQUEST_INVALID",
        parsed.error.issues.map(issue => `${issue.path.join(".")}: ${issue.message}`).join("; "),
      );
    }
    await options.artifacts?.assertCanStart();
    const discovery = await options.devices.discover();
    const test = options.config.tests.find(item => item.id === parsed.data.testId);
    if (test) {
      const parameters = validateParameters(test, parsed.data.parameters ?? {});
      const selectedDevices = discovery.devices.filter(device => parsed.data.deviceKeys?.includes(device.key));
      const blockedPreparation = selectedDevices.flatMap(device => (device.preparations ?? [])
        .filter(item => item.blocksTests && item.status !== "ready")
        .map(item => ({ device, preparation: item })))[0];
      if (blockedPreparation) {
        throw new ConsoleError(
          "DEVICE_PREPARATION_REQUIRED",
          `${blockedPreparation.device.name} 需要先完成${blockedPreparation.preparation.label}：${blockedPreparation.preparation.detail}`,
          409,
        );
      }
      const environment = parameters.environment || "qa";
      if ((parsed.data.deviceKeys?.length ?? 0) > 0) for (const parameter of test.parameters) {
        if (parameter.type !== "account-profile") continue;
        const selection = parameters[parameter.id];
        if (selection === "current-session") continue;
        const separator = selection.lastIndexOf(":");
        const profileId = selection.slice(0, separator);
        const provider = selection.slice(separator + 1) as AccountProfileProvider;
        await accountProfiles.validateTaskSelection(
          profileId,
          provider,
          parameter.capability,
          environment,
          selectedDevices,
        );
      }
    }
    return {
      tasks: await options.tasks.start(
        parsed.data,
        discovery.devices,
        undefined,
        undefined,
        undefined,
        configuredRunTargets(options.config),
      ),
    };
  });

  app.post<{ Body: { deviceKey: string } }>("/api/devices/start", async request => {
    const parsed = startDeviceRequestSchema.safeParse(request.body);
    if (!parsed.success) throw invalidRequest(parsed.error);
    return { device: await options.devices.start(parsed.data.deviceKey) };
  });

  app.post<{ Body: { deviceKey: string; preparationId: string } }>("/api/devices/preparations/install", async request => {
    const parsed = installDevicePreparationSchema.safeParse(request.body);
    if (!parsed.success) throw invalidRequest(parsed.error);
    return options.devices.installPreparation(parsed.data.deviceKey, parsed.data.preparationId);
  });

  app.post<{ Params: { taskId: string } }>("/api/tasks/:taskId/stop", async request => ({
    task: await options.tasks.stop(request.params.taskId),
  }));

  app.put<{ Params: { taskId: string }; Body: { retained: boolean } }>("/api/tasks/:taskId/retention", async request => {
    const parsed = taskRetentionSchema.safeParse(request.body);
    if (!parsed.success) throw invalidRequest(parsed.error);
    return { task: await requireArtifactRetention(options).setTaskRetained(request.params.taskId, parsed.data.retained) };
  });

  app.get("/api/repairs", async () => ({
    schemaVersion: "mobile-test-console.repair-jobs.v1" as const,
    jobs: options.repairs?.list() ?? [],
  }));

  app.get<{ Params: { repairJobId: string } }>("/api/repairs/:repairJobId", async request => ({
    job: requireRepairJob(options, request.params.repairJobId),
  }));

  app.post<{ Params: { taskId: string }; Body: { caseRunId?: string } }>("/api/tasks/:taskId/repairs", async request => {
    const parsed = createRepairRequestSchema.safeParse(request.body ?? {});
    if (!parsed.success) throw invalidRequest(parsed.error);
    return { job: await requireRepairs(options).create(request.params.taskId, parsed.data.caseRunId, parsed.data.projectDirectory) };
  });

  app.post<{ Params: { taskId: string }; Body: { caseRunId?: string } }>("/api/tasks/:taskId/repairs/preview", async request => {
    const parsed = createRepairRequestSchema.safeParse(request.body ?? {});
    if (!parsed.success) throw invalidRequest(parsed.error);
    return { preview: await requireRepairs(options).preview(request.params.taskId, parsed.data.caseRunId) };
  });

  app.post("/api/repairs/select-project-directory", async () => ({
    projectDirectory: await requireRepairs(options).selectProjectDirectory(),
  }));

  app.post<{ Params: { repairJobId: string } }>("/api/repairs/:repairJobId/cancel", async request => ({
    job: await requireRepairs(options).cancel(request.params.repairJobId),
  }));

  app.post<{ Params: { repairJobId: string } }>("/api/repairs/:repairJobId/retry-test", async request => ({
    job: await requireRepairs(options).retryTest(request.params.repairJobId),
  }));

  app.post<{ Params: { repairJobId: string } }>("/api/repairs/:repairJobId/open-task", async request => ({
    job: await requireRepairs(options).openTask(request.params.repairJobId),
  }));

  app.get<{ Params: { taskId: string }; Querystring: { refresh?: string } }>("/api/tasks/:taskId/result", async request => ({
    result: await taskResults.load(request.params.taskId, { refresh: request.query.refresh === "1" }),
  }));

  app.get<{ Params: { taskId: string; artifactId: string } }>(
    "/api/tasks/:taskId/artifacts/:artifactId",
    async (request, reply) => {
      const artifact = await taskResults.artifact(request.params.taskId, request.params.artifactId);
      reply.type(artifact.mimeType);
      reply.header("Content-Length", artifact.sizeBytes);
      reply.header("Content-Disposition", "inline");
      reply.header("X-Content-Type-Options", "nosniff");
      return reply.send(fs.createReadStream(artifact.absolutePath));
    },
  );

  app.delete<{ Params: { taskId: string } }>("/api/tasks/:taskId", async request => {
    const task = await options.tasks.delete(request.params.taskId);
    taskResults.invalidate(request.params.taskId);
    return { task };
  });

  app.setErrorHandler((error, _request, reply) => {
    const known = error instanceof ConsoleError;
    const statusCode = known ? error.statusCode : 500;
    if (!known) console.error("[server] 未处理的请求异常", error);
    reply.status(statusCode).send({
      error: {
        code: known ? error.code : "INTERNAL_ERROR",
        message: known ? error.message : "控制服务发生内部错误",
      },
    });
  });

  if (options.staticDir && fs.existsSync(options.staticDir)) {
    await app.register(fastifyStatic, {
      root: options.staticDir,
      prefix: "/",
    });
    app.setNotFoundHandler((request, reply) => {
      if (request.url.startsWith("/api/")) {
        reply.status(404).send({ error: { code: "NOT_FOUND", message: "API 不存在" } });
        return;
      }
      reply.type("text/html").send(fs.createReadStream(path.join(options.staticDir!, "index.html")));
    });
  }

  return app;
}

function configuredRunTargets(config: LoadedProjectConfig): RunTarget[] {
  return (config.testing?.targets ?? []).map(target => ({
    key: target.key,
    kind: "mini-program" as const,
    label: target.label,
    platform: target.platform,
    runtime: target.runtime,
    appId: target.appId,
    concurrencyKey: target.concurrencyKey,
    ...(target.extensions ? { extensions: structuredClone(target.extensions) } : {}),
  }));
}

async function findAvailableDevice(options: CreateAppOptions, deviceKey: string) {
  const discovery = await options.devices.discover();
  const device = discovery.devices.find(item => item.key === deviceKey);
  if (!device) throw new ConsoleError("DEVICE_UNKNOWN", `设备不存在: ${deviceKey}`, 404);
  if (device.connectionState !== "available") throw new ConsoleError("DEVICE_UNAVAILABLE", `${device.name} 当前不可用`, 409);
  return device;
}

function invalidRequest(error: z.ZodError): ConsoleError {
  return new ConsoleError(
    "REQUEST_INVALID",
    error.issues.map(issue => `${issue.path.join(".")}: ${issue.message}`).join("; "),
  );
}

function requireRepairs(options: CreateAppOptions): RepairJobManager {
  if (!options.repairs) throw new ConsoleError("CODEX_REPAIR_DISABLED", "项目未初始化 Codex 修复服务", 409);
  return options.repairs;
}

function requireArtifactRetention(options: CreateAppOptions): ArtifactRetentionService {
  if (!options.artifacts) throw new ConsoleError("ARTIFACT_RETENTION_DISABLED", "当前项目未启用测试产物治理", 409);
  return options.artifacts;
}

function requireRepairJob(options: CreateAppOptions, repairJobId: string) {
  const job = requireRepairs(options).get(repairJobId);
  if (!job) throw new ConsoleError("REPAIR_JOB_UNKNOWN", `修复任务不存在: ${repairJobId}`, 404);
  return job;
}

function requireProjectCatalog(options: CreateAppOptions): ProjectCatalogService {
  if (!options.projectCatalog) {
    throw new ConsoleError("PROJECT_CATALOG_UNAVAILABLE", "项目目录服务尚未初始化", 503);
  }
  return options.projectCatalog;
}
