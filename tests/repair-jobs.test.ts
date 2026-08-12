import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Device, RepairJob, TaskResult, TestTask } from "../src/shared/contracts.js";
import { SystemCommandRunner } from "../src/server/command-runner.js";
import type { LoadedProjectConfig } from "../src/server/config.js";
import { TEST_PROJECT_ADAPTER } from "./fixtures/project-adapter.js";
import type { DeviceDiscoveryService } from "../src/server/devices.js";
import { buildCompleteFailureLogs, buildFailureContext, RepairJobManager, resolveCodexExecutable } from "../src/server/repair-job-manager.js";
import { RepairJobStore } from "../src/server/repair-job-store.js";
import { StateStore } from "../src/server/state-store.js";
import { TaskManager } from "../src/server/task-manager.js";
import type { TaskResultService } from "../src/server/task-results.js";
import { createApp } from "../src/server/app.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map(directory => fs.rm(directory, { recursive: true, force: true })));
});

describe("Codex 修复任务", () => {
  it("配置使用裸 codex 时解析到 ChatGPT 内置 CLI", () => {
    expect(resolveCodexExecutable("codex")).toBe("/Applications/ChatGPT.app/Contents/Resources/codex");
    expect(resolveCodexExecutable("/tmp/custom-codex")).toBe("/tmp/custom-codex");
  });

  it("隔离原工作区、幂等创建并在同参数复测通过后导出修复 patch", async () => {
    const fixture = await createFixture("pass");
    const nestedDirectory = path.join(fixture.repo, "nested");
    await fs.mkdir(nestedDirectory);
    const first = await fixture.repairs.create(fixture.originalTask.id, undefined, nestedDirectory);
    const duplicate = await fixture.repairs.create(fixture.originalTask.id);
    expect(duplicate.repairJobId).toBe(first.repairJobId);
    expect(await fs.realpath(first.snapshot.workspace)).toBe(await fs.realpath(fixture.repo));

    const fixed = await waitForRepair(fixture.repairs, first.repairJobId, "fixed");
    expect(fixed.attempt).toBe(1);
    expect(fixed.verificationStatus).toBe("passed");
    expect(fixed.diff).toContain("+repair-fix");
    expect(fixed.diff).not.toContain("+user-change");
    expect(fixed.logs).toContain("[codex] stdout-tail");
    expect(fixed.logs).toContain("[codex stderr] stderr-tail");
    const context = buildFailureContext(fixed);
    expect(context).toContain("errorSummary: 页面打开失败");
    expect(context).toContain("failureLogExcerpt: fixture failed");
    expect(context).toContain("missingEvents: page_ready");
    expect(fixed.events.filter(event => event.status === "fixing" && event.message === "Codex 正在修改代码")).toHaveLength(1);
    expect(await fs.readFile(path.join(fixed.worktreePath, "untracked.txt"), "utf8")).toBe("untracked\n");
    expect(await fs.readFile(fixed.patchPath, "utf8")).toBe(fixed.diff);
    expect(await fs.readFile(path.join(fixture.repo, "tracked.txt"), "utf8")).toBe("base\nuser-change\n");

    const replay = fixture.tasks.get(fixed.replayTaskId);
    expect(replay).toMatchObject({
      status: "passed",
      parameters: fixture.originalTask.parameters,
      workspaceRoot: fixed.worktreePath,
      repairJobId: fixed.repairJobId,
    });
    const [second, secondDuplicate] = await Promise.all([
      fixture.repairs.create(fixture.originalTask.id, "failed-task-my-index"),
      fixture.repairs.create(fixture.originalTask.id, "failed-task-my-index"),
    ]);
    expect(second.caseRunId).toBe("failed-task-my-index");
    expect(second.repairJobId).not.toBe(first.repairJobId);
    expect(secondDuplicate.repairJobId).toBe(second.repairJobId);
    await waitForRepair(fixture.repairs, second.repairJobId, "fixed");

    const app = await createApp({
      config: fixture.config,
      devices: fixture.devices,
      tasks: fixture.tasks,
      taskResults: fixture.results,
      repairs: fixture.repairs,
    });
    const jobs = await app.inject({ method: "GET", url: "/api/repairs" });
    expect(jobs.statusCode).toBe(200);
    expect(jobs.json().jobs).toContainEqual(expect.objectContaining({ repairJobId: fixed.repairJobId, status: "fixed" }));
    const snapshot = await app.inject({ method: "GET", url: "/api/snapshot" });
    expect(snapshot.json().codexRepairEnabled).toBe(true);
    const preview = await app.inject({
      method: "POST",
      url: `/api/tasks/${fixture.originalTask.id}/repairs/preview`,
      payload: { caseRunId: "failed-task-my-index" },
    });
    expect(preview.statusCode).toBe(200);
    expect(preview.json().preview).toMatchObject({
      schemaVersion: "mobile-test-console.repair-preview.v1",
      caseRunId: "failed-task-my-index",
      targetPage: "myIndex",
      platform: "android",
    });
    expect(preview.json().preview.prompt).toContain("errorSummary: 个人中心接口断言失败");
    expect(preview.json().preview.prompt).not.toContain("errorSummary: 页面打开失败");
    const selectedCase = await app.inject({
      method: "POST",
      url: `/api/tasks/${fixture.originalTask.id}/repairs`,
      payload: { caseRunId: "failed-task-my-index" },
    });
    expect(selectedCase.statusCode).toBe(200);
    expect(selectedCase.json().job.repairJobId).toBe(second.repairJobId);
    const unknownCase = await app.inject({
      method: "POST",
      url: `/api/tasks/${fixture.originalTask.id}/repairs`,
      payload: { caseRunId: "unknown-case" },
    });
    expect(unknownCase.statusCode).toBe(404);
    expect(unknownCase.json().error.code).toBe("REPAIR_CASE_UNKNOWN");
    const unknownPreview = await app.inject({
      method: "POST",
      url: `/api/tasks/${fixture.originalTask.id}/repairs/preview`,
      payload: { caseRunId: "unknown-case" },
    });
    expect(unknownPreview.statusCode).toBe(404);
    expect(unknownPreview.json().error.code).toBe("REPAIR_CASE_UNKNOWN");
    const unknown = await app.inject({ method: "GET", url: "/api/repairs/unknown" });
    expect(unknown.statusCode).toBe(404);
    expect(unknown.json().error.code).toBe("REPAIR_JOB_UNKNOWN");
    const unopened = await app.inject({ method: "POST", url: `/api/repairs/${fixed.repairJobId}/open-task` });
    expect(unopened.statusCode).toBe(409);
    expect(unopened.json().error.code).toBe("REPAIR_CODEX_THREAD_UNKNOWN");
    await app.close();
    await fixture.repairs.shutdown();
    await fixture.tasks.shutdown();
  }, 15_000);

  it("第二轮同参数复测仍失败后停止自动修复", async () => {
    const fixture = await createFixture("fail");
    const created = await fixture.repairs.create(fixture.originalTask.id);
    const failed = await waitForRepair(fixture.repairs, created.repairJobId, "failed");

    expect(failed.attempt).toBe(2);
    expect(failed.verificationStatus).toBe("failed");
    expect(failed.error).toContain("第二轮");
    expect(failed.events.filter(event => event.status === "fixing").length).toBeGreaterThanOrEqual(2);
    await fixture.repairs.shutdown();
    await fixture.tasks.shutdown();
  });

  it("回收过期终态 worktree 前归档修复补丁并保留审计记录", async () => {
    const fixture = await createFixture("pass");
    const created = await fixture.repairs.create(fixture.originalTask.id);
    const fixed = await waitForRepair(fixture.repairs, created.repairJobId, "fixed");
    const originalWorktree = fixed.worktreePath;

    const cleanup = await fixture.repairs.cleanupExpiredWorktrees(0);
    const archived = fixture.repairs.get(fixed.repairJobId)!;

    expect(cleanup).toMatchObject({ removed: 1, errors: [] });
    expect(cleanup.bytesFreed).toBeGreaterThan(0);
    expect(archived.worktreePath).toBe("");
    expect(archived.patchPath).toContain(path.join("repair-snapshots", fixed.repairJobId, "repair.patch"));
    expect(await fs.readFile(archived.patchPath, "utf8")).toBe(fixed.diff);
    await expect(fs.stat(originalWorktree)).rejects.toMatchObject({ code: "ENOENT" });
    expect(archived.logs.at(-1)).toContain("已回收过期修复工作目录");
    await fixture.repairs.shutdown();
    await fixture.tasks.shutdown();
  }, 15_000);

  it("复测前置条件失败时保留修复轮次并提示处理环境问题", async () => {
    const fixture = await createFixture("precondition-fail");
    const created = await fixture.repairs.create(fixture.originalTask.id);
    const blocked = await waitForRepair(fixture.repairs, created.repairJobId, "blocked");

    expect(blocked.attempt).toBe(1);
    expect(blocked.verificationStatus).toBe("failed");
    expect(blocked.verificationFailureKind).toBe("precondition");
    expect(blocked.error).toBe("复测前置条件失败：登录前置：确认 Android 设备已解锁失败");
    expect(blocked.events.filter(event => event.message.includes("准备第 2 轮修复"))).toHaveLength(0);
    await fixture.repairs.shutdown();
    await fixture.tasks.shutdown();
  });

  it("Codex 启动异常会持久化为失败状态", async () => {
    const fixture = await createFixture("pass");
    fixture.config.codexRepair!.executable = path.join(fixture.repo, "missing-codex");
    const created = await fixture.repairs.create(fixture.originalTask.id);
    const failed = await waitForRepair(fixture.repairs, created.repairJobId, "failed");

    expect(failed.error).toContain("Codex");
    expect(failed.events.at(-1)).toMatchObject({ status: "failed" });
    fixture.config.codexRepair!.executable = path.join(path.dirname(fixture.repo), "fake-codex");
    const retry = await fixture.repairs.create(fixture.originalTask.id);
    expect(retry.repairJobId).not.toBe(failed.repairJobId);
    await waitForRepair(fixture.repairs, retry.repairJobId, "fixed");
    await fixture.repairs.shutdown();
    await fixture.tasks.shutdown();
  });

  it("通过 App Server 创建项目修复任务并在完成后复测", async () => {
    const fixture = await createFixture("pass");
    const executableDirectory = path.join(path.dirname(fixture.repo), "app-server-bin");
    const executable = path.join(executableDirectory, "codex");
    await fs.mkdir(executableDirectory);
    await fs.writeFile(executable, `#!/usr/bin/env node
const fs = require("node:fs");
const readline = require("node:readline");
const input = readline.createInterface({ input: process.stdin });
let initialized = false;
const send = payload => process.stdout.write(JSON.stringify(payload) + String.fromCharCode(10));
input.on("close", () => process.exit(0));
input.on("line", line => {
  const request = JSON.parse(line);
  if (request.method === "initialize") {
    if (!request.params.capabilities?.experimentalApi) process.exit(9);
    send({ id: request.id, result: { userAgent: "fixture" } });
  } else if (request.method === "initialized") {
    initialized = true;
  } else if (request.method === "thread/start") {
    if (!initialized) process.exit(8);
    fs.appendFileSync(request.params.runtimeWorkspaceRoots[0] + "/tracked.txt", "repair-app-server" + String.fromCharCode(10));
    send({ id: request.id, result: { thread: { id: "sample-repair-thread" } } });
  } else if (request.method === "thread/name/set") {
    send({ id: request.id, result: {} });
  } else if (request.method === "turn/start") {
    fs.writeFileSync(request.params.runtimeWorkspaceRoots[0] + "/.codex-repair/app-server-prompt.txt", String(request.params.input?.[0]?.text || ""));
    fs.writeFileSync(request.params.runtimeWorkspaceRoots[0] + "/.codex-repair/app-server-turn.json", JSON.stringify(request.params));
    send({ id: request.id, result: { turn: { id: "turn-one" } } });
    send({ method: "turn/started", params: { threadId: request.params.threadId, turn: { id: "turn-one" } } });
    send({ method: "turn/completed", params: { threadId: request.params.threadId, turn: { id: "turn-one", status: "completed", items: [] } } });
  }
});
`);
    await fs.chmod(executable, 0o755);
    fixture.config.codexRepair!.executable = executable;
    fixture.config.codexRepair!.appServer = true;

    const created = await fixture.repairs.create(fixture.originalTask.id);
    const fixed = await waitForRepair(fixture.repairs, created.repairJobId, "fixed");

    expect(fixed.codexThreadId).toBe("sample-repair-thread");
    expect(fixed.diff).toContain("+repair-app-server");
    const prompt = await fs.readFile(path.join(fixed.worktreePath, ".codex-repair", "app-server-prompt.txt"), "utf8");
    expect(prompt).toContain("errorSummary: 页面打开失败");
    expect(prompt).toContain("failureLogExcerpt: fixture failed");
    expect(prompt).toContain("原始复测设备：Device 1");
    expect(prompt).toContain('原始复测参数：{"suite":"smoke"}');
    expect(prompt).toContain("完整测试日志路径：.codex-repair/failure-logs.txt");
    expect(prompt).toContain("失败证据、原始设备和参数快照路径：.codex-repair/input.json");
    expect(prompt).not.toContain("# console task logs");
    const turn = JSON.parse(await fs.readFile(path.join(fixed.worktreePath, ".codex-repair", "app-server-turn.json"), "utf8"));
    expect(turn.additionalContext).toBeUndefined();
    const evidence = await fs.readFile(path.join(fixed.worktreePath, ".codex-repair", "failure-logs.txt"), "utf8");
    expect(evidence).toContain("# console task logs");
    expect(evidence).toContain("fixture failed");
    expect(fixed.verificationStatus).toBe("passed");
    await fixture.repairs.shutdown();
    await fixture.tasks.shutdown();
  }, 15_000);

  it("错误上下文只读取选中的失败用例", async () => {
    const fixture = await createFixture("pass");
    const job = {
      caseRunId: "failed-task-my-index",
      targetPage: "myIndex",
      snapshot: { result: createTaskResult("failed-task", "failed") },
    } as unknown as RepairJob;
    const context = buildFailureContext(job);
    expect(context).toContain("caseRunId: failed-task-my-index");
    expect(context).toContain("targetPage: myIndex");
    expect(context).not.toContain("targetPage: loginIndex");
    expect(context).toContain("errorSummary: 个人中心接口断言失败");
    expect(context).not.toContain("errorSummary: 页面打开失败");
    expect(context).toContain("failedAssertions: api: member 接口返回成功");
    expect(context).toContain("failedApiCalls: UserIndex (500)");
    await fixture.repairs.shutdown();
    await fixture.tasks.shutdown();
  });

  it("错误上下文包含任务级前置条件失败", () => {
    const job = {
      caseRunId: "case",
      targetPage: "page",
      snapshot: {
        result: {
          runs: [],
          preconditions: [{ label: "登录前置", status: "failed", detail: "账号画像回放失败" }],
        },
      },
    } as unknown as RepairJob;
    expect(buildFailureContext(job)).toContain("failedPreconditions: 登录前置: 账号画像回放失败");
  });

  it("Codex 输入包含选中用例证据文件的完整文本", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "mtc-repair-evidence-"));
    tempDirs.push(root);
    const artifactDir = path.join(root, "qa/history/artifacts/run-case");
    await fs.mkdir(artifactDir, { recursive: true });
    await fs.writeFile(path.join(artifactDir, "android-logcat.log"), "完整 logcat 第一行\n完整 logcat 最后一行\n");
    const job = {
      caseRunId: "case",
      snapshot: {
        workspace: root,
        taskError: "测试进程退出码: 1",
        taskLogs: ["[stderr] 测试失败明细"],
        result: {
          runId: "run",
          runs: [{ caseRunId: "case", evidenceFiles: ["run-case/android-logcat.log"], failureLogExcerpt: "尾部摘要" }],
        },
      },
    } as unknown as RepairJob;
    const logs = buildCompleteFailureLogs(job);
    expect(logs).toContain("完整 logcat 第一行");
    expect(logs).toContain("完整 logcat 最后一行");
    expect(logs).toContain("测试失败明细");
  });

  it("服务重启会把等待设备的任务恢复为可重试阻塞态", async () => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "mtc-repair-state-"));
    tempDirs.push(stateDir);
    const store = new RepairJobStore(stateDir);
    await store.save([{
      repairJobId: "repair-waiting",
      status: "waiting_device",
      updatedAt: "2026-08-04T00:00:00.000Z",
      error: "",
      events: [],
    } as unknown as RepairJob]);

    const [recovered] = await store.load();
    expect(recovered.status).toBe("blocked");
    expect(recovered.error).toContain("控制服务");
    expect(recovered.events.at(-1)).toMatchObject({ status: "blocked" });
  });

  it("服务重启会迁移旧版复测前置失败状态", async () => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "mtc-repair-state-"));
    tempDirs.push(stateDir);
    const store = new RepairJobStore(stateDir);
    await store.save([{
      repairJobId: "repair-precondition",
      status: "failed",
      verificationStatus: "failed",
      updatedAt: "2026-08-04T00:00:00.000Z",
      error: "第二轮同参数复测仍失败，转人工处理",
      events: [],
      latestVerificationResult: createPreconditionFailureResult("replay-task"),
    } as unknown as RepairJob]);
    const manager = new RepairJobManager(
      {} as LoadedProjectConfig,
      store,
      {} as TaskManager,
      {} as TaskResultService,
      {} as DeviceDiscoveryService,
    );

    await manager.initialize();
    const migrated = manager.get("repair-precondition");
    expect(migrated).toMatchObject({
      status: "blocked",
      verificationFailureKind: "precondition",
      error: "复测前置条件失败：登录前置：确认 Android 设备已解锁失败",
    });
    await manager.shutdown();
  });
});

