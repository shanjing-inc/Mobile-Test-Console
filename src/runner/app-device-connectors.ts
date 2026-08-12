import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type {
  ConnectorCapabilityManifest,
  Device,
  Platform,
} from "../shared/contracts.js";
import { ConsoleError } from "../shared/errors.js";
import { APP_CONNECTOR_MANIFESTS } from "./app-connector-manifest.js";
import {
  InProcessConnectorRegistry,
  type CommandRunner,
  type ConnectorDevice,
  type DeviceConnector,
} from "./sdk.js";

export interface IosSimulatorProjectConfig {
  workspace: string;
  scheme: string;
}

export interface AppDeviceConnectorOptions {
  iosSimulator?: IosSimulatorProjectConfig;
  prepare?: DeviceConnector["prepare"];
  preparePlatforms?: readonly Platform[];
}

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
        ddiServicesAvailable?: boolean;
        developerModeStatus?: string;
        name?: string;
        osVersionNumber?: string;
      };
      hardwareProperties?: {
        platform?: string;
      };
    }>;
  };
}

type CoreDevice = NonNullable<NonNullable<CoreDevicePayload["result"]>["devices"]>[number];

interface CoreDeviceDetailsPayload {
  result?: CoreDevice;
}

export function parseIosPhysicalDevices(output: string): Device[] {
  return parseIosPhysicalDeviceRecords(output).map(device => createIosPhysicalDevice(device));
}

function parseIosPhysicalDeviceRecords(output: string): CoreDevice[] {
  const payload = JSON.parse(String(output || "{}")) as CoreDevicePayload;
  return (payload.result?.devices ?? [])
    .filter(device => device.identifier && device.hardwareProperties?.platform === "iOS");
}

export function parseIosPhysicalDeviceDetails(output: string): Device {
  const payload = JSON.parse(String(output || "{}")) as CoreDeviceDetailsPayload;
  if (!payload.result?.identifier || payload.result.hardwareProperties?.platform !== "iOS") {
    throw new Error("devicectl 未返回有效的 iOS 真机详情");
  }
  return createIosPhysicalDevice(payload.result);
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

export function createAppDeviceConnectorRegistry(
  runner: CommandRunner,
  platforms: readonly Platform[],
  options: AppDeviceConnectorOptions = {},
): InProcessConnectorRegistry {
  const registry = new InProcessConnectorRegistry();
  for (const platform of new Set(platforms)) {
    const prepare = options.prepare && (!options.preparePlatforms || options.preparePlatforms.includes(platform))
      ? options.prepare
      : undefined;
    const manifest = prepare
      ? APP_CONNECTOR_MANIFESTS[platform]
      : withoutCapability(APP_CONNECTOR_MANIFESTS[platform], "device.prepare");
    const discover = platform === "android"
      ? () => discoverAndroid(runner)
      : platform === "ios"
        ? () => discoverIos(runner, options.iosSimulator)
        : () => discoverHarmony(runner);
    registry.register(createDiscoveryConnector(
      manifest,
      discover,
      platform === "ios" ? device => startIosSimulator(runner, device) : undefined,
      prepare,
    ));
  }
  return registry;
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
    const records = parseIosPhysicalDeviceRecords(await readDevicectlJsonOutput(outputPath));
    const devices = records.map(device => createIosPhysicalDevice(device));
    const detailedDevices = await Promise.all(devices.map(async (device, index) => {
      if (records[index].connectionProperties?.pairingState !== "paired") return device;
      const detailPath = path.join(tempDir, `device-${index}.json`);
      try {
        const detailResult = await runner.capture(
          "xcrun",
          ["devicectl", "device", "info", "details", "--device", device.id, "--quiet", "--json-output", detailPath],
          30_000,
        );
        if (detailResult.code !== 0) {
          return classifyIosPhysicalProbeFailure(device, detailResult.stderr || detailResult.stdout);
        }
        return parseIosPhysicalDeviceDetails(await readDevicectlJsonOutput(detailPath));
      } catch (error) {
        return classifyIosPhysicalProbeFailure(
          device,
          error instanceof Error ? error.message : String(error),
        );
      }
    }));
    return detailedDevices;
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
}

async function readDevicectlJsonOutput(filePath: string): Promise<string> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      return await fs.readFile(filePath, "utf8");
    } catch (error) {
      lastError = error;
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
  }
  throw lastError;
}

