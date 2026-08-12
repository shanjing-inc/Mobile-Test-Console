import type { ConnectorCapabilityManifest, Platform } from "../shared/contracts.js";
import { validateCapabilityManifest } from "./sdk.js";

/** 三端 App connector 的共同能力。厂商 connector 可以在此基础上增补能力。 */
export const APP_CONNECTOR_CAPABILITIES = [
  { id: "device.discover", version: 1 },
  { id: "device.health", version: 1 },
  { id: "device.start", version: 1 },
  { id: "device.prepare", version: 1 },
  { id: "device.unlock", version: 1 },
  { id: "target.app.install", version: 1 },
  { id: "target.app.launch", version: 1 },
  { id: "evidence.screenshot", version: 1 },
  { id: "evidence.recording", version: 1, limits: { maxSeconds: 300 } },
  { id: "evidence.network", version: 1 },
  { id: "evidence.logs", version: 1 },
  { id: "result.export", version: 1 },
] as const;

export function createAppConnectorManifest(
  connectorId: string,
  platform: Platform,
  options: {
    deviceType?: Array<"physical" | "emulator" | "simulator">;
    capabilities?: Readonly<ConnectorCapabilityManifest["capabilities"]>;
    version?: string;
  } = {},
): ConnectorCapabilityManifest {
  const manifest: ConnectorCapabilityManifest = {
    schemaVersion: "mobile-test-console.capabilities.v1",
    connectorId,
    scope: {
      platform,
      deviceType: options.deviceType ?? ["physical", "emulator", "simulator"],
      targetKinds: ["app"],
    },
    capabilities: options.capabilities ? [...options.capabilities] : [...APP_CONNECTOR_CAPABILITIES],
    version: options.version ?? "1.0.0",
  };
  validateCapabilityManifest(manifest);
  return manifest;
}

export const APP_CONNECTOR_MANIFESTS: Record<Platform, ConnectorCapabilityManifest> = {
  android: createAppConnectorManifest("android-app", "android", { deviceType: ["physical", "emulator"] }),
  ios: createAppConnectorManifest("ios-app", "ios", { deviceType: ["physical", "simulator"] }),
  harmony: createAppConnectorManifest("harmony-app", "harmony", { deviceType: ["physical", "emulator"] }),
};
