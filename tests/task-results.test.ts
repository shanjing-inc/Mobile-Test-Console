import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "../src/server/app.js";
import type { CommandRunner } from "../src/server/command-runner.js";
import type { LoadedProjectConfig } from "../src/server/config.js";
import { DeviceDiscoveryService } from "../src/server/devices.js";
import { ResultBundleStore } from "../src/server/result-bundle-store.js";
import { StateStore } from "../src/server/state-store.js";
import { TaskManager } from "../src/server/task-manager.js";
import { TaskResultService } from "../src/server/task-results.js";
import type { TestTask } from "../src/shared/contracts.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map(directory => fs.rm(directory, { recursive: true, force: true })));
});

describe("测试结果服务", () => {
  it("读取终态任务结果并限制截图在产物目录内", async () => {
    const fixture = await createFixture();
    const result = await fixture.results.load(fixture.task.id);

    expect(result).toMatchObject({
      taskId: fixture.task.id,
      runId: fixture.task.runId,
      total: 1,
      passed: 1,
    });
    expect(result.runs[0].screenshots).toHaveLength(1);
    expect(result.runs[0]).toMatchObject({
      routeParams: { q: "牙膏" },
      parameterProfileId: "recorded-search",
    });
    expect(result.preconditions).toEqual([{
      id: "authentication",
      label: "登录前置",
      status: "passed",
      action: "account-profile-replay",
      profileId: "qa-account-wechat",
      provider: "wechat",
      detail: "账号画像回放后会员接口复验成功",
      checkedAt: "2026-08-03T00:00:00.000Z",
    }]);
    expect(result.warnings).toEqual(expect.arrayContaining([
      expect.stringContaining("产物目录外"),
      expect.stringContaining("产物目录外"),
    ]));

    const artifact = await fixture.results.artifact(fixture.task.id, result.runs[0].screenshots[0].id);
    expect(artifact.absolutePath).toBe(await fs.realpath(fixture.screenshotPath));
    await expect(fixture.results.artifact(fixture.task.id, "missing")).rejects.toMatchObject({
      code: "TASK_ARTIFACT_UNKNOWN",
      statusCode: 404,
    });
  });

  it("通过 HTTP 返回结果与图片，并保护活动任务", async () => {
    const fixture = await createFixture();
    let activeTaskId = "";
    const runner: CommandRunner = {
      async capture() {
        return { code: 0, stdout: "", stderr: "" };
      },
    };
    const app = await createApp({
      config: fixture.config,
      devices: new DeviceDiscoveryService(runner, []),
      tasks: fixture.manager,
    });

    try {
      const response = await app.inject({ method: "GET", url: `/api/tasks/${fixture.task.id}/result` });
      expect(response.statusCode).toBe(200);
      await app.inject({ method: "GET", url: `/api/tasks/${fixture.task.id}/result` });
      expect(await fs.readFile(fixture.providerCallsPath, "utf8")).toBe("1");

      const refreshed = await app.inject({
        method: "GET",
        url: `/api/tasks/${fixture.task.id}/result?refresh=1`,
      });
      expect(refreshed.statusCode).toBe(200);
      expect(await fs.readFile(fixture.providerCallsPath, "utf8")).toBe("11");

      const artifactId = response.json().result.runs[0].screenshots[0].id;
      const image = await app.inject({
        method: "GET",
        url: `/api/tasks/${fixture.task.id}/artifacts/${artifactId}`,
      });
      expect(image.statusCode).toBe(200);
      expect(image.headers["content-type"]).toContain("image/png");
      expect(image.rawPayload.toString()).toBe("image-bytes");

      const [activeTask] = await fixture.manager.start({
        testId: "long",
        deviceKeys: [fixture.task.device.key],
        parameters: {},
      }, [fixture.task.device]);
      activeTaskId = activeTask.id;
      await waitForTaskStatus(fixture.manager, activeTask.id, "running");
      await expect(fixture.results.load(activeTask.id)).rejects.toMatchObject({
        code: "TASK_RESULT_ACTIVE",
        statusCode: 409,
      });
    } finally {
      if (activeTaskId) await fixture.manager.stop(activeTaskId);
      await fixture.manager.shutdown();
      await app.close();
    }
  });

  it("从任务 Result Bundle 映射旧 API 并沿用截图边界和缓存刷新", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "mtc-bundle-results-"));
    tempDirs.push(root);
    const artifactsRoot = path.join(root, "artifacts");
    const stateDir = path.join(root, "state");
    await fs.mkdir(artifactsRoot, { recursive: true });
    const screenshotPath = path.join(artifactsRoot, "screen.png");
    const outsidePath = path.join(root, "outside.png");
    const symlinkPath = path.join(artifactsRoot, "linked.png");
    await fs.writeFile(screenshotPath, "bundle-image");
    await fs.writeFile(outsidePath, "outside");
    await fs.symlink(outsidePath, symlinkPath);

    const bundleStore = new ResultBundleStore(stateDir);
    const ingestion = await bundleStore.ingest({
      schemaVersion: "test-analysis.run.v1",
      project: { id: "demo", name: "Demo" },
      target: { kind: "app", runtime: "lynx", platform: "android" },
      run: {
        runId: "run-one",
        status: "passed",
        environment: "qa",
        startedAt: "2026-07-21T00:00:00.000Z",
        finishedAt: "2026-07-21T00:00:02.000Z",
      },
      cases: [{
        caseRunId: "run-one-case-one",
        caseId: "case-one",
        title: "Case one",
        status: "passed",
        targetPage: "page/search",
        scenario: "搜索页面",
        steps: [{
          stepId: "open-page",
          name: "page/search",
          status: "passed",
          metadata: { bundleName: "search.bundle", events: ["page_ready"] },
        }],
        assertions: [{
          assertionId: "ready",
          kind: "runtimeEvent",
          passed: true,
          description: "页面已就绪",
        }],
        evidenceRefs: ["screen", "outside", "linked", "traversal"],
        apiCalls: [{ method: "POST", operationName: "DemoQuery", status: 200, result: "success" }],
        errorSummary: "",
        metadata: {
          runId: "run-one-case-one",
          routeParams: { q: "牙膏" },
          parameterProfileId: "recorded-search",
          platform: "android",
          device: "device-1",
          requiredEvents: ["page_ready"],
          missingEvents: [],
          runtimeEventCount: 2,
          uiActionCount: 1,
          evidenceFiles: ["runtime-events.jsonl"],
        },
      }],
      artifacts: [
        { id: "screen", uri: "project://demo/artifacts/screen.png", role: "screenshot", mimeType: "image/png" },
        { id: "outside", uri: "project://demo/outside.png", role: "screenshot", mimeType: "image/png" },
        { id: "linked", uri: "project://demo/artifacts/linked.png", role: "screenshot", mimeType: "image/png" },
        { id: "traversal", uri: "project://demo/%2E%2E/outside.png", role: "screenshot", mimeType: "image/png" },
      ],
      warnings: [],
      provenance: { adapter: "demo", adapterVersion: "1", generatedAt: "2026-07-21T00:00:02.000Z" },
      metadata: {
        legacyPreconditions: [{
          id: "authentication",
          label: "登录前置",
          status: "passed",
          action: "reused-session",
          detail: "会员会话有效",
          checkedAt: "2026-07-21T00:00:00.000Z",
        }],
      },
    }, "test");

    const providerPath = path.join(root, "legacy-provider.cjs");
    const providerCallsPath = path.join(root, "legacy-provider-calls.txt");
    await fs.writeFile(providerPath, `require("node:fs").writeFileSync(${JSON.stringify(providerCallsPath)}, "called");`);
    const config = createConfig(root, stateDir, artifactsRoot, providerPath);
    const task = { ...createTask(), resultUri: ingestion.resultUri };
    const store = new StateStore(stateDir);
    await store.save([task]);
    const manager = new TaskManager(config, store);
    await manager.initialize();
    const results = new TaskResultService(config, manager, bundleStore);

    const first = await results.load(task.id);
    const refreshed = await results.load(task.id, { refresh: true });

    expect(first).toMatchObject({
      taskId: task.id,
      runId: task.runId,
      total: 1,
      passed: 1,
      preconditions: [{ action: "reused-session", detail: "会员会话有效" }],
      runs: [{
        caseRunId: "run-one-case-one",
        routeParams: { q: "牙膏" },
        parameterProfileId: "recorded-search",
        runtimeEventCount: 2,
        uiActionCount: 1,
        evidenceFiles: ["runtime-events.jsonl"],
      }],
    });
    expect(first.runs[0].screenshots).toHaveLength(1);
    expect(first.warnings).toEqual(expect.arrayContaining([
      expect.stringContaining("产物目录外"),
      expect.stringContaining("路径无效"),
    ]));
    expect(refreshed).toEqual(first);
    await expect(fs.readFile(providerCallsPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    const artifact = await results.artifact(task.id, first.runs[0].screenshots[0].id);
    expect(artifact.absolutePath).toBe(await fs.realpath(screenshotPath));
    await manager.shutdown();
  });

  it("未配置旧结果提供器时从项目根目录读取 Result Bundle 截图", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "mtc-bundle-project-root-"));
    tempDirs.push(root);
    const stateDir = path.join(root, "state");
    const screenshotPath = path.join(root, ".test", "results", "run-one", "screenshots", "screen.png");
    await fs.mkdir(path.dirname(screenshotPath), { recursive: true });
    await fs.writeFile(screenshotPath, "mini-program-image");

    const bundleStore = new ResultBundleStore(stateDir);
    const ingestion = await bundleStore.ingest({
      schemaVersion: "test-analysis.run.v1",
      project: { id: "demo", name: "Demo" },
      target: { kind: "mini-program", runtime: "wechat-devtools", platform: "wechat" },
      run: {
        runId: "run-one",
        status: "passed",
        environment: "e2e",
        startedAt: "2026-08-11T00:00:00.000Z",
        finishedAt: "2026-08-11T00:00:02.000Z",
      },
      cases: [{
        caseRunId: "run-one-flow",
        caseId: "flow",
        title: "业务流程",
        status: "passed",
        targetPage: "pages/index",
        scenario: "小程序流程",
        steps: [],
        assertions: [],
        evidenceRefs: ["screen"],
        apiCalls: [],
        errorSummary: "",
      }],
      artifacts: [{
        id: "screen",
        uri: "project://demo/.test/results/run-one/screenshots/screen.png",
        role: "screenshot",
        mimeType: "image/png",
      }],
      warnings: [],
      provenance: { adapter: "demo", adapterVersion: "1", generatedAt: "2026-08-11T00:00:02.000Z" },
      metadata: {},
    }, "test");

    const task = { ...createTask(), resultUri: ingestion.resultUri };
    const config: LoadedProjectConfig = {
      ...createConfig(root, stateDir, path.join(root, "artifacts"), path.join(root, "provider.cjs")),
      taskResults: undefined,
    };
    const store = new StateStore(stateDir);
    await store.save([task]);
    const manager = new TaskManager(config, store);
    await manager.initialize();
    const results = new TaskResultService(config, manager, bundleStore);

    const result = await results.load(task.id);

    expect(result.runs[0].screenshots).toHaveLength(1);
    expect(result.warnings).toEqual([]);
    const artifact = await results.artifact(task.id, result.runs[0].screenshots[0].id);
    expect(artifact.absolutePath).toBe(await fs.realpath(screenshotPath));
    await manager.shutdown();
  });
});

