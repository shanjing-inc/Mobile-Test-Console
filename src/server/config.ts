import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import {
  PLATFORMS,
  type Device,
  type Platform,
  type PublicTestDefinition,
} from "../shared/contracts.js";
import { ConsoleError } from "./errors.js";

const commandSchema = z.object({
  executable: z.string().min(1),
  args: z.array(z.string()).default([]),
  cwd: z.string().optional(),
  env: z.record(z.string()).optional(),
});

const selectParameterSchema = z.object({
  id: z.string().regex(/^[a-z][a-z0-9-]*$/),
  label: z.string().min(1),
  type: z.literal("select"),
  defaultValue: z.string().min(1),
  options: z.array(z.object({
    value: z.string().min(1),
    label: z.string().min(1),
  })).min(1),
});

const testSchema = z.object({
  id: z.string().regex(/^[a-z][a-z0-9-]*$/),
  label: z.string().min(1),
  description: z.string().default(""),
  platforms: z.array(z.enum(PLATFORMS)).min(1),
  parameters: z.array(selectParameterSchema).default([]),
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
  tests: z.array(testSchema).min(1),
}).superRefine((config, context) => {
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
      if (!parameter.options.some(option => option.value === parameter.defaultValue)) {
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
    if (!parameter.options.some(option => option.value === value)) {
      throw new ConsoleError("PARAMETER_INVALID", `${parameter.label} 的值无效: ${value}`);
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
): ResolvedCommand {
  const definition = test.commands[device.platform] ?? test.commands.default;
  if (!definition) {
    throw new ConsoleError(
      "COMMAND_UNAVAILABLE",
      `${test.label} 未配置 ${device.platform} 命令`,
    );
  }

  const values: Record<string, string> = {
    projectRoot: config.project.root,
    "device.id": device.id,
    "device.key": device.key,
    "device.name": device.name,
    "device.platform": device.platform,
    "device.type": device.type,
    "task.id": task.id,
    "task.runId": task.runId,
  };
  for (const [key, value] of Object.entries(parameters)) {
    values[`params.${key}`] = value;
  }

  const render = (template: string) => template.replace(/\{\{([a-zA-Z0-9_.-]+)\}\}/g, (_match, key: string) => {
    if (!(key in values)) {
      throw new ConsoleError("TEMPLATE_TOKEN_UNKNOWN", `命令模板变量未定义: ${key}`);
    }
    return values[key];
  });

  return {
    executable: render(definition.executable),
    args: definition.args.map(render),
    cwd: definition.cwd ? path.resolve(config.project.root, render(definition.cwd)) : config.project.root,
    env: Object.fromEntries(Object.entries(definition.env ?? {}).map(([key, value]) => [key, render(value)])),
  };
}
