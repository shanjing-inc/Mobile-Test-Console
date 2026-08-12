import type {
  AccountProfileCapture,
  AccountProfileProvider,
  AccountProfileProviderAdapterManifest,
  Device,
  ProjectAdapterManifest,
} from "../shared/contracts.js";
import type { LoadedProjectConfig } from "./config.js";
import { supportsAccountProfileProvider } from "../shared/account-profile-compatibility.js";
import { EMPTY_PROJECT_ADAPTER } from "../shared/project-adapter-defaults.js";

export function resolveProjectAdapter(config: Pick<LoadedProjectConfig, "adapter">): ProjectAdapterManifest {
  return config.adapter ?? EMPTY_PROJECT_ADAPTER;
}

export function resolveAccountProfileProviderAdapter(
  config: Pick<LoadedProjectConfig, "adapter">,
  provider: AccountProfileProvider,
): AccountProfileProviderAdapterManifest | undefined {
  return resolveProjectAdapter(config).accountProfiles.providers[provider];
}

export function supportsAccountProfileProviderAdapter(
  definition: AccountProfileProviderAdapterManifest | undefined,
  device: Pick<Device, "platform" | "manufacturer" | "name" | "detail">,
): boolean {
  return supportsAccountProfileProvider(definition, device);
}

export function accountProfileCapabilities(
  definition: AccountProfileProviderAdapterManifest | undefined,
  captures: AccountProfileCapture[],
): string[] {
  if (!definition) return [];
  const capabilities = new Set<string>([definition.requiredCapability]);
  for (const capture of captures) {
    for (const rule of definition.capabilityRules) {
      if (rule.module && capture.module !== rule.module) continue;
      if ((rule.methods?.length ?? 0) > 0 && !rule.methods?.includes(String(capture.method ?? ""))) continue;
      capabilities.add(rule.capability);
    }
  }
  return [...capabilities].sort();
}

export function isCompleteAccountProfileRecording(
  definition: AccountProfileProviderAdapterManifest | undefined,
  captures: AccountProfileCapture[],
): boolean {
  if (!definition) return false;
  if (!definition.requiredCaptureKinds.every(kind => captures.some(capture => capture.kind === kind))) return false;
  return definition.requiredResultFields.every(field => captures.some(capture => Boolean(findScalar(capture.result, field))));
}

function findScalar(value: unknown, key: string): string {
  if (!value || typeof value !== "object") return "";
  if (!Array.isArray(value) && key in value) return String((value as Record<string, unknown>)[key] ?? "").trim();
  for (const item of Object.values(value as Record<string, unknown>)) {
    const found = findScalar(item, key);
    if (found) return found;
  }
  return "";
}
