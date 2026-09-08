import fs from "node:fs";
import { AsyncLocalStorage } from "node:async_hooks";
import path from "node:path";
import fastifyStatic from "@fastify/static";
import Fastify, { type FastifyInstance } from "fastify";
import { z } from "zod";
import { ACTIVE_TASK_STATUSES, ARTIFACT_RUN_ID_PATTERN, PAGE_PARAMETER_PLATFORMS, PLATFORMS, PROJECT_DATA_IMPORT_MAX_BYTES, TERMINAL_TASK_STATUSES, type AccountProfileProvider, type ApplyProjectInitializationRequest, type ApplyProjectSetupRequest, type ApplyProjectTestEntryRequest, type ArtifactCleanupApplyRequest, type BusinessSuite, type ConsoleSnapshot, type Device, type PreviewProjectInitializationRequest, type PreviewProjectTestEntryRequest, type PreviewTestCommandsRequest, type PreviewTestCommandsResponse, type ProjectProviderManifestSummary, type RegisterProjectRequest, type RetryTaskRequest, type SaveBusinessScriptDraftRequest, type SavePageParameterProfileRequest, type StartAccountProfileRecordingRequest, type StartBusinessScriptRecordingRequest, type StartPageParameterRecordingRequest, type StartTasksRequest, type RunTarget, type TaskRetrySource, type TestTask } from "../shared/contracts.js";
import { LEGACY_COMMAND_RUNNER_ID } from "../runner/sdk.js";
import { loadProjectConfig, resolveTargetCommand, toPublicTestsFromConfig, validateParameters, type LoadedProjectConfig } from "./config.js";
import { ensureConfigPageInspectionTheme } from "./page-inspection-theme.js";
import type { DeviceDiscoveryService } from "./devices.js";
import { ConsoleError } from "./errors.js";
import type { TaskManager } from "./task-manager.js";
import { TaskResultService } from "./task-results.js";
import { exportProjectData, importProjectData } from "./project-data-backup.js";
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
import type { ProjectRuntime, ProjectRuntimeRegistry } from "./project-runtime.js";
import { createScreenshotComparison, listScreenshotComparisonCandidates, type ScreenshotComparisonRuntime } from "./screenshot-comparison.js";

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

const retryTaskRequestSchema = z.object({
  caseRunIds: z.array(z.string().min(1)).min(1).max(500).optional(),
  targetPages: z.array(z.string().min(1)).min(1).max(500).optional(),
}).strict().refine(value => !(value.caseRunIds && value.targetPages), {
  message: "用例和页面只能选择一种重试范围",
});

const accountProfileProviderSchema = z.string().regex(/^[a-z][a-z0-9-]*$/);

const screenshotComparisonRequestSchema = z.object({
  left: z.object({
    projectId: z.string().min(1),
    taskId: z.string().min(1),
  }),
  right: z.object({
    projectId: z.string().min(1),
    taskId: z.string().min(1),
  }),
}).refine(value => value.left.projectId !== value.right.projectId || value.left.taskId !== value.right.taskId, {
  message: "请选择两个不同的历史结果",
});

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
  deviceKey: z.string().min(1).optional(),
  targetKey: z.string().min(1).optional(),
  environment: z.string().min(1),
}).refine(value => Boolean(value.deviceKey) !== Boolean(value.targetKey), {
  message: "设备和运行目标需要选择其中一个",
});

