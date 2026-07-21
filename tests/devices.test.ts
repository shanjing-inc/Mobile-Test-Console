import { describe, expect, it } from "vitest";
import {
  DeviceDiscoveryService,
  parseAndroidDevices,
  parseHarmonyDevices,
  parseIosPhysicalDevices,
  parseIosSimulators,
} from "../src/server/devices.js";
import type { CommandRunner } from "../src/server/command-runner.js";

describe("设备输出解析", () => {
  it("解析 Android 在线、离线、未授权和模拟器", () => {
    const devices = parseAndroidDevices(`List of devices attached
378effca device product:foo model:Pixel_8 device:husky transport_id:1
emulator-5554\tdevice product:sdk model:sdk_gphone64_arm64 device:emu
offline-one offline
pending-one unauthorized
`);

    expect(devices).toHaveLength(4);
    expect(devices[0]).toMatchObject({ id: "378effca", name: "Pixel 8", type: "physical", connectionState: "available" });
    expect(devices[1]).toMatchObject({ id: "emulator-5554", type: "emulator", connectionState: "available" });
    expect(devices[2].connectionState).toBe("offline");
    expect(devices[3].connectionState).toBe("unauthorized");
  });

  it("解析 iOS 模拟器和 CoreDevice 真机", () => {
    const simulators = parseIosSimulators(JSON.stringify({
      devices: {
        "com.apple.CoreSimulator.SimRuntime.iOS-18-2": [
          { udid: "SIM-1", name: "iPhone 16", state: "Booted", isAvailable: true },
        ],
      },
    }));
    const physical = parseIosPhysicalDevices(JSON.stringify({
      result: {
        devices: [{
          identifier: "PHONE-1",
          connectionProperties: { tunnelState: "connected", transportType: "wired", pairingState: "paired" },
          deviceProperties: { name: "QA iPhone", osVersionNumber: "18.2" },
          hardwareProperties: { platform: "iOS" },
        }],
      },
    }));

    expect(simulators[0]).toMatchObject({ key: "ios:SIM-1", type: "simulator", osVersion: "18.2" });
    expect(physical[0]).toMatchObject({ key: "ios:PHONE-1", type: "physical", connectionState: "available" });
  });

  it("解析 Harmony 设备并保留多个目标", () => {
    expect(parseHarmonyDevices("device-a\ndevice-b\n")).toEqual([
      expect.objectContaining({ key: "harmony:device-a" }),
      expect.objectContaining({ key: "harmony:device-b" }),
    ]);
  });

  it("单个平台发现失败时保留其他平台设备和错误", async () => {
    const runner: CommandRunner = {
      async capture(executable) {
        if (executable === "adb") return { code: 0, stdout: "abc device model:Phone\n", stderr: "" };
        return { code: 1, stdout: "", stderr: "hdc unavailable" };
      },
    };
    const service = new DeviceDiscoveryService(runner, ["android", "harmony"]);
    const result = await service.discover();

    expect(result.devices).toHaveLength(1);
    expect(result.errors.harmony).toContain("hdc unavailable");
  });
});
