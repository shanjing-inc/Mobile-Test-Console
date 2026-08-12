import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { CommandRunner, CommandResult } from "../src/server/command-runner.js";
import type { LoadedProjectConfig } from "../src/server/config.js";
import { ArtifactRetentionService, ArtifactRetentionStore } from "../src/server/artifact-retention.js";
import { StateStore } from "../src/server/state-store.js";
import { TaskManager } from "../src/server/task-manager.js";
import type { ArtifactRetentionPolicy, Device, TestTask } from "../src/shared/contracts.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map(directory => fs.rm(directory, { recursive: true, force: true })));
});

describe("测试产物保留服务", () => {
  it("按任务状态、保留标记和最近运行生成 dry-run，并在 apply 后同步任务索引", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "mtc-artifact-retention-"));
    tempDirs.push(root);
    const artifactsRoot = path.join(root, "artifacts");
    const stateDir = path.join(root, "state");
    await fs.mkdir(artifactsRoot, { recursive: true });
    const tasks = [
      createTask("task-one", "run-one", "2026-07-01T00:00:00.000Z", { retained: true }),
      createTask("task-two", "run-two", "2026-07-02T00:00:00.000Z"),
      createTask("task-three", "run-three", "2026-07-03T00:00:00.000Z"),
      createTask("task-four", "run-four", "2026-07-04T00:00:00.000Z"),
    ];
    for (const task of tasks) {
      const directory = path.join(artifactsRoot, task.runId);
      await fs.mkdir(directory);
      await fs.writeFile(path.join(directory, "evidence.bin"), task.runId);
    }
    const stateStore = new StateStore(stateDir);
    await stateStore.save(tasks);
    const manager = new TaskManager(createConfig(root, artifactsRoot), stateStore);
    await manager.initialize();
    const runner = new CleanupRunner(artifactsRoot);
    const service = new ArtifactRetentionService(
      createConfig(root, artifactsRoot),
      manager,
      new ArtifactRetentionStore(stateDir),
      undefined,
      runner,
    );

    const preview = await service.preview();

    expect(preview.supported).toBe(true);
    expect(preview.mode).toBe("plan");
    expect(preview.items.map(item => item.runId)).toEqual(["run-two"]);
    expect(preview.protectedRunIds).toEqual(expect.arrayContaining(["run-one", "run-three", "run-four"]));
    expect(await fs.stat(path.join(artifactsRoot, "run-two"))).toBeTruthy();

    const applied = await service.apply();

    expect(applied.mode).toBe("apply");
    expect(applied.items).toEqual([expect.objectContaining({ runId: "run-two", status: "deleted" })]);
    await expect(fs.stat(path.join(artifactsRoot, "run-two"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(manager.list().map(task => task.runId)).not.toContain("run-two");
    expect(manager.list().map(task => task.runId)).toContain("run-one");
    expect(runner.requests.map(request => request.mode)).toEqual(["plan", "plan", "apply"]);
    await manager.shutdown();
  });

  it("适配器执行失败时保留任务索引并返回明确错误", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "mtc-artifact-retention-failure-"));
    tempDirs.push(root);
    const artifactsRoot = path.join(root, "artifacts");
    const stateDir = path.join(root, "state");
    await fs.mkdir(path.join(artifactsRoot, "run-old"), { recursive: true });
    await fs.writeFile(path.join(artifactsRoot, "run-old", "evidence.bin"), "run-old");
    const stateStore = new StateStore(stateDir);
    await stateStore.save([createTask("task-old", "run-old", "2026-07-01T00:00:00.000Z")]);
    const config = createConfig(root, artifactsRoot, { maxRuns: 0, keepSuccessfulPerPlatform: 0 });
    const manager = new TaskManager(config, stateStore);
    await manager.initialize();
    const runner = new CleanupRunner(artifactsRoot, "exit-failure");
    const service = new ArtifactRetentionService(config, manager, new ArtifactRetentionStore(stateDir), undefined, runner);

    await expect(service.apply()).rejects.toMatchObject({ code: "ARTIFACT_CLEANUP_FAILED" });
    expect(manager.list().map(task => task.runId)).toContain("run-old");
    await manager.shutdown();
  });

  it("适配器报告失败或返回请求外运行时保留任务索引", async () => {
    for (const behavior of ["reported-failure", "unknown-run"] as const) {
      const root = await fs.mkdtemp(path.join(os.tmpdir(), `mtc-artifact-retention-${behavior}-`));
      tempDirs.push(root);
      const artifactsRoot = path.join(root, "artifacts");
      const stateDir = path.join(root, "state");
      await fs.mkdir(path.join(artifactsRoot, "run-old"), { recursive: true });
      await fs.writeFile(path.join(artifactsRoot, "run-old", "evidence.bin"), "run-old");
      const stateStore = new StateStore(stateDir);
      await stateStore.save([createTask("task-old", "run-old", "2026-07-01T00:00:00.000Z")]);
      const config = createConfig(root, artifactsRoot, { maxRuns: 0, keepSuccessfulPerPlatform: 0 });
      const manager = new TaskManager(config, stateStore);
      await manager.initialize();
      const service = new ArtifactRetentionService(
        config,
        manager,
        new ArtifactRetentionStore(stateDir),
        undefined,
        new CleanupRunner(artifactsRoot, behavior),
      );

      if (behavior === "reported-failure") {
        const result = await service.apply();
        expect(result.errors).toContain("项目清理适配器报告执行失败，任务索引已保留");
      } else {
        await expect(service.apply()).rejects.toMatchObject({ code: "ARTIFACT_CLEANUP_RESULT_INVALID" });
      }
      expect(manager.list().map(task => task.runId)).toContain("run-old");
      await manager.shutdown();
    }
  });

  it("磁盘空间低于项目安全水位时阻止新测试写入", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "mtc-artifact-storage-"));
    tempDirs.push(root);
    const artifactsRoot = path.join(root, "artifacts");
    const stateDir = path.join(root, "state");
    await fs.mkdir(artifactsRoot, { recursive: true });
    const config = createConfig(root, artifactsRoot, { minimumFreeBytes: Number.MAX_SAFE_INTEGER });
    const manager = new TaskManager(config, new StateStore(stateDir));
    await manager.initialize();
    const service = new ArtifactRetentionService(
      config,
      manager,
      new ArtifactRetentionStore(stateDir),
      undefined,
      new CleanupRunner(artifactsRoot),
    );

    await expect(service.assertCanStart()).rejects.toMatchObject({ code: "ARTIFACT_STORAGE_LOW_SPACE" });
    await manager.shutdown();
  });

  it("扫描无任务索引的历史产物并只清理用户选择的运行", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "mtc-artifact-inventory-"));
    tempDirs.push(root);
    const artifactsRoot = path.join(root, "artifacts");
    const stateDir = path.join(root, "state");
    for (const runId of ["run-history-one", "run-history-two"]) {
      await fs.mkdir(path.join(artifactsRoot, runId), { recursive: true });
      await fs.writeFile(path.join(artifactsRoot, runId, "evidence.bin"), runId);
    }
    const config = createConfig(root, artifactsRoot);
    const manager = new TaskManager(config, new StateStore(stateDir));
    await manager.initialize();
    const runner = new CleanupRunner(artifactsRoot);
    const service = new ArtifactRetentionService(config, manager, new ArtifactRetentionStore(stateDir), undefined, runner);

    const inventory = await service.inventory();

    expect(inventory.items.map(item => item.runId).sort()).toEqual(["run-history-one", "run-history-two"]);
    expect(runner.requests.at(-1)).toMatchObject({ mode: "plan", discoverCandidates: true });

    const applied = await service.apply(["run-history-one"]);

    expect(applied.items).toEqual([expect.objectContaining({ runId: "run-history-one", status: "deleted" })]);
    await expect(fs.stat(path.join(artifactsRoot, "run-history-one"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(await fs.stat(path.join(artifactsRoot, "run-history-two"))).toBeTruthy();
    await manager.shutdown();
  });

  it("拒绝手工清理处于保护范围的运行", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "mtc-artifact-protected-selection-"));
    tempDirs.push(root);
    const artifactsRoot = path.join(root, "artifacts");
    const stateDir = path.join(root, "state");
    for (const runId of ["run-retained", "run-recent"]) {
      await fs.mkdir(path.join(artifactsRoot, runId), { recursive: true });
      await fs.writeFile(path.join(artifactsRoot, runId, "evidence.bin"), runId);
    }
    const stateStore = new StateStore(stateDir);
    await stateStore.save([
      createTask("task-retained", "run-retained", "2026-07-01T00:00:00.000Z", { retained: true }),
      createTask("task-recent", "run-recent", "2026-08-11T00:00:00.000Z"),
    ]);
    const config = createConfig(root, artifactsRoot);
    const manager = new TaskManager(config, stateStore);
    await manager.initialize();
    const service = new ArtifactRetentionService(
      config,
      manager,
      new ArtifactRetentionStore(stateDir),
      undefined,
      new CleanupRunner(artifactsRoot),
    );

    expect((await service.apply(["run-recent"])).items).toEqual([
      expect.objectContaining({ runId: "run-recent", status: "deleted" }),
    ]);
    await expect(service.apply(["run-retained"])).rejects.toMatchObject({ code: "ARTIFACT_CLEANUP_RUN_PROTECTED" });
    await expect(fs.stat(path.join(artifactsRoot, "run-recent"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(await fs.stat(path.join(artifactsRoot, "run-retained"))).toBeTruthy();
    await manager.shutdown();
  });

  it("开启自动治理后在无项目候选时仍回收过期修复工作目录", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "mtc-artifact-repair-retention-"));
    tempDirs.push(root);
    const artifactsRoot = path.join(root, "artifacts");
    const stateDir = path.join(root, "state");
    await fs.mkdir(artifactsRoot, { recursive: true });
    const config = createConfig(root, artifactsRoot);
    config.artifactRetention!.autoCleanup = true;
    const manager = new TaskManager(config, new StateStore(stateDir));
    await manager.initialize();
    let cleanupCalls = 0;
    const service = new ArtifactRetentionService(
      config,
      manager,
      new ArtifactRetentionStore(stateDir),
      {
        list: () => [],
        cleanupExpiredWorktrees: async maxAgeDays => {
          cleanupCalls += 1;
          expect(maxAgeDays).toBe(7);
          return { removed: 1, bytesFreed: 2048, errors: [] };
        },
      },
      new CleanupRunner(artifactsRoot),
    );

    await service.initialize();
    await new Promise(resolve => setTimeout(resolve, 1_100));
    await service.shutdown();

    expect(cleanupCalls).toBe(1);
    expect((await service.snapshot()).latestCleanup).toMatchObject({ bytesFreed: 2048, items: [] });
    await manager.shutdown();
  });
});