async function createFixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "mtc-results-"));
  tempDirs.push(root);
  const artifactsRoot = path.join(root, "artifacts");
  const stateDir = path.join(root, "state");
  await fs.mkdir(artifactsRoot, { recursive: true });
  const screenshotPath = path.join(artifactsRoot, "screen.png");
  const outsidePath = path.join(root, "outside.png");
  const symlinkPath = path.join(artifactsRoot, "linked.png");
  await fs.writeFile(screenshotPath, "image-bytes");
  await fs.writeFile(outsidePath, "outside");
  await fs.symlink(outsidePath, symlinkPath);

  const task = createTask();
  const providerPath = path.join(root, "provider.cjs");
  const providerCallsPath = path.join(root, "provider-calls.txt");
  const providerResult = {
    schemaVersion: "mobile-test-console.task-result.v1",
    generatedAt: "2026-07-21T00:00:02.000Z",
    runId: task.runId,
    total: 1,
    passed: 1,
    failed: 0,
    warnings: [],
    preconditions: [{
      id: "authentication",
      label: "登录前置",
      status: "passed",
      action: "account-profile-replay",
      profileId: "qa-account-wechat",
      provider: "wechat",
      detail: "账号画像回放后会员接口复验成功",
      checkedAt: "2026-08-03T00:00:00.000Z",
    }],
    runs: [{
      runId: `${task.runId}-case-one`,
      caseId: "case-one",
      routeParams: { q: "牙膏" },
      parameterProfileId: "recorded-search",
      platform: "android",
      status: "passed",
      screenshots: [
        { path: screenshotPath, label: "screen.png" },
        { path: outsidePath, label: "outside.png" },
        { path: symlinkPath, label: "linked.png" },
      ],
      apiCalls: [{
        index: 1,
        method: "POST",
        operationName: "DemoQuery",
        status: 200,
        result: "success",
        durationMs: 20,
        request: { page: 1 },
        response: { ok: true },
      }],
      evidenceFiles: ["runtime-events.jsonl"],
    }],
  };
  await fs.writeFile(providerPath, [
    `require("node:fs").appendFileSync(${JSON.stringify(providerCallsPath)}, "1");`,
    `process.stdout.write(${JSON.stringify(JSON.stringify(providerResult))});`,
    "",
  ].join("\n"));
  const config = createConfig(root, stateDir, artifactsRoot, providerPath);
  const store = new StateStore(stateDir);
  await store.save([task]);
  const manager = new TaskManager(config, store);
  await manager.initialize();
  const results = new TaskResultService(config, manager);
  return { config, manager, results, screenshotPath, providerCallsPath, store, task };
}

