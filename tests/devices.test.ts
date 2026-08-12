import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  DeviceDiscoveryService,
  compareDiscoveredDevices,
} from "../src/server/devices.js";
import {
  classifyIosSimulators,
  parseAndroidDevices,
  parseHarmonyDevices,
  parseIosPhysicalDeviceDetails,
  parseIosPhysicalDevices,
  parseIosSimulators,
  parseSupportedIosSimulatorIds,
} from "../src/runner/app-device-connectors.js";
import type { CommandRunner } from "../src/server/command-runner.js";
import type { LoadedProjectConfig } from "../src/server/config.js";
import { createAppConnectorManifest } from "../src/runner/app-connector-manifest.js";
import { InProcessConnectorRegistry } from "../src/runner/sdk.js";

describe("设备输出解析", () => {
  it("通过 Connector Registry 发现设备并暴露能力清单", async () => {
    const registry = new InProcessConnectorRegistry();
    const manifest = createAppConnectorManifest("android-test", "android", {
      capabilities: [{ id: "device.discover", version: 1 }],
    });
    const device = {
      key: "android:test-device",
      id: "test-device",
      name: "Test Device",
      platform: "android" as const,
      type: "physical" as const,
      connectionState: "available" as const,
      osVersion: "14",
      detail: "",
      controlState: "ready" as const,
      controlReason: "",
      connectorId: "android-test",
      capabilities: ["device.discover"],
    };
    let discoverCount = 0;
    registry.register({
      id: "android-test",
      manifest,
      discover: async () => {
        discoverCount += 1;
        return [device];
      },
    });

    const service = new DeviceDiscoveryService(
      { capture: async () => ({ code: 0, stdout: "", stderr: "" }) },
      ["android"],
      undefined,
      undefined,
      { connectorRegistry: registry },
    );

    await expect(service.discover()).resolves.toMatchObject({ devices: [device] });
    expect(discoverCount).toBe(1);
    expect(service.connectorManifests()).toEqual([manifest]);
  });

  it("通过 Connector lifecycle port 启动设备并保留服务层校验", async () => {
    const registry = new InProcessConnectorRegistry();
    const manifest = createAppConnectorManifest("ios-test", "ios", {
      deviceType: ["simulator"],
      capabilities: [
        { id: "device.discover", version: 1 },
        { id: "device.start", version: 1 },
      ],
    });
    const device = {
      key: "ios:test-simulator",
      id: "test-simulator",
      name: "Test Simulator",
      platform: "ios" as const,
      type: "simulator" as const,
      connectionState: "offline" as const,
      osVersion: "18",
      detail: "可启动",
      controlState: "startable" as const,
      controlReason: "",
      connectorId: "ios-test",
      capabilities: ["device.discover", "device.start"],
    };
    let startCount = 0;
    registry.register({
      id: "ios-test",
      manifest,
      discover: async () => [device],
      start: async current => {
        startCount += 1;
        return { ...current, connectionState: "available", controlState: "ready", detail: "已启动" };
      },
    });

    const service = new DeviceDiscoveryService(
      { capture: async () => ({ code: 0, stdout: "", stderr: "" }) },
      ["ios"],
      undefined,
      undefined,
      { connectorRegistry: registry },
    );

    await expect(service.start(device.key)).resolves.toMatchObject({ connectionState: "available", controlState: "ready" });
    expect(startCount).toBe(1);
  });

  it("通过 Connector lifecycle port 检查并安装设备准备项", async () => {
    const registry = new InProcessConnectorRegistry();
    const manifest = createAppConnectorManifest("android-test", "android", {
      capabilities: [
        { id: "device.discover", version: 1 },
        { id: "device.prepare", version: 1 },
      ],
    });
    const device = {
      key: "android:test-device",
      id: "test-device",
      name: "Test Device",
      platform: "android" as const,
      type: "physical" as const,
      connectionState: "available" as const,
      osVersion: "14",
      detail: "",
      controlState: "ready" as const,
      controlReason: "",
      connectorId: "android-test",
      capabilities: ["device.discover", "device.prepare"],
    };
    let installed = false;
    const actions: string[] = [];
    registry.register({
      id: "android-test",
      manifest,
      discover: async () => [device],
      prepare: async (current, request) => {
        actions.push(request.action);
        if (request.action === "install") installed = true;
        return {
          ...current,
          preparations: [{
            id: "driver",
            label: "Driver",
            status: installed ? "ready" : "required",
            detail: installed ? "已就绪" : "需要安装",
            installable: true,
            blocksTests: true,
          }],
        };
      },
    });
    const service = new DeviceDiscoveryService(
      { capture: async () => ({ code: 0, stdout: "", stderr: "" }) },
      ["android"],
      undefined,
      undefined,
      { connectorRegistry: registry },
    );

    await expect(service.discover()).resolves.toMatchObject({
      devices: [{ preparations: [{ id: "driver", status: "required" }] }],
    });
    await expect(service.installPreparation(device.key, "driver")).resolves.toMatchObject({
      preparation: { id: "driver", status: "ready" },
    });
    expect(actions).toEqual(["check", "check", "install"]);
  });

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

  it("iOS 真机已连接但开发者磁盘映像不可用时展示 Xcode 引导", () => {
    const listed = parseIosPhysicalDevices(JSON.stringify({
      result: {
        devices: [{
          identifier: "PHONE-DDI",
          connectionProperties: { tunnelState: "disconnected", transportType: "wired", pairingState: "paired" },
          deviceProperties: { name: "QA iPhone", osVersionNumber: "26.5.2" },
          hardwareProperties: { platform: "iOS" },
        }],
      },
    }));
    const detailed = parseIosPhysicalDeviceDetails(JSON.stringify({
      result: {
        identifier: "PHONE-DDI",
        connectionProperties: { tunnelState: "connected", transportType: "wired", pairingState: "paired" },
        deviceProperties: {
          name: "QA iPhone",
          osVersionNumber: "26.5.2",
          developerModeStatus: "enabled",
          ddiServicesAvailable: false,
        },
        hardwareProperties: { platform: "iOS" },
      },
    }));

    expect(listed[0]).toMatchObject({ connectionState: "available", controlState: "unavailable" });
    expect(detailed).toMatchObject({
      connectionState: "available",
      controlState: "unavailable",
      detail: expect.stringContaining("Developer Disk Image 不可用"),
      controlReason: expect.stringContaining("支持 iOS 26.5.2 的 Xcode"),
    });
  });

  it("发现 iOS 真机时继续探测开发服务详情", async () => {
    const calls: string[] = [];
    const outputPaths: string[] = [];
    const runner: CommandRunner = {
      async capture(executable, args) {
        calls.push([executable, ...args].join(" "));
        if (executable === "xcrun" && args[0] === "simctl") {
          return { code: 0, stdout: JSON.stringify({ devices: {} }), stderr: "" };
        }
        if (executable === "xcrun" && args[0] === "devicectl" && args[1] === "list") {
          const outputPath = args[args.indexOf("--json-output") + 1];
          outputPaths.push(outputPath);
          await fs.writeFile(outputPath, JSON.stringify({
            result: {
              devices: [{
                identifier: "PHONE-DETAIL",
                connectionProperties: { tunnelState: "disconnected", transportType: "wired", pairingState: "paired" },
                deviceProperties: { name: "QA iPhone", osVersionNumber: "26.5.2" },
                hardwareProperties: { platform: "iOS" },
              }],
            },
          }));
          return { code: 0, stdout: "", stderr: "" };
        }
        if (executable === "xcrun" && args[0] === "devicectl" && args[1] === "device") {
          const outputPath = args[args.indexOf("--json-output") + 1];
          outputPaths.push(outputPath);
          setTimeout(() => void fs.writeFile(outputPath, JSON.stringify({
            result: {
              identifier: "PHONE-DETAIL",
              connectionProperties: { tunnelState: "connected", transportType: "wired", pairingState: "paired" },
              deviceProperties: {
                name: "QA iPhone",
                osVersionNumber: "26.5.2",
                developerModeStatus: "enabled",
                ddiServicesAvailable: false,
              },
              hardwareProperties: { platform: "iOS" },
            },
          })), 10);
          return { code: 0, stdout: "", stderr: "" };
        }
        return { code: 1, stdout: "", stderr: "unexpected command" };
      },
    };
    const service = new DeviceDiscoveryService(runner, ["ios"]);

    const result = await service.discover();

    expect(result.devices[0]).toMatchObject({
      id: "PHONE-DETAIL",
      connectionState: "available",
      controlState: "unavailable",
      controlReason: expect.stringContaining("Developer Disk Image 服务不可用"),
    });
    expect(calls.some(call => call.includes("devicectl device info details --device PHONE-DETAIL"))).toBe(true);
    expect(outputPaths).toHaveLength(2);
    await expect(fs.access(path.dirname(outputPaths[0]))).rejects.toThrow();
  });

  it("单台 iOS 真机详情探测失败时保留其他设备", async () => {
    const runner: CommandRunner = {
      async capture(executable, args) {
        if (executable === "xcrun" && args[0] === "simctl") {
          return { code: 0, stdout: JSON.stringify({ devices: {} }), stderr: "" };
        }
        if (executable === "xcrun" && args[0] === "devicectl" && args[1] === "list") {
          const outputPath = args[args.indexOf("--json-output") + 1];
          await fs.writeFile(outputPath, JSON.stringify({
            result: {
              devices: ["PHONE-READY", "PHONE-FAILED"].map(identifier => ({
                identifier,
                connectionProperties: { tunnelState: "disconnected", transportType: "wired", pairingState: "paired" },
                deviceProperties: { name: identifier, osVersionNumber: "26.5.2" },
                hardwareProperties: { platform: "iOS" },
              })),
            },
          }));
          return { code: 0, stdout: "", stderr: "" };
        }
        const deviceId = args[args.indexOf("--device") + 1];
        if (deviceId === "PHONE-FAILED") throw new Error("详情命令异常退出");
        const outputPath = args[args.indexOf("--json-output") + 1];
        await fs.writeFile(outputPath, JSON.stringify({
          result: {
            identifier: deviceId,
            connectionProperties: { tunnelState: "connected", transportType: "wired", pairingState: "paired" },
            deviceProperties: { name: deviceId, osVersionNumber: "26.5.2", developerModeStatus: "enabled", ddiServicesAvailable: true },
            hardwareProperties: { platform: "iOS" },
          },
        }));
        return { code: 0, stdout: "", stderr: "" };
      },
    };

    const result = await new DeviceDiscoveryService(runner, ["ios"]).discover();

    expect(result.devices).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "PHONE-READY", connectionState: "available", controlState: "ready" }),
      expect.objectContaining({
        id: "PHONE-FAILED",
        connectionState: "available",
        controlState: "unavailable",
        controlReason: "iOS 真机详情探测失败：详情命令异常退出",
      }),
    ]));
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
    const preparationCalls: string[] = [];
    const runner: CommandRunner = {
      async capture(executable, args) {
        if (executable === "adb" && args[0] === "devices") {
          return { code: 0, stdout: "redmi-1 device model:Redmi_K20\n", stderr: "" };
        }
        if (executable === "adb") return { code: 0, stdout: "Xiaomi\n", stderr: "" };
        if (args[0] === "check") {
          preparationCalls.push("check");
          return { code: installed ? 0 : 1, stdout: "", stderr: "" };
        }
        if (args[0] === "install") {
          preparationCalls.push("install");
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
    expect(preparationCalls.slice(-3)).toEqual(["install", "check", "check"]);
  });

  it("v1 设备准备适配器保留未知项和缺少安装命令错误", async () => {
    const runner: CommandRunner = {
      async capture(executable, args) {
        if (executable === "adb" && args[0] === "devices") {
          return { code: 0, stdout: "redmi-1 device model:Redmi_K20\n", stderr: "" };
        }
        if (executable === "adb") return { code: 0, stdout: "Xiaomi\n", stderr: "" };
        return { code: 1, stdout: "", stderr: "missing" };
      },
    };
    const config = preparationConfig();
    const service = new DeviceDiscoveryService(runner, ["android"], undefined, config);

    await expect(service.installPreparation("android:redmi-1", "unknown"))
      .rejects.toMatchObject({ code: "DEVICE_PREPARATION_UNKNOWN" });

    config.devicePreparations![0] = { ...config.devicePreparations![0], install: undefined };
    const unavailableService = new DeviceDiscoveryService(runner, ["android"], undefined, config);
    await expect(unavailableService.installPreparation("android:redmi-1", "maestro-driver"))
      .rejects.toMatchObject({ code: "DEVICE_PREPARATION_UNAVAILABLE" });
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
