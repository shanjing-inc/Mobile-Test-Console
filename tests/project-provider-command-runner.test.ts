import { describe, expect, it } from "vitest";
import { ProjectProviderCommandRunner } from "../src/runner/project-provider-command-runner.js";
import type { ProjectProvider } from "../src/runner/project-provider.js";
import type { RunPlan, RunnerEvent } from "../src/runner/sdk.js";

describe("项目 Provider 命令 Runner", () => {
  it("按 Provider 准备命令和任务命令的顺序执行", async () => {
    const requests: Array<{ capabilities: readonly string[]; runId: string }> = [];
    const provider = fakeProvider(async request => {
      requests.push({ capabilities: request.capabilities, runId: request.plan.runId });
      return {
        commands: [
          {
            executable: process.execPath,
            args: ["-e", "console.log('app-prepare')"],
          },
          {
            executable: process.execPath,
            args: ["-e", "console.log('account-preflight')"],
          },
        ],
      };
    });
    const runner = new ProjectProviderCommandRunner(
      "project-runner",
      provider,
      ["app.build", "app.install", "account.preflight"],
    );
    const events: RunnerEvent[] = [];

    const result = await runner.run(createPlan({
      executable: process.execPath,
      args: ["-e", "console.log('suite-execute')"],
    }), {
      signal: new AbortController().signal,
      emit: event => events.push(event),
    });

    expect(result).toMatchObject({ status: "passed", exitCode: 0 });
    expect(requests).toEqual([{
      capabilities: ["app.build", "app.install", "account.preflight"],
      runId: "run-1",
    }]);
    const messages = events.map(event => event.message).filter(Boolean);
    expect(messages.indexOf("app-prepare")).toBeLessThan(messages.indexOf("account-preflight"));
    expect(messages.indexOf("account-preflight")).toBeLessThan(messages.indexOf("suite-execute"));
    expect(messages).toEqual(expect.arrayContaining(["项目能力准备开始", "项目能力准备完成"]));
  });

  it("将单页面复测范围传给最终测试命令并保留原始重试元数据", async () => {
    let collectedPlan: RunPlan | undefined;
    const provider = fakeProvider(async () => ({ commands: [] }));
    provider.manifest.capabilities.push({ id: "result.analysis", version: 1 });
    provider.collectResult = request => {
      collectedPlan = request.plan;
      return { bundle: { runId: request.plan.runId, status: request.result.status } };
    };
    const messages: string[] = [];
    const runner = new ProjectProviderCommandRunner("project-runner", provider, ["app.build"], {
      async ingest() {
        return { resultUri: "result-bundle://runs/run-1", status: "created", fingerprint: "digest" };
      },
    });

    const result = await runner.run(createPlan({
      executable: process.execPath,
      args: ["-e", "console.log(process.env.MTC_RETRY_TARGET_PAGES)"],
    }, {
      retry: {
        taskId: "source-task",
        runId: "source-run",
        scope: "cases",
        attempt: 1,
        caseRunIds: ["case-run"],
        caseIds: ["case-one"],
        targetPages: ["pages/detail"],
      },
    }), {
      signal: new AbortController().signal,
      emit: event => { if (event.message) messages.push(event.message); },
    });

    expect(result.status).toBe("passed");
    expect(messages).toContain("pages/detail");
    expect(collectedPlan?.metadata).toMatchObject({
      retry: { targetPages: ["pages/detail"], caseIds: ["case-one"] },
    });
  });

  it("账号前置命令失败时停止任务命令", async () => {
    const provider = fakeProvider(async () => ({
      commands: [
        { executable: process.execPath, args: ["-e", "console.log('app-prepare')"] },
        { executable: process.execPath, args: ["-e", "process.exit(7)"] },
      ],
    }));
    const runner = new ProjectProviderCommandRunner(
      "project-runner",
      provider,
      ["app.build", "app.install", "account.preflight"],
    );
    const messages: string[] = [];

    const result = await runner.run(createPlan({
      executable: process.execPath,
      args: ["-e", "console.log('must-not-run')"],
    }), {
      signal: new AbortController().signal,
      emit: event => { if (event.message) messages.push(event.message); },
    });

    expect(result).toMatchObject({ status: "failed", exitCode: 7 });
    expect(messages).toContain("app-prepare");
    expect(messages).not.toContain("must-not-run");
  });

  it("账号前置命令取消时停止任务命令", async () => {
    const provider = fakeProvider(async () => ({
      commands: [
        { executable: process.execPath, args: ["-e", "console.log('app-prepare')"] },
        {
          executable: process.execPath,
          args: ["-e", "console.log('account-preflight-started'); setInterval(() => {}, 1000)"],
        },
      ],
    }));
    const runner = new ProjectProviderCommandRunner(
      "project-runner",
      provider,
      ["app.build", "app.install", "account.preflight"],
    );
    const messages: string[] = [];
    let notifyPreflightStarted!: () => void;
    const preflightStarted = new Promise<void>(resolve => { notifyPreflightStarted = resolve; });
    const pending = runner.run(createPlan({
      executable: process.execPath,
      args: ["-e", "console.log('must-not-run')"],
    }), {
      signal: new AbortController().signal,
      emit: event => {
        if (event.message) messages.push(event.message);
        if (event.message === "account-preflight-started") notifyPreflightStarted();
      },
    });

    await preflightStarted;
    runner.cancel("run-1");

    await expect(pending).resolves.toMatchObject({ status: "cancelled" });
    expect(messages).toContain("app-prepare");
    expect(messages).not.toContain("must-not-run");
  });

  it("拒绝缺少执行入口或返回无效命令的 Provider", async () => {
    const manifestOnly = { ...fakeProvider(async () => ({ commands: [] })), prepareRun: undefined };
    expect(() => new ProjectProviderCommandRunner("project-runner", manifestOnly, ["app.build"]))
      .toThrow("项目 Provider 缺少 prepareRun(): demo-app");

    const invalid = fakeProvider(async () => ({ commands: [{ executable: "", args: [] }] }));
    const runner = new ProjectProviderCommandRunner("project-runner", invalid, ["app.build"]);
    const events: RunnerEvent[] = [];
    const result = await runner.run(createPlan(), {
      signal: new AbortController().signal,
      emit: event => events.push(event),
    });

    expect(result).toMatchObject({ status: "failed", exitCode: null, error: "Runner 命令缺少 executable" });
    expect(events.at(-1)?.message).toBe("项目能力准备失败: Runner 命令缺少 executable");
  });

  it("通过和失败结果都执行 Provider 分析并返回平台结果 URI", async () => {
    const collectedStatuses: string[] = [];
    const ingested: unknown[] = [];
    const expectedContexts: unknown[] = [];
    const provider = fakeProvider(async () => ({ commands: [] }));
    provider.manifest.capabilities.push({ id: "result.analysis", version: 1 });
    provider.collectResult = request => {
      collectedStatuses.push(request.result.status);
      return { bundle: { runId: request.plan.runId, status: request.result.status } };
    };
    const resultSink = {
      async ingest(bundle: unknown, _source?: string, expected?: unknown) {
        ingested.push(bundle);
        expectedContexts.push(expected);
        return { resultUri: "result-bundle://runs/run-1", status: "created", fingerprint: "digest" };
      },
    };

    for (const exitCode of [0, 7]) {
      const runner = new ProjectProviderCommandRunner("project-runner", provider, ["app.build"], resultSink);
      const result = await runner.run(createPlan({
        executable: process.execPath,
        args: ["-e", `process.exit(${exitCode})`],
      }), {
        signal: new AbortController().signal,
        emit: () => undefined,
      });

      expect(result).toMatchObject({
        status: exitCode === 0 ? "passed" : "failed",
        resultUri: "result-bundle://runs/run-1",
        metadata: { resultAnalysis: { providerId: "demo-app", ingestionStatus: "created" } },
      });
    }
    expect(collectedStatuses).toEqual(["passed", "failed"]);
    expect(ingested).toEqual([
      { runId: "run-1", status: "passed" },
      { runId: "run-1", status: "failed" },
    ]);
    expect(expectedContexts).toEqual([
      { runId: "run-1", projectId: "demo", status: "passed" },
      { runId: "run-1", projectId: "demo", status: "failed" },
    ]);
  });

  it("取消结果沿用原语义并跳过 Provider 分析", async () => {
    let collected = 0;
    const provider = fakeProvider(async () => ({ commands: [] }));
    provider.manifest.capabilities.push({ id: "result.analysis", version: 1 });
    provider.collectResult = () => {
      collected += 1;
      return { bundle: {} };
    };
    const runner = new ProjectProviderCommandRunner("project-runner", provider, ["app.build"], {
      async ingest() {
        throw new Error("取消任务不应摄取结果");
      },
    });
    const controller = new AbortController();
    let started!: () => void;
    const commandStarted = new Promise<void>(resolve => { started = resolve; });
    const pending = runner.run(createPlan({
      executable: process.execPath,
      args: ["-e", "console.log('started'); setInterval(() => {}, 1000)"],
    }), {
      signal: controller.signal,
      emit: event => { if (event.message === "started") started(); },
    });

    await commandStarted;
    controller.abort();
    runner.cancel("run-1");

    const result = await pending;
    expect(result).toMatchObject({ status: "cancelled" });
    expect(result).not.toHaveProperty("resultUri");
    expect(collected).toBe(0);
  });

  it("结果摄取失败时将执行结果收敛为失败", async () => {
    const provider = fakeProvider(async () => ({ commands: [] }));
    provider.manifest.capabilities.push({ id: "result.analysis", version: 1 });
    provider.collectResult = () => ({ bundle: {} });
    const runner = new ProjectProviderCommandRunner("project-runner", provider, ["app.build"], {
      async ingest() {
        throw new Error("bundle invalid");
      },
    });

    const result = await runner.run(createPlan({
      executable: process.execPath,
      args: ["-e", "process.exit(0)"],
    }), {
      signal: new AbortController().signal,
      emit: () => undefined,
    });

    expect(result).toMatchObject({
      status: "failed",
      exitCode: 0,
      error: "项目结果分析失败: bundle invalid",
    });
    expect(result).not.toHaveProperty("resultUri");
  });
});

function fakeProvider(
  prepareRun: NonNullable<ProjectProvider["prepareRun"]>,
): ProjectProvider {
  return {
    id: "demo-app",
    manifest: {
      schemaVersion: "mobile-test-console.project-provider.v1",
      providerId: "demo-app",
      scope: { targetKinds: ["app"], runtimes: ["lynx"], platforms: ["android"] },
      capabilities: [
        { id: "app.build", version: 1 },
        { id: "app.install", version: 1 },
        { id: "account.preflight", version: 1 },
      ],
    },
    prepareRun,
  };
}

function createPlan(command?: RunPlan["command"], metadata?: RunPlan["metadata"]): RunPlan {
  return {
    runId: "run-1",
    projectId: "demo",
    testId: "smoke",
    runnerId: "project-runner",
    device: {
      key: "android:demo",
      id: "demo",
      name: "Demo",
      platform: "android",
      type: "physical",
      connectionState: "available",
      controlState: "ready",
      controlReason: "",
      osVersion: "14",
      detail: "",
    },
    command,
    metadata: { parameters: { suite: "smoke" }, ...metadata },
  };
}
