import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import {
  assertProjectProviderPlugin,
  ProjectProviderRegistry,
} from "../runner/project-provider.js";
import type { LoadedProjectConfig, ProjectProviderPluginDefinition } from "./config.js";
import { ConsoleError } from "./errors.js";

type ProjectProviderPluginConfig = Pick<
  LoadedProjectConfig,
  "configPath" | "project" | "projectProviderPlugins" | "stateDir"
>;

export async function loadProjectProviderRuntime(
  config: ProjectProviderPluginConfig,
): Promise<ProjectProviderRegistry> {
  const registry = new ProjectProviderRegistry();
  for (const definition of config.projectProviderPlugins ?? []) {
    const plugin = await importProjectProviderPlugin(config.configPath, definition);
    let created: unknown;
    try {
      created = await plugin.createProviders({
        configPath: config.configPath,
        project: Object.freeze({ ...config.project }),
        stateDir: config.stateDir,
        options: Object.freeze({ ...definition.options }),
      });
    } catch (error) {
      throw new ConsoleError(
        "CONFIG_INVALID",
        `项目 Provider 插件初始化失败 (${definition.module}): ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (!Array.isArray(created)) {
      throw new ConsoleError("CONFIG_INVALID", `项目 Provider 插件必须返回数组: ${definition.module}`);
    }
    try {
      for (const provider of created) registry.register(provider);
    } catch (error) {
      throw new ConsoleError(
        "CONFIG_INVALID",
        `项目 Provider 注册失败 (${definition.module}): ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  return registry;
}

async function importProjectProviderPlugin(
  configPath: string,
  definition: ProjectProviderPluginDefinition,
) {
  let imported: unknown;
  try {
    const moduleRequire = createRequire(configPath);
    const resolved = moduleRequire.resolve(definition.module);
    const source = await fs.readFile(resolved);
    const fingerprint = createHash("sha256").update(source).digest("hex");
    delete moduleRequire.cache[resolved];
    imported = await import(`${pathToFileURL(resolved).href}?mtc=${fingerprint}`);
  } catch (error) {
    throw new ConsoleError(
      "CONFIG_LOAD_FAILED",
      `读取项目 Provider 插件失败 (${definition.module}): ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const namespace = imported as { default?: unknown };
  const plugin = namespace.default ?? imported;
  try {
    assertProjectProviderPlugin(plugin);
  } catch (error) {
    throw new ConsoleError(
      "CONFIG_INVALID",
      `项目 Provider 插件导出无效 (${definition.module}): ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return plugin;
}
