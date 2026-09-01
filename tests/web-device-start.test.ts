import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Device, MiniProgramRunTarget, PublicTestDefinition, TestCommandPreview, TestTask } from "../src/shared/contracts.js";
import { DeviceRow, formatCommandLine, hasBusySelectedTarget, initializeSelectedTargetKeys, materializeTestParameters, reconcileSelectedKeysForTest, resolveCommandPreviewTargetKeys, TargetRow, TestCommandDetailsDialog, TestCommandPreviewPanel, TestEntryDescription, testEntryOptionLabel } from "../src/web/App.js";
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
    expect(testEntryOptionLabel({ label: "Smoke 测试", testType: "", source: "preset" })).toBe("预制 · Smoke 测试");
    expect(testEntryOptionLabel({ label: "页面测试", testType: "页面回归", source: "custom" })).toBe("自定义 · 页面回归 · 页面测试");
    expect(html).toContain("test-type-label");
    expect(html).toContain("核心链路 Smoke");
    expect(html).toContain("验证登录和组织入口；适合合并前。");
    expect(legacyHtml).not.toContain("test-type-label");
    expect(legacyHtml).toContain("旧配置说明");
  });

  it("单目标展示完整命令，多目标通过详情弹窗逐条展示", () => {
    const test: PublicTestDefinition = {
      id: "pages",
      label: "页面测试",
      source: "custom",
      testType: "页面回归",
      description: "运行项目已有页面测试",
      kind: "page",
      runnerId: "legacy-command-runner",
      requiredCapabilities: [],
      platforms: [],
      targetKeys: ["wechat", "alipay"],
      parameters: [{ id: "suite", label: "套件", type: "select", defaultValue: "smoke", options: [{ value: "smoke", label: "Smoke", description: "" }] }],
    };
    const commands: TestCommandPreview[] = [
      { targetKey: "wechat", targetLabel: "微信", executable: "node", args: ["qa/run.cjs", "--page", "pages/home index"], cwd: "/project", env: { API_TOKEN: "<redacted>" } },
      { targetKey: "alipay", targetLabel: "支付宝", executable: "pnpm", args: ["test:mini", "--target", "alipay"], cwd: "/project", env: {} },
    ];
    const single = renderToStaticMarkup(React.createElement(TestCommandPreviewPanel, {
      test,
      preview: { requestKey: "single", loading: false, response: { schemaVersion: "mobile-test-console.test-command-preview.v1", testId: test.id, commands: [commands[0]] }, error: "" },
      previewTargetCount: 1,
      missingCapabilities: [],
      onOpenDetails: vi.fn(),
      onCopy: vi.fn(),
    }));
    expect(single).toContain("自定义");
    expect(single).toContain("node qa/run.cjs --page \&quot;pages/home index\&quot;");
    expect(single).toContain("API_TOKEN=&lt;redacted&gt;");
    expect(single).toContain("/project");

    const multiple = renderToStaticMarkup(React.createElement(TestCommandPreviewPanel, {
      test,
      preview: { requestKey: "multiple", loading: false, response: { schemaVersion: "mobile-test-console.test-command-preview.v1", testId: test.id, commands }, error: "" },
      previewTargetCount: 2,
      missingCapabilities: [],
      onOpenDetails: vi.fn(),
      onCopy: vi.fn(),
    }));
    expect(multiple).toContain("2 条目标命令");
    expect(multiple).toContain("查看详情");
    expect(multiple).not.toContain("pnpm test:mini");

    const details = renderToStaticMarkup(React.createElement(TestCommandDetailsDialog, {
      commands,
      onClose: vi.fn(),
      onCopy: vi.fn(),
    }));
    expect(details).toContain("测试命令详情");
    expect(details).toContain("node qa/run.cjs");
    expect(details).toContain("pnpm test:mini --target alipay");
    expect(formatCommandLine(commands[0])).toBe('node qa/run.cjs --page "pages/home index"');
    expect(materializeTestParameters(test, { suite: "smoke", stale: "ignored" })).toEqual({ suite: "smoke" });

    const runner = renderToStaticMarkup(React.createElement(TestCommandPreviewPanel, {
      test: { ...test, runnerId: "custom-runner" },
      preview: { requestKey: "runner", loading: false, response: { schemaVersion: "mobile-test-console.test-command-preview.v1", testId: test.id, commands: [] }, error: "" },
      previewTargetCount: 1,
      missingCapabilities: [],
      onOpenDetails: vi.fn(),
      onCopy: vi.fn(),
    }));
    expect(runner).toContain("custom-runner");
    expect(runner).toContain("将在任务启动后生成运行计划");
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

  it("设备已有任务时仍可选择并显示队列状态", () => {
    const device = createSimulator({
      key: "android:device-queue",
      id: "device-queue",
      name: "Android Queue Device",
      platform: "android",
      type: "physical",
      connectionState: "available",
      controlState: "ready",
      detail: "",
    });
    const task: TestTask = {
      id: "task-queue",
      runId: "run-queue",
      projectId: "demo",
      testId: "smoke",
      testLabel: "Smoke",
      device,
      parameters: {},
      status: "queued",
      phase: "等待执行",
      createdAt: "2026-09-01T00:00:00.000Z",
      startedAt: "",
      finishedAt: "",
      exitCode: null,
      error: "",
      logs: [],
    };

    const html = renderToStaticMarkup(React.createElement(DeviceRow, {
      device,
      task,
      selected: false,
      starting: false,
      onToggle: () => undefined,
      onStart: () => undefined,
    }));

    expect(html).toContain("type=\"checkbox\"");
    expect(html).not.toContain("disabled=\"\"");
    expect(html).toContain("队列中");
  });

  it("小程序单目标展示已绑定状态且不提供取消控件", () => {
    const target: MiniProgramRunTarget = {
      key: "wechat-devtools",
      kind: "mini-program",
      label: "微信开发者工具",
      platform: "wechat",
      runtime: "wechat-devtools",
      appId: "wx-test",
      concurrencyKey: "mini-wechat",
    };
    const html = renderToStaticMarkup(React.createElement(TargetRow, {
      target,
      selected: true,
      autoBound: true,
      onToggle: () => undefined,
    }));
    expect(html).toContain("微信开发者工具");
    expect(html).toContain("wechat · wechat-devtools");
    expect(html).toContain("已自动绑定");
    expect(html).toContain("role=\"img\"");
    expect(html).toContain("aria-label=\"已绑定 微信开发者工具\"");
    expect(html).toContain("可运行");
    expect(html).not.toContain("type=\"checkbox\"");
  });

  it("小程序单目标执行时展示测试中且不提供取消控件", () => {
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
    const html = renderToStaticMarkup(React.createElement(TargetRow, { target, task, selected: true, autoBound: true, onToggle: () => undefined }));
    expect(html).toContain("微信开发者工具");
    expect(html).toContain("wechat · wechat-devtools");
    expect(html).toContain("测试中");
    expect(html).not.toContain("type=\"checkbox\"");
  });

  it("小程序多目标继续提供可操作选择框", () => {
    const target: MiniProgramRunTarget = {
      key: "wechat-devtools",
      kind: "mini-program",
      label: "微信开发者工具",
      platform: "wechat",
      runtime: "wechat-devtools",
      appId: "wx-test",
      concurrencyKey: "mini-wechat",
    };
    const html = renderToStaticMarkup(React.createElement(TargetRow, {
      target,
      selected: false,
      autoBound: false,
      onToggle: () => undefined,
    }));
    expect(html).toContain("type=\"checkbox\"");
    expect(html).toContain("aria-label=\"选择 微信开发者工具\"");
    expect(html).not.toContain("disabled=\"\"");

    const busyHtml = renderToStaticMarkup(React.createElement(TargetRow, {
      target,
      task: {
        id: "task-busy", runId: "run-busy", projectId: "mini", testId: "smoke", testLabel: "Smoke",
        target, device: { key: "target:wechat-devtools", id: "wechat-devtools", name: "微信开发者工具", platform: "android", type: "emulator", connectionState: "available", osVersion: "", detail: "", controlState: "ready", controlReason: "" },
        parameters: {}, status: "running", phase: "running", createdAt: "", startedAt: "", finishedAt: "", exitCode: null, error: "", logs: [],
      },
      selected: true,
      autoBound: false,
      onToggle: () => undefined,
    }));
    expect(busyHtml).toContain("type=\"checkbox\"");
    expect(busyHtml).toContain("disabled=\"\"");
    expect(busyHtml).toContain("测试中");
  });

  it("运行列表归并隐藏活动重试时仍阻止共享执行环境启动", () => {
    const target: MiniProgramRunTarget = {
      key: "wechat-devtools",
      kind: "mini-program",
      label: "微信开发者工具",
      platform: "wechat",
      runtime: "wechat-devtools",
      appId: "wx-test",
      concurrencyKey: "mini-wechat",
    };
    const targets = [target];
    const source: TestTask = {
      id: "task-source", runId: "run-source", projectId: "mini", testId: "smoke", testLabel: "Smoke",
      target, device: { key: "target:wechat-devtools", id: "wechat-devtools", name: "微信开发者工具", platform: "android", type: "emulator", connectionState: "available", osVersion: "", detail: "", controlState: "ready", controlReason: "" },
      parameters: {}, status: "failed", phase: "failed", createdAt: "2026-09-01T00:00:00.000Z", startedAt: "", finishedAt: "", exitCode: 1, error: "failed", logs: [],
    };
    const retry: TestTask = {
      ...source,
      id: "task-retry",
      runId: "run-retry",
      status: "running",
      phase: "running",
      createdAt: "2026-09-01T00:01:00.000Z",
      retryOf: { taskId: source.id, runId: source.runId, scope: "task", attempt: 1 },
    };

    expect(hasBusySelectedTarget([target.key], targets, [source, retry])).toBe(true);
    expect(hasBusySelectedTarget([target.key], targets, [source, { ...retry, status: "passed" }])).toBe(false);
    expect(hasBusySelectedTarget([], targets, [source, retry])).toBe(false);
  });

  it("切换小程序测试入口时保留共享目标并移除失效目标", () => {
    const nextTest: PublicTestDefinition = {
      id: "smoke",
      label: "Smoke 测试",
      source: "preset",
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

  it("按入口支持范围预览命令，并在用户选择目标后收窄范围", () => {
    const targets: MiniProgramRunTarget[] = [
      {
        key: "wechat-devtools",
        kind: "mini-program",
        label: "微信开发者工具",
        platform: "wechat",
        runtime: "wechat-devtools",
        appId: "wx-test",
        concurrencyKey: "mini-wechat",
      },
      {
        key: "alipay-devtools",
        kind: "mini-program",
        label: "支付宝开发者工具",
        platform: "alipay",
        runtime: "alipay-devtools",
        appId: "ali-test",
        concurrencyKey: "mini-alipay",
      },
    ];
    const allTargetsTest: PublicTestDefinition = {
      id: "pages",
      label: "页面测试",
      source: "preset",
      testType: "页面回归",
      description: "",
      kind: "page",
      runnerId: "legacy-command-runner",
      requiredCapabilities: [],
      platforms: [],
      targetKeys: targets.map(target => target.key),
      parameters: [],
    };
    const wechatOnlyTest = { ...allTargetsTest, id: "wechat-pages", targetKeys: ["wechat-devtools"] };

    expect(resolveCommandPreviewTargetKeys([], allTargetsTest, targets)).toEqual(["wechat-devtools", "alipay-devtools"]);
    expect(resolveCommandPreviewTargetKeys(["alipay-devtools"], allTargetsTest, targets)).toEqual(["alipay-devtools"]);
    expect(resolveCommandPreviewTargetKeys([], wechatOnlyTest, targets)).toEqual(["wechat-devtools"]);
    expect(resolveCommandPreviewTargetKeys([], { ...allTargetsTest, targetKeys: ["missing"] }, targets)).toEqual([]);
    expect(initializeSelectedTargetKeys([], wechatOnlyTest, targets)).toEqual(["wechat-devtools"]);
    expect(initializeSelectedTargetKeys([], allTargetsTest, targets)).toEqual([]);
    expect(initializeSelectedTargetKeys(["alipay-devtools"], allTargetsTest, targets)).toEqual(["alipay-devtools"]);
  });

  it("未勾选运行目标时直接展示入口支持的命令", () => {
    const test: PublicTestDefinition = {
      id: "sort",
      label: "取件码排序验证",
      source: "preset",
      testType: "页面排序",
      description: "验证取件码排序",
      kind: "page",
      runnerId: "legacy-command-runner",
      requiredCapabilities: [],
      platforms: [],
      targetKeys: ["wechat-devtools"],
      parameters: [],
    };
    const html = renderToStaticMarkup(React.createElement(TestCommandPreviewPanel, {
      test,
      preview: {
        requestKey: "entry-targets",
        loading: false,
        response: {
          schemaVersion: "mobile-test-console.test-command-preview.v1",
          testId: test.id,
          commands: [{
            targetKey: "wechat-devtools",
            targetLabel: "微信开发者工具",
            executable: "pnpm",
            args: ["test:e2e:pickup-code-sort"],
            cwd: "/project",
            env: {},
          }],
        },
        error: "",
      },
      previewTargetCount: 1,
      usingEntryTargets: true,
      missingCapabilities: [],
      onOpenDetails: vi.fn(),
      onCopy: vi.fn(),
    }));

    expect(html).toContain("当前展示入口支持的命令；启动前请选择运行目标。");
    expect(html).toContain("pnpm test:e2e:pickup-code-sort");
    expect(html).not.toContain("选择运行目标后显示完整命令");
  });

  it("切换 App 测试入口时保留平台匹配设备并移除失效设备", () => {
    const nextTest: PublicTestDefinition = {
      id: "android-smoke",
      label: "Android Smoke 测试",
      source: "preset",
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
