import type { AccountProfileProvider, Device } from "./contracts.js";

export function isHuaweiDevice(device: Pick<Device, "platform" | "manufacturer" | "name" | "detail">): boolean {
  if (device.platform === "harmony") return true;
  return [device.manufacturer, device.name, device.detail]
    .some(value => /huawei|华为/i.test(String(value || "")));
}

export function supportsAccountProfileProvider(
  provider: AccountProfileProvider,
  device: Pick<Device, "platform" | "manufacturer" | "name" | "detail">,
): boolean {
  return provider !== "huawei" || isHuaweiDevice(device);
}