async function createFixture(replayOutcome: "pass" | "fail" | "precondition-fail") {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "mtc-repair-"));
  tempDirs.push(root);
  const repo = path.join(root, "repo");
  const stateDir = path.join(root, "state");
  await fs.mkdir(repo, { recursive: true });
  const runner = new SystemCommandRunner();
  await runGit(runner, repo, ["init"]);
  await runGit(runner, repo, ["config", "user.name", "Mobile Test Console"]);
  await runGit(runner, repo, ["config", "user.email", "mobile-test-console@example.invalid"]);
  await fs.writeFile(path.join(repo, "tracked.txt"), "base\n");
  await runGit(runner, repo, ["add", "tracked.txt"]);
  await runGit(runner, repo, ["commit", "-m", "baseline"]);
  await fs.appendFile(path.join(repo, "tracked.txt"), "user-change\n");
  await fs.writeFile(path.join(repo, "untracked.txt"), "untracked\n");

  const fakeCodex = path.join(root, "fake-codex");
  await fs.writeFile(fakeCodex, `#!/bin/sh
output=""
approval=""
while [ "$#" -gt 0 ]; do
  if [ "$1" = "--output-last-message" ]; then
    shift
    output="$1"
  fi
  if [ "$1" = "-c" ]; then
    shift
    approval="$1"
  fi
  shift
done
[ "$approval" = 'approval_policy="never"' ] || exit 9
printf 'repair-fix\\n' >> tracked.txt
last=""
for arg in "$@"; do last="$arg"; done
printf '%s' "$last" > .codex-repair/prompt.txt
printf '%s\\n' '{"type":"thread.started"}' '{"type":"turn.started"}' '{"type":"turn.completed"}'
printf 'stdout-tail'
printf 'stderr-tail' >&2
printf '%s\\n' '{"status":"fixed","summary":"已修复","rootCause":"fixture","changedFiles":["tracked.txt"],"verificationCommand":"fixture","notes":""}' > "$output"
`);
  await fs.chmod(fakeCodex, 0o755);

  const config = createConfig(repo, stateDir, fakeCodex, replayOutcome);
  const originalTask = createFailedTask();
  const taskStore = new StateStore(stateDir);
  await taskStore.save([originalTask]);
  const tasks = new TaskManager(config, taskStore);
  await tasks.initialize();
  const results = {
    async load(taskId: string): Promise<TaskResult> {
      if (taskId !== originalTask.id && replayOutcome === "precondition-fail") return createPreconditionFailureResult(taskId);
      return createTaskResult(taskId, taskId === originalTask.id || replayOutcome === "fail" ? "failed" : "passed");
    },
  } as unknown as TaskResultService;
  const devices = {
    async discover() {
      return { devices: [device], errors: {} };
    },
    async snapshot() {
      return { devices: [device], errors: {}, refreshing: false };
    },
  } as unknown as DeviceDiscoveryService;
  const repairs = new RepairJobManager(config, new RepairJobStore(stateDir), tasks, results, devices, runner);
  await repairs.initialize();
  return { repo, stateDir, config, devices, results, tasks, repairs, originalTask };
}

