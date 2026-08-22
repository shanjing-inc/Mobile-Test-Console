import os from "node:os";
import path from "node:path";
import { EMPTY_PROJECT_ADAPTER } from "../shared/project-adapter-defaults.js";
import { loadProjectConfig, type LoadedProjectConfig } from "./config.js";

export interface StartupProjectResolution {
  config: LoadedProjectConfig;
  source: "explicit" | "platform";
  diagnostic: string;
}

export function resolveProjectCatalogPath(input?: string): string {
  return String(input || process.env.MTC_PROJECT_CATALOG || path.join(os.homedir(), ".mobile-test-console", "projects.json")).trim();
}

export async function resolveStartupProject(options: {
  configPath?: string;
  platformRoot: string;
}): Promise<StartupProjectResolution> {
  const requestedConfigPath = String(options.configPath || "").trim();
  if (requestedConfigPath) {
    return {
      config: await loadProjectConfig(requestedConfigPath),
      source: "explicit",
      diagnostic: "",
    };
  }
  return {
    config: createPlatformConfig(options.platformRoot),
    source: "platform",
    diagnostic: "",
  };
}

export function isConfiguredProject(resolution: StartupProjectResolution): boolean {
  return resolution.source !== "platform";
}

function createPlatformConfig(platformRoot: string): LoadedProjectConfig {
  const root = path.resolve(platformRoot);
  return {
    schemaVersion: "mobile-test-console.config.v1",
    configPath: path.join(root, ".mobile-test-console.platform"),
    project: {
      id: "mobile-test-console",
      name: "Mobile Test Console",
      root,
      integrationType: "app",
    },
    stateDir: path.join(os.homedir(), ".mobile-test-console", "platform"),
    console: { host: "127.0.0.1", port: 4310, webPort: 4311 },
    deviceProviders: [],
    testing: { environments: [], capabilities: [] },
    lifecycle: {},
    taskDeletion: {},
    adapter: structuredClone(EMPTY_PROJECT_ADAPTER),
    compatibility: { v1ProjectAdapterDefaults: false },
    runnerPlugins: [],
    projectProviderPlugins: [],
    devicePreparations: [],
    tests: [],
  };
}
