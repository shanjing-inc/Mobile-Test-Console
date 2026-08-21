import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import {
  CURRENT_ACCOUNT_SESSION,
  PLATFORMS,
  PROJECT_INTEGRATION_TYPES,
  PROJECT_WORKSPACE_IDS,
  type Device,
  type Platform,
  type PublicTestDefinition,
  type ProjectAdapterManifest,
  type ProjectIntegrationType,
  type ProjectTestingManifest,
  type RepairJob,
  type RunTarget,
  type TaskRetrySource,
  type TestTask,
} from "../shared/contracts.js";
import { EMPTY_PROJECT_ADAPTER } from "../shared/project-adapter-defaults.js";
import { LEGACY_COMMAND_RUNNER_ID, RUNNER_ID_PATTERN } from "../runner/sdk.js";
import { ConsoleError } from "./errors.js";

let configImportNonce = 0;

const commandSchema = z.object({
  executable: z.string().min(1),
  args: z.array(z.string()).default([]),
  cwd: z.string().optional(),
  env: z.record(z.string()).optional(),
});

const lifecycleSchema = z.object({
  startup: commandSchema.optional(),
  shutdown: commandSchema.optional(),
}).default({});

const taskDeletionSchema = z.object({
  cleanup: commandSchema.optional(),
}).default({});

const taskResultsSchema = z.object({
  schemaVersion: z.string().min(1).default("mobile-test-console.task-result.v1"),
  artifactsRoot: z.string().min(1),
  provider: commandSchema,
}).optional();

const artifactRetentionSchema = z.object({
  enabled: z.boolean().default(true),
  autoCleanup: z.boolean().default(false),
  artifactsRoot: z.string().min(1).optional(),
  cleanup: commandSchema.optional(),
  policy: z.object({
    maxAgeDays: z.number().int().min(1).default(7),
    maxRuns: z.number().int().min(1).default(20),
    maxBytes: z.number().int().positive().default(10 * 1024 * 1024 * 1024),
    minimumFreeBytes: z.number().int().nonnegative().default(5 * 1024 * 1024 * 1024),
    keepSuccessfulPerPlatform: z.number().int().nonnegative().default(1),
    keepFailedPerPlatform: z.number().int().nonnegative().default(3),
    repairWorktreeMaxAgeDays: z.number().int().min(1).default(7),
  }).default({}),
}).optional();

const testingTargetSchema = z.object({
  key: z.string().regex(/^[a-z][a-z0-9-]*$/),
  label: z.string().min(1),
  kind: z.literal("mini-program"),
  platform: z.string().min(1),
  runtime: z.string().min(1),
  appId: z.string().min(1),
  concurrencyKey: z.string().min(1),
  healthCheck: commandSchema.optional(),
  extensions: z.record(z.unknown()).optional(),
});

const testingSchema = z.object({
  environments: z.array(z.object({
    id: z.string().regex(/^[a-z][a-z0-9-]*$/),
    label: z.string().min(1),
    description: z.string().default(""),
  })).default([]),
  capabilities: z.array(z.object({
    id: z.string().regex(/^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/),
    label: z.string().min(1),
    description: z.string().default(""),
    guidance: z.array(z.string().min(1)).default([]),
    providerId: z.string().regex(RUNNER_ID_PATTERN),
    required: z.boolean().default(true),
  })).default([]),
  targets: z.array(testingTargetSchema).default([]),
}).default({});

const pageParametersSchema = z.object({
  provider: commandSchema,
}).optional();

const businessScriptsSchema = z.object({
  provider: commandSchema,
}).optional();

const accountProfilesSchema = z.object({
  provider: commandSchema,
}).optional();

const codexRepairSchema = z.object({
  enabled: z.boolean().default(false),
  appServer: z.boolean().default(true),
  mode: z.literal("confirm").default("confirm"),
  executable: z.string().min(1).default("codex"),
  maxAttempts: z.number().int().min(1).max(2).default(2),
  sandbox: z.literal("workspace-write").default("workspace-write"),
  approvalPolicy: z.literal("never").default("never"),
  worktreeRoot: z.string().optional(),
  worktreeLinks: z.array(z.string().min(1)).default([]),
  replay: commandSchema.optional(),
}).default({});

const iosSimulatorSchema = z.object({
  workspace: z.string().min(1),
  scheme: z.string().min(1),
}).optional();

const adapterCapabilityRuleSchema = z.object({
  module: z.string().min(1).optional(),
  methods: z.array(z.string().min(1)).default([]),
  capability: z.string().min(1),
});

