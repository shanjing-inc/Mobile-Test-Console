import fs from "node:fs/promises";
import { describe, expect, it } from "vitest";
import type { ConnectorDevice } from "../src/runner/sdk.js";
import {
  assertRunnerPlugin,
  defineRunnerPlugin,
  InProcessConnectorRegistry,
  InProcessRunnerRegistry,
  LEGACY_COMMAND_RUNNER_ID,
  retryEnvironmentOfPlan,
  RUNNER_PLUGIN_API_VERSION,
  type InProcessRunner,
  validateCapabilityManifest,
} from "../src/runner/sdk.js";
import { APP_CONNECTOR_MANIFESTS } from "../src/runner/app-connector-manifest.js";
import {
  assertMiniProgramTarget,
  createMiniProgramConnectorManifest,
  supportsMiniProgramTarget,
  type MiniProgramConnector,
} from "../src/runner/mini-program-connector.js";
import {
  CommandTaskRunner,
  LegacyTaskRunner,
  createLegacyTaskRunnerConnector,
} from "../src/runner/legacy-task-runner.js";
import {
  SIDECAR_PROTOCOL_VERSION,
  assertSidecarHandshake,
} from "../src/runner/sidecar-protocol.js";
import { validateProjectProviderManifest } from "../src/runner/project-provider.js";