class CleanupRunner implements CommandRunner {
  readonly requests: Array<{ mode: "plan" | "apply"; candidateRunIds: string[]; discoverCandidates: boolean }> = [];

  constructor(
    private readonly artifactsRoot: string,
    private readonly behavior: "success" | "exit-failure" | "reported-failure" | "unknown-run" = "success",
  ) {}

  async capture(executable: string, args: string[]): Promise<CommandResult> {
    if (executable === "du") return { code: 0, stdout: `10240\t${this.artifactsRoot}\n`, stderr: "" };
    if (executable === "df") {
      return { code: 0, stdout: "Filesystem 1024-blocks Used Available Capacity Mounted on\n/dev/test 1000000 100 999900 1% /Volumes/Test\n", stderr: "" };
    }
    const requestPath = args[args.indexOf("--request") + 1];
    const request = JSON.parse(await fs.readFile(requestPath, "utf8")) as {
      mode: "plan" | "apply";
      candidateRunIds: string[];
      discoverCandidates?: boolean;
    };
    this.requests.push({ ...request, discoverCandidates: request.discoverCandidates === true });
    if (request.mode === "apply" && this.behavior === "exit-failure") {
      return { code: 1, stdout: "", stderr: "模拟清理失败" };
    }
    const items = [];
    const candidateRunIds = request.discoverCandidates
      ? (await fs.readdir(this.artifactsRoot, { withFileTypes: true })).filter(entry => entry.isDirectory()).map(entry => entry.name)
      : request.candidateRunIds;
    for (const runId of candidateRunIds) {
      const directory = path.join(this.artifactsRoot, runId);
      const exists = await fs.stat(directory).then(stat => stat.isDirectory()).catch(() => false);
      if (!exists) {
        items.push({ runId, relativePaths: [], files: 0, bytes: 0, status: "missing", reason: "artifacts-not-found" });
        continue;
      }
      const size = (await fs.stat(path.join(directory, "evidence.bin"))).size;
      if (request.mode === "apply") await fs.rm(directory, { recursive: true, force: true });
      items.push({
        runId,
        relativePaths: [runId],
        files: 1,
        bytes: size,
        status: request.mode === "plan" ? "planned" : "deleted",
        reason: "candidate",
      });
    }
    if (this.behavior === "unknown-run") {
      items.push({ runId: "request-external-run", relativePaths: [], files: 0, bytes: 0, status: "missing", reason: "unexpected" });
    }
    const files = items.reduce((total, item) => total + item.files, 0);
    const bytes = items.reduce((total, item) => total + item.bytes, 0);
    return {
      code: 0,
      stdout: `${JSON.stringify({
        schemaVersion: "mobile-test-console.artifact-cleanup-result.v1",
        ok: this.behavior !== "reported-failure",
        items,
        files,
        bytes,
        filesRemoved: request.mode === "apply" ? files : 0,
        bytesFreed: request.mode === "apply" ? bytes : 0,
        errors: this.behavior === "reported-failure" ? ["模拟部分失败"] : [],
      })}\n`,
      stderr: "",
    };
  }
}