function createConfig(projectRoot: string, stateDir: string, executable: string, outcome: "pass" | "fail" | "precondition-fail"): LoadedProjectConfig {
  return {
    schemaVersion: "mobile-test-console.config.v1",
    configPath: path.join(projectRoot, "mobile-test.config.cjs"),
    project: { id: "demo", name: "Demo", root: projectRoot },
    stateDir,
    deviceProviders: ["android"],
    lifecycle: {},
    taskDeletion: {},
    adapter: TEST_PROJECT_ADAPTER,
    taskResults: {
      artifactsRoot: path.join(projectRoot, "artifacts"),
      provider: { executable: process.execPath, args: ["-e", "process.exit(0)"] },
    },
    codexRepair: {
      enabled: true,
      appServer: false,
      mode: "confirm",
      executable,
      maxAttempts: 2,
      sandbox: "workspace-write",
      approvalPolicy: "never",
      worktreeLinks: [],
      replay: {
        executable: process.execPath,
        args: ["-e", outcome === "pass" ? "process.exit(0)" : "process.exit(1)"],
      },
    },
    tests: [{
      id: "suite",
      label: "Suite",
      description: "",
      platforms: ["android"],
      parameters: [{
        id: "suite",
        label: "套件",
        type: "select",
        defaultValue: "smoke",
        options: [{ value: "smoke", label: "Smoke", description: "" }],
      }],
      commands: {
        default: {
          executable: process.execPath,
          args: ["-e", "process.exit(1)"],
        },
      },
    }],
  };
}