describe("Runner SDK", () => {
  it("将单页面复测范围转换为标准命令环境变量", () => {
    expect(retryEnvironmentOfPlan({ metadata: { retry: {
      taskId: "source-task",
      runId: "source-run",
      scope: "cases",
      attempt: 1,
      caseRunIds: ["case-run"],
      caseIds: ["case-one"],
      targetPages: ["pages/home"],
    } } })).toEqual({
      MTC_RETRY_SCOPE: "cases",
      MTC_RETRY_ATTEMPT: "1",
      MTC_RETRY_CASE_RUN_IDS: "case-run",
      MTC_RETRY_CASE_IDS: "case-one",
      MTC_RETRY_TARGET_PAGES: "pages/home",
      MTC_RETRY_CASES: "[]",
      MTC_RETRY_SOURCE_TASK_ID: "source-task",
      MTC_RETRY_SOURCE_RUN_ID: "source-run",
    });
  });
  it("按 RunPlan.runnerId 从进程内 Registry 选择 Runner", () => {
    const legacyRunner = fakeRunner(LEGACY_COMMAND_RUNNER_ID);
    const customRunner = fakeRunner("custom-runner");
    const registry = new InProcessRunnerRegistry(LEGACY_COMMAND_RUNNER_ID);
    registry.register(legacyRunner);
    registry.register(customRunner);

    const plan = {
      runId: "run-registry",
      projectId: "demo",
      testId: "smoke",
      device: fakeDevice(),
    };
    expect(registry.resolve(plan)).toBe(legacyRunner);
    expect(registry.resolve({ ...plan, runnerId: "custom-runner" })).toBe(customRunner);
    expect(() => registry.resolve({ ...plan, runnerId: "missing-runner" })).toThrow("Runner 未注册");
    expect(() => registry.register(customRunner)).toThrow("Runner 已注册");
    expect(() => registry.register(fakeRunner("Bad Runner"))).toThrow("Runner ID 无效");
    expect(() => registry.register({ id: "broken-runner" } as InProcessRunner)).toThrow("缺少 run");
  });

  it("定义并校验版本化 Runner 插件", () => {
    const plugin = defineRunnerPlugin({
      apiVersion: RUNNER_PLUGIN_API_VERSION,
      createRunners: () => [fakeRunner("plugin-runner")],
    });
    expect(() => assertRunnerPlugin(plugin)).not.toThrow();
    expect(() => assertRunnerPlugin({ ...plugin, apiVersion: "v0" })).toThrow("协议不兼容");
  });

  it("平台设备服务只通过 Connector lifecycle 调度厂商能力", async () => {
    const source = await fs.readFile(new URL("../src/server/devices.ts", import.meta.url), "utf8");

    expect(source).toContain("connector.discover()");
    expect(source).toContain("connector.start(");
    expect(source).toContain("connector.prepare(");
    expect(source).not.toMatch(/runner\.capture|\b(?:adb|xcrun|xcodebuild|devicectl|hdc)\b/);
  });

  it("提供带版本的 App connector capability manifest", () => {
    expect(APP_CONNECTOR_MANIFESTS.android).toMatchObject({
      schemaVersion: "mobile-test-console.capabilities.v1",
      connectorId: "android-app",
      scope: { platform: "android", targetKinds: ["app"] },
    });
    expect(APP_CONNECTOR_MANIFESTS.android.capabilities.map(item => item.id))
      .toContain("target.app.install");
    expect(() => validateCapabilityManifest({ ...APP_CONNECTOR_MANIFESTS.android, connectorId: "Bad ID" }))
      .toThrow("连接器 ID 无效");
  });

  it("定义小程序目标和 attach/launch/reload 能力契约", () => {
    const manifest = createMiniProgramConnectorManifest("wechat-mini", "wechat", {
      runtime: "wechat-devtools",
      devtoolsVersion: "1.06",
    });
    const target = {
      key: "wechat:wx-demo",
      kind: "mini-program" as const,
      platform: "wechat",
      runtime: "wechat-devtools",
      appId: "wx-demo",
    };
    expect(supportsMiniProgramTarget(manifest, target, ["target.mini-program.attach"])).toBe(true);
    expect(() => assertMiniProgramTarget({ ...target, appId: "" })).toThrow("appId");
  });

  it("项目 Provider 清单接受开放的小程序平台", () => {
    expect(() => validateProjectProviderManifest({
      schemaVersion: "mobile-test-console.project-provider.v1",
      providerId: "wechat-provider",
      scope: { targetKinds: ["mini-program"], runtimes: ["wechat-devtools"], platforms: ["wechat"] },
      capabilities: [{ id: "mini-program.smoke", version: 1 }],
    })).not.toThrow();
  });

  it("注册连接器并拒绝重复 ID", () => {
    const connector = fakeConnector("android-fake");
    const registry = new InProcessConnectorRegistry();
    registry.register(connector);
    expect(registry.select({ platform: "android", requiredCapabilities: ["device.discover"] })).toBe(connector);
    expect(registry.select({ platform: "android", targetKind: "app" })).toBeUndefined();
    expect(() => registry.register(connector)).toThrow("已注册");
    expect(() => registry.register({ ...connector, id: "other-id" })).toThrow("ID 与能力清单不一致");
  });

  it("将旧设备 provider 包装为 connector", async () => {
    const device = fakeDevice();
    const connector = createLegacyTaskRunnerConnector({
      id: "android-legacy",
      manifest: { ...APP_CONNECTOR_MANIFESTS.android, connectorId: "android-legacy" },
      discover: async () => [device],
    });
    expect(await connector.discover()).toEqual([device]);
    await expect(connector.healthCheck?.(device)).resolves.toMatchObject({ ok: true });
    expect(connector.runner.id).toBe("legacy-command-runner");
  });

  it("校验 sidecar 协议握手版本", () => {
    const handshake = {
      type: "handshake" as const,
      protocol: SIDECAR_PROTOCOL_VERSION,
      connectorId: "wechat-mini",
      manifest: createMiniProgramConnectorManifest("wechat-mini", "wechat"),
    };
    expect(() => assertSidecarHandshake(handshake)).not.toThrow();
    expect(() => assertSidecarHandshake({ ...handshake, protocol: "mobile-test-console.sidecar.v0" }))
      .toThrow("协议不兼容");
  });

  it("legacy runner 转发 stdout/stderr、退出码和取消事件", async () => {
    const runner = new LegacyTaskRunner();
    const controller = new AbortController();
    const events: string[] = [];
    const result = await runner.run({
      runId: "run-pass",
      projectId: "demo",
      testId: "smoke",
      device: fakeDevice(),
      command: { executable: process.execPath, args: ["-e", "console.log('ok'); console.error('warn')"] },
    }, {
      signal: controller.signal,
      emit: event => { if (event.message) events.push(event.message); },
    });
    expect(result).toMatchObject({ runId: "run-pass", status: "passed", exitCode: 0 });
    expect(events).toEqual(expect.arrayContaining(["ok", "warn", "legacy 命令完成"]));

    const cancelController = new AbortController();
    const cancelEvents: string[] = [];
    const pending = runner.run({
      runId: "run-cancel",
      projectId: "demo",
      testId: "long",
      device: fakeDevice(),
      command: { executable: process.execPath, args: ["-e", "setInterval(() => {}, 1000)"] },
    }, { signal: cancelController.signal, emit: event => cancelEvents.push(event.type) });
    setTimeout(() => cancelController.abort(), 20);
    await expect(pending).resolves.toMatchObject({ status: "cancelled" });
    expect(cancelEvents).toContain("cancelled");

    const explicitCancel = new LegacyTaskRunner();
    const explicitPending = explicitCancel.run({
      runId: "run-explicit-cancel",
      projectId: "demo",
      testId: "long",
      device: fakeDevice(),
      command: { executable: process.execPath, args: ["-e", "setInterval(() => {}, 1000)"] },
    }, { signal: new AbortController().signal, emit: () => {} });
    setTimeout(() => explicitCancel.cancel("run-explicit-cancel"), 20);
    await expect(explicitPending).resolves.toMatchObject({ status: "cancelled" });
  });

  it("命名命令 Runner 使用平台中立日志并保留命令语义", async () => {
    const runner = new CommandTaskRunner("project-runner");
    const messages: string[] = [];
    const result = await runner.run({
      runId: "run-project",
      projectId: "demo",
      testId: "smoke",
      runnerId: "project-runner",
      device: fakeDevice(),
      command: { executable: process.execPath, args: ["-e", "console.log('project output')"] },
    }, {
      signal: new AbortController().signal,
      emit: event => { if (event.message) messages.push(event.message); },
    });

    expect(result).toMatchObject({ status: "passed", exitCode: 0 });
    expect(messages).toEqual(expect.arrayContaining(["准备执行命令", "project output", "命令执行完成"]));
    expect(messages.join("\n")).not.toContain("legacy");
  });
});

function fakeDevice(): ConnectorDevice {
  return {
    key: "android:demo",
    id: "demo",
    name: "Demo",
    platform: "android",
    type: "physical",
    connectionState: "available",
    osVersion: "14",
    detail: "",
    controlState: "ready",
    controlReason: "",
    connectorId: "android-fake",
    capabilities: ["device.discover"],
  };
}

function fakeConnector(id: string): MiniProgramConnector {
  const manifest = createMiniProgramConnectorManifest(id, "android");
  return {
    id,
    manifest,
    targetKind: "mini-program",
    discover: async () => [],
    attach: async () => { throw new Error("未实现"); },
    launch: async () => { throw new Error("未实现"); },
    reload: async () => { throw new Error("未实现"); },
    detach: async () => {},
  };
}

function fakeRunner(id: string): InProcessRunner {
  return {
    id,
    async run(plan) {
      return { runId: plan.runId, status: "passed", exitCode: 0 };
    },
  };
}
