import { describe, expect, it } from "vitest";
import {
  DeviceDiscoveryService,
  classifyIosSimulators,
  compareDiscoveredDevices,
  parseAndroidDevices,
  parseHarmonyDevices,
  parseIosPhysicalDevices,
  parseIosSimulators,
  parseSupportedIosSimulatorIds,
} from "../src/server/devices.js";
import type { CommandRunner } from "../src/server/command-runner.js";
import type { LoadedProjectConfig } from "../src/server/config.js";

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

    expect(simulators[0]).toMatchObject({ key: "ios:SIM-1", type: "simulator", osVersion: "18.2", controlState: "ready" });
    expect(physical[0]).toMatchObject({ key: "ios:PHONE-1", type: "physical", connectionState: "available" });
  });

  it("按 Xcode destinations 标记已启动、可启动和不可用模拟器", () => {
    const simulators = parseIosSimulators(JSON.stringify({
      devices: {
        "com.apple.CoreSimulator.SimRuntime.iOS-18-5": [
          { udid: "SIM-READY", name: "iPhone 16", state: "Booted", isAvailable: true },
          { udid: "SIM-START", name: "iPhone 16 Pro", state: "Shutdown", isAvailable: true },
          { udid: "SIM-OLD", name: "iPhone 12", state: "Shutdown", isAvailable: true },
        ],
      },
    }));
    const supported = parseSupportedIosSimulatorIds(`
      { platform:iOS Simulator, arch:arm64, id:SIM-READY, OS:18.5, name:iPhone 16 }
      { platform:iOS Simulator, arch:arm64, id:SIM-START, OS:18.5, name:iPhone 16 Pro }
      { platform:macOS, arch:arm64, id:MAC-1, name:My Mac }
    `);

    expect(classifyIosSimulators(simulators, supported)).toEqual([
      expect.objectContaining({ id: "SIM-READY", connectionState: "available", controlState: "ready" }),
      expect.objectContaining({ id: "SIM-START", connectionState: "offline", controlState: "startable", detail: "可启动" }),
      expect.objectContaining({ id: "SIM-OLD", connectionState: "unavailable", controlState: "unavailable", controlReason: "当前工程不支持此模拟器" }),
    ]);
  });

  it("缺少项目启动配置时保留已启动模拟器并说明关机设备原因", () => {
    const simulators = parseIosSimulators(JSON.stringify({
      devices: {
        "com.apple.CoreSimulator.SimRuntime.iOS-18-5": [
          { udid: "SIM-READY", name: "iPhone 16", state: "Booted", isAvailable: true },
          { udid: "SIM-SHUTDOWN", name: "iPhone 16 Pro", state: "Shutdown", isAvailable: true },
        ],
      },
    }));

    const classified = classifyIosSimulators(simulators, null);
    expect(classified[0]).toMatchObject({ controlState: "ready", connectionState: "available" });
    expect(classified[1]).toMatchObject({
      controlState: "unavailable",
      controlReason: "项目未配置 iOS 模拟器启动参数",
    });
  });

  it("Xcode destinations 查询失败时保留设备并阻止未校验的模拟器启动", async () => {
    const runner: CommandRunner = {
      async capture(executable, args) {
        if (executable === "xcodebuild") return { code: 65, stdout: "", stderr: "scheme unavailable" };
        if (executable === "xcrun" && args[0] === "simctl" && args[1] === "list") {
          return {
            code: 0,
            stdout: JSON.stringify({ devices: { runtime: [
              { udid: "SIM-READY", name: "iPhone 16", state: "Booted", isAvailable: true },
              { udid: "SIM-SHUTDOWN", name: "iPhone 16 Pro", state: "Shutdown", isAvailable: true },
            ] } }),
            stderr: "",
          };
        }
        return { code: 1, stdout: "", stderr: "devicectl unavailable" };
      },
    };
    const service = new DeviceDiscoveryService(runner, ["ios"], { workspace: "/tmp/Demo.xcworkspace", scheme: "Demo" });

    const result = await service.discover();

    expect(result.devices).toHaveLength(2);
    expect(result.devices).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: "SIM-READY",
        controlState: "unavailable",
        controlReason: expect.stringContaining("scheme unavailable"),
      }),
      expect.objectContaining({
        id: "SIM-SHUTDOWN",
        controlState: "unavailable",
        controlReason: expect.stringContaining("scheme unavailable"),
      }),
    ]));
  });

  it("解析 Harmony 设备并保留多个目标", () => {
    expect(parseHarmonyDevices("device-a\ndevice-b\n")).toEqual([
      expect.objectContaining({ key: "harmony:device-a" }),
      expect.objectContaining({ key: "harmony:device-b" }),
    ]);
  });

  it("iOS 设备按控制状态、自然名称和同名模拟器系统版本排列", () => {
    const devices = parseIosSimulators(JSON.stringify({
      devices: {
        "com.apple.CoreSimulator.SimRuntime.iOS-18-5": [
          { udid: "SIM-READY-10", name: "iPhone 10", state: "Booted", isAvailable: true },
          { udid: "SIM-START", name: "iPhone 1", state: "Shutdown", isAvailable: true },
          { udid: "SIM-UNAVAILABLE", name: "iPhone 0", state: "Shutdown", isAvailable: true },
          { udid: "SIM-SAME-18-5", name: "iPhone 20", state: "Booted", isAvailable: true },
        ],
        "com.apple.CoreSimulator.SimRuntime.iOS-17-6": [
          { udid: "SIM-READY-9", name: "iPhone 9", state: "Booted", isAvailable: true },
        ],
        "com.apple.CoreSimulator.SimRuntime.iOS-18-10": [
          { udid: "SIM-SAME-B", name: "iPhone 20", state: "Booted", isAvailable: true },
          { udid: "SIM-SAME-A", name: "iPhone 20", state: "Booted", isAvailable: true },
        ],
      },
    }));
    const classified = classifyIosSimulators(devices, new Set([
      "SIM-READY-10",
      "SIM-READY-9",
      "SIM-START",
      "SIM-SAME-18-5",
      "SIM-SAME-A",
      "SIM-SAME-B",
    ]));
    const physical = parseIosPhysicalDevices(JSON.stringify({
      result: {
        devices: [{
          identifier: "PHONE-READY",
          connectionProperties: { tunnelState: "connected" },
          deviceProperties: { name: "iPhone 11 QA Phone", osVersionNumber: "18.5" },
          hardwareProperties: { platform: "iOS" },
        }],
      },
    }));

    expect([...classified, ...physical].sort(compareDiscoveredDevices).map(device => `${device.controlState}:${device.name}:${device.osVersion}:${device.key}`)).toEqual([
      "ready:iPhone 9:17.6:ios:SIM-READY-9",
      "ready:iPhone 10:18.5:ios:SIM-READY-10",
      "ready:iPhone 11 QA Phone:18.5:ios:PHONE-READY",
      "ready:iPhone 20:18.10:ios:SIM-SAME-A",
      "ready:iPhone 20:18.10:ios:SIM-SAME-B",
      "ready:iPhone 20:18.5:ios:SIM-SAME-18-5",
      "startable:iPhone 1:18.5:ios:SIM-START",
      "unavailable:iPhone 0:18.5:ios:SIM-UNAVAILABLE",
    ]);
  });

  it("Android 和 Harmony 继续按名称和 key 排列", () => {
    const android = parseAndroidDevices(`List of devices attached
z-device device model:Zulu
a-device offline model:Alpha
`);
    android[0].controlState = "ready";
    android[1].controlState = "unavailable";
    const harmony = parseHarmonyDevices("z-target\na-target\n");
    harmony[0].controlState = "ready";
    harmony[1].controlState = "unavailable";

    expect([...android, ...harmony].sort(compareDiscoveredDevices).map(device => device.key)).toEqual([
      "android:a-device",
      "android:z-device",
      "harmony:a-target",
      "harmony:z-target",
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

  it("设备快照使用 stale-while-revalidate 并合并并发发现", async () => {
    let now = 0;
    let captureCount = 0;
    const gates = [deferred<void>(), deferred<void>()];
    const runner: CommandRunner = {
      async capture() {
        const gate = gates[captureCount];
        captureCount += 1;
        await gate.promise;
        return { code: 0, stdout: `device-${captureCount} offline model:Pixel\n`, stderr: "" };
      },
    };
    const service = new DeviceDiscoveryService(runner, ["android"], undefined, undefined, {
      cacheMaxAgeMs: 100,
      now: () => now,
    });

    await expect(service.snapshot()).resolves.toMatchObject({ devices: [], refreshing: true });
    await expect(service.snapshot()).resolves.toMatchObject({ devices: [], refreshing: true });
    expect(captureCount).toBe(1);

    const firstRefresh = service.discover();
    gates[0].resolve();
    await expect(firstRefresh).resolves.toMatchObject({ devices: [expect.objectContaining({ key: "android:device-1" })] });
    await expect(service.snapshot()).resolves.toMatchObject({
      devices: [expect.objectContaining({ key: "android:device-1" })],
      refreshing: false,
    });

    now = 200;
    await expect(service.snapshot()).resolves.toMatchObject({
      devices: [expect.objectContaining({ key: "android:device-1" })],
      refreshing: true,
    });
    expect(captureCount).toBe(2);
    const secondRefresh = service.discover();
    gates[1].resolve();
    await expect(secondRefresh).resolves.toMatchObject({ devices: [expect.objectContaining({ key: "android:device-2" })] });
    expect(captureCount).toBe(2);
  });

  it("设备发现读取 Android 与 Harmony 厂商", async () => {
    const runner: CommandRunner = {
      async capture(executable, args) {
        if (executable === "adb" && args[0] === "devices") {
          return { code: 0, stdout: "redmi-1 device model:Redmi_Note_13\nhuawei-1 device model:HUAWEI_Mate_60\n", stderr: "" };
        }
        if (executable === "adb") {
          return { code: 0, stdout: args[1] === "redmi-1" ? "Xiaomi\n" : "Huawei\n", stderr: "" };
        }
        if (executable === "hdc" && args[0] === "list") {
          return { code: 0, stdout: "harmony-1\n", stderr: "" };
        }
        return { code: 0, stdout: "Huawei\n", stderr: "" };
      },
    };

    const result = await new DeviceDiscoveryService(runner, ["android", "harmony"]).discover();

    expect(result.devices).toEqual(expect.arrayContaining([
      expect.objectContaining({ key: "android:redmi-1", manufacturer: "Xiaomi" }),
      expect.objectContaining({ key: "android:huawei-1", manufacturer: "Huawei" }),
      expect.objectContaining({ key: "harmony:harmony-1", manufacturer: "Huawei" }),
    ]));
  });

  it("Android 设备展示 Maestro 准备状态并支持安装复检", async () => {
    let installed = false;
    const runner: CommandRunner = {
      async capture(executable, args) {
        if (executable === "adb" && args[0] === "devices") {
          return { code: 0, stdout: "redmi-1 device model:Redmi_K20\n", stderr: "" };
        }
        if (executable === "adb") return { code: 0, stdout: "Xiaomi\n", stderr: "" };
        if (args[0] === "check") return { code: installed ? 0 : 1, stdout: "", stderr: "" };
        if (args[0] === "install") {
          installed = true;
          return { code: 0, stdout: "installed", stderr: "" };
        }
        return { code: 1, stdout: "", stderr: "unknown" };
      },
    };
    const config = preparationConfig();
    const service = new DeviceDiscoveryService(runner, ["android"], undefined, config);

    expect((await service.discover()).devices[0].preparations).toEqual([
      expect.objectContaining({ id: "maestro-driver", status: "required", installable: true, blocksTests: true }),
    ]);
    expect(await service.installPreparation("android:redmi-1", "maestro-driver"))
      .toMatchObject({ preparation: { status: "ready" } });
    expect((await service.discover()).devices[0].preparations)
      .toEqual([expect.objectContaining({ status: "ready" })]);
  });

  it("启动重新校验后的可启动模拟器并等待 bootstatus", async () => {
    let simulatorState = "Shutdown";
    const calls: string[] = [];
    const runner: CommandRunner = {
      async capture(executable, args) {
        calls.push([executable, ...args].join(" "));
        if (executable === "xcodebuild") {
          return { code: 0, stdout: "{ platform:iOS Simulator, id:SIM-START, OS:18.5, name:iPhone 16 }", stderr: "" };
        }
        if (executable === "xcrun" && args[0] === "simctl" && args[1] === "list") {
          return {
            code: 0,
            stdout: JSON.stringify({ devices: { runtime: [{ udid: "SIM-START", name: "iPhone 16", state: simulatorState, isAvailable: true }] } }),
            stderr: "",
          };
        }
        if (executable === "xcrun" && args[0] === "devicectl") {
          return { code: 1, stdout: "", stderr: "devicectl unavailable" };
        }
        if (executable === "xcrun" && args[0] === "simctl" && args[1] === "boot") simulatorState = "Booted";
        return { code: 0, stdout: "", stderr: "" };
      },
    };
    const service = new DeviceDiscoveryService(runner, ["ios"], { workspace: "/tmp/Demo.xcworkspace", scheme: "Demo" });

    const firstStart = service.start("ios:SIM-START");
    await expect(service.start("ios:SIM-START")).rejects.toMatchObject({
      code: "DEVICE_START_IN_PROGRESS",
    });
    await expect(firstStart).resolves.toMatchObject({
      id: "SIM-START",
      connectionState: "available",
      controlState: "ready",
    });
    expect(calls).toEqual(expect.arrayContaining([
      "xcrun simctl boot SIM-START",
      "open -a Simulator --args -CurrentDeviceUDID SIM-START",
      "xcrun simctl bootstatus SIM-START -b",
    ]));
  });

  it("拒绝未知设备、非模拟器和不可用模拟器的启动请求", async () => {
    const runner: CommandRunner = {
      async capture(executable, args) {
        if (executable === "adb") return { code: 0, stdout: "android-1 device model:Pixel\n", stderr: "" };
        if (executable === "xcodebuild") return { code: 0, stdout: "", stderr: "" };
        if (executable === "xcrun" && args[0] === "simctl" && args[1] === "list") {
          return { code: 0, stdout: JSON.stringify({ devices: { runtime: [{ udid: "SIM-OLD", name: "iPhone 12", state: "Shutdown", isAvailable: true }] } }), stderr: "" };
        }
        return { code: 1, stdout: "", stderr: "devicectl unavailable" };
      },
    };
    const service = new DeviceDiscoveryService(runner, ["android", "ios"], { workspace: "/tmp/Demo.xcworkspace", scheme: "Demo" });

    await expect(service.start("ios:missing")).rejects.toMatchObject({ code: "DEVICE_UNKNOWN" });
    await expect(service.start("android:android-1")).rejects.toMatchObject({ code: "DEVICE_START_UNAVAILABLE" });
    await expect(service.start("ios:SIM-OLD")).rejects.toMatchObject({ code: "DEVICE_START_UNAVAILABLE" });
  });
});

function preparationConfig(): LoadedProjectConfig {
  return {
    schemaVersion: "mobile-test-console.config.v1",
    configPath: "/tmp/config.cjs",
    project: { id: "demo", name: "Demo", root: "/tmp" },
    stateDir: "/tmp/state",
    deviceProviders: ["android"],
    lifecycle: {},
    taskDeletion: {},
    devicePreparations: [{
      id: "maestro-driver",
      label: "Maestro 驱动",
      platforms: ["android"],
      blocksTests: true,
      readyDetail: "已就绪",
      requiredDetail: "需要安装",
      check: { executable: "driver", args: ["check", "{{device.id}}"] },
      install: { executable: "driver", args: ["install", "{{device.id}}"] },
    }],
    tests: [{ id: "pass", label: "Pass", description: "", platforms: ["android"], parameters: [], commands: { default: { executable: "true", args: [] } } }],
  };
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>(next => { resolve = next; });
  return { promise, resolve };
}