function createIosPhysicalDevice(device: CoreDevice): Device {
  const id = String(device.identifier);
  const connection = device.connectionProperties;
  const properties = device.deviceProperties;
  const paired = connection?.pairingState === "paired";
  const pairingRejected = Boolean(connection?.pairingState) && !paired;
  const connected = connection?.tunnelState === "connected";
  const wired = connection?.transportType === "wired";
  const physicallyConnected = connected || (paired && wired);
  const developerMode = properties?.developerModeStatus;
  const ddiAvailable = properties?.ddiServicesAvailable;
  let controlReason = "";
  if (pairingRejected && physicallyConnected) {
    controlReason = "请在设备上完成与此 Mac 的配对授权，重新连接并解锁设备";
  } else if (!physicallyConnected) {
    controlReason = paired
      ? "iOS 真机当前未连接，请连接并解锁设备"
      : "iOS 真机尚未配对，请连接设备并在 iPhone 上信任此 Mac";
  } else if (developerMode && developerMode !== "enabled") {
    controlReason = "iOS 开发者模式未开启，请在设置 > 隐私与安全性 > 开发者模式中开启";
  } else if (ddiAvailable === false) {
    const version = properties?.osVersionNumber ? `iOS ${properties.osVersionNumber}` : "当前 iOS 版本";
    controlReason = `Developer Disk Image 服务不可用，请升级至支持 ${version} 的 Xcode，重新连接并解锁设备`;
  } else if (!connected) {
    controlReason = "iOS 开发服务通道尚未建立，请保持设备解锁并重新连接";
  }
  return {
    key: `ios:${id}`,
    id,
    name: String(properties?.name || id),
    platform: "ios",
    type: "physical",
    connectionState: pairingRejected && physicallyConnected
      ? "unauthorized"
      : physicallyConnected ? "available" : "offline",
    osVersion: String(properties?.osVersionNumber || ""),
    detail: [
      connection?.transportType,
      paired ? "已配对" : connection?.pairingState,
      developerMode === "enabled" ? "开发者模式已开启" : "",
      ddiAvailable === false ? "Developer Disk Image 不可用" : "",
    ].filter(Boolean).join(" / "),
    controlState: physicallyConnected && !controlReason ? "ready" : "unavailable",
    controlReason,
  };
}

function classifyIosPhysicalProbeFailure(device: Device, output: string): Device {
  const message = String(output || "");
  const diskImageUnavailable = /developer disk image|disk image could not be mounted|ddi/i.test(message);
  return {
    ...device,
    controlState: "unavailable",
    controlReason: diskImageUnavailable
      ? `Developer Disk Image 服务不可用，请升级至支持 iOS ${device.osVersion || "设备系统版本"} 的 Xcode，重新连接并解锁设备`
      : `iOS 真机详情探测失败：${message.trim() || "请重新连接并解锁设备"}`,
  };
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

function createDiscoveryConnector(
  manifest: ConnectorCapabilityManifest,
  discover: () => Promise<Device[]>,
  start?: DeviceConnector["start"],
  prepare?: DeviceConnector["prepare"],
): DeviceConnector {
  return {
    id: manifest.connectorId,
    manifest,
    discover: async () => (await discover()).map(device => ({
      ...device,
      connectorId: manifest.connectorId,
      capabilities: manifest.capabilities.map(capability => capability.id),
    } satisfies ConnectorDevice)),
    ...(start ? { start } : {}),
    ...(prepare ? { prepare } : {}),
  };
}

function withoutCapability(
  manifest: ConnectorCapabilityManifest,
  capabilityId: string,
): ConnectorCapabilityManifest {
  return {
    ...manifest,
    capabilities: manifest.capabilities.filter(capability => capability.id !== capabilityId),
  };
}

async function startIosSimulator(runner: CommandRunner, device: ConnectorDevice): Promise<ConnectorDevice> {
  const boot = await runner.capture("xcrun", ["simctl", "boot", device.id], 120_000);
  const bootOutput = `${boot.stdout}\n${boot.stderr}`;
  if (boot.code !== 0 && !/current state: Booted|Unable to boot device in current state: Booted/i.test(bootOutput)) {
    throw new ConsoleError("DEVICE_START_FAILED", `启动 iOS 模拟器失败: ${device.name}\n${boot.stderr || boot.stdout}`, 500);
  }
  const open = await runner.capture(
    "open",
    ["-a", "Simulator", "--args", "-CurrentDeviceUDID", device.id],
    30_000,
  );
  if (open.code !== 0) {
    throw new ConsoleError("DEVICE_START_FAILED", `打开 Simulator 失败: ${open.stderr || open.stdout}`, 500);
  }
  const ready = await runner.capture("xcrun", ["simctl", "bootstatus", device.id, "-b"], 300_000);
  if (ready.code !== 0) {
    throw new ConsoleError("DEVICE_START_FAILED", `等待 iOS 模拟器启动失败: ${device.name}\n${ready.stderr || ready.stdout}`, 500);
  }
  return {
    ...device,
    connectionState: "available",
    controlState: "ready",
    controlReason: "",
    detail: "已启动",
  };
}