const device: Device = {
  key: "android:device-1",
  id: "device-1",
  name: "Device 1",
  platform: "android",
  type: "physical",
  connectionState: "available",
  controlState: "ready",
  controlReason: "",
  osVersion: "14",
  detail: "",
};

function createFailedTask(): TestTask {
  const now = new Date().toISOString();
  return {
    id: "failed-task",
    runId: "failed-run",
    projectId: "demo",
    testId: "suite",
    testLabel: "Suite",
    device,
    parameters: { suite: "smoke" },
    status: "failed",
    phase: "测试失败",
    createdAt: now,
    startedAt: now,
    finishedAt: now,
    exitCode: 1,
    error: "fixture failed",
    logs: ["fixture failed"],
  };
}

function createTaskResult(taskId: string, status: "passed" | "failed"): TaskResult {
  const baseRun = {
    runId: taskId === "failed-task" ? "failed-run" : `run-${taskId}`,
    caseRunId: `${taskId}-login-index`,
    caseRunCount: 1,
    caseId: "login-index",
    executionKind: "page-replay" as const,
    targetPage: "loginIndex",
    launchPage: "loginIndex",
    scenario: "login-index",
    fixture: "fixture",
    platform: "android" as const,
    device: "device-1",
    status,
    errorSummary: status === "failed" ? "页面打开失败" : "",
    requiredEvents: ["page_ready"],
    missingEvents: status === "failed" ? ["page_ready"] : [],
    runtimeEventCount: status === "passed" ? 1 : 0,
    uiActionCount: 0,
    apiCalls: [],
    screenshots: [],
    evidenceFiles: [],
    failureLogExcerpt: status === "failed" ? "fixture failed" : "",
  };
  const runs = taskId === "failed-task"
    ? [baseRun, {
        ...baseRun,
        caseRunId: "failed-task-my-index",
        caseId: "my-index",
        targetPage: "myIndex",
        launchPage: "myIndex",
        errorSummary: "个人中心接口断言失败",
        failureLogExcerpt: "UserIndex request failed",
        missingEvents: [],
        passBasis: [{ kind: "api", passed: false, description: "member 接口返回成功" }],
        apiCalls: [{
          index: 0,
          ts: "",
          eventType: "api",
          page: "myIndex",
          apiType: "graphql",
          method: "POST",
          url: "https://api.example.invalid/graphql",
          host: "api.example.invalid",
          path: "/graphql",
          endpoint: "member",
          operationName: "UserIndex",
          status: 500,
          result: "failed",
          durationMs: 10,
          request: {},
          response: { errors: [{ message: "业务失败" }] },
          network: { dnsType: "", dnsIps: "", connectIp: "", protocol: "http/2" },
        }],
      }]
    : [baseRun];
  return {
    schemaVersion: "mobile-test-console.task-result.v1",
    generatedAt: new Date().toISOString(),
    taskId,
    runId: taskId === "failed-task" ? "failed-run" : `run-${taskId}`,
    total: runs.length,
    caseRunCount: runs.length,
    passed: status === "passed" ? 1 : 0,
    failed: status === "failed" ? runs.length : 0,
    warnings: [],
    runs,
  };
}

function createPreconditionFailureResult(taskId: string): TaskResult {
  return {
    schemaVersion: "mobile-test-console.task-result.v1",
    generatedAt: new Date().toISOString(),
    taskId,
    runId: `run-${taskId}`,
    total: 0,
    caseRunCount: 0,
    passed: 0,
    failed: 0,
    warnings: ["未找到匹配的 QA 测试结果"],
    preconditions: [{
      id: "authentication",
      label: "登录前置",
      status: "failed",
      action: "failed",
      detail: "账号画像回放失败: {\n  \"errorSummary\": \"确认 Android 设备已解锁失败\"\n}",
      checkedAt: new Date().toISOString(),
    }],
    runs: [],
  };
}

async function runGit(runner: SystemCommandRunner, cwd: string, args: string[]): Promise<void> {
  const result = await runner.capture("git", args, 60_000, { cwd });
  if (result.code !== 0) throw new Error(result.stderr || result.stdout);
}

async function waitForRepair(manager: RepairJobManager, repairJobId: string, status: "fixed" | "failed" | "blocked") {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const job = manager.get(repairJobId);
    if (job?.status === status) return job;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error(`等待修复状态超时: ${status}`);
}
