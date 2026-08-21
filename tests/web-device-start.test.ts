import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Device, MiniProgramRunTarget, PublicTestDefinition, TestTask } from "../src/shared/contracts.js";
import { DeviceRow, reconcileSelectedKeysForTest, TargetRow, TestEntryDescription, testEntryOptionLabel } from "../src/web/App.js";
import { installDevicePreparation, startDevice } from "../src/web/api.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("网页 iOS 模拟器启动", () => {
  it("测试入口展示配置提供的类型和说明", () => {
    const html = renderToStaticMarkup(React.createElement(TestEntryDescription, {
      testType: "核心链路 Smoke",
      text: "验证登录和组织入口；适合合并前。",
    }));
    const legacyHtml = renderToStaticMarkup(React.createElement(TestEntryDescription, {
      testType: "",
      text: "旧配置说明",
    }));

    expect(testEntryOptionLabel({ label: "Smoke 测试", testType: "核心链路 Smoke" })).toBe("核心链路 Smoke · Smoke 测试");
    expect(testEntryOptionLabel({ label: "Smoke 测试", testType: "" })).toBe("Smoke 测试");
    expect(html).toContain("test-type-label");
    expect(html).toContain("核心链路 Smoke");
    expect(html).toContain("验证登录和组织入口；适合合并前。");
    expect(legacyHtml).not.toContain("test-type-label");
    expect(legacyHtml).toContain("旧配置说明");
  });

  it("可启动设备展示启动按钮并禁用测试选择", () => {
    const html = renderToStaticMarkup(React.createElement(DeviceRow, {
      device: createSimulator({ controlState: "startable", connectionState: "offline", detail: "可启动" }),
      selected: false,
      starting: false,
      onToggle: () => undefined,
      onStart: () => undefined,
    }));

    expect(html).toContain("启动");
    expect(html).toContain("disabled=\"\"");
    expect(html).toContain("device-start-button");

    const startingHtml = renderToStaticMarkup(React.createElement(DeviceRow, {
      device: createSimulator({ controlState: "startable", connectionState: "offline", detail: "可启动" }),
      selected: false,
      starting: true,
      onToggle: () => undefined,
      onStart: () => undefined,
    }));
    expect(startingHtml).toContain("启动中");
    expect(startingHtml).toContain("device-start-button\" type=\"button\" disabled");
  });

  it("不可用设备展示工程兼容性原因", () => {
    const html = renderToStaticMarkup(React.createElement(DeviceRow, {
      device: createSimulator({
        controlState: "unavailable",
        connectionState: "unavailable",
        detail: "当前工程不支持此模拟器",
        controlReason: "当前工程不支持此模拟器",
      }),
      selected: false,
      starting: false,
      onToggle: () => undefined,
      onStart: () => undefined,
    }));

    expect(html).toContain("当前工程不支持此模拟器");
    expect(html).not.toContain("device-start-button");
  });

  it("iOS 真机开发服务不可用时展示具体修复引导", () => {
    const html = renderToStaticMarkup(React.createElement(DeviceRow, {
      device: createSimulator({
        name: "QA iPhone",
        type: "physical",
        connectionState: "available",
        controlState: "unavailable",
        controlReason: "开发者磁盘映像服务不可用，请升级到支持当前 iOS 版本的 Xcode，重新连接并解锁设备",
      }),
      selected: false,
      starting: false,
      onToggle: () => undefined,
      onStart: () => undefined,
    }));

    expect(html).toContain("开发者磁盘映像服务不可用，请升级到支持当前 iOS 版本的 Xcode，重新连接并解锁设备");
    expect(html).toContain("iOS · 真机");
    expect(html).toContain("disabled=\"\"");
  });

  it("启动请求发送当前设备 key", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ device: createSimulator({ controlState: "ready", connectionState: "available", detail: "已启动" }) }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }));
    vi.stubGlobal("fetch", fetchMock);

    await startDevice("ios:SIM-1");

    expect(fetchMock).toHaveBeenCalledWith("/api/devices/start", expect.objectContaining({
      method: "POST",
      body: JSON.stringify({ deviceKey: "ios:SIM-1" }),
    }));
  });

  it("缺少 Maestro 驱动时展示安装按钮并发送准备请求", async () => {
    const device = createSimulator({
      key: "android:redmi-1",
      id: "redmi-1",
      name: "Redmi K20",
      platform: "android",
      type: "physical",
      connectionState: "available",
      controlState: "ready",
      preparations: [{
        id: "maestro-driver",
        label: "Maestro 驱动",
        status: "required",
        detail: "缺少主驱动",
        installable: true,
        blocksTests: false,
      }],
    });
    const html = renderToStaticMarkup(React.createElement(DeviceRow, {
      device,
      selected: false,
      starting: false,
      preparing: false,
      onToggle: () => undefined,
      onStart: () => undefined,
      onInstallPreparation: () => undefined,
    }));
    expect(html).toContain("安装驱动");
    expect(html).toContain("device-prepare-button");
    expect(html).toContain("aria-label=\"选择 Redmi K20\"");

    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ device, preparation: device.preparations![0] }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }));
    vi.stubGlobal("fetch", fetchMock);
    await installDevicePreparation(device.key, "maestro-driver");
    expect(fetchMock).toHaveBeenCalledWith("/api/devices/preparations/install", expect.objectContaining({
      method: "POST",
      body: JSON.stringify({ deviceKey: device.key, preparationId: "maestro-driver" }),
    }));
  });

  it("小程序运行目标展示运行时并在任务执行时锁定选择", () => {
    const target: MiniProgramRunTarget = {
      key: "wechat-devtools",
      kind: "mini-program",
      label: "微信开发者工具",
      platform: "wechat",
      runtime: "wechat-devtools",
      appId: "wx-test",
      concurrencyKey: "mini-wechat",
    };
    const task: TestTask = {
      id: "task-1", runId: "run-1", projectId: "mini", testId: "smoke", testLabel: "Smoke",
      target, device: { key: "target:wechat-devtools", id: "wechat-devtools", name: "微信开发者工具", platform: "android", type: "emulator", connectionState: "available", osVersion: "", detail: "", controlState: "ready", controlReason: "" },
      parameters: {}, status: "running" as const, phase: "running", createdAt: "", startedAt: "", finishedAt: "", exitCode: null, error: "", logs: [],
    };
    const html = renderToStaticMarkup(React.createElement(TargetRow, { target, task, selected: true, onToggle: () => undefined }));
    expect(html).toContain("微信开发者工具");
    expect(html).toContain("wechat · wechat-devtools");
    expect(html).toContain("测试中");
    expect(html).toContain("disabled=\"\"");
  });

  it("切换小程序测试入口时保留共享目标并移除失效目标", () => {
    const nextTest: PublicTestDefinition = {
      id: "smoke",
      label: "Smoke 测试",
      testType: "",
      description: "",
      kind: "general",
      runnerId: "wechat-runner",
      requiredCapabilities: [],
      platforms: [],
      targetKeys: ["wechat-devtools"],
      parameters: [],
    };

    expect(reconcileSelectedKeysForTest(
      ["wechat-devtools", "unsupported-target"],
      nextTest,
      "mini-program",
      [],
    )).toEqual(["wechat-devtools"]);
  });

  it("切换 App 测试入口时保留平台匹配设备并移除失效设备", () => {
    const nextTest: PublicTestDefinition = {
      id: "android-smoke",
      label: "Android Smoke 测试",
      testType: "",
      description: "",
      kind: "general",
      runnerId: "app-runner",
      requiredCapabilities: [],
      platforms: ["android"],
      parameters: [],
    };
    const androidDevice = createSimulator({ key: "android:device-1", platform: "android" });
    const iosDevice = createSimulator({ key: "ios:device-1", platform: "ios" });

    expect(reconcileSelectedKeysForTest(
      [androidDevice.key, iosDevice.key],
      nextTest,
      "app",
      [androidDevice, iosDevice],
    )).toEqual([androidDevice.key]);
  });
});

function createSimulator(overrides: Partial<Device>): Device {
  return {
    key: "ios:SIM-1",
    id: "SIM-1",
    name: "iPhone 16",
    platform: "ios",
    type: "simulator",
    connectionState: "offline",
    osVersion: "18.5",
    detail: "可启动",
    controlState: "startable",
    controlReason: "",
    ...overrides,
  };
}