const replayPageParameterProfileSchema = z.object({
  deviceKey: z.string().min(1).optional(),
  targetKey: z.string().min(1).optional(),
}).refine(value => Boolean(value.deviceKey) !== Boolean(value.targetKey), {
  message: "设备和运行目标需要选择其中一个",
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

const projectTestCommandSchema = z.object({
  executable: z.string().trim().min(1),
  args: z.array(z.string()),
  cwd: z.string().trim().min(1).optional(),
  env: z.record(z.string()).optional(),
});

const projectTestParameterSchema = z.discriminatedUnion("type", [
  z.object({
    id: z.string().regex(/^[a-z][a-z0-9-]*$/),
    label: z.string().min(1),
    type: z.literal("select"),
    defaultValue: z.string().min(1),
    options: z.array(z.object({ value: z.string().min(1), label: z.string().min(1), description: z.string().optional() })).min(1),
  }),
  z.object({
    id: z.string().regex(/^[a-z][a-z0-9-]*$/),
    label: z.string().min(1),
    type: z.literal("account-profile"),
    defaultValue: z.literal("current-session"),
    capability: z.string().min(1),
  }),
  z.object({
    id: z.string().regex(/^[a-z][a-z0-9-]*$/),
    label: z.string().min(1),
    type: z.literal("page-selection"),
    defaultValue: z.string().min(1),
    source: z.literal("page-parameters"),
    presets: z.array(z.object({
      value: z.string().min(1),
      label: z.string().min(1),
      description: z.string().optional(),
      filter: z.object({ priorities: z.array(z.string()).optional(), tags: z.array(z.string()).optional(), testScopes: z.array(z.string()).optional() }),
    })).min(1),
  }),
]);

const projectTestEntrySchema = z.object({
  id: z.string().regex(/^[a-z][a-z0-9-]*$/),
  label: z.string().trim().min(1),
  testType: z.string(),
  description: z.string(),
  kind: z.enum(["general", "page", "flow"]),
  runnerId: z.string().regex(/^[a-z][a-z0-9-]*$/),
  providerId: z.string().regex(/^[a-z][a-z0-9-]*$/).optional(),
  requiredCapabilities: z.array(z.string()),
  platforms: z.array(z.enum(PLATFORMS)),
  targetKeys: z.array(z.string().regex(/^[a-z][a-z0-9-]*$/)),
  parameters: z.array(projectTestParameterSchema),
  commands: z.object({
    default: projectTestCommandSchema.optional(),
    android: projectTestCommandSchema.optional(),
    ios: projectTestCommandSchema.optional(),
    harmony: projectTestCommandSchema.optional(),
  }),
});

const previewProjectTestEntrySchema = z.object({
  mode: z.literal("create"),
  entry: projectTestEntrySchema,
  commandLine: z.string().trim().min(1).max(4096).optional(),
}) satisfies z.ZodType<PreviewProjectTestEntryRequest>;

const applyProjectTestEntrySchema = z.object({
  planId: z.string().min(1),
}) satisfies z.ZodType<ApplyProjectTestEntryRequest>;

const previewTestCommandsSchema = z.object({
  testId: z.string().min(1),
  targetKeys: z.array(z.string().min(1)).min(1).max(100)
    .refine(keys => new Set(keys).size === keys.length, { message: "运行目标不能重复" }),
  parameters: z.record(z.string()),
}).strict() satisfies z.ZodType<PreviewTestCommandsRequest>;

const projectInitializationSchema = z.discriminatedUnion("family", [
  z.object({
    projectDirectory: z.string().trim().min(1),
    platforms: z.array(z.enum(PLATFORMS)).min(1),
    family: z.literal("app"),
  }),
  z.object({
    projectDirectory: z.string().trim().min(1),
    platforms: z.array(z.enum(PLATFORMS)).length(0),
    family: z.literal("mini-program"),
  }),
]);

const previewProjectInitializationSchema = projectInitializationSchema;

const applyProjectInitializationSchema = projectInitializationSchema.and(z.object({
  planId: z.string().min(1),
}));

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

const ACTIVE_TASK_STATUS_SET = new Set(ACTIVE_TASK_STATUSES);

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
  runtimes?: ProjectRuntimeRegistry;
  onProjectSwitch?: (configPath: string) => void | Promise<void>;
  staticDir?: string;
}

export async function createApp(baseOptions: CreateAppOptions): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  const runtimeContext = new AsyncLocalStorage<ProjectRuntime>();
  const options = new Proxy(baseOptions, {
    get(target, property, receiver) {
      const runtime = runtimeContext.getStore();
      if (runtime && property in runtime) return Reflect.get(runtime, property, runtime);
      return Reflect.get(target, property, receiver);
    },
  });
  const directoryPicker = options.directoryPicker ?? new DirectoryPicker();
  const defaultTaskResults = options.taskResults
    ?? new TaskResultService(options.config, options.tasks, options.resultBundles);
  const defaultPageParameters = new PageParameterService(
    options.config,
    new PageParameterStore(options.config.pageParameterStorage?.directory ?? options.config.stateDir, options.config.pageParameterStorage?.legacyDirectories),
  );
  const defaultAccountProfiles = new AccountProfileService(
    options.config,
    new AccountProfileStore(options.config.accountProfileStorage?.directory ?? options.config.stateDir, options.config.adapter, options.config.accountProfileStorage?.legacyDirectories, options.config.accountProfileStorage?.id),
  );
  const defaultBusinessScripts = new BusinessScriptService(
    options.config,
    new BusinessScriptStore(options.config.stateDir),
  );
  const taskResults = requestScopedService(defaultTaskResults, runtime => runtime.taskResults, runtimeContext);
  const pageParameters = requestScopedService(defaultPageParameters, runtime => runtime.pageParameters, runtimeContext);
  const accountProfiles = requestScopedService(defaultAccountProfiles, runtime => runtime.accountProfiles, runtimeContext);
  const businessScripts = requestScopedService(defaultBusinessScripts, runtime => runtime.businessScripts, runtimeContext);

  app.addHook("onRequest", (request, _reply, done) => {
    if (!baseOptions.runtimes || !request.url.startsWith("/api/") || request.url.startsWith("/api/projects") || request.url.startsWith("/api/health")) {
      done();
      return;
    }
    const header = request.headers["x-mtc-project-id"];
    const headerProjectId = Array.isArray(header) ? header[0] : header;
    const queryProjectId = new URL(request.url, "http://localhost").searchParams.get("projectId") ?? "";
    void baseOptions.runtimes.resolve(String(headerProjectId || queryProjectId).trim()).then(
      runtime => runtimeContext.run(runtime, done),
      error => done(error instanceof Error ? error : new Error(String(error))),
    );
  });

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

  app.get<{ Params: { projectId: string } }>("/api/projects/:projectId/screenshot-comparison/candidates", async request => {
    const runtime = await resolveScreenshotComparisonRuntime(baseOptions, request.params.projectId);
    return { candidates: await listScreenshotComparisonCandidates(runtime) };
  });

  app.post<{ Body: unknown }>("/api/screenshot-comparisons", async request => {
    const parsed = screenshotComparisonRequestSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      throw new ConsoleError(
        "SCREENSHOT_COMPARISON_INVALID",
        parsed.error.issues.map(issue => issue.message).join("; ") || "请选择两个历史结果",
        400,
      );
    }
    const [leftRuntime, rightRuntime] = await Promise.all([
      resolveScreenshotComparisonRuntime(baseOptions, parsed.data.left.projectId),
      resolveScreenshotComparisonRuntime(baseOptions, parsed.data.right.projectId),
    ]);
    return createScreenshotComparison(leftRuntime, rightRuntime, parsed.data);
  });

  app.get<{ Params: { projectId: string } }>("/api/projects/:projectId/test-entry-editor", async request => (
    requireProjectCatalog(options).testEntryEditor(request.params.projectId)
  ));

  app.post<{ Params: { projectId: string }; Body: PreviewProjectTestEntryRequest }>("/api/projects/:projectId/test-entries/preview", async request => {
    const parsed = previewProjectTestEntrySchema.safeParse(request.body);
    if (!parsed.success) throw invalidRequest(parsed.error);
    return requireProjectCatalog(options).previewTestEntry(request.params.projectId, parsed.data);
  });

  app.post<{ Params: { projectId: string }; Body: ApplyProjectTestEntryRequest }>("/api/projects/:projectId/test-entries/apply", async request => {
    const parsed = applyProjectTestEntrySchema.safeParse(request.body);
    if (!parsed.success) throw invalidRequest(parsed.error);
    const response = await requireProjectCatalog(options).applyTestEntry(request.params.projectId, parsed.data);
    if (request.params.projectId === options.config.project.id) {
      const refreshed = await loadProjectConfig(options.config.configPath);
      options.config.tests = refreshed.tests;
      options.config.mainConfigTests = refreshed.mainConfigTests;
      options.config.sidecarTests = refreshed.sidecarTests;
      options.config.testEntriesPath = refreshed.testEntriesPath;
    }
    return response;
  });

  app.post<{ Body: PreviewTestCommandsRequest }>("/api/test-commands/preview", async request => {
    const parsed = previewTestCommandsSchema.safeParse(request.body);
    if (!parsed.success) throw invalidRequest(parsed.error);
    return previewTestCommands(options.config, parsed.data, pageParameters);
  });

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
    if (baseOptions.runtimes) await baseOptions.runtimes.resolve(request.params.projectId);
    const activeTaskCount = options.tasks.list().filter(task => ACTIVE_TASK_STATUSES.includes(task.status)).length;
    const activation = await requireProjectCatalog(options).activate(request.params.projectId, activeTaskCount);
    if (!baseOptions.runtimes && options.onProjectSwitch && activation.projectId !== options.config.project.id) {
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
    const tasks = await projectRetryTaskStatuses(options.tasks.listVisible(), options.tasks, taskResults);
    ensureConfigPageInspectionTheme(options.config);
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
      tests: toPublicTestsFromConfig(options.config),
      tasks,
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
    const execution = parsed.data.targetKey
      ? findConfiguredTarget(options.config, parsed.data.targetKey)
      : await findAvailableDevice(options, parsed.data.deviceKey!);
    return { recording: await pageParameters.startRecording(execution, parsed.data.environment) };
  });

  app.get<{ Params: { recordingId: string } }>("/api/page-parameter-recordings/:recordingId", async request => ({
    recording: await pageParameters.refreshRecording(request.params.recordingId),
  }));

  app.post<{ Params: { recordingId: string } }>("/api/page-parameter-recordings/:recordingId/stop", async request => ({
    recording: await pageParameters.stopRecording(request.params.recordingId),
  }));

  app.post<{ Params: { pageId: string; profileId: string }; Body: { deviceKey?: string; targetKey?: string } }>(
    "/api/page-parameters/:pageId/profiles/:profileId/replay",
    async request => {
      const parsed = replayPageParameterProfileSchema.safeParse(request.body);
      if (!parsed.success) throw invalidRequest(parsed.error);
      const execution = parsed.data.targetKey
        ? findConfiguredTarget(options.config, parsed.data.targetKey)
        : await findAvailableDevice(options, parsed.data.deviceKey!);
      return { replay: await pageParameters.replayProfile(request.params.pageId, request.params.profileId, execution) };
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

  app.get("/api/project-data/export", async (_request, reply) => {
    reply.header("Cache-Control", "no-store");
    reply.header("Content-Disposition", 'attachment; filename="project-data-backup.json"');
    return exportProjectData(options.config, accountProfiles, pageParameters);
  });

  app.post("/api/project-data/import", {
    bodyLimit: PROJECT_DATA_IMPORT_MAX_BYTES,
    errorHandler(error, _request, reply) {
      const known = error instanceof ConsoleError;
      const status = known ? error.statusCode : error.statusCode === 413 ? 413 : error.statusCode === 400 ? 400 : 500;
      reply.code(status).send({ error: {
        code: known ? error.code : "PROJECT_DATA_IMPORT_FAILED",
        message: known ? error.message : status === 413 ? "项目备份文件应小于 40 MiB" : "项目数据导入失败，请检查文件格式和存储状态",
      } });
    },
  }, async request => {
    await importProjectData(request.body, accountProfiles, pageParameters);
    return { ok: true };
  });

  app.get("/api/account-profiles", async () => accountProfiles.snapshot());

  app.get("/api/account-profiles/export", async (_request, reply) => {
    reply.header("Cache-Control", "no-store");
    reply.header("Content-Disposition", 'attachment; filename="account-profiles.json"');
    return accountProfiles.exportData();
  });

  app.post("/api/account-profiles/import", {
    bodyLimit: 20 * 1024 * 1024,
    errorHandler(error, _request, reply) {
      const known = error instanceof ConsoleError;
      const status = known ? error.statusCode : error.statusCode === 413 ? 413 : 400;
      reply.code(status).send({ error: {
        code: known ? error.code : "ACCOUNT_PROFILE_IMPORT_FAILED",
        message: known ? error.message : status === 413 ? "画像文件应小于 20 MiB" : "画像导入失败，请检查文件格式和存储状态",
      } });
    },
  }, async request => {
    await accountProfiles.importData(request.body);
    return { ok: true };
  });

  app.post<{ Params: { backupId: string } }>("/api/account-profiles/backups/:backupId/restore", async request => {
    await accountProfiles.restoreBackup(request.params.backupId);
    return { ok: true };
  });

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
    return { tasks: await startTaskRequest(options, accountProfiles, parsed.data, undefined, undefined, pageParameters) };
  });

  app.post<{ Params: { taskId: string }; Body: RetryTaskRequest }>("/api/tasks/:taskId/retry", async request => {
    const parsed = retryTaskRequestSchema.safeParse(request.body ?? {});
    if (!parsed.success) throw invalidRequest(parsed.error);
    const source = options.tasks.get(request.params.taskId);
    if (!source) throw new ConsoleError("TASK_UNKNOWN", `任务不存在: ${request.params.taskId}`, 404);
    if (!TERMINAL_TASK_STATUSES.includes(source.status)) {
      throw new ConsoleError("TASK_NOT_RETRYABLE", "终态任务才支持重新测试", 409);
    }

    const requestedCaseRunIds = parsed.data.caseRunIds;
    const requestedTargetPages = parsed.data.targetPages;
    const retryOf: TaskRetrySource = {
      taskId: source.id,
      runId: source.runId,
      scope: requestedCaseRunIds || requestedTargetPages ? "cases" : "task",
      attempt: options.tasks.nextRetryAttempt(source.id),
    };
    if (requestedCaseRunIds || requestedTargetPages) {
      const result = await taskResults.load(source.id);
      const runsById = new Map(result.runs.map(run => [run.caseRunId, run]));
      const selectedRuns = requestedCaseRunIds
        ? (() => {
          const uniqueCaseRunIds = [...new Set(requestedCaseRunIds)];
          if (uniqueCaseRunIds.length !== requestedCaseRunIds.length) {
            throw new ConsoleError("RETRY_CASE_DUPLICATE", "重试范围包含重复用例");
          }
          return uniqueCaseRunIds.map(caseRunId => {
            const run = runsById.get(caseRunId);
            if (!run) throw new ConsoleError("RETRY_CASE_UNKNOWN", `测试结果中不存在用例: ${caseRunId}`, 404);
            return run;
          });
        })()
        : (() => {
          const targetPages = requestedTargetPages!;
          const uniqueTargetPages = [...new Set(targetPages)];
          if (uniqueTargetPages.length !== targetPages.length) {
            throw new ConsoleError("RETRY_PAGE_DUPLICATE", "重试范围包含重复页面");
          }
          const pageSet = new Set(uniqueTargetPages);
          const matches = result.runs.filter(run => pageSet.has(run.targetPage));
          const matchedPages = new Set(matches.map(run => run.targetPage));
          const unknownPages = uniqueTargetPages.filter(page => !matchedPages.has(page));
          if (unknownPages.length > 0) throw new ConsoleError("RETRY_PAGE_UNKNOWN", `测试结果中不存在页面: ${unknownPages.join(", ")}`, 404);
          if (matches.length === 0) throw new ConsoleError("RETRY_PAGE_UNKNOWN", "测试结果中不存在可重试页面", 404);
          return matches;
        })();
      const uniqueCaseRunIds = [...new Set(selectedRuns.map(run => run.caseRunId))];
      if (uniqueCaseRunIds.length !== selectedRuns.length) {
        throw new ConsoleError("RETRY_CASE_DUPLICATE", "测试结果中存在重复用例运行记录");
      }
      retryOf.caseRunIds = uniqueCaseRunIds;
      retryOf.caseIds = [...new Set(selectedRuns.map(run => run.caseId).filter(Boolean))];
      retryOf.targetPages = [...new Set(selectedRuns.map(run => run.targetPage).filter(Boolean))];
      retryOf.caseRuns = selectedRuns.map(run => ({
        caseRunId: run.caseRunId,
        caseId: run.caseId,
        targetPage: run.targetPage,
        launchPage: run.launchPage,
        ...(run.routeParams ? { routeParams: structuredClone(run.routeParams) } : {}),
        ...(run.parameterProfileId ? { parameterProfileId: run.parameterProfileId } : {}),
      }));
    }

    const startRequest: StartTasksRequest = {
      testId: source.testId,
      parameters: structuredClone(source.parameters),
      ...(source.target?.kind === "mini-program"
        ? { targetKeys: [source.target.key] }
        : { deviceKeys: [source.device.key] }),
    };
    return {
      tasks: await startTaskRequest(
        options,
        accountProfiles,
        startRequest,
        retryOf,
        source.target ? [source.target] : undefined,
        pageParameters,
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
      const task = options.tasks.get(request.params.taskId);
      const live = task?.artifacts?.some(artifact => artifact.id === request.params.artifactId);
      const artifact = live
        ? await options.tasks.artifact(request.params.taskId, request.params.artifactId)
        : await taskResults.artifact(request.params.taskId, request.params.artifactId);
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

function requestScopedService<T extends object>(
  fallback: T,
  select: (runtime: ProjectRuntime) => T,
  context: AsyncLocalStorage<ProjectRuntime>,
): T {
  return new Proxy(fallback, {
    get(_target, property) {
      const service = context.getStore() ? select(context.getStore()!) : fallback;
      const value = Reflect.get(service, property, service);
      return typeof value === "function" ? value.bind(service) : value;
    },
  });
}

async function projectRetryTaskStatuses(
  visibleTasks: TestTask[],
  tasks: TaskManager,
  taskResults: TaskResultServiceType,
): Promise<TestTask[]> {
  return Promise.all(visibleTasks.map(async task => {
    if (task.retryOf || !["failed", "interrupted"].includes(task.status)) return task;
    const retries = tasks.listRetryDescendants(task.id);
    if (retries.length === 0 || retries.some(retry => ACTIVE_TASK_STATUS_SET.has(retry.status))) return task;
    try {
      const result = await taskResults.load(task.id);
      if (result.total === 0 || result.failed > 0) return task;
      return {
        ...task,
        status: "passed",
        phase: "重试后通过",
        exitCode: 0,
        error: "",
      };
    } catch {
      return task;
    }
  }));
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

function findConfiguredTarget(config: LoadedProjectConfig, targetKey: string): Extract<RunTarget, { kind: "mini-program" }> {
  const target = configuredRunTargets(config).find(item => item.key === targetKey);
  if (!target) throw new ConsoleError("TARGET_UNKNOWN", `运行目标不存在: ${targetKey}`, 404);
  return target as Extract<RunTarget, { kind: "mini-program" }>;
}

export async function previewTestCommands(
  config: LoadedProjectConfig,
  request: PreviewTestCommandsRequest,
  pageParameters?: Pick<PageParameterService, "isEnabled" | "snapshot">,
): Promise<PreviewTestCommandsResponse> {
  if (config.project.integrationType !== "mini-program") {
    throw new ConsoleError("TEST_COMMAND_PREVIEW_UNSUPPORTED", "命令预览当前仅支持小程序项目", 409);
  }
  const test = config.tests.find(item => item.id === request.testId);
  if (!test) throw new ConsoleError("TEST_UNKNOWN", `测试入口不存在: ${request.testId}`, 404);
  const parameters = validateParameters(test, request.parameters);
  await expandPageSelectionParameters(test, parameters, pageParameters, []);
  const supportedTargetKeys = new Set(test.targetKeys ?? []);
  const commands = request.targetKeys.flatMap(targetKey => {
    const target = findConfiguredTarget(config, targetKey);
    if (!supportedTargetKeys.has(targetKey)) {
      throw new ConsoleError("TEST_TARGET_UNSUPPORTED", `${test.label} 不支持运行目标: ${targetKey}`, 409);
    }
    const command = resolveTargetCommand(config, test, target, {
      id: "<runtime:task.id>",
      runId: "<runtime:task.runId>",
    }, parameters);
    if (!command) {
      if (test.runnerId !== LEGACY_COMMAND_RUNNER_ID) return [];
      throw new ConsoleError("COMMAND_UNAVAILABLE", `${test.label} 未配置可预览的测试命令`, 409);
    }
    return [{
      targetKey: target.key,
      targetLabel: target.label,
      executable: command.executable,
      args: command.args,
      cwd: command.cwd,
      env: Object.fromEntries(Object.keys(command.env).map(key => [key, "<redacted>" as const])),
    }];
  });
  return {
    schemaVersion: "mobile-test-console.test-command-preview.v1",
    testId: test.id,
    commands,
  };
}

async function startTaskRequest(
  options: CreateAppOptions,
  accountProfiles: AccountProfileService,
  request: StartTasksRequest,
  retryOf?: TaskRetrySource,
  targets = configuredRunTargets(options.config),
  pageParameters?: PageParameterService,
) {
  await options.artifacts?.assertCanStart();
  const discovery = await options.devices.discover();
  const test = options.config.tests.find(item => item.id === request.testId);
  if (test) {
    const parameters = validateParameters(test, request.parameters ?? {});
    const selectedDevices = discovery.devices.filter(device => request.deviceKeys?.includes(device.key));
    if (!retryOf) await expandPageSelectionParameters(test, parameters, pageParameters, selectedDevices);
    request.parameters = parameters;
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
    if ((request.deviceKeys?.length ?? 0) > 0) for (const parameter of test.parameters) {
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
  return options.tasks.start(
    request,
    discovery.devices,
    undefined,
    undefined,
    undefined,
    targets,
    retryOf,
  );
}

export async function expandPageSelectionParameters(
  test: LoadedProjectConfig["tests"][number],
  parameters: Record<string, string>,
  pageParameters: Pick<PageParameterService, "isEnabled" | "snapshot"> | undefined,
  selectedDevices: Device[],
): Promise<void> {
  const pageParameter = test.parameters.find(item => item.type === "page-selection");
  if (!pageParameter || !pageParameters || !pageParameters.isEnabled()) return;
  const value = parameters[pageParameter.id];
  const snapshot = await pageParameters.snapshot();
  const platforms = [...new Set(selectedDevices.map(device => device.platform))];
  const pages = snapshot.pages.filter(page => (
    platforms.length === 0
      || !page.platforms?.length
      || platforms.every(platform => page.platforms?.includes(platform))
  ));
  const preset = pageParameter.presets.find(item => item.value === value);
  if (!preset) {
    const availablePageIds = new Set(pages.map(page => page.pageId));
    const selectedPageIds = value.split(",").map(pageId => pageId.trim()).filter(Boolean);
    const unknownPageIds = selectedPageIds.filter(pageId => !availablePageIds.has(pageId));
    if (unknownPageIds.length > 0) {
      throw new ConsoleError("PAGE_SELECTION_UNKNOWN", `${pageParameter.label} 包含不可测试页面: ${unknownPageIds.join(", ")}`);
    }
    return;
  }
  const selected = pages.filter(page => (
    (!preset.filter.priorities?.length || preset.filter.priorities.includes(page.priority ?? ""))
    && (!preset.filter.tags?.length || preset.filter.tags.some(tag => page.tags?.includes(tag)))
    && (!preset.filter.testScopes?.length || preset.filter.testScopes.includes(page.testScope ?? ""))
  ));
  if (selected.length === 0) throw new ConsoleError("PAGE_SELECTION_EMPTY", `${pageParameter.label} 没有匹配的页面`);
  parameters[pageParameter.id] = selected.map(page => page.pageId).join(",");
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

async function resolveScreenshotComparisonRuntime(
  options: CreateAppOptions,
  projectId: string,
): Promise<ScreenshotComparisonRuntime> {
  if (options.runtimes) {
    const runtime = await options.runtimes.resolve(projectId);
    return {
      config: runtime.config,
      tasks: runtime.tasks,
      taskResults: runtime.taskResults,
      resultBundles: runtime.resultBundles,
    };
  }
  if (projectId && projectId !== options.config.project.id) {
    throw new ConsoleError("PROJECT_UNKNOWN", `项目不存在: ${projectId}`, 404);
  }
  return {
    config: options.config,
    tasks: options.tasks,
    taskResults: options.taskResults ?? new TaskResultService(options.config, options.tasks, options.resultBundles),
    resultBundles: options.resultBundles,
  };
}
