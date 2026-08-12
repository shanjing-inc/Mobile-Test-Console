import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { Device, DevicePreparation, Platform } from "../shared/contracts.js";
import type { CommandRunner } from "./command-runner.js";
import { resolveDevicePreparationCommand, type LoadedProjectConfig } from "./config.js";
import { ConsoleError } from "./errors.js";

export interface IosSimulatorProjectConfig {
  workspace: string;
  scheme: string;
}

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
}

const DEFAULT_DEVICE_CACHE_MAX_AGE_MS = 30_000;

export function parseAndroidDevices(output: string): Device[] {
  const devices = String(output || "")
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(line => line && !line.startsWith("List of devices"))
    .map(line => {
      const [id = "", state = "", ...fields] = line.split(/\s+/);
      if (!id || !state) return null;
      const metadata = Object.fromEntries(fields.map(field => {
        const separator = field.indexOf(":");
        return separator > 0 ? [field.slice(0, separator), field.slice(separator + 1)] : [field, ""];
      }));
      const type = /^emulator-\d+$/.test(id) ? "emulator" as const : "physical" as const;
      const name = String(metadata.model || metadata.device || id).replace(/_/g, " ");
      const connectionState = state === "device"
        ? "available" as const
        : state === "offline"
          ? "offline" as const
          : state === "unauthorized"
            ? "unauthorized" as const
            : "unavailable" as const;
      return {
        key: `android:${id}`,
        id,
        name,
        platform: "android" as const,
        type,
        connectionState,
        osVersion: "",
        detail: [metadata.product, metadata.device].filter(Boolean).join(" / "),
        controlState: connectionState === "available" ? "ready" as const : "unavailable" as const,
        controlReason: connectionState === "available" ? "" : "设备当前未连接",
      };
    })
    .filter((device): device is Exclude<typeof device, null> => Boolean(device));
  return devices;
}

interface IosSimulatorPayload {
  devices?: Record<string, Array<{
    udid?: string;
    name?: string;
    state?: string;
    isAvailable?: boolean;
    dataPath?: string;
  }>>;
}

export function parseIosSimulators(output: string): Device[] {
  const payload = JSON.parse(String(output || "{}")) as IosSimulatorPayload;
  return Object.entries(payload.devices ?? {}).flatMap(([runtime, devices]) => devices
    .filter(device => device.udid)
    .map(device => ({
      key: `ios:${device.udid}`,
      id: String(device.udid),
      name: String(device.name || device.udid),
      platform: "ios" as const,
      type: "simulator" as const,
      connectionState: device.isAvailable === false || device.state !== "Booted"
        ? "unavailable" as const
        : "available" as const,
      osVersion: runtime.replace(/^.*iOS-/, "").replace(/-/g, "."),
      detail: device.state === "Booted" ? "已启动" : String(device.state || "状态未知"),
      controlState: device.state === "Booted" && device.isAvailable !== false
        ? "ready" as const
        : "unavailable" as const,
      controlReason: device.isAvailable === false ? "模拟器运行时不可用" : "",
    })));
}

export function parseSupportedIosSimulatorIds(output: string): Set<string> {
  const ids = String(output || "")
    .split(/\r?\n/)
    .filter(line => /platform:iOS Simulator/i.test(line))
    .flatMap(line => [...line.matchAll(/\bid:\s*([^,}\s]+)/gi)].map(match => match[1]));
  return new Set(ids);
}

export function classifyIosSimulators(
  devices: Device[],
  supportedIds: ReadonlySet<string> | null,
  compatibilityError = "",
): Device[] {
  return devices.map(device => {
    if (device.controlReason) return device;
    if (compatibilityError) {
      return {
        ...device,
        connectionState: "unavailable",
        controlState: "unavailable",
        controlReason: compatibilityError,
        detail: compatibilityError,
      };
    }
    if (supportedIds && !supportedIds.has(device.id)) {
      return {
        ...device,
        connectionState: "unavailable",
        controlState: "unavailable",
        controlReason: "当前工程不支持此模拟器",
        detail: "当前工程不支持此模拟器",
      };
    }
    if (device.detail === "已启动") {
      return {
        ...device,
        connectionState: "available",
        controlState: "ready",
        controlReason: "",
      };
    }
    if (device.detail === "Shutdown" && supportedIds) {
      return {
        ...device,
        connectionState: "offline",
        controlState: "startable",
        controlReason: "",
        detail: "可启动",
      };
    }
    const reason = supportedIds ? `模拟器状态无法启动: ${device.detail}` : "项目未配置 iOS 模拟器启动参数";
    return {
      ...device,
      connectionState: "unavailable",
      controlState: "unavailable",
      controlReason: reason,
      detail: reason,
    };
  });
}

interface CoreDevicePayload {
  result?: {
    devices?: Array<{
      identifier?: string;
      connectionProperties?: {
        transportType?: string;
        tunnelState?: string;
        pairingState?: string;
      };
      deviceProperties?: {
        name?: string;
        osVersionNumber?: string;
      };
      hardwareProperties?: {
        platform?: string;
      };
    }>;
  };
}

