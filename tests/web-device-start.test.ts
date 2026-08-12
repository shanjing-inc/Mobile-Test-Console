import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Device } from "../src/shared/contracts.js";
import { DeviceRow } from "../src/web/App.js";
import { installDevicePreparation, startDevice } from "../src/web/api.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("网页 iOS 模拟器启动", () => {
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