function createConfig(
  root: string,
  artifactsRoot: string,
  policyOverrides: Partial<ArtifactRetentionPolicy> = {},
): LoadedProjectConfig {
  return {
    schemaVersion: "mobile-test-console.config.v1",
    configPath: path.join(root, "mobile-test.config.cjs"),
    project: { id: "demo", name: "Demo", root },
    stateDir: path.join(root, "state"),
    deviceProviders: ["android"],
    lifecycle: {},
    taskDeletion: {},
    taskResults: {
      schemaVersion: "test-analysis.run.v1",
      artifactsRoot,
      provider: { executable: "node", args: [] },
    },
    artifactRetention: {
      enabled: true,
      autoCleanup: false,
      cleanup: { executable: "cleanup-adapter", args: ["--request", "{{cleanup.requestPath}}"] },
      policy: {
        maxAgeDays: 1,
        maxRuns: 2,
        maxBytes: 1024,
        minimumFreeBytes: 0,
        keepSuccessfulPerPlatform: 1,
        keepFailedPerPlatform: 0,
        repairWorktreeMaxAgeDays: 7,
        ...policyOverrides,
      },
    },
    tests: [{
      id: "smoke",
      label: "Smoke",
      description: "",
      platforms: ["android"],
      parameters: [],
      commands: { default: { executable: process.execPath, args: ["-e", ""] } },
    }],
  };
}

const device: Device = {
  key: "android:device",
  id: "device",
  name: "Android",
  platform: "android",
  type: "physical",
  connectionState: "available",
  osVersion: "14",
  detail: "",
  controlState: "ready",
  controlReason: "",
};

function createTask(
  id: string,
  runId: string,
  finishedAt: string,
  overrides: Partial<TestTask> = {},
): TestTask {
  return {
    id,
    runId,
    projectId: "demo",
    testId: "smoke",
    testLabel: "Smoke",
    device,
    parameters: {},
    status: "passed",
    phase: "测试通过",
    createdAt: finishedAt || "2026-08-11T00:00:00.000Z",
    startedAt: finishedAt || "2026-08-11T00:00:00.000Z",
    finishedAt,
    exitCode: 0,
    error: "",
    logs: [],
    ...overrides,
  };
}