export function parseIosPhysicalDevices(output: string): Device[] {
  const payload = JSON.parse(String(output || "{}")) as CoreDevicePayload;
  return (payload.result?.devices ?? [])
    .filter(device => device.identifier && device.hardwareProperties?.platform === "iOS")
    .map(device => {
      const id = String(device.identifier);
      const available = device.connectionProperties?.tunnelState === "connected";
      return {
        key: `ios:${id}`,
        id,
        name: String(device.deviceProperties?.name || id),
        platform: "ios" as const,
        type: "physical" as const,
        connectionState: available ? "available" as const : "offline" as const,
        osVersion: String(device.deviceProperties?.osVersionNumber || ""),
        detail: [
          device.connectionProperties?.transportType,
          device.connectionProperties?.pairingState,
        ].filter(Boolean).join(" / "),
        controlState: available ? "ready" as const : "unavailable" as const,
        controlReason: available ? "" : "iOS 真机当前未连接",
      };
    });
}

export function parseHarmonyDevices(output: string): Device[] {
  return String(output || "")
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(line => line && line !== "[Empty]")
    .map(line => {
      const id = line.split(/\s+/)[0];
      return {
        key: `harmony:${id}`,
        id,
        name: id,
        platform: "harmony" as const,
        type: "physical" as const,
        connectionState: "available" as const,
        osVersion: "",
        detail: "HDC 设备",
        controlState: "ready" as const,
        controlReason: "",
      };
    });
}

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

async function discoverAndroid(runner: CommandRunner): Promise<Device[]> {
  const result = await runner.capture("adb", ["devices", "-l"]);
  if (result.code !== 0) throw new Error(result.stderr || "adb devices 执行失败");
  return Promise.all(parseAndroidDevices(result.stdout).map(async device => {
    if (device.connectionState !== "available") return device;
    const manufacturer = await runner.capture(
      "adb",
      ["-s", device.id, "shell", "getprop", "ro.product.manufacturer"],
      10_000,
    );
    return {
      ...device,
      manufacturer: manufacturer.code === 0 ? manufacturer.stdout.trim() : "",
    };
  }));
}

async function discoverIos(
  runner: CommandRunner,
  project: IosSimulatorProjectConfig | undefined,
): Promise<Device[]> {
  const [simulators, physical, destinations] = await Promise.allSettled([
    runner.capture("xcrun", ["simctl", "list", "devices", "-j"], 30_000),
    discoverIosPhysical(runner),
    project
      ? runner.capture("xcodebuild", [
        "-workspace", project.workspace,
        "-scheme", project.scheme,
        "-showdestinations",
      ], 120_000)
      : Promise.resolve(null),
  ]);
  const devices: Device[] = [];
  const errors: string[] = [];
  let supportedIds: Set<string> | null = null;
  let compatibilityError = "";
  if (destinations.status === "rejected") {
    compatibilityError = `读取当前工程支持的 iOS 模拟器失败: ${String(destinations.reason)}`;
  }
  if (destinations.status === "fulfilled" && destinations.value) {
    if (destinations.value.code !== 0) {
      compatibilityError = `读取当前工程支持的 iOS 模拟器失败: ${destinations.value.stderr || destinations.value.stdout}`;
    } else {
      supportedIds = parseSupportedIosSimulatorIds(`${destinations.value.stdout}\n${destinations.value.stderr}`);
    }
  }
  if (simulators.status === "fulfilled" && simulators.value.code === 0) {
    devices.push(...classifyIosSimulators(
      parseIosSimulators(simulators.value.stdout),
      supportedIds,
      compatibilityError,
    ));
  } else {
    errors.push(simulators.status === "rejected" ? String(simulators.reason) : simulators.value.stderr);
  }
  if (physical.status === "fulfilled") {
    devices.push(...physical.value);
  } else {
    errors.push(String(physical.reason));
  }
  if (devices.length === 0 && errors.length > 0) throw new Error(errors.filter(Boolean).join("; "));
  return devices;
}

async function discoverIosPhysical(runner: CommandRunner): Promise<Device[]> {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "mobile-test-console-"));
  const outputPath = path.join(tempDir, "devices.json");
  try {
    const result = await runner.capture(
      "xcrun",
      ["devicectl", "list", "devices", "--quiet", "--json-output", outputPath],
      30_000,
    );
    if (result.code !== 0) throw new Error(result.stderr || "devicectl 执行失败");
    return parseIosPhysicalDevices(await fs.readFile(outputPath, "utf8"));
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
}

