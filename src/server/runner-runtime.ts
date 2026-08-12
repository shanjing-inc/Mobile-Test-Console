import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { CommandTaskRunner, LegacyTaskRunner } from "../runner/legacy-task-runner.js";
import {
  assertRunnerPlugin,
  InProcessRunnerRegistry,
  LEGACY_COMMAND_RUNNER_ID,
  type InProcessRunner,
} from "../runner/sdk.js";
import type { LoadedProjectConfig, RunnerPluginDefinition } from "./config.js";
import { ConsoleError } from "./errors.js";
import { loadProjectProviderRuntime } from "./project-provider-runtime.js";
import { ProjectProviderRegistry } from "../runner/project-provider.js";
import { ProjectProviderCommandRunner } from "../runner/project-provider-command-runner.js";
import { ResultBundleStore } from "./result-bundle-store.js";

export interface RunnerRuntime {
  compatibilityRunner: LegacyTaskRunner;
  resolver: InProcessRunnerRegistry;
  providers: ProjectProviderRegistry;
}

type RunnerPluginConfig = Pick<
  LoadedProjectConfig,
  "configPath" | "project" | "projectProviderPlugins" | "runnerPlugins" | "stateDir" | "tests"
>;

export async function loadRunnerRuntime(
  config: RunnerPluginConfig,
  additionalRunners: InProcessRunner[] = [],
  resultBundles = new ResultBundleStore(config.stateDir),
): Promise<RunnerRuntime> {
  const providers = await loadProjectProviderRuntime(config);
  const pluginRunners = await loadConfiguredRunners(config, providers, resultBundles);
  try {
    return createRunnerRuntime(config, [...additionalRunners, ...pluginRunners], providers);
  } catch (error) {
    if (error instanceof ConsoleError) throw error;
    throw new ConsoleError(
      "CONFIG_INVALID",
      `Runner 注册失败: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

export function createRunnerRuntime(
  config: Pick<LoadedProjectConfig, "tests">,
  additionalRunners: InProcessRunner[] = [],
  providers = new ProjectProviderRegistry(),
): RunnerRuntime {
  const compatibilityRunner = new LegacyTaskRunner();
  const resolver = new InProcessRunnerRegistry(LEGACY_COMMAND_RUNNER_ID);
  resolver.register(compatibilityRunner);
  for (const runner of additionalRunners) resolver.register(runner);

  const missing = config.tests
    .map(test => ({ testId: test.id, runnerId: test.runnerId ?? LEGACY_COMMAND_RUNNER_ID }))
    .filter(item => !resolver.get(item.runnerId));
  if (missing.length > 0) {
    throw new ConsoleError(
      "CONFIG_INVALID",
      `测试引用了未注册 Runner: ${missing.map(item => `${item.testId}=${item.runnerId}`).join(", ")}`,
    );
  }

  for (const test of config.tests) {
    if (!test.providerId || !test.requiredCapabilities?.length) continue;
    try {
      providers.require(test.providerId, test.requiredCapabilities);
    } catch (error) {
      throw new ConsoleError(
        "CONFIG_INVALID",
        `测试能力不可用 (${test.id}): ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  return { compatibilityRunner, resolver, providers };
}

async function loadConfiguredRunners(
  config: RunnerPluginConfig,
  providers: ProjectProviderRegistry,
  resultBundles: ResultBundleStore,
): Promise<InProcessRunner[]> {
  const runners: InProcessRunner[] = [];
  for (const definition of config.runnerPlugins ?? []) {
    const plugin = await importRunnerPlugin(config.configPath, definition);
    let created: unknown;
    try {
      created = await plugin.createRunners({
        configPath: config.configPath,
        project: Object.freeze({ ...config.project }),
        stateDir: config.stateDir,
        options: Object.freeze({ ...definition.options }),
        services: Object.freeze({
          createCommandRunner: (id: string) => new CommandTaskRunner(id),
          createProviderCommandRunner: (
            id: string,
            providerId: string,
            requiredCapabilities: readonly string[],
          ) => new ProjectProviderCommandRunner(
            id,
            providers.require(providerId, requiredCapabilities),
            requiredCapabilities,
            resultBundles,
          ),
          requireProjectProvider: (providerId: string, requiredCapabilities?: readonly string[]) => (
            providers.require(providerId, requiredCapabilities)
          ),
        }),
      });
    } catch (error) {
      throw new ConsoleError(
        "CONFIG_INVALID",
        `Runner 插件初始化失败 (${definition.module}): ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (!Array.isArray(created)) {
      throw new ConsoleError("CONFIG_INVALID", `Runner 插件必须返回数组: ${definition.module}`);
    }
    runners.push(...created);
  }
  return runners;
}

async function importRunnerPlugin(configPath: string, definition: RunnerPluginDefinition) {
  let imported: unknown;
  try {
    const resolved = createRequire(configPath).resolve(definition.module);
    imported = await import(pathToFileURL(resolved).href);
  } catch (error) {
    throw new ConsoleError(
      "CONFIG_LOAD_FAILED",
      `读取 Runner 插件失败 (${definition.module}): ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const namespace = imported as { default?: unknown };
  const plugin = namespace.default ?? imported;
  try {
    assertRunnerPlugin(plugin);
  } catch (error) {
    throw new ConsoleError(
      "CONFIG_INVALID",
      `Runner 插件导出无效 (${definition.module}): ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return plugin;
}