function createConfig(
  root: string,
  stateDir: string,
  artifactsRoot: string,
  providerPath: string,
): LoadedProjectConfig {
  return {
    schemaVersion: "mobile-test-console.config.v1",
    configPath: path.join(root, "config.cjs"),
    project: { id: "demo", name: "Demo", root },
    stateDir,
    deviceProviders: [],
    lifecycle: {},
    taskDeletion: {},
    taskResults: {
      artifactsRoot,
      provider: { executable: process.execPath, args: [providerPath] },
    },
    tests: [
      {
        id: "pass",
        label: "Pass",
        description: "",
        platforms: ["android"],
        parameters: [],
        commands: { default: { executable: process.execPath, args: ["-e", "process.exit(0)"] } },
      },
      {
        id: "long",
        label: "Long",
        description: "",
        platforms: ["android"],
        parameters: [],
        commands: { default: { executable: process.execPath, args: ["-e", "setInterval(() => {}, 20)"] } },
      },
    ],
  };
}

function createTask(): TestTask {
  return {
    id: "task-one",
    runId: "run-one",
    projectId: "demo",
    testId: "pass",
    testLabel: "Pass",
    device: {
      key: "android:device-1",
      id: "device-1",
      name: "Pixel 8",
      platform: "android",
      type: "physical",
      connectionState: "available",
      controlState: "ready",
      controlReason: "",
      osVersion: "14",
      detail: "",
    },
    parameters: {},
    status: "passed",
    phase: "测试通过",
    createdAt: "2026-07-21T00:00:00.000Z",
    startedAt: "2026-07-21T00:00:00.000Z",
    finishedAt: "2026-07-21T00:00:02.000Z",
    exitCode: 0,
    error: "",
    logs: [],
  };
}

async function waitForTaskStatus(manager: TaskManager, taskId: string, status: TestTask["status"]) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (manager.get(taskId)?.status === status) return;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error(`等待任务状态超时: ${status}`);
}