const adapterProviderSchema = z.object({
  label: z.string().min(1),
  recordingLabel: z.string().min(1),
  defaultProfileId: z.string().min(1),
  defaultAccountLabel: z.string().min(1),
  requiredCapability: z.string().min(1),
  crossPlatformCapability: z.string().min(1).optional(),
  devicePlatforms: z.array(z.enum(PLATFORMS)).default([]),
  deviceTextIncludes: z.array(z.string().min(1)).default([]),
  requiredCaptureKinds: z.array(z.enum(["native", "graphql"])).default(["native"]),
  requiredResultFields: z.array(z.string().min(1)).default([]),
  capabilityRules: z.array(adapterCapabilityRuleSchema).default([]),
});

const adapterSchema = z.object({
  workspaces: z.array(z.enum(PROJECT_WORKSPACE_IDS))
    .refine(items => new Set(items).size === items.length, { message: "项目工作台 ID 不能重复" })
    .default([]),
  pageParameters: z.object({
    defaultRoute: z.string().default(""),
    templateParameter: z.string().default(""),
    pageReadyEvent: z.string().default(""),
    actionSucceededEvent: z.string().default(""),
  }).default({}),
  resultAnalysis: z.object({
    pageOpenedEvents: z.array(z.string()).default([]),
  }).default({}),
  accountProfiles: z.object({
  providers: z.record(z.string().regex(/^[a-z][a-z0-9-]*$/), adapterProviderSchema).default({}),
  }).default({}),
  repair: z.object({
    displayName: z.string().default("修复任务"),
    threadNamePrefix: z.string().default("修复"),
    fixingMessage: z.string().default("修复任务执行中"),
  }).default({}),
}).optional();

const compatibilitySchema = z.object({
  v1ProjectAdapterDefaults: z.boolean().default(false),
}).default({});

const runnerPluginSchema = z.object({
  module: z.string().trim().min(1),
  options: z.record(z.unknown()).default({}),
});

const projectProviderPluginSchema = z.object({
  module: z.string().trim().min(1),
  options: z.record(z.unknown()).default({}),
});

const devicePreparationSchema = z.object({
  id: z.string().regex(/^[a-z][a-z0-9-]*$/),
  label: z.string().min(1),
  platforms: z.array(z.enum(PLATFORMS)).min(1),
  check: commandSchema,
  install: commandSchema.optional(),
  blocksTests: z.boolean().default(true),
  readyDetail: z.string().default("已就绪"),
  requiredDetail: z.string().default("需要安装"),
});

const selectParameterSchema = z.object({
  id: z.string().regex(/^[a-z][a-z0-9-]*$/),
  label: z.string().min(1),
  type: z.literal("select"),
  defaultValue: z.string().min(1),
  options: z.array(z.object({
    value: z.string().min(1),
    label: z.string().min(1),
    description: z.string().default(""),
  })).min(1),
});

const accountProfileParameterSchema = z.object({
  id: z.string().regex(/^[a-z][a-z0-9-]*$/),
  label: z.string().min(1),
  type: z.literal("account-profile"),
  defaultValue: z.literal(CURRENT_ACCOUNT_SESSION),
  capability: z.string().min(1).default("login"),
});

const pageSelectionParameterSchema = z.object({
  id: z.string().regex(/^[a-z][a-z0-9-]*$/),
  label: z.string().min(1),
  type: z.literal("page-selection"),
  defaultValue: z.string().min(1),
  source: z.literal("page-parameters"),
  presets: z.array(z.object({
    value: z.string().min(1),
    label: z.string().min(1),
    description: z.string().default(""),
    filter: z.object({
      priorities: z.array(z.string().min(1)).optional(),
      tags: z.array(z.string().min(1)).optional(),
      testScopes: z.array(z.string().min(1)).optional(),
    }).default({}),
  })).min(1),
});

const testParameterSchema = z.discriminatedUnion("type", [
  selectParameterSchema,
  accountProfileParameterSchema,
  pageSelectionParameterSchema,
]);

const testSchema = z.object({
  id: z.string().regex(/^[a-z][a-z0-9-]*$/),
  label: z.string().min(1),
  testType: z.string().default(""),
  description: z.string().default(""),
  kind: z.enum(["general", "page", "flow"]).default("general"),
  runnerId: z.string().regex(RUNNER_ID_PATTERN).default(LEGACY_COMMAND_RUNNER_ID),
  providerId: z.string().regex(RUNNER_ID_PATTERN).optional(),
  requiredCapabilities: z.array(z.string().regex(/^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/)).default([]),
  platforms: z.array(z.enum(PLATFORMS)).default([]),
  targetKeys: z.array(z.string().regex(/^[a-z][a-z0-9-]*$/)).default([]),
  parameters: z.array(testParameterSchema).default([]),
  commands: z.object({
    default: commandSchema.optional(),
    android: commandSchema.optional(),
    ios: commandSchema.optional(),
    harmony: commandSchema.optional(),
  }).default({}),
});

