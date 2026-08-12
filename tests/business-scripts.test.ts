import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { BusinessScriptStore } from "../src/server/business-script-store.js";
import { BusinessScriptService } from "../src/server/business-scripts.js";
import type { LoadedProjectConfig } from "../src/server/config.js";
import type { Device } from "../src/shared/contracts.js";

const tempDirs: string[] = [];
afterEach(async () => { await Promise.all(tempDirs.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true }))); });

describe("业务脚本服务", () => {
  it("完成录制草稿、多个场景、不可变发布版本与回放", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "mtc-business-scripts-"));
    tempDirs.push(root);
    const providerPath = path.join(root, "provider.cjs");
    await fs.writeFile(providerPath, `
      const action = process.argv.find(value => ["recording-start", "recording-status", "recording-stop", "replay"].includes(value));
      const schemaVersion = "mobile-test-console.business-script-provider.v1";
      const draft = {
        draftId: "draft-recorded", recordingId: process.argv[process.argv.indexOf("--recording-id") + 1], name: "搜索并查看商品",
        platformScope: ["harmony"], startPage: "pageSearchIndex", expectedFinalPage: "pageGoodsDetail",
        variables: [{ name: "QA_INPUT", strategy: "runtimeResolver", sensitive: true }], warnings: [], createdAt: "2026-07-30T10:00:00.000Z", updatedAt: "2026-07-30T10:01:00.000Z",
        steps: [
          { stepId: "step-1", name: "点击商品", kind: "action", actionType: "tap", semanticTarget: { strategy: "accessibilityId", value: "search.results.item.0", status: "resolved" }, status: "resolved" },
          { stepId: "step-2", name: "进入详情", kind: "pageTransition", actionType: "pageTransition", pageId: "pageGoodsDetail", status: "resolved" }
        ],
        assertions: [{ assertionId: "assert-page", type: "page", page: "pageGoodsDetail" }], scenarios: []
      };
      if (action === "recording-start" || action === "recording-status") console.log(JSON.stringify({ schemaVersion, status: "recording" }));
      else if (action === "recording-stop") console.log(JSON.stringify({ schemaVersion, status: "stopped", draft }));
      else if (action === "replay") console.log(JSON.stringify({ schemaVersion, status: "passed" }));
    `);
    const config = createConfig(root, providerPath);
    const service = new BusinessScriptService(config, new BusinessScriptStore(root));
    const recording = await service.startRecording(device, "qa", "qa-installed");
    expect(recording.status).toBe("recording");
    const stopped = await service.stopRecording(recording.recordingId);
    expect(stopped.draft?.steps).toHaveLength(2);

    const draft = stopped.draft!;
    const scenarios = [
      { scenarioId: "search-result", name: "查看搜索结果", startPage: "pageSearchIndex", expectedFinalPage: "pageSearchIndex", tags: ["search"], stepIds: ["step-1"], assertionIds: [] },
      { scenarioId: "goods-detail", name: "查看商品详情", setupRef: "search-result", startPage: "pageSearchIndex", expectedFinalPage: "pageGoodsDetail", tags: ["goods"], stepIds: ["step-1", "step-2"], assertionIds: ["assert-page"] },
    ];
    await service.saveDraft(draft.draftId, { name: draft.name, startPage: draft.startPage, expectedFinalPage: draft.expectedFinalPage, steps: draft.steps, assertions: draft.assertions, scenarios });
    const v1 = await service.publish(draft.draftId);
    const v2 = await service.publish(draft.draftId);
    expect([v1.version, v2.version]).toEqual([1, 2]);
    expect(v1.scenarios).toHaveLength(2);
    await service.saveSuite("deleted-version-suite", {
      name: "待删除版本套件",
      scenarioRefs: [{ scriptId: v1.scriptId, version: 1, scenarioId: "search-result" }],
      platformMatrix: ["harmony"],
    });
    const deleted = await service.deletePublishedVersion(v1.scriptId, 1);
    expect(deleted).toMatchObject({ script: { version: 1 }, removedSuiteReferenceCount: 1, removedSuiteCount: 1 });
    await expect(service.deletePublishedVersion(v1.scriptId, 1)).rejects.toThrow("已发布脚本不存在");
    const v3 = await service.publish(draft.draftId);
    expect(v3.version).toBe(3);

    await service.saveDraft(draft.draftId, {
      name: draft.name,
      startPage: draft.startPage,
      expectedFinalPage: draft.expectedFinalPage,
      steps: draft.steps.map(step => step.stepId === "step-1" ? { ...step, status: "needs-review" } : step),
      assertions: draft.assertions,
      scenarios,
    });
    await expect(service.publish(draft.draftId)).rejects.toThrow("仍需校正");

    await service.saveDraft(draft.draftId, {
      name: draft.name,
      startPage: draft.startPage,
      expectedFinalPage: draft.expectedFinalPage,
      steps: draft.steps.map(step => step.stepId === "step-1" ? {
        ...step,
        semanticTarget: { strategy: "system", value: "home", status: "resolved" },
        status: "resolved",
      } : step),
      assertions: draft.assertions,
      scenarios,
    });
    await expect(service.publish(draft.draftId)).rejects.toThrow("缺少稳定 target");

    await service.saveDraft(draft.draftId, {
      name: draft.name,
      startPage: draft.startPage,
      expectedFinalPage: draft.expectedFinalPage,
      steps: draft.steps.map(step => step.stepId === "step-1" ? {
        ...step,
        actionType: "input",
        semanticTarget: { strategy: "accessibilityId", value: "search.input", status: "resolved" },
        inputBinding: { strategy: "secretRef", value: "QA_INPUT" },
        status: "resolved",
      } : step),
      assertions: draft.assertions,
      scenarios,
    });
    await expect(service.publish(draft.draftId)).rejects.toThrow("变量解析策略不一致");

    await service.saveDraft(draft.draftId, {
      name: draft.name,
      startPage: draft.startPage,
      expectedFinalPage: draft.expectedFinalPage,
      variables: [{ name: "QA_INPUT", strategy: "secretRef", sensitive: true }],
      steps: draft.steps.map(step => step.stepId === "step-1" ? {
        ...step,
        actionType: "input",
        semanticTarget: { strategy: "accessibilityId", value: "search.input", status: "resolved" },
        inputBinding: { strategy: "secretRef", value: "QA_INPUT" },
        status: "resolved",
      } : step),
      assertions: draft.assertions,
      scenarios,
    });
    const secretVersion = await service.publish(draft.draftId);
    expect(secretVersion.variables).toEqual([{ name: "QA_INPUT", strategy: "secretRef", sensitive: true }]);

    await service.saveDraft(draft.draftId, {
      name: draft.name,
      startPage: draft.startPage,
      expectedFinalPage: draft.expectedFinalPage,
      steps: draft.steps.map(step => step.stepId === "step-1" ? {
        ...step,
        actionType: "input",
        semanticTarget: { strategy: "accessibilityId", value: "search.input", status: "resolved" },
        inputBinding: { strategy: "literal", value: "牙膏" },
        status: "resolved",
      } : step),
      assertions: draft.assertions,
      scenarios,
    });
    const literalVersion = await service.publish(draft.draftId);
    expect(literalVersion.steps[0].inputBinding).toEqual({ strategy: "literal", value: "牙膏" });

    await service.saveSuite("goods-suite", { name: "商品链路", scenarioRefs: [{ scriptId: v2.scriptId, version: 2, scenarioId: "goods-detail" }], platformMatrix: ["harmony"] });
    const replay = await service.replayScenario(v2.scriptId, 2, "goods-detail", device);
    expect(replay.status).toBe("passed");
    const suite = await service.replaySuite("goods-suite", device);
    expect(suite).toHaveLength(1);
    expect((await service.snapshot()).scripts.map(item => item.version)).toEqual([2, 3, 4, 5]);
    expect((await fs.stat(path.join(root, "business-scripts.json"))).mode & 0o777).toBe(0o600);

    await expect(service.saveSuite("invalid-platform", {
      name: "无效平台套件",
      scenarioRefs: [{ scriptId: v2.scriptId, version: 2, scenarioId: "goods-detail" }],
      platformMatrix: ["android"],
    })).rejects.toThrow("未发布 android 版本");
  });

  it("串行化同设备录制创建并阻止重复活动会话", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "mtc-business-recording-lock-"));
    tempDirs.push(root);
    const providerPath = path.join(root, "provider.cjs");
    await fs.writeFile(providerPath, `
      setTimeout(() => console.log(JSON.stringify({
        schemaVersion: "mobile-test-console.business-script-provider.v1",
        status: "recording"
      })), 100);
    `);
    const service = new BusinessScriptService(createConfig(root, providerPath), new BusinessScriptStore(root));
    const results = await Promise.allSettled([
      service.startRecording(device, "qa", "qa-installed"),
      service.startRecording(device, "qa", "qa-installed"),
    ]);
    expect(results.filter(item => item.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find(item => item.status === "rejected");
    expect(rejected?.status === "rejected" ? String(rejected.reason) : "").toContain("已有业务录制会话");
    expect((await service.snapshot()).recordings).toHaveLength(1);
  });
});

const device: Device = {
  key: "harmony:device-1", id: "device-1", name: "Harmony Device", platform: "harmony", type: "physical",
  connectionState: "available", osVersion: "5", detail: "", controlState: "ready", controlReason: "",
};

function createConfig(root: string, providerPath: string): LoadedProjectConfig {
  return {
    schemaVersion: "mobile-test-console.config.v1", configPath: path.join(root, "config.cjs"), project: { id: "demo", name: "Demo", root },
    stateDir: root, deviceProviders: ["harmony"], lifecycle: {}, taskDeletion: {},
    businessScripts: { provider: { executable: process.execPath, args: [providerPath, "--scripts", "{{businessScripts.statePath}}"] } },
    tests: [{ id: "pass", label: "Pass", description: "", platforms: ["harmony"], parameters: [], commands: { default: { executable: process.execPath, args: ["-e", "process.exit(0)"] } } }],
  };
}
