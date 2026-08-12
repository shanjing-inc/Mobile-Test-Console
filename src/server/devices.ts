import type { Device, DevicePreparation, Platform } from "../shared/contracts.js";
import type { CommandRunner } from "./command-runner.js";
import type { LoadedProjectConfig } from "./config.js";
import { ConsoleError } from "./errors.js";
import {
  createV1AppDeviceConnectorRegistry,
} from "../compat/v1-device-connectors.js";
import {
  InProcessConnectorRegistry,
  type ConnectorDevice,
  type DeviceConnector,
} from "../runner/sdk.js";

export type { IosSimulatorProjectConfig } from "../runner/app-device-connectors.js";
import type { IosSimulatorProjectConfig } from "../runner/app-device-connectors.js";

export interface DeviceDiscoveryResult {
  devices: Device[];
  errors: Partial<Record<Platform, string>>;
}

export interface DeviceDiscoverySnapshot extends DeviceDiscoveryResult {
  refreshing: boolean;
}

export interface DeviceDiscoveryOptions {
  cacheMaxAgeMs?: number;
  now?: () => number;
  connectorRegistry?: InProcessConnectorRegistry;
}

const DEFAULT_DEVICE_CACHE_MAX_AGE_MS = 30_000;

export function compareDiscoveredDevices(left: Device, right: Device): number {
  const platformOrder = left.platform.localeCompare(right.platform);
  if (platformOrder !== 0) return platformOrder;

  if (left.platform === "ios") {
    const controlStateOrder = iosControlStateOrder(left) - iosControlStateOrder(right);
    if (controlStateOrder !== 0) return controlStateOrder;

    const nameOrder = left.name.localeCompare(right.name, undefined, { numeric: true });
    if (nameOrder !== 0) return nameOrder;

    if (left.type === "simulator" && right.type === "simulator") {
      const versionOrder = compareVersionDescending(left.osVersion, right.osVersion);
      if (versionOrder !== 0) return versionOrder;
    }
  } else {
    const nameOrder = left.name.localeCompare(right.name);
    if (nameOrder !== 0) return nameOrder;
  }

  return left.key.localeCompare(right.key);
}

function iosControlStateOrder(device: Device): number {
  if (device.controlState === "ready") return 0;
  if (device.controlState === "startable") return 1;
  return 2;
}

