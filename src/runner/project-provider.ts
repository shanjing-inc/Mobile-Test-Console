import { PLATFORMS, type Platform, type TestTarget } from "../shared/contracts.js";
import {
  RUNNER_ID_PATTERN,
  type RunPlan,
  type RunnerCommand,
  type RunnerResult,
  validateRunnerCommand,
} from "./sdk.js";

export const PROJECT_PROVIDER_PLUGIN_API_VERSION = "mobile-test-console.project-provider-plugin.v1" as const;
export const PROJECT_PROVIDER_MANIFEST_SCHEMA_VERSION = "mobile-test-console.project-provider.v1" as const;
export const PROJECT_PROVIDER_CAPABILITY_ID_PATTERN = /^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/;

export interface ProjectProviderCapability {
  id: string;
  version: number;
}

export interface ProjectProviderManifest {
  schemaVersion: typeof PROJECT_PROVIDER_MANIFEST_SCHEMA_VERSION;
  providerId: string;
  scope: {
    targetKinds: TestTarget["kind"][];
    runtimes?: string[];
    platforms?: Platform[];
  };
  capabilities: ProjectProviderCapability[];
}

export interface ProjectProvider {
  readonly id: string;
  readonly manifest: ProjectProviderManifest;
  prepareRun?(
    request: ProjectProviderRunPreparationRequest,
  ): ProjectProviderRunPreparation | Promise<ProjectProviderRunPreparation>;
  collectResult?(
    request: ProjectProviderResultCollectionRequest,
  ): ProjectProviderResultCollection | Promise<ProjectProviderResultCollection>;
}

export interface ProjectProviderRunPreparationRequest {
  plan: Readonly<RunPlan>;
  capabilities: readonly string[];
}

export interface ProjectProviderRunPreparation {
  commands: RunnerCommand[];
}

export interface ProjectProviderResultCollectionRequest {
  plan: Readonly<RunPlan>;
  result: Readonly<RunnerResult>;
  signal: AbortSignal;
}

export interface ProjectProviderResultCollection {
  bundle: unknown;
}

export interface ProjectProviderPluginContext {
  configPath: string;
  project: Readonly<{ id: string; name: string; root: string }>;
  stateDir: string;
  options: Readonly<Record<string, unknown>>;
}

export interface ProjectProviderPlugin {
  apiVersion: typeof PROJECT_PROVIDER_PLUGIN_API_VERSION;
  createProviders(
    context: ProjectProviderPluginContext,
  ): ProjectProvider[] | Promise<ProjectProvider[]>;
}

export function defineProjectProviderPlugin(plugin: ProjectProviderPlugin): ProjectProviderPlugin {
  return plugin;
}

export class ProjectProviderRegistry {
  private readonly providers = new Map<string, ProjectProvider>();

  register(provider: ProjectProvider): void {
    validateProjectProvider(provider);
    if (this.providers.has(provider.id)) throw new Error(`项目 Provider 已注册: ${provider.id}`);
    this.providers.set(provider.id, provider);
  }

  unregister(providerId: string): boolean {
    return this.providers.delete(providerId);
  }

  get(providerId: string): ProjectProvider | undefined {
    return this.providers.get(providerId);
  }

  list(): ProjectProvider[] {
    return [...this.providers.values()];
  }

  require(providerId: string, requiredCapabilities: readonly string[] = []): ProjectProvider {
    const provider = this.providers.get(providerId);
    if (!provider) throw new Error(`项目 Provider 未注册: ${providerId}`);
    assertProjectProviderCapabilities(provider, requiredCapabilities);
    return provider;
  }

  manifests(): ProjectProviderManifest[] {
    return this.list().map(provider => structuredClone(provider.manifest));
  }
}

export function assertProjectProviderPlugin(value: unknown): asserts value is ProjectProviderPlugin {
  if (!value || typeof value !== "object") throw new Error("项目 Provider 插件导出无效");
  const plugin = value as Partial<ProjectProviderPlugin>;
  if (plugin.apiVersion !== PROJECT_PROVIDER_PLUGIN_API_VERSION) {
    throw new Error(`项目 Provider 插件协议不兼容: ${String(plugin.apiVersion ?? "unknown")}`);
  }
  if (typeof plugin.createProviders !== "function") {
    throw new Error("项目 Provider 插件缺少 createProviders()");
  }
}

