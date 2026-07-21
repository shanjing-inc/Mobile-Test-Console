import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { Device, Platform } from "../shared/contracts.js";
import type { CommandRunner } from "./command-runner.js";

export interface DeviceDiscoveryResult {
  devices: Device[];
  errors: Partial<Record<Platform, string>>;
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
    .filter(device => device.isAvailable !== false && device.udid)
    .map(device => ({
      key: `ios:${device.udid}`,
      id: String(device.udid),
      name: String(device.name || device.udid),
      platform: "ios" as const,
      type: "simulator" as const,
      connectionState: "available" as const,
      osVersion: runtime.replace(/^.*iOS-/, "").replace(/-/g, "."),
      detail: device.state === "Booted" ? "已启动" : "可启动",
    })));
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
      };
    });
}

async function discoverAndroid(runner: CommandRunner): Promise<Device[]> {
  const result = await runner.capture("adb", ["devices", "-l"]);
  if (result.code !== 0) throw new Error(result.stderr || "adb devices 执行失败");
  return parseAndroidDevices(result.stdout);
}

async function discoverIos(runner: CommandRunner): Promise<Device[]> {
  const [simulators, physical] = await Promise.allSettled([
    runner.capture("xcrun", ["simctl", "list", "devices", "available", "-j"], 30_000),
    discoverIosPhysical(runner),
  ]);
  const devices: Device[] = [];
  const errors: string[] = [];
  if (simulators.status === "fulfilled" && simulators.value.code === 0) {
    devices.push(...parseIosSimulators(simulators.value.stdout));
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
  return parseHarmonyDevices(result.stdout);
}

const discoverers: Record<Platform, (runner: CommandRunner) => Promise<Device[]>> = {
  android: discoverAndroid,
  ios: discoverIos,
  harmony: discoverHarmony,
};

export class DeviceDiscoveryService {
  constructor(
    private readonly runner: CommandRunner,
    private readonly platforms: Platform[],
  ) {}

  async discover(): Promise<DeviceDiscoveryResult> {
    const results = await Promise.allSettled(this.platforms.map(platform => discoverers[platform](this.runner)));
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
    return {
      devices: devices.sort((left, right) => left.platform.localeCompare(right.platform) || left.name.localeCompare(right.name)),
      errors,
    };
  }
}