export const configSchema = z.object({
  schemaVersion: z.literal("mobile-test-console.config.v1"),
  project: z.object({
    id: z.string().regex(/^[a-z][a-z0-9-]*$/),
    name: z.string().min(1),
    root: z.string().min(1),
    integrationType: z.enum(PROJECT_INTEGRATION_TYPES).default("app"),
  }),
  stateDir: z.string().optional(),
  deviceProviders: z.array(z.enum(PLATFORMS)).default([...PLATFORMS]),
  testing: testingSchema,
  lifecycle: lifecycleSchema,
  taskDeletion: taskDeletionSchema,
  taskResults: taskResultsSchema,
  artifactRetention: artifactRetentionSchema,
  pageParameters: pageParametersSchema,
  businessScripts: businessScriptsSchema,
  accountProfiles: accountProfilesSchema,
  codexRepair: codexRepairSchema,
  adapter: adapterSchema,
  compatibility: compatibilitySchema,
  runnerPlugins: z.array(runnerPluginSchema).default([]),
  projectProviderPlugins: z.array(projectProviderPluginSchema).default([]),
  iosSimulator: iosSimulatorSchema,
  devicePreparations: z.array(devicePreparationSchema).default([]),
  tests: z.array(testSchema).min(1),
}).superRefine((config, context) => {
  const environmentIds = new Set<string>();
  for (const [environmentIndex, environment] of config.testing.environments.entries()) {
    if (environmentIds.has(environment.id)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: `测试环境 ID 重复: ${environment.id}`,
        path: ["testing", "environments", environmentIndex, "id"],
      });
    }
    environmentIds.add(environment.id);
  }
  const capabilityIds = new Set<string>();
  for (const [capabilityIndex, capability] of config.testing.capabilities.entries()) {
    if (capabilityIds.has(capability.id)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: `项目能力 ID 重复: ${capability.id}`,
        path: ["testing", "capabilities", capabilityIndex, "id"],
      });
    }
    capabilityIds.add(capability.id);
  }
  const targetKeys = new Set<string>();
  for (const [targetIndex, target] of config.testing.targets.entries()) {
    if (targetKeys.has(target.key)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: `运行目标 key 重复: ${target.key}`,
        path: ["testing", "targets", targetIndex, "key"],
      });
    }
    targetKeys.add(target.key);
  }
  const runnerPluginModules = new Set<string>();
  for (const [pluginIndex, plugin] of config.runnerPlugins.entries()) {
    if (runnerPluginModules.has(plugin.module)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Runner 插件模块重复: ${plugin.module}`,
        path: ["runnerPlugins", pluginIndex, "module"],
      });
    }
    runnerPluginModules.add(plugin.module);
  }
  const projectProviderPluginModules = new Set<string>();
  for (const [pluginIndex, plugin] of config.projectProviderPlugins.entries()) {
    if (projectProviderPluginModules.has(plugin.module)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: `项目 Provider 插件模块重复: ${plugin.module}`,
        path: ["projectProviderPlugins", pluginIndex, "module"],
      });
    }
    projectProviderPluginModules.add(plugin.module);
  }
  const preparationIds = new Set<string>();
  for (const [preparationIndex, preparation] of config.devicePreparations.entries()) {
    if (preparationIds.has(preparation.id)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: `设备准备 ID 重复: ${preparation.id}`,
        path: ["devicePreparations", preparationIndex, "id"],
      });
    }
    preparationIds.add(preparation.id);
  }
  const testIds = new Set<string>();
  for (const [testIndex, test] of config.tests.entries()) {
    if (testIds.has(test.id)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: `测试 ID 重复: ${test.id}`,
        path: ["tests", testIndex, "id"],
      });
    }
    testIds.add(test.id);
    if (test.platforms.length === 0 && test.targetKeys.length === 0) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "测试至少需要声明 platforms 或 targetKeys",
        path: ["tests", testIndex],
      });
    }
    const referencedTargetKeys = new Set<string>();
    for (const [targetKeyIndex, targetKey] of test.targetKeys.entries()) {
      if (referencedTargetKeys.has(targetKey)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: `测试运行目标重复: ${targetKey}`,
          path: ["tests", testIndex, "targetKeys", targetKeyIndex],
        });
      } else if (!targetKeys.has(targetKey)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: `测试引用了未声明的运行目标: ${targetKey}`,
          path: ["tests", testIndex, "targetKeys", targetKeyIndex],
        });
      }
      referencedTargetKeys.add(targetKey);
    }
    if (test.runnerId === LEGACY_COMMAND_RUNNER_ID && !Object.values(test.commands).some(Boolean)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "legacy-command-runner 测试至少需要声明一条命令",
        path: ["tests", testIndex, "commands"],
      });
    }
    if (test.requiredCapabilities.length > 0 && !test.providerId) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "声明能力依赖的测试需要配置 providerId",
        path: ["tests", testIndex, "providerId"],
      });
    }
    for (const [capabilityIndex, capability] of test.requiredCapabilities.entries()) {
      const declared = config.testing.capabilities.find(item => item.id === capability);
      if (!declared) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: `测试引用了未声明的项目能力: ${capability}`,
          path: ["tests", testIndex, "requiredCapabilities", capabilityIndex],
        });
      } else if (declared.providerId !== test.providerId) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: `测试能力 ${capability} 属于 Provider ${declared.providerId}`,
          path: ["tests", testIndex, "providerId"],
        });
      }
    }

    const parameterIds = new Set<string>();
    for (const [parameterIndex, parameter] of test.parameters.entries()) {
      if (parameterIds.has(parameter.id)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: `参数 ID 重复: ${parameter.id}`,
          path: ["tests", testIndex, "parameters", parameterIndex, "id"],
        });
      }
      parameterIds.add(parameter.id);
      if (parameter.type === "select" && !parameter.options.some(option => option.value === parameter.defaultValue)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: `默认值不在选项中: ${parameter.defaultValue}`,
          path: ["tests", testIndex, "parameters", parameterIndex, "defaultValue"],
        });
      }
      if (parameter.type === "page-selection" && !parameter.presets.some(preset => preset.value === parameter.defaultValue)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: `默认页面预设未声明: ${parameter.defaultValue}`,
          path: ["tests", testIndex, "parameters", parameterIndex, "defaultValue"],
        });
      }
    }
  }
});

export type ProjectConfigInput = z.input<typeof configSchema>;

export type CommandDefinition = z.infer<typeof commandSchema>;
type ParsedTestDefinition = z.infer<typeof testSchema>;
export type TestDefinition = Omit<ParsedTestDefinition, "testType" | "runnerId" | "kind" | "requiredCapabilities" | "targetKeys"> & {
  testType?: string;
  runnerId?: string;
  kind?: ParsedTestDefinition["kind"];
  requiredCapabilities?: string[];
  targetKeys?: string[];
};
export type DevicePreparationDefinition = z.infer<typeof devicePreparationSchema>;
type ParsedRunnerPluginDefinition = z.infer<typeof runnerPluginSchema>;
export type RunnerPluginDefinition = Omit<ParsedRunnerPluginDefinition, "options"> & {
  options?: Record<string, unknown>;
};
type ParsedProjectProviderPluginDefinition = z.infer<typeof projectProviderPluginSchema>;
export type ProjectProviderPluginDefinition = Omit<ParsedProjectProviderPluginDefinition, "options"> & {
  options?: Record<string, unknown>;
};

export interface LoadedProjectConfig {
  schemaVersion: "mobile-test-console.config.v1";
  configPath: string;
  project: {
    id: string;
    name: string;
    root: string;
    integrationType?: ProjectIntegrationType;
  };
  stateDir: string;
  deviceProviders: Platform[];
  testing?: ProjectTestingManifest;
  lifecycle: {
    startup?: CommandDefinition;
    shutdown?: CommandDefinition;
  };
  taskDeletion: {
    cleanup?: CommandDefinition;
  };
  taskResults?: {
    schemaVersion?: string;
    artifactsRoot: string;
    provider: CommandDefinition;
  };
  artifactRetention?: {
    enabled: boolean;
    autoCleanup: boolean;
    artifactsRoot?: string;
    cleanup?: CommandDefinition;
    policy: {
      maxAgeDays: number;
      maxRuns: number;
      maxBytes: number;
      minimumFreeBytes: number;
      keepSuccessfulPerPlatform: number;
      keepFailedPerPlatform: number;
      repairWorktreeMaxAgeDays: number;
    };
  };
  pageParameters?: {
    provider: CommandDefinition;
  };
  businessScripts?: {
    provider: CommandDefinition;
  };
  accountProfiles?: {
    provider: CommandDefinition;
  };
  codexRepair?: {
    enabled: boolean;
    appServer?: boolean;
    mode: "confirm";
    executable: string;
    maxAttempts: number;
    sandbox: "workspace-write";
    approvalPolicy: "never";
    worktreeRoot?: string;
    worktreeLinks: string[];
    replay?: CommandDefinition;
  };
  adapter?: ProjectAdapterManifest;
  compatibility?: {
    v1ProjectAdapterDefaults: boolean;
  };
  runnerPlugins?: RunnerPluginDefinition[];
  projectProviderPlugins?: ProjectProviderPluginDefinition[];
  iosSimulator?: {
    workspace: string;
    scheme: string;
  };
  devicePreparations?: DevicePreparationDefinition[];
  tests: TestDefinition[];
}

export interface ResolvedCommand {
  executable: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
}

export async function loadProjectConfig(inputPath: string): Promise<LoadedProjectConfig> {
  const configPath = path.resolve(inputPath);
  let imported: unknown;
  try {
    if (path.extname(configPath) === ".cjs") {
      const configRequire = createRequire(configPath);
      const resolved = configRequire.resolve(configPath);
      delete configRequire.cache[resolved];
      imported = configRequire(resolved);
    } else {
      configImportNonce += 1;
      imported = await import(`${pathToFileURL(configPath).href}?mtc=${Date.now()}-${configImportNonce}`);
    }
  } catch (error) {
    throw new ConsoleError(
      "CONFIG_LOAD_FAILED",
      `读取项目配置失败: ${configPath}\n${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const raw = (imported as { default?: unknown }).default ?? imported;
  const parsed = configSchema.safeParse(raw);
  if (!parsed.success) {
    throw new ConsoleError(
      "CONFIG_INVALID",
      `项目配置校验失败: ${parsed.error.issues.map(issue => `${issue.path.join(".")}: ${issue.message}`).join("; ")}`,
    );
  }

  const configDir = path.dirname(configPath);
  const projectRoot = path.resolve(configDir, parsed.data.project.root);
  const stateDir = parsed.data.stateDir
    ? path.resolve(configDir, parsed.data.stateDir)
    : path.join(os.homedir(), ".mobile-test-console", parsed.data.project.id);
  const adapter = await resolveLoadedProjectAdapter(
    parsed.data.adapter as ProjectAdapterManifest | undefined,
    parsed.data.compatibility.v1ProjectAdapterDefaults,
  );

  return {
    ...parsed.data,
    configPath,
    project: {
      ...parsed.data.project,
      root: projectRoot,
    },
    taskResults: parsed.data.taskResults ? {
      ...parsed.data.taskResults,
      artifactsRoot: path.resolve(projectRoot, parsed.data.taskResults.artifactsRoot),
    } : undefined,
    artifactRetention: parsed.data.artifactRetention ? {
      ...parsed.data.artifactRetention,
      artifactsRoot: parsed.data.artifactRetention.artifactsRoot
        ? path.resolve(projectRoot, parsed.data.artifactRetention.artifactsRoot)
        : parsed.data.taskResults
          ? path.resolve(projectRoot, parsed.data.taskResults.artifactsRoot)
          : undefined,
    } : undefined,
    testing: {
      ...parsed.data.testing,
      ...(parsed.data.taskResults ? {
        result: {
          schemaVersion: parsed.data.taskResults.schemaVersion,
          artifactsRoot: path.resolve(projectRoot, parsed.data.taskResults.artifactsRoot),
        },
      } : {}),
    },
    iosSimulator: parsed.data.iosSimulator ? {
      ...parsed.data.iosSimulator,
      workspace: path.resolve(projectRoot, parsed.data.iosSimulator.workspace),
    } : undefined,
    codexRepair: parsed.data.codexRepair.worktreeRoot
      ? {
          ...parsed.data.codexRepair,
          worktreeRoot: path.resolve(projectRoot, parsed.data.codexRepair.worktreeRoot),
        }
      : parsed.data.codexRepair,
    adapter,
    stateDir,
  };
}

async function resolveLoadedProjectAdapter(
  adapter: ProjectAdapterManifest | undefined,
  useV1Defaults: boolean,
): Promise<ProjectAdapterManifest> {
  if (adapter) return structuredClone(adapter);
  if (!useV1Defaults) return structuredClone(EMPTY_PROJECT_ADAPTER);

  // 旧版项目可通过显式兼容开关临时恢复历史默认清单。
  const { resolveV1ProjectAdapter } = await import("../compat/v1-project-adapter.js");
  return resolveV1ProjectAdapter(undefined);
}

export function toPublicTests(tests: TestDefinition[]): PublicTestDefinition[] {
  return tests.map(test => ({
    id: test.id,
    label: test.label,
    testType: test.testType ?? "",
    description: test.description,
    kind: test.kind ?? "general",
    runnerId: test.runnerId ?? LEGACY_COMMAND_RUNNER_ID,
    ...(test.providerId ? { providerId: test.providerId } : {}),
    requiredCapabilities: [...(test.requiredCapabilities ?? [])],
    platforms: test.platforms,
    targetKeys: [...(test.targetKeys ?? [])],
    parameters: test.parameters,
  }));
}

export function validateParameters(
  test: TestDefinition,
  input: Record<string, string>,
): Record<string, string> {
  const knownIds = new Set(test.parameters.map(parameter => parameter.id));
  const unknownIds = Object.keys(input).filter(id => !knownIds.has(id));
  if (unknownIds.length > 0) {
    throw new ConsoleError("PARAMETER_UNKNOWN", `测试参数未声明: ${unknownIds.join(", ")}`);
  }

  const result: Record<string, string> = {};
  for (const parameter of test.parameters) {
    const value = String(Object.hasOwn(input, parameter.id) ? input[parameter.id] : parameter.defaultValue);
    if (parameter.type === "select" && !parameter.options.some(option => option.value === value)) {
      throw new ConsoleError("PARAMETER_INVALID", `${parameter.label} 的值无效: ${value}`);
    }
    if (parameter.type === "account-profile"
      && value !== CURRENT_ACCOUNT_SESSION
      && !/^[A-Za-z0-9._-]+:[a-z][a-z0-9-]*$/.test(value)) {
      throw new ConsoleError("PARAMETER_INVALID", `${parameter.label} 的账号画像格式无效: ${value}`);
    }
    if (parameter.type === "page-selection") {
      const preset = parameter.presets.some(item => item.value === value);
      const pageIds = value.split(",").map(item => item.trim()).filter(Boolean);
      if (!preset && (pageIds.length === 0 || pageIds.some(pageId => /[\u0000-\u001F\u007F,]/.test(pageId)))) {
        throw new ConsoleError("PARAMETER_INVALID", `${parameter.label} 的页面选择无效: ${value}`);
      }
    }
    result[parameter.id] = value;
  }
  return result;
}

export function resolveCommand(
  config: LoadedProjectConfig,
  test: TestDefinition,
  device: Device,
  task: { id: string; runId: string },
  parameters: Record<string, string>,
  workspaceRoot = config.project.root,
): ResolvedCommand {
  const command = resolveOptionalCommand(config, test, device, task, parameters, workspaceRoot);
  if (!command) {
    throw new ConsoleError(
      "COMMAND_UNAVAILABLE",
      `${test.label} 未配置 ${device.platform} 命令`,
    );
  }
  return command;
}

export function resolveOptionalCommand(
  config: LoadedProjectConfig,
  test: TestDefinition,
  device: Device,
  task: { id: string; runId: string; retryOf?: TaskRetrySource },
  parameters: Record<string, string>,
  workspaceRoot = config.project.root,
): ResolvedCommand | null {
  const definition = test.commands[device.platform] ?? test.commands.default;
  if (!definition) return null;

  const values: Record<string, string> = {
    projectRoot: workspaceRoot,
    configPath: config.configPath,
    "process.pid": String(process.pid),
    "device.id": device.id,
    "device.key": device.key,
    "device.name": device.name,
    "device.manufacturer": device.manufacturer ?? "",
    "device.platform": device.platform,
    "device.type": device.type,
    "task.id": task.id,
    "task.runId": task.runId,
    "pageParameters.statePath": path.join(config.stateDir, "page-parameters.json"),
    "businessScripts.statePath": path.join(config.stateDir, "business-scripts.json"),
    "accountProfiles.statePath": path.join(config.stateDir, "account-profiles.json"),
  };
  for (const [key, value] of Object.entries(parameters)) {
    values[`params.${key}`] = value;
  }
  Object.assign(values, buildRetryTemplateValues(task.retryOf));

  return resolveCommandDefinition(config, definition, values, workspaceRoot);
}

export function resolveTargetCommand(
  config: LoadedProjectConfig,
  test: TestDefinition,
  target: RunTarget,
  task: { id: string; runId: string; retryOf?: TaskRetrySource },
  parameters: Record<string, string>,
  workspaceRoot = config.project.root,
): ResolvedCommand | null {
  if (target.kind === "app") {
    return resolveOptionalCommand(config, test, target.device, task, parameters, workspaceRoot);
  }
  const definition = test.commands.default;
  if (!definition) return null;
  return resolveCommandDefinition(config, definition, {
    ...buildCommonTemplateValues(config, workspaceRoot),
    ...buildTargetTemplateValues(target),
    "task.id": task.id,
    "task.runId": task.runId,
    ...Object.fromEntries(Object.entries(parameters).map(([key, value]) => [`params.${key}`, value])),
    ...buildRetryTemplateValues(task.retryOf),
  }, workspaceRoot);
}

export function resolveTargetHealthCheckCommand(
  config: LoadedProjectConfig,
  targetKey: string,
): ResolvedCommand | null {
  const target = config.testing?.targets?.find(item => item.key === targetKey);
  if (!target?.healthCheck) return null;
  const runTarget: RunTarget = {
    key: target.key,
    kind: "mini-program",
    label: target.label,
    platform: target.platform,
    runtime: target.runtime,
    appId: target.appId,
    concurrencyKey: target.concurrencyKey,
    ...(target.extensions ? { extensions: structuredClone(target.extensions) } : {}),
  };
  return resolveCommandDefinition(config, target.healthCheck, {
    ...buildCommonTemplateValues(config),
    ...buildTargetTemplateValues(runTarget),
  });
}

export function resolveLifecycleCommand(
  config: LoadedProjectConfig,
  phase: "startup" | "shutdown",
  processId = process.pid,
): ResolvedCommand | null {
  const definition = config.lifecycle[phase];
  if (!definition) return null;

  return resolveCommandDefinition(config, definition, {
    projectRoot: config.project.root,
    configPath: config.configPath,
    "process.pid": String(processId),
  });
}

export function resolveTaskDeletionCommand(
  config: LoadedProjectConfig,
  task: TestTask,
): ResolvedCommand | null {
  const definition = config.taskDeletion.cleanup;
  if (!definition) return null;

  return resolveCommandDefinition(config, definition, buildTaskTemplateValues(config, task));
}

export function resolveArtifactCleanupCommand(
  config: LoadedProjectConfig,
  requestPath: string,
): ResolvedCommand | null {
  const definition = config.artifactRetention?.cleanup;
  const artifactsRoot = config.artifactRetention?.artifactsRoot ?? config.taskResults?.artifactsRoot;
  if (!definition || !artifactsRoot) return null;
  return resolveCommandDefinition(config, definition, {
    ...buildCommonTemplateValues(config),
    "cleanup.requestPath": requestPath,
    "results.artifactsRoot": artifactsRoot,
  });
}

export function resolveDevicePreparationCommand(
  config: LoadedProjectConfig,
  preparation: DevicePreparationDefinition,
  action: "check" | "install",
  device: Device,
): ResolvedCommand | null {
  const definition = preparation[action];
  if (!definition) return null;
  return resolveCommandDefinition(config, definition, {
    projectRoot: config.project.root,
    configPath: config.configPath,
    "process.pid": String(process.pid),
    "device.id": device.id,
    "device.key": device.key,
    "device.name": device.name,
    "device.manufacturer": device.manufacturer ?? "",
    "device.platform": device.platform,
    "device.type": device.type,
  });
}

export function resolveTaskResultCommand(
  config: LoadedProjectConfig,
  task: TestTask,
): ResolvedCommand | null {
  const definition = config.taskResults?.provider;
  if (!definition) return null;

  const workspaceRoot = task.workspaceRoot || config.project.root;
  const artifactsRoot = resolveTaskArtifactsRoot(config, task);

  return resolveCommandDefinition(config, definition, {
    ...buildTaskTemplateValues(config, task),
    projectRoot: workspaceRoot,
    "results.artifactsRoot": artifactsRoot,
  }, workspaceRoot);
}

export function resolveTaskArtifactsRoot(config: LoadedProjectConfig, task: TestTask): string {
  if (!config.taskResults) return "";
  if (!task.workspaceRoot) return config.taskResults.artifactsRoot;
  const relativeRoot = path.relative(config.project.root, config.taskResults.artifactsRoot);
  return path.resolve(task.workspaceRoot, relativeRoot);
}

export function resolveRepairReplayCommand(
  config: LoadedProjectConfig,
  job: RepairJob,
  task: TestTask,
): ResolvedCommand | null {
  const definition = config.codexRepair?.replay;
  if (!definition) return null;
  const snapshotDir = path.join(config.stateDir, "repair-snapshots", job.repairJobId);
  return resolveCommandDefinition(config, definition, {
    ...buildTaskTemplateValues(config, task),
    projectRoot: job.worktreePath,
    "repair.jobId": job.repairJobId,
    "repair.caseRunId": job.caseRunId,
    "repair.targetPage": job.targetPage,
    "repair.attempt": String(job.attempt),
    "repair.snapshotPath": path.join(job.worktreePath, ".codex-repair", "input.json"),
    "repair.pageParametersPath": path.join(snapshotDir, "page-parameters.json"),
    "repair.accountProfilesPath": path.join(snapshotDir, "account-profiles.json"),
  }, job.worktreePath);
}

export function resolvePageParameterProviderCommand(
  config: LoadedProjectConfig,
  action: "catalog" | "recording-start" | "recording-status" | "recording-stop" | "replay",
  values: Record<string, string> = {},
): ResolvedCommand | null {
  const definition = config.pageParameters?.provider;
  if (!definition) return null;
  const command = resolveCommandDefinition(config, definition, {
    projectRoot: config.project.root,
    configPath: config.configPath,
    "process.pid": String(process.pid),
    "pageParameters.statePath": path.join(config.stateDir, "page-parameters.json"),
    "accountProfiles.statePath": path.join(config.stateDir, "account-profiles.json"),
    ...values,
  });
  return { ...command, args: [...command.args, action] };
}

export function resolveBusinessScriptProviderCommand(
  config: LoadedProjectConfig,
  action: "recording-start" | "recording-status" | "recording-stop" | "replay",
): ResolvedCommand | null {
  const definition = config.businessScripts?.provider;
  if (!definition) return null;
  const command = resolveCommandDefinition(config, definition, {
    projectRoot: config.project.root,
    configPath: config.configPath,
    "process.pid": String(process.pid),
    "businessScripts.statePath": path.join(config.stateDir, "business-scripts.json"),
  });
  return { ...command, args: [...command.args, action] };
}

export function resolveAccountProfileProviderCommand(
  config: LoadedProjectConfig,
  action: "recording-start" | "recording-status" | "recording-stop" | "replay",
): ResolvedCommand | null {
  const definition = config.accountProfiles?.provider;
  if (!definition) return null;
  const command = resolveCommandDefinition(config, definition, {
    projectRoot: config.project.root,
    configPath: config.configPath,
    "process.pid": String(process.pid),
    "accountProfiles.statePath": path.join(config.stateDir, "account-profiles.json"),
  });
  return { ...command, args: [...command.args, action] };
}

function buildTaskTemplateValues(config: LoadedProjectConfig, task: TestTask): Record<string, string> {
  const values: Record<string, string> = {
    ...buildCommonTemplateValues(config),
    "task.id": task.id,
    "task.runId": task.runId,
    "task.testId": task.testId,
    "pageParameters.statePath": path.join(config.stateDir, "page-parameters.json"),
    "businessScripts.statePath": path.join(config.stateDir, "business-scripts.json"),
    "accountProfiles.statePath": path.join(config.stateDir, "account-profiles.json"),
  };
  const target = task.target;
  if (target) Object.assign(values, buildTargetTemplateValues(target));
  if (task.device) {
    Object.assign(values, {
      "device.id": task.device.id,
      "device.key": task.device.key,
      "device.name": task.device.name,
      "device.manufacturer": task.device.manufacturer ?? "",
      "device.platform": task.device.platform,
      "device.type": task.device.type,
    });
  }
  for (const [key, value] of Object.entries(task.parameters)) {
    values[`params.${key}`] = value;
  }
  Object.assign(values, buildRetryTemplateValues(task.retryOf));
  return values;
}

function buildCommonTemplateValues(
  config: LoadedProjectConfig,
  workspaceRoot = config.project.root,
): Record<string, string> {
  return {
    projectRoot: workspaceRoot,
    configPath: config.configPath,
    "process.pid": String(process.pid),
    "pageParameters.statePath": path.join(config.stateDir, "page-parameters.json"),
    "businessScripts.statePath": path.join(config.stateDir, "business-scripts.json"),
    "accountProfiles.statePath": path.join(config.stateDir, "account-profiles.json"),
  };
}

function buildTargetTemplateValues(target: RunTarget): Record<string, string> {
  return {
    "target.key": target.key,
    "target.kind": target.kind,
    "target.label": target.label,
    "target.platform": target.platform,
    "target.runtime": target.runtime,
    "target.appId": target.kind === "mini-program" ? target.appId : "",
    "target.concurrencyKey": target.concurrencyKey,
  };
}

function buildRetryTemplateValues(retry?: TaskRetrySource): Record<string, string> {
  return {
    "retry.scope": retry?.scope ?? "task",
    "retry.attempt": String(retry?.attempt ?? ""),
    "retry.caseRunIds": (retry?.caseRunIds ?? []).join(","),
    "retry.caseIds": (retry?.caseIds ?? []).join(","),
    "retry.targetPages": (retry?.targetPages ?? []).join(","),
    "retry.sourceTaskId": retry?.taskId ?? "",
    "retry.sourceRunId": retry?.runId ?? "",
  };
}

function resolveCommandDefinition(
  config: LoadedProjectConfig,
  definition: CommandDefinition,
  values: Record<string, string>,
  workspaceRoot = config.project.root,
): ResolvedCommand {
  const render = (template: string) => template.replace(/\{\{([a-zA-Z0-9_.-]+)\}\}/g, (_match, key: string) => {
    if (!(key in values)) {
      throw new ConsoleError("TEMPLATE_TOKEN_UNKNOWN", `命令模板变量未定义: ${key}`);
    }
    return values[key];
  });

  return {
    executable: render(definition.executable),
    args: definition.args.map(render),
    cwd: definition.cwd ? path.resolve(workspaceRoot, render(definition.cwd)) : workspaceRoot,
    env: Object.fromEntries(Object.entries(definition.env ?? {}).map(([key, value]) => [key, render(value)])),
  };
}