export function validateProjectProvider(value: unknown): asserts value is ProjectProvider {
  if (!value || typeof value !== "object") throw new Error("项目 Provider 导出无效");
  const provider = value as Partial<ProjectProvider>;
  if (!RUNNER_ID_PATTERN.test(String(provider.id ?? ""))) {
    throw new Error(`项目 Provider ID 无效: ${String(provider.id ?? "")}`);
  }
  validateProjectProviderManifest(provider.manifest);
  if (provider.id !== provider.manifest.providerId) {
    throw new Error(`项目 Provider ID 与能力清单不一致: ${provider.id}/${provider.manifest.providerId}`);
  }
  if (provider.prepareRun !== undefined && typeof provider.prepareRun !== "function") {
    throw new Error(`项目 Provider prepareRun 无效: ${provider.id}`);
  }
  if (provider.collectResult !== undefined && typeof provider.collectResult !== "function") {
    throw new Error(`项目 Provider collectResult 无效: ${provider.id}`);
  }
  const hasResultAnalysis = provider.manifest.capabilities.some(capability => capability.id === "result.analysis");
  if (hasResultAnalysis && typeof provider.collectResult !== "function") {
    throw new Error(`项目 Provider 缺少 collectResult(): ${provider.id}`);
  }
  if (!hasResultAnalysis && typeof provider.collectResult === "function") {
    throw new Error(`项目 Provider collectResult() 必须声明 result.analysis: ${provider.id}`);
  }
}

export function assertProjectProviderCapabilities(
  provider: ProjectProvider,
  requiredCapabilities: readonly string[],
): void {
  const available = new Set(provider.manifest.capabilities.map(capability => capability.id));
  const missing = requiredCapabilities.filter(capability => !available.has(capability));
  if (missing.length > 0) {
    throw new Error(`项目 Provider 缺少能力: ${provider.id}=${missing.join(", ")}`);
  }
}

export function validateProjectProviderRunPreparation(
  value: unknown,
): asserts value is ProjectProviderRunPreparation {
  if (!value || typeof value !== "object") throw new Error("项目 Provider 准备结果无效");
  const preparation = value as Partial<ProjectProviderRunPreparation>;
  if (!Array.isArray(preparation.commands)) throw new Error("项目 Provider 准备命令必须为数组");
  for (const command of preparation.commands) validateRunnerCommand(command);
}

export function validateProjectProviderResultCollection(
  value: unknown,
): asserts value is ProjectProviderResultCollection {
  if (!value || typeof value !== "object" || !("bundle" in value)) {
    throw new Error("项目 Provider 结果收集输出无效");
  }
}

export function validateProjectProviderManifest(
  manifest: ProjectProviderManifest | undefined,
): asserts manifest is ProjectProviderManifest {
  if (!manifest || manifest.schemaVersion !== PROJECT_PROVIDER_MANIFEST_SCHEMA_VERSION) {
    throw new Error(`项目 Provider 能力协议不兼容: ${String(manifest?.schemaVersion ?? "unknown")}`);
  }
  if (!RUNNER_ID_PATTERN.test(manifest.providerId)) {
    throw new Error(`项目 Provider ID 无效: ${manifest.providerId}`);
  }
  if (!manifest.scope || !Array.isArray(manifest.scope.targetKinds) || manifest.scope.targetKinds.length === 0) {
    throw new Error("项目 Provider 必须声明目标类型");
  }
  validateUniqueValues(
    manifest.scope.targetKinds,
    value => value === "app" || value === "mini-program",
    "项目 Provider 目标类型",
  );
  if (manifest.scope.runtimes) {
    validateUniqueValues(manifest.scope.runtimes, value => typeof value === "string" && value.trim().length > 0, "项目 Provider runtime");
  }
  if (manifest.scope.platforms) {
    validateUniqueValues(manifest.scope.platforms, value => PLATFORMS.includes(value), "项目 Provider 平台");
  }
  if (!Array.isArray(manifest.capabilities) || manifest.capabilities.length === 0) {
    throw new Error(`项目 Provider 必须声明能力: ${manifest.providerId}`);
  }
  const ids = new Set<string>();
  for (const capability of manifest.capabilities) {
    if (!PROJECT_PROVIDER_CAPABILITY_ID_PATTERN.test(capability.id)
      || !Number.isInteger(capability.version)
      || capability.version < 1) {
      throw new Error(`项目 Provider 能力无效: ${capability.id}`);
    }
    if (ids.has(capability.id)) throw new Error(`项目 Provider 能力重复: ${capability.id}`);
    ids.add(capability.id);
  }
}

function validateUniqueValues<T>(
  values: T[],
  valid: (value: T) => boolean,
  label: string,
): void {
  const seen = new Set<T>();
  for (const value of values) {
    if (!valid(value)) throw new Error(`${label}无效: ${String(value)}`);
    if (seen.has(value)) throw new Error(`${label}重复: ${String(value)}`);
    seen.add(value);
  }
}
