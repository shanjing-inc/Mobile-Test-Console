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
import { mergeRetryTaskResult, TaskResultService, terminalRetryTasks } from "../src/server/task-results.js";
import type { TaskResult, TaskResultRun, TestTask } from "../src/shared/contracts.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map(directory => fs.rm(directory, { recursive: true, force: true })));
});

describe("测试结果服务", () => {
  it("将单用例重试结果合并回来源任务并替换对应失败用例", () => {
    const run = (caseId: string, status: string) => ({ caseId, targetPage: caseId, status, runId: `run-${caseId}`, caseRunId: `case-run-${caseId}` });
    const sourceRuns = [run("stable", "passed"), run("flaky", "failed")];
    const source = { taskId: "source", runId: "source-run", generatedAt: "old", total: 2, caseRunCount: 2, passed: 1, failed: 1, warnings: [], runs: sourceRuns } as unknown as import("../src/shared/contracts.js").TaskResult;
    const retry = { taskId: "retry", runId: "retry-run", generatedAt: "new", total: 1, caseRunCount: 1, passed: 1, failed: 0, warnings: [], runs: [run("flaky", "passed")] } as unknown as import("../src/shared/contracts.js").TaskResult;
    const merged = mergeRetryTaskResult(
      { id: "source", runId: "source-run" } as TestTask,
      source,
      retry,
      { taskId: "source", runId: "source-run", scope: "cases", attempt: 1, caseRunIds: [sourceRuns[1].caseRunId], caseIds: ["flaky"], targetPages: ["flaky"] },
    );
    expect(merged.runs.map(item => [item.caseId, item.status])).toEqual([["stable", "passed"], ["flaky", "passed"]]);
    expect(merged.passed).toBe(2);
    expect(merged.failed).toBe(0);
  });

  it("重试失败时保留原条目的全部结果", () => {
    const sourceRun = retryRun("flaky", "failed", "source-case-run", "原始失败证据");
    const source = retryResult("source", "old", [sourceRun]);
    const failedRetry = retryResult("retry", "new", [retryRun("flaky", "failed", "retry-case-run", "重试失败证据")]);

    const merged = mergeRetryTaskResult(
      { id: "source", runId: "source-run" } as TestTask,
      source,
      failedRetry,
      { taskId: "source", runId: "source-run", scope: "cases", attempt: 1, caseRunIds: [sourceRun.caseRunId], caseIds: ["flaky"], targetPages: ["flaky"] },
    );

    expect(merged.runs).toEqual([sourceRun]);
    expect(merged.generatedAt).toBe("old");
    expect(merged.warnings).toContain("第 1 次重试未通过，保留原结果");
  });

  it("批量重试只替换通过条目并保持原条目 ID", () => {
    const first = retryRun("first", "failed", "source-first", "首次失败");
    const second = retryRun("second", "failed", "source-second", "首次失败");
    const source = retryResult("source", "old", [first, second]);
    const retry = retryResult("retry", "new", [
      retryRun("first", "passed", "retry-first", "重试通过"),
      retryRun("second", "failed", "retry-second", "重试失败"),
    ]);

    const merged = mergeRetryTaskResult(
      { id: "source", runId: "source-run" } as TestTask,
      source,
      retry,
      { taskId: "source", runId: "source-run", scope: "cases", attempt: 1, caseRunIds: [first.caseRunId, second.caseRunId], caseIds: ["first", "second"], targetPages: ["first", "second"] },
    );

    expect(merged.runs.map(run => [run.caseRunId, run.caseId, run.status, run.errorSummary])).toEqual([
      ["source-first", "first", "passed", "重试通过"],
      ["source-second", "second", "failed", "首次失败"],
    ]);
  });

  it("同名用例按目标页面匹配复测结果", () => {
    const first = { ...retryRun("render", "failed", "source-first", "页面一失败"), targetPage: "pages/first" };
    const second = { ...retryRun("render", "failed", "source-second", "页面二失败"), targetPage: "pages/second" };
    const retriedSecond = { ...retryRun("render", "passed", "retry-second", "页面二通过"), targetPage: "pages/second" };

    const merged = mergeRetryTaskResult(
      { id: "source", runId: "source-run" } as TestTask,
      retryResult("source", "old", [first, second]),
      retryResult("retry", "new", [retriedSecond]),
      {
        taskId: "source",
        runId: "source-run",
        scope: "cases",
        attempt: 1,
        caseRunIds: [first.caseRunId, second.caseRunId],
        caseIds: ["render"],
        targetPages: ["pages/first", "pages/second"],
      },
    );

    expect(merged.runs.map(run => [run.caseRunId, run.targetPage, run.status, run.errorSummary])).toEqual([
      ["source-first", "pages/first", "failed", "页面一失败"],
      ["source-second", "pages/second", "passed", "页面二通过"],
    ]);
  });

  it("同页面同名用例按参数画像匹配复测结果", () => {
    const first = { ...retryRun("render", "failed", "source-first", "画像一失败"), targetPage: "pages/detail", parameterProfileId: "profile-one" };
    const second = { ...retryRun("render", "failed", "source-second", "画像二失败"), targetPage: "pages/detail", parameterProfileId: "profile-two" };
    const retriedSecond = { ...retryRun("render", "passed", "retry-second", "画像二通过"), targetPage: "pages/detail", parameterProfileId: "profile-two" };
    const retriedFirst = { ...retryRun("render", "passed", "retry-first", "画像一通过"), targetPage: "pages/detail", parameterProfileId: "profile-one" };

    const merged = mergeRetryTaskResult(
      { id: "source", runId: "source-run" } as TestTask,
      retryResult("source", "old", [first, second]),
      retryResult("retry", "new", [retriedSecond, retriedFirst]),
      {
        taskId: "source",
        runId: "source-run",
        scope: "cases",
        attempt: 1,
        caseRunIds: [first.caseRunId, second.caseRunId],
        caseIds: ["render"],
        targetPages: ["pages/detail"],
      },
    );

    expect(merged.runs.map(run => [run.caseRunId, run.parameterProfileId, run.errorSummary])).toEqual([
      ["source-first", "profile-one", "画像一通过"],
      ["source-second", "profile-two", "画像二通过"],
    ]);
  });

  it("多层复测将通过结果继续合并到根任务", () => {
    const sourceRun = { ...retryRun("render", "failed", "source-run", "原始失败"), targetPage: "pages/detail" };
    const firstRetryRun = { ...retryRun("render", "failed", "first-retry-run", "首次复测失败"), targetPage: "pages/detail" };
    const nestedRetryRun = { ...retryRun("render", "passed", "nested-retry-run", "二层复测通过"), targetPage: "pages/detail" };
    const sourceTask = { id: "source", runId: "source-run" } as TestTask;

    const afterFirstRetry = mergeRetryTaskResult(
      sourceTask,
      retryResult("source", "old", [sourceRun]),
      retryResult("retry-first", "first", [firstRetryRun]),
      {
        taskId: "source",
        runId: "source-run",
        scope: "cases",
        attempt: 1,
        caseRunIds: [sourceRun.caseRunId],
        caseIds: ["render"],
        targetPages: ["pages/detail"],
      },
    );
    const merged = mergeRetryTaskResult(
      sourceTask,
      afterFirstRetry,
      retryResult("retry-nested", "nested", [nestedRetryRun]),
      {
        taskId: "retry-first",
        runId: "retry-first",
        scope: "cases",
        attempt: 2,
        caseRunIds: [firstRetryRun.caseRunId],
        caseIds: ["render"],
        targetPages: ["pages/detail"],
      },
    );

    expect(merged.runs.map(run => [run.caseRunId, run.status, run.errorSummary])).toEqual([
      ["source-run", "passed", "二层复测通过"],
    ]);

    const unrelated = mergeRetryTaskResult(
      sourceTask,
      retryResult("source", "old", [sourceRun]),
      retryResult("retry-unrelated", "unrelated", [nestedRetryRun]),
      {
        taskId: "retry-first",
        runId: "retry-first",
        scope: "cases",
        attempt: 2,
        caseRunIds: ["unknown-parent-run"],
        caseIds: ["unrelated"],
        targetPages: ["pages/unrelated"],
      },
    );
    expect(unrelated.runs).toEqual([sourceRun]);
  });

  it("连续重试累计成功结果并忽略后续失败结果", () => {
    const first = retryRun("first", "failed", "source-first", "A 原始失败");
    const second = retryRun("second", "failed", "source-second", "B 原始失败");
    const sourceTask = { id: "source", runId: "source-run" } as TestTask;
    const source = retryResult("source", "old", [first, second]);

    const afterFirstPassed = mergeRetryTaskResult(
      sourceTask,
      source,
      retryResult("retry-first", "retry-a", [retryRun("first", "passed", "retry-first", "A 重试通过")]),
      { taskId: "source", runId: "source-run", scope: "cases", attempt: 1, caseRunIds: [first.caseRunId], caseIds: ["first"] },
    );
    const afterSecondFailed = mergeRetryTaskResult(
      sourceTask,
      afterFirstPassed,
      retryResult("retry-second", "retry-b", [retryRun("second", "failed", "retry-second", "B 重试失败")]),
      { taskId: "source", runId: "source-run", scope: "cases", attempt: 1, caseRunIds: [second.caseRunId], caseIds: ["second"] },
    );

    expect(afterSecondFailed.runs.map(run => [run.caseId, run.status, run.errorSummary])).toEqual([
      ["first", "passed", "A 重试通过"],
      ["second", "failed", "B 原始失败"],
    ]);
  });

  it("按创建时间累计来源任务的兄弟和多层终态重试", () => {
    const source = retryTask("source", "2026-08-13T00:00:00.000Z");
    const retryA = retryTask("retry-a", "2026-08-13T00:01:00.000Z", source.id);
    const retryB = retryTask("retry-b", "2026-08-13T00:02:00.000Z", source.id);
    const nested = retryTask("retry-c", "2026-08-13T00:03:00.000Z", retryA.id);
    const active = { ...retryTask("retry-active", "2026-08-13T00:04:00.000Z", source.id), status: "running" as const };

    expect(terminalRetryTasks([nested, retryB, active, source, retryA], source.id).map(task => task.id)).toEqual([
      retryA.id,
      retryB.id,
      nested.id,
    ]);
  });

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

function retryRun(caseId: string, status: string, caseRunId: string, errorSummary: string): TaskResultRun {
  return {
    runId: caseRunId,
    caseRunId,
    caseRunCount: 1,
    caseId,
    targetPage: caseId,
    launchPage: caseId,
    scenario: caseId,
    fixture: "",
    platform: "android",
    device: "device-1",
    status,
    errorSummary,
    requiredEvents: [],
    missingEvents: [],
    runtimeEventCount: 0,
    uiActionCount: 0,
    apiCalls: [],
    screenshots: [],
    evidenceFiles: [],
    failureLogExcerpt: "",
  };
}

function retryResult(taskId: string, generatedAt: string, runs: TaskResultRun[]): TaskResult {
  return {
    schemaVersion: "mobile-test-console.task-result.v1",
    generatedAt,
    taskId,
    runId: `${taskId}-run`,
    total: runs.length,
    caseRunCount: runs.length,
    passed: runs.filter(run => run.status === "passed").length,
    failed: runs.filter(run => run.status !== "passed").length,
    warnings: [],
    runs,
  };
}

function retryTask(id: string, createdAt: string, parentTaskId?: string): TestTask {
  const task = { ...createTask(), id, runId: `${id}-run`, createdAt };
  return parentTaskId
    ? { ...task, retryOf: { taskId: parentTaskId, runId: `${parentTaskId}-run`, scope: "cases", attempt: 1 } }
    : task;
}

async function waitForTaskStatus(manager: TaskManager, taskId: string, status: TestTask["status"]) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (manager.get(taskId)?.status === status) return;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error(`等待任务状态超时: ${status}`);
}
