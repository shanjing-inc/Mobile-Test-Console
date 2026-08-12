import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import {
  CURRENT_ACCOUNT_SESSION,
  PLATFORMS,
  type Device,
  type Platform,
  type PublicTestDefinition,
  type RepairJob,
  type TestTask,
} from "../shared/contracts.js";
import { ConsoleError } from "./errors.js";

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
  artifactsRoot: z.string().min(1),
  provider: commandSchema,
}).optional();

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

const testParameterSchema = z.discriminatedUnion("type", [
  selectParameterSchema,
  accountProfileParameterSchema,
]);

const testSchema = z.object({
  id: z.string().regex(/^[a-z][a-z0-9-]*$/),
  label: z.string().min(1),
  description: z.string().default(""),
  platforms: z.array(z.enum(PLATFORMS)).min(1),
  parameters: z.array(testParameterSchema).default([]),
  commands: z.object({
    default: commandSchema.optional(),
    android: commandSchema.optional(),
    ios: commandSchema.optional(),
    harmony: commandSchema.optional(),
  }).refine(commands => Object.values(commands).some(Boolean), {
    message: "每个测试至少需要声明一条命令",
  }),
});

const configSchema = z.object({
  schemaVersion: z.literal("mobile-test-console.config.v1"),
  project: z.object({
    id: z.string().regex(/^[a-z][a-z0-9-]*$/),
    name: z.string().min(1),
    root: z.string().min(1),
  }),
  stateDir: z.string().optional(),
  deviceProviders: z.array(z.enum(PLATFORMS)).default([...PLATFORMS]),
  lifecycle: lifecycleSchema,
  taskDeletion: taskDeletionSchema,
  taskResults: taskResultsSchema,
  pageParameters: pageParametersSchema,
  businessScripts: businessScriptsSchema,
  accountProfiles: accountProfilesSchema,
  codexRepair: codexRepairSchema,
  iosSimulator: iosSimulatorSchema,
  devicePreparations: z.array(devicePreparationSchema).default([]),
  tests: z.array(testSchema).min(1),
}).superRefine((config, context) => {
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
    }
  }
});

export type CommandDefinition = z.infer<typeof commandSchema>;
export type TestDefinition = z.infer<typeof testSchema>;
export type DevicePreparationDefinition = z.infer<typeof devicePreparationSchema>;

export interface LoadedProjectConfig {
  schemaVersion: "mobile-test-console.config.v1";
  configPath: string;
  project: {
    id: string;
    name: string;
    root: string;
  };
  stateDir: string;
  deviceProviders: Platform[];
  lifecycle: {
    startup?: CommandDefinition;
    shutdown?: CommandDefinition;
  };
  taskDeletion: {
    cleanup?: CommandDefinition;
  };
  taskResults?: {
    artifactsRoot: string;
    provider: CommandDefinition;
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
    imported = await import(`${pathToFileURL(configPath).href}?t=${Date.now()}`);
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
    stateDir,
  };
}

export function toPublicTests(tests: TestDefinition[]): PublicTestDefinition[] {
  return tests.map(test => ({
    id: test.id,
    label: test.label,
    description: test.description,
    platforms: test.platforms,
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
    const value = String(input[parameter.id] || parameter.defaultValue);
    if (parameter.type === "select" && !parameter.options.some(option => option.value === value)) {
      throw new ConsoleError("PARAMETER_INVALID", `${parameter.label} 的值无效: ${value}`);
    }
    if (parameter.type === "account-profile"
      && value !== CURRENT_ACCOUNT_SESSION
      && !/^[A-Za-z0-9._-]+:[a-z][a-z0-9-]*$/.test(value)) {
      throw new ConsoleError("PARAMETER_INVALID", `${parameter.label} 的账号画像格式无效: ${value}`);
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
  const definition = test.commands[device.platform] ?? test.commands.default;
  if (!definition) {
    throw new ConsoleError(
      "COMMAND_UNAVAILABLE",
      `${test.label} 未配置 ${device.platform} 命令`,
    );
  }

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

  return resolveCommandDefinition(config, definition, values, workspaceRoot);
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
    projectRoot: config.project.root,
    configPath: config.configPath,
    "process.pid": String(process.pid),
    "device.id": task.device.id,
    "device.key": task.device.key,
    "device.name": task.device.name,
    "device.manufacturer": task.device.manufacturer ?? "",
    "device.platform": task.device.platform,
    "device.type": task.device.type,
    "task.id": task.id,
    "task.runId": task.runId,
    "task.testId": task.testId,
    "pageParameters.statePath": path.join(config.stateDir, "page-parameters.json"),
    "businessScripts.statePath": path.join(config.stateDir, "business-scripts.json"),
    "accountProfiles.statePath": path.join(config.stateDir, "account-profiles.json"),
  };
  for (const [key, value] of Object.entries(task.parameters)) {
    values[`params.${key}`] = value;
  }
  return values;
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
