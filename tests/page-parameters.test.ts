import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "../src/server/app.js";
import type { CommandRunner } from "../src/server/command-runner.js";
import type { LoadedProjectConfig } from "../src/server/config.js";
import { DeviceDiscoveryService } from "../src/server/devices.js";
import { StateStore } from "../src/server/state-store.js";
import { TaskManager } from "../src/server/task-manager.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true })));
});

describe("页面参数 API", () => {
  it("读取目录、推进录制会话并持久化安全画像", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mtc-page-parameters-"));
    tempDirs.push(dir);
    const providerPath = path.join(dir, "provider.cjs");
    await fs.writeFile(providerPath, `
      const action = process.argv[2];
      const schemaVersion = "mobile-test-console.page-parameter-provider.v1";
      const pages = [{
        pageId: "pageGoodsDetail", label: "商品详情", bundle: "pageGoodsDetail.bundle",
        source: "qa-manifest:goods-detail", warnings: [],
        navigation: { route: "huigou://lynx", params: { _tpl: "pageGoodsDetail.bundle" } },
        targets: [
          { id: "goods.buy", label: "购买按钮", kind: "button", actions: ["tap"] },
          { id: "goods.harmony-only", label: "Harmony 操作", kind: "region", actions: ["tap"], platforms: ["harmony"] }
        ],
        assertionTargets: ["goods.content"],
        fields: [
          { key: "id", required: false, requirement: "conditional", alternatives: ["q", "id"], sensitive: false, strategies: ["literal", "runtimeResolver"], description: "商品 ID" },
          { key: "token", required: false, sensitive: true, strategies: ["secretRef"], description: "登录令牌" },
          { key: "q", required: false, requirement: "conditional", alternatives: ["q", "id"], sensitive: false, strategies: ["literal"], description: "商品候选 ID" },
          { key: "invitation_code", required: false, requirement: "conditional", sensitive: false, strategies: ["literal"], description: "邀请分支参数" }
        ]
      }];
      const observation = { observationId: "obs-1", pageId: "pageGoodsDetail", bundle: "pageGoodsDetail.bundle", previousPageId: "home", values: { id: "10001" }, capturedAt: "2026-07-29T08:00:00.000Z", rawData: '{"routeParams":{"id":"10001"}}' };
      if (action === "catalog") console.log(JSON.stringify({ schemaVersion, pages, warnings: [] }));
      else if (action === "recording-start") console.log(JSON.stringify({ schemaVersion, status: "recording", observations: [] }));
      else if (action === "recording-status") console.log(JSON.stringify({ schemaVersion, status: "recording", observations: [observation] }));
      else if (action === "recording-stop") console.log(JSON.stringify({ schemaVersion, status: "stopped", observations: [observation, { ...observation, observationId: "obs-2" }] }));
      else if (action === "replay") console.log(JSON.stringify({
        schemaVersion, status: "passed", output: "page replay passed",
        summary: {
          pageOpened: true, expectedPage: "pageGoodsDetail", actualPage: "pageGoodsDetail",
          actionCount: 1, actionPassed: 1, assertionCount: 2, assertionPassed: 2,
          missingEvents: [],
          steps: [
            { index: 1, kind: "action", type: "tap", target: "goods.buy", status: "passed", evidence: "uiActions" },
            { index: 2, kind: "assertion", type: "runtimeEvent", status: "passed", message: "lynx_page_ready", evidence: "runtime-events" }
          ]
        }
      }));
      else process.exit(2);
    `);
    const config = createConfig(dir, providerPath);
    const runner: CommandRunner = {
      async capture() { return { code: 0, stdout: "device-1 device model:Pixel_8\n", stderr: "" }; },
    };
    const devices = new DeviceDiscoveryService(runner, ["android"]);
    const tasks = new TaskManager(config, new StateStore(dir));
    await tasks.initialize();
    const app = await createApp({ config, devices, tasks });

    try {
      const catalog = await app.inject({ method: "GET", url: "/api/page-parameters" });
      expect(catalog.statusCode).toBe(200);
      expect(catalog.json().pages[0]).toMatchObject({ pageId: "pageGoodsDetail", status: "missing", profiles: [] });

      const started = await app.inject({
        method: "POST",
        url: "/api/page-parameter-recordings",
        payload: { deviceKey: "android:device-1", environment: "qa" },
      });
      expect(started.statusCode).toBe(200);
      expect(started.json().recording.status).toBe("recording");
      const recordingId = started.json().recording.recordingId as string;

      const refreshed = await app.inject({ method: "GET", url: `/api/page-parameter-recordings/${recordingId}` });
      expect(refreshed.json().recording.observations).toEqual([expect.objectContaining({ observationId: "obs-1", values: { id: "10001" }, rawData: '{"routeParams":{"id":"10001"}}' })]);

      const unsafe = await app.inject({
        method: "PUT",
        url: "/api/page-parameters/pageGoodsDetail/profiles/qa-default",
        payload: {
          scenario: "detail", platform: "android", environment: "qa", accountLabel: "qa-user",
          values: { id: { strategy: "literal", value: "10001" }, token: { strategy: "literal", value: "plain-token" } },
        },
      });
      expect(unsafe.statusCode).toBe(400);
      expect(unsafe.json().error.code).toBe("PAGE_PARAMETER_SENSITIVE_LITERAL");

      const capturedEmpty = await app.inject({
        method: "PUT",
        url: "/api/page-parameters/pageGoodsDetail/profiles/captured-empty",
        payload: {
          scenario: "detail", platform: "android", environment: "qa", accountLabel: "qa-user",
          values: { id: { strategy: "literal", value: "" }, token: { strategy: "secretRef", value: "QA_TOKEN" } },
          capturedKeys: ["id"],
        },
      });
      expect(capturedEmpty.statusCode).toBe(200);
      expect(capturedEmpty.json().profile.values.id).toEqual({ strategy: "literal", value: "" });

      const capturedWhitespace = await app.inject({
        method: "PUT",
        url: "/api/page-parameters/pageGoodsDetail/profiles/captured-whitespace",
        payload: {
          scenario: "detail", platform: "android", environment: "qa", accountLabel: "qa-user",
          values: { id: { strategy: "literal", value: " 10001 " }, token: { strategy: "secretRef", value: "QA_TOKEN" } },
          capturedKeys: [],
        },
      });
      expect(capturedWhitespace.statusCode).toBe(200);

      const manualEmpty = await app.inject({
        method: "PUT",
        url: "/api/page-parameters/pageGoodsDetail/profiles/manual-empty",
        payload: {
          scenario: "detail", platform: "android", environment: "qa", accountLabel: "qa-user",
          values: { id: { strategy: "literal", value: "" }, token: { strategy: "secretRef", value: "QA_TOKEN" } },
        },
      });
      expect(manualEmpty.statusCode).toBe(400);
      expect(manualEmpty.json().error.code).toBe("PAGE_PARAMETER_REQUIRED");

      const missingConditionalGroup = await app.inject({
        method: "PUT",
        url: "/api/page-parameters/pageGoodsDetail/profiles/missing-conditional-group",
        payload: {
          scenario: "detail", platform: "android", environment: "qa", accountLabel: "qa-user",
          values: { id: { strategy: "literal", value: "" }, token: { strategy: "secretRef", value: "QA_TOKEN" } },
          capturedKeys: [],
        },
      });
      expect(missingConditionalGroup.statusCode).toBe(400);
      expect(missingConditionalGroup.json().error.code).toBe("PAGE_PARAMETER_REQUIRED");
      expect(missingConditionalGroup.json().error.message).toContain("q / id");

      const missingRequiredKey = await app.inject({
        method: "PUT",
        url: "/api/page-parameters/pageGoodsDetail/profiles/missing-required-key",
        payload: {
          scenario: "detail", platform: "android", environment: "qa", accountLabel: "qa-user",
          values: { token: { strategy: "secretRef", value: "QA_TOKEN" } },
          capturedKeys: ["token"],
        },
      });
      expect(missingRequiredKey.statusCode).toBe(400);
      expect(missingRequiredKey.json().error.code).toBe("PAGE_PARAMETER_REQUIRED");

      const capturedNonLiteralEmpty = await app.inject({
        method: "PUT",
        url: "/api/page-parameters/pageGoodsDetail/profiles/captured-runtime-empty",
        payload: {
          scenario: "detail", platform: "android", environment: "qa", accountLabel: "qa-user",
          values: { id: { strategy: "runtimeResolver", value: "" }, token: { strategy: "secretRef", value: "QA_TOKEN" } },
          capturedKeys: ["id"],
        },
      });
      expect(capturedNonLiteralEmpty.statusCode).toBe(400);
      expect(capturedNonLiteralEmpty.json().error.code).toBe("PAGE_PARAMETER_REQUIRED");

      const saved = await app.inject({
        method: "PUT",
        url: "/api/page-parameters/pageGoodsDetail/profiles/qa-default",
        payload: {
          scenario: "detail", platform: "android", environment: "qa", accountLabel: "qa-user",
          values: { id: { strategy: "literal", value: "10001" }, token: { strategy: "secretRef", value: "QA_TOKEN" } },
          actions: [{
            type: "tap", target: "goods.buy",
            assertions: [{ type: "visible", target: "goods.content" }, { type: "runtimeEvent", event: "goods_checkout_opened" }],
          }],
          assertions: [{ type: "visible", target: "goods.content" }, { type: "runtimeEvent", event: "lynx_page_ready" }],
        },
      });
      expect(saved.statusCode).toBe(200);
      expect(saved.json().profile).toMatchObject({
        navigation: { route: "huigou://lynx", params: { _tpl: "pageGoodsDetail.bundle" } },
        actions: [{
          type: "tap", target: "goods.buy",
          assertions: [{ type: "visible", target: "goods.content" }, { type: "runtimeEvent", event: "goods_checkout_opened" }],
        }],
        assertions: [{ type: "visible", target: "goods.content" }, { type: "runtimeEvent", event: "lynx_page_ready" }],
      });

      const defaulted = await app.inject({
        method: "POST",
        url: "/api/page-parameters/pageGoodsDetail/profiles/qa-default/default",
      });
      expect(defaulted.statusCode).toBe(200);
      expect(defaulted.json().profile).toMatchObject({ profileId: "qa-default", isDefault: true });

      const invalidActionAssertion = await app.inject({
        method: "PUT",
        url: "/api/page-parameters/pageGoodsDetail/profiles/invalid-action-assertion",
        payload: {
          scenario: "detail", platform: "android", environment: "qa", accountLabel: "qa-user",
          values: { id: { strategy: "literal", value: "10001" }, token: { strategy: "secretRef", value: "QA_TOKEN" } },
          actions: [{ type: "tap", target: "goods.buy", assertions: [{ type: "visible", target: "goods.unknown" }] }],
        },
      });
      expect(invalidActionAssertion.statusCode).toBe(400);
      expect(invalidActionAssertion.json().error.code).toBe("PAGE_SCENARIO_ASSERTION_TARGET_UNKNOWN");

      const missingActionAssertion = await app.inject({
        method: "PUT",
        url: "/api/page-parameters/pageGoodsDetail/profiles/missing-action-assertion",
        payload: {
          scenario: "detail", platform: "android", environment: "qa", accountLabel: "qa-user",
          values: { id: { strategy: "literal", value: "10001" }, token: { strategy: "secretRef", value: "QA_TOKEN" } },
          actions: [{ type: "tap", target: "goods.buy" }],
        },
      });
      expect(missingActionAssertion.statusCode).toBe(400);
      expect(missingActionAssertion.json().error.code).toBe("PAGE_SCENARIO_ACTION_ASSERTION_REQUIRED");

      const incompatiblePlatformAction = await app.inject({
        method: "PUT",
        url: "/api/page-parameters/pageGoodsDetail/profiles/platform-incompatible",
        payload: {
          scenario: "detail", platform: "all", environment: "qa", accountLabel: "qa-user",
          values: { id: { strategy: "literal", value: "10001" }, token: { strategy: "secretRef", value: "QA_TOKEN" } },
          actions: [{ type: "tap", target: "goods.harmony-only" }],
        },
      });
      expect(incompatiblePlatformAction.statusCode).toBe(400);
      expect(incompatiblePlatformAction.json().error.code).toBe("PAGE_SCENARIO_ACTION_UNSUPPORTED");

      const savedForAllPlatforms = await app.inject({
        method: "PUT",
        url: "/api/page-parameters/pageGoodsDetail/profiles/all-platform",
        payload: {
          scenario: "detail-all", environment: "qa", accountLabel: "qa-user",
          values: { id: { strategy: "literal", value: "10001" }, token: { strategy: "secretRef", value: "QA_TOKEN" } },
        },
      });
      expect(savedForAllPlatforms.statusCode).toBe(200);
      expect(savedForAllPlatforms.json().profile.platform).toBe("all");

      const switchedDefault = await app.inject({
        method: "POST",
        url: "/api/page-parameters/pageGoodsDetail/profiles/all-platform/default",
      });
      expect(switchedDefault.statusCode).toBe(200);
      expect(switchedDefault.json().profile).toMatchObject({ profileId: "all-platform", isDefault: true });

      const clearedDefault = await app.inject({
        method: "POST",
        url: "/api/page-parameters/pageGoodsDetail/profiles/all-platform/default",
        payload: { isDefault: false },
      });
      expect(clearedDefault.statusCode).toBe(200);
      expect(clearedDefault.json().profile).toMatchObject({ profileId: "all-platform", isDefault: false });

      const restoredDefault = await app.inject({
        method: "POST",
        url: "/api/page-parameters/pageGoodsDetail/profiles/qa-default/default",
      });
      expect(restoredDefault.statusCode).toBe(200);
      expect(restoredDefault.json().profile).toMatchObject({ profileId: "qa-default", isDefault: true });

      const replayedAllPlatforms = await app.inject({
        method: "POST",
        url: "/api/page-parameters/pageGoodsDetail/profiles/all-platform/replay",
        payload: { deviceKey: "android:device-1" },
      });
      expect(replayedAllPlatforms.statusCode).toBe(200);
      expect(replayedAllPlatforms.json().replay).toMatchObject({
        pageId: "pageGoodsDetail",
        profileId: "all-platform",
        status: "passed",
      });

      const replayed = await app.inject({
        method: "POST",
        url: "/api/page-parameters/pageGoodsDetail/profiles/qa-default/replay",
        payload: { deviceKey: "android:device-1" },
      });
      expect(replayed.statusCode).toBe(200);
      expect(replayed.json().replay).toMatchObject({
        pageId: "pageGoodsDetail",
        profileId: "qa-default",
        status: "passed",
        output: "page replay passed",
        summary: {
          pageOpened: true,
          actionCount: 1,
          actionPassed: 1,
          assertionCount: 2,
          assertionPassed: 2,
        },
      });

      const recordedCatalog = await app.inject({ method: "GET", url: "/api/page-parameters" });
      expect(recordedCatalog.json().pages[0]).toMatchObject({ status: "recorded" });
      expect(recordedCatalog.json().pages[0].profiles).toEqual(expect.arrayContaining([
        expect.objectContaining({ profileId: "qa-default", isDefault: true }),
        expect.objectContaining({ profileId: "all-platform", isDefault: false }),
      ]));
      const stored = JSON.parse(await fs.readFile(path.join(dir, "page-parameters.json"), "utf8")) as {
        profiles: Array<{ profileId: string; values: unknown; actions: unknown }>;
      };
      const savedProfile = stored.profiles.find(profile => profile.profileId === "qa-default");
      expect(savedProfile?.values).toEqual({ id: { strategy: "literal", value: "10001" }, token: { strategy: "secretRef", value: "QA_TOKEN" } });
      expect(savedProfile?.actions).toEqual([{
        type: "tap", target: "goods.buy",
        assertions: [{ type: "visible", target: "goods.content" }, { type: "runtimeEvent", event: "goods_checkout_opened" }],
      }]);

      const stopped = await app.inject({ method: "POST", url: `/api/page-parameter-recordings/${recordingId}/stop` });
      expect(stopped.json().recording.status).toBe("stopped");
      expect(stopped.json().recording.observations).toHaveLength(1);
      const deleted = await app.inject({ method: "DELETE", url: "/api/page-parameters/pageGoodsDetail/profiles/qa-default" });
      expect(deleted.statusCode).toBe(200);
    } finally {
      await app.close();
    }
  });
});

function createConfig(stateDir: string, providerPath: string): LoadedProjectConfig {
  return {
    schemaVersion: "mobile-test-console.config.v1",
    configPath: path.join(stateDir, "config.cjs"),
    project: { id: "demo", name: "Demo", root: stateDir },
    stateDir,
    deviceProviders: ["android"],
    lifecycle: {},
    taskDeletion: {},
    pageParameters: { provider: { executable: process.execPath, args: [providerPath] } },
    tests: [{
      id: "pass", label: "Pass", description: "", platforms: ["android"], parameters: [],
      commands: { default: { executable: process.execPath, args: ["-e", "process.exit(0)"] } },
    }],
  };
}