async function discoverHarmony(runner: CommandRunner): Promise<Device[]> {
  const result = await runner.capture("hdc", ["list", "targets"]);
  if (result.code !== 0) throw new Error(result.stderr || "hdc list targets 执行失败");
  return Promise.all(parseHarmonyDevices(result.stdout).map(async device => {
    const manufacturer = await runner.capture(
      "hdc",
      ["-t", device.id, "shell", "param", "get", "const.product.manufacturer"],
      10_000,
    );
    return {
      ...device,
      manufacturer: manufacturer.code === 0 ? manufacturer.stdout.trim() : "Huawei",
    };
  }));
}

export class DeviceDiscoveryService {
  private readonly startingKeys = new Set<string>();
  private readonly preparationKeys = new Set<string>();
  private readonly cacheMaxAgeMs: number;
  private readonly now: () => number;
  private cachedDiscovery: { result: DeviceDiscoveryResult; capturedAt: number } | null = null;
  private discoveryPromise: Promise<DeviceDiscoveryResult> | null = null;

  constructor(
    private readonly runner: CommandRunner,
    private readonly platforms: Platform[],
    private readonly iosSimulator?: IosSimulatorProjectConfig,
    private readonly config?: LoadedProjectConfig,
    options: DeviceDiscoveryOptions = {},
  ) {
    this.cacheMaxAgeMs = options.cacheMaxAgeMs ?? DEFAULT_DEVICE_CACHE_MAX_AGE_MS;
    this.now = options.now ?? Date.now;
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
      if (platform === "ios") return discoverIos(this.runner, this.iosSimulator);
      if (platform === "android") return discoverAndroid(this.runner);
      return discoverHarmony(this.runner);
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
      const definition = this.config?.devicePreparations?.find(item => item.id === preparationId);
      if (!definition || !definition.platforms.includes(device.platform)) {
        throw new ConsoleError("DEVICE_PREPARATION_UNKNOWN", `设备准备项不存在: ${preparationId}`, 404);
      }
      const command = resolveDevicePreparationCommand(this.config!, definition, "install", device);
      if (!command) {
        throw new ConsoleError("DEVICE_PREPARATION_UNAVAILABLE", `${definition.label} 未配置安装命令`, 409);
      }
      const result = await this.runner.capture(command.executable, command.args, 10 * 60_000, {
        cwd: command.cwd,
        env: command.env,
      });
      if (result.code !== 0) {
        throw new ConsoleError(
          "DEVICE_PREPARATION_FAILED",
          `${definition.label}安装失败\n${result.stderr || result.stdout}`,
          500,
        );
      }
      const preparedDevice = await this.attachPreparations(device);
      const preparation = preparedDevice.preparations?.find(item => item.id === preparationId);
      if (!preparation || preparation.status !== "ready") {
        throw new ConsoleError("DEVICE_PREPARATION_FAILED", `${definition.label}安装后检查仍未通过`, 500);
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

      const boot = await this.runner.capture("xcrun", ["simctl", "boot", device.id], 120_000);
      const bootOutput = `${boot.stdout}\n${boot.stderr}`;
      if (boot.code !== 0 && !/current state: Booted|Unable to boot device in current state: Booted/i.test(bootOutput)) {
        throw new ConsoleError("DEVICE_START_FAILED", `启动 iOS 模拟器失败: ${device.name}\n${boot.stderr || boot.stdout}`, 500);
      }
      const open = await this.runner.capture(
        "open",
        ["-a", "Simulator", "--args", "-CurrentDeviceUDID", device.id],
        30_000,
      );
      if (open.code !== 0) {
        throw new ConsoleError("DEVICE_START_FAILED", `打开 Simulator 失败: ${open.stderr || open.stdout}`, 500);
      }
      const ready = await this.runner.capture("xcrun", ["simctl", "bootstatus", device.id, "-b"], 300_000);
      if (ready.code !== 0) {
        throw new ConsoleError("DEVICE_START_FAILED", `等待 iOS 模拟器启动失败: ${device.name}\n${ready.stderr || ready.stdout}`, 500);
      }
      this.invalidateCache();
      return {
        ...device,
        connectionState: "available",
        controlState: "ready",
        controlReason: "",
        detail: "已启动",
      };
    } finally {
      this.startingKeys.delete(deviceKey);
    }
  }

  private async attachPreparations(device: Device): Promise<Device> {
    const definitions = this.config?.devicePreparations?.filter(item => item.platforms.includes(device.platform)) ?? [];
    if (definitions.length === 0 || device.connectionState !== "available") return device;
    const preparations = await Promise.all(definitions.map(async definition => {
      const command = resolveDevicePreparationCommand(this.config!, definition, "check", device)!;
      const result = await this.runner.capture(command.executable, command.args, 30_000, {
        cwd: command.cwd,
        env: command.env,
      });
      return {
        id: definition.id,
        label: definition.label,
        status: result.code === 0 ? "ready" as const : "required" as const,
        detail: result.code === 0 ? definition.readyDetail : definition.requiredDetail,
        installable: Boolean(definition.install),
        blocksTests: definition.blocksTests,
      };
    }));
    return { ...device, preparations };
  }
}