function compareVersionDescending(left: string, right: string): number {
  const leftParts = left.split(".").map(part => Number(part));
  const rightParts = right.split(".").map(part => Number(part));
  const partCount = Math.max(leftParts.length, rightParts.length);
  for (let index = 0; index < partCount; index += 1) {
    const difference = (rightParts[index] || 0) - (leftParts[index] || 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

export class DeviceDiscoveryService {
  private readonly startingKeys = new Set<string>();
  private readonly preparationKeys = new Set<string>();
  private readonly cacheMaxAgeMs: number;
  private readonly now: () => number;
  private cachedDiscovery: { result: DeviceDiscoveryResult; capturedAt: number } | null = null;
  private discoveryPromise: Promise<DeviceDiscoveryResult> | null = null;
  private readonly connectorRegistry: InProcessConnectorRegistry;

  constructor(
    runner: CommandRunner,
    private readonly platforms: Platform[],
    iosSimulator?: IosSimulatorProjectConfig,
    config?: LoadedProjectConfig,
    options: DeviceDiscoveryOptions = {},
  ) {
    this.connectorRegistry = options.connectorRegistry
      ?? createV1AppDeviceConnectorRegistry(runner, platforms, iosSimulator, config);
    this.cacheMaxAgeMs = options.cacheMaxAgeMs ?? DEFAULT_DEVICE_CACHE_MAX_AGE_MS;
    this.now = options.now ?? Date.now;
  }

  connectorManifests() {
    return this.connectorRegistry.manifests();
  }

  async snapshot(options: { refresh?: boolean } = {}): Promise<DeviceDiscoverySnapshot> {
    if (options.refresh) {
      const result = await this.discover();
      return { ...result, refreshing: false };
    }

    const cached = this.cachedDiscovery;
    if (!cached) {
      this.refreshInBackground();
      return { devices: [], errors: {}, refreshing: true };
    }

    const expired = this.now() - cached.capturedAt >= this.cacheMaxAgeMs;
    if (expired) this.refreshInBackground();
    return {
      ...structuredClone(cached.result),
      refreshing: expired || this.discoveryPromise !== null,
    };
  }

  async discover(): Promise<DeviceDiscoveryResult> {
    if (this.discoveryPromise) return structuredClone(await this.discoveryPromise);
    const promise = this.performDiscovery();
    this.discoveryPromise = promise;
    try {
      const result = await promise;
      this.cachedDiscovery = { result: structuredClone(result), capturedAt: this.now() };
      return structuredClone(result);
    } finally {
      if (this.discoveryPromise === promise) this.discoveryPromise = null;
    }
  }

  private async performDiscovery(): Promise<DeviceDiscoveryResult> {
    const results = await Promise.allSettled(this.platforms.map(platform => {
      const connector = this.connectorRegistry.select({
        platform,
        targetKind: "app",
        requiredCapabilities: ["device.discover"],
      });
      if (!connector) throw new Error(`未找到 ${platform} App 设备连接器`);
      return connector.discover();
    }));
    const devices: Device[] = [];
    const errors: Partial<Record<Platform, string>> = {};
    results.forEach((result, index) => {
      const platform = this.platforms[index];
      if (result.status === "fulfilled") {
        devices.push(...result.value);
      } else {
        errors[platform] = result.reason instanceof Error ? result.reason.message : String(result.reason);
      }
    });
    const preparedDevices = await Promise.all(devices.map(device => this.attachPreparations(device)));
    return {
      devices: preparedDevices.sort(compareDiscoveredDevices),
      errors,
    };
  }

  private refreshInBackground(): void {
    if (this.discoveryPromise) return;
    void this.discover().catch(() => undefined);
  }

  private invalidateCache(): void {
    this.cachedDiscovery = null;
  }

  async installPreparation(deviceKey: string, preparationId: string): Promise<{ device: Device; preparation: DevicePreparation }> {
    const operationKey = `${deviceKey}:${preparationId}`;
    if (this.preparationKeys.has(operationKey)) {
      throw new ConsoleError("DEVICE_PREPARATION_IN_PROGRESS", "设备依赖正在安装", 409);
    }
    this.preparationKeys.add(operationKey);
    try {
      const discovery = await this.discover();
      const device = discovery.devices.find(item => item.key === deviceKey);
      if (!device) throw new ConsoleError("DEVICE_UNKNOWN", `设备不存在: ${deviceKey}`, 404);
      if (device.connectionState !== "available") {
        throw new ConsoleError("DEVICE_UNAVAILABLE", `${device.name} 当前不可用`, 409);
      }
      const connector = this.connectorFor(device);
      if (!connector?.prepare || !this.connectorSupports(connector, "device.prepare")) {
        throw new ConsoleError("DEVICE_PREPARATION_UNAVAILABLE", `${device.name} 的连接器未提供准备能力`, 409);
      }
      const preparedDevice = await connector.prepare(device as ConnectorDevice, {
        action: "install",
        preparationId,
      });
      const preparation = preparedDevice.preparations?.find(item => item.id === preparationId);
      if (!preparation || preparation.status !== "ready") {
        throw new ConsoleError("DEVICE_PREPARATION_FAILED", `设备准备项安装后检查仍未通过: ${preparationId}`, 500);
      }
      this.invalidateCache();
      return { device: preparedDevice, preparation };
    } finally {
      this.preparationKeys.delete(operationKey);
    }
  }

  async start(deviceKey: string): Promise<Device> {
    if (this.startingKeys.has(deviceKey)) {
      throw new ConsoleError("DEVICE_START_IN_PROGRESS", "iOS 模拟器正在启动", 409);
    }
    this.startingKeys.add(deviceKey);
    try {
      const discovery = await this.discover();
      const device = discovery.devices.find(item => item.key === deviceKey);
      if (!device) throw new ConsoleError("DEVICE_UNKNOWN", `设备不存在: ${deviceKey}`, 404);
      if (device.platform !== "ios" || device.type !== "simulator") {
        throw new ConsoleError("DEVICE_START_UNAVAILABLE", "仅支持启动 iOS 模拟器", 409);
      }
      if (device.controlState !== "startable") {
        throw new ConsoleError(
          "DEVICE_START_UNAVAILABLE",
          device.controlReason || `${device.name} 当前无法启动`,
          409,
        );
      }
      const connector = this.connectorFor(device, "device.start");
      if (!connector?.start || !this.connectorSupports(connector, "device.start")) {
        throw new ConsoleError("DEVICE_START_UNAVAILABLE", `${device.name} 的连接器未提供启动能力`, 409);
      }
      const started = await connector.start(device as ConnectorDevice);
      this.invalidateCache();
      return started;
    } finally {
      this.startingKeys.delete(deviceKey);
    }
  }

  private async attachPreparations(device: Device): Promise<Device> {
    if (device.connectionState !== "available") return device;
    const connector = this.connectorFor(device, "device.prepare");
    if (!connector?.prepare || !this.connectorSupports(connector, "device.prepare")) return device;
    return connector.prepare(device as ConnectorDevice, { action: "check" });
  }

  private connectorFor(device: Device, requiredCapability?: string): DeviceConnector | undefined {
    return device.connectorId
      ? this.connectorRegistry.get(device.connectorId)
      : this.connectorRegistry.select({
        platform: device.platform,
        targetKind: "app",
        requiredCapabilities: requiredCapability ? [requiredCapability] : [],
      });
  }

  private connectorSupports(connector: DeviceConnector, capabilityId: string): boolean {
    return connector.manifest.capabilities.some(capability => capability.id === capabilityId);
  }
}
