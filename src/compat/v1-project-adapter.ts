import type { ProjectAdapterManifest } from "../shared/contracts.js";
import { EMPTY_PROJECT_ADAPTER } from "../shared/project-adapter-defaults.js";

/**
 * 保留 v1 兼容开关的配置加载入口，同时确保平台不注入任何项目领域语义。
 * 旧项目需要在自己的 mobile-test.config.cjs 中显式声明 adapter。
 */
export const V1_PROJECT_ADAPTER_DEFAULTS: ProjectAdapterManifest = structuredClone(EMPTY_PROJECT_ADAPTER);

/** 由配置加载边界在兼容开关启用且未声明 adapter 时调用。 */
export function resolveV1ProjectAdapter(
  adapter: ProjectAdapterManifest | undefined,
): ProjectAdapterManifest {
  return structuredClone(adapter ?? V1_PROJECT_ADAPTER_DEFAULTS);
}
