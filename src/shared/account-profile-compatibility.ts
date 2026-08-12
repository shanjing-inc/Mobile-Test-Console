import type { AccountProfileProviderAdapterManifest, Device } from "./contracts.js";

export function supportsAccountProfileProvider(
  definition: AccountProfileProviderAdapterManifest | undefined,
  device: Pick<Device, "platform" | "manufacturer" | "name" | "detail">,
): boolean {
  if (!definition) return true;
  if (definition.devicePlatforms.includes(device.platform)) return true;
  if (definition.deviceTextIncludes.length === 0) return definition.devicePlatforms.length === 0;
  const deviceText = [device.manufacturer, device.name, device.detail].join(" ").toLowerCase();
  return definition.deviceTextIncludes.some(value => deviceText.includes(value.toLowerCase()));
}
