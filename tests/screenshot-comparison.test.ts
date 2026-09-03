import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/server/app.js";
import type { CommandRunner } from "../src/server/command-runner.js";
import type { LoadedProjectConfig } from "../src/server/config.js";
import { DeviceDiscoveryService } from "../src/server/devices.js";
import type { ProjectRuntime, ProjectRuntimeRegistry } from "../src/server/project-runtime.js";
import { ResultBundleStore } from "../src/server/result-bundle-store.js";
import { StateStore } from "../src/server/state-store.js";
import { TaskManager } from "../src/server/task-manager.js";
import { TaskResultService } from "../src/server/task-results.js";
import type { TestTask } from "../src/shared/contracts.js";
import {
  pairScreenshotComparisonItems,
  parseScreenshotComparisonTitle,
  screenshotComparisonKey,
} from "../src/shared/screenshot-comparison.js";

const tempDirs: string[] = [];
const PAGE_MATRIX_LABELS = [
  "newCustomer-pages_index.jpg",
  "shopEmployee-pages_index.jpg",
  "shopManager-pages_index.jpg",
  "shopOwner-pages_index.jpg",
] as const;
const PAGE_MATRIX_CASE_ID = "tests/e2e/specs/wechatide-page-matrix.e2e · 最新版微信开发者工具全页面巡检";
const LEFT_REAL_BUNDLE = "/Users/fengit/workspace/biaoju/saas-mini-program.worktrees/FEATURE-403-infrastructure/.mtc-state/result-bundles/saas-mini-program-feature-403-infrastructure-cbfb5960-20260901061819-547ea49d.json";
const RIGHT_REAL_BUNDLE = "/Users/fengit/workspace/biaoju/saas-mini-program.worktrees/sp-org/.mtc-state/result-bundles/sp-org-3ddb7984-20260903053434-a4f09d53.json";

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map(directory => fs.rm(directory, { recursive: true, force: true })));
});

describe("截图对比配对", () => {
  it("用 caseId 与页面矩阵文件名配对，并解析角色路由标题", () => {
    const left = PAGE_MATRIX_LABELS.map(label => ({
      caseId: PAGE_MATRIX_CASE_ID,
      label,
      artifactId: `left-${label}`,
    }));
    const right = PAGE_MATRIX_LABELS.map(label => ({
      caseId: PAGE_MATRIX_CASE_ID,
      label,
      artifactId: `right-${label}`,
    }));
    const pairs = pairScreenshotComparisonItems(left, right);
    expect(pairs).toHaveLength(4);
    expect(pairs.every(pair => pair.presence === "both")).toBe(true);
    expect(parseScreenshotComparisonTitle("newCustomer-pages_index.jpg")).toBe("newCustomer / pages/index");
    expect(screenshotComparisonKey(PAGE_MATRIX_CASE_ID, "newCustomer-pages_index.jpg")).toContain("newCustomer-pages_index.jpg");
  });

  it("caseId 不一致时按文件名补配，缺页标记仅一侧存在", () => {
    const left = PAGE_MATRIX_LABELS.map(label => ({ caseId: "main-case", label, artifactId: `l-${label}` }));
    const right = PAGE_MATRIX_LABELS.slice(0, 3).map(label => ({ caseId: "worktree-case", label, artifactId: `r-${label}` }));
    const pairs = pairScreenshotComparisonItems(left, right);
    expect(pairs.filter(pair => pair.presence === "both")).toHaveLength(3);
    const missing = pairs.find(pair => pair.presence === "left-only");
    expect(missing?.label).toBe("shopOwner-pages_index.jpg");
    expect(missing?.title).toBe("shopOwner / pages/index");
  });
});

describe("截图对比 API", () => {
  it("跨项目读取历史截图并提示缺失页", async () => {
    const left = await createProjectFixture("project-a", "Main", PAGE_MATRIX_LABELS);
    const right = await createProjectFixture("project-b", "Worktree", PAGE_MATRIX_LABELS.slice(0, 3));
    const resolve = vi.fn(async (projectId = "") => {
      const runtime = projectId === "project-b" ? right.runtime : left.runtime;
      if (!runtime) throw new Error(`missing runtime ${projectId}`);
      return runtime;
    });
    const app = await createApp({
      config: left.config,
      devices: left.devices,
      tasks: left.tasks,
      taskResults: left.taskResults,
      resultBundles: left.resultBundles,
      runtimes: { resolve } as unknown as ProjectRuntimeRegistry,
    });

    try {
      const candidates = await app.inject({
        method: "GET",
        url: "/api/projects/project-b/screenshot-comparison/candidates",
      });
      expect(candidates.statusCode).toBe(200);
      expect(candidates.json().candidates).toEqual([
        expect.objectContaining({
          projectId: "project-b",
          taskId: right.task.id,
          screenshotCount: 3,
        }),
      ]);

      const comparison = await app.inject({
        method: "POST",
        url: "/api/screenshot-comparisons",
        payload: {
          left: { projectId: "project-a", taskId: left.task.id },
          right: { projectId: "project-b", taskId: right.task.id },
        },
      });
      expect(comparison.statusCode).toBe(200);
      const body = comparison.json();
      expect(body.left.directoryName).toBe(path.basename(left.root));
      expect(body.right.directoryName).toBe(path.basename(right.root));
      expect(body.pairs.filter((pair: { presence: string }) => pair.presence === "both")).toHaveLength(3);
      const missing = body.pairs.find((pair: { presence: string }) => pair.presence === "left-only");
      expect(missing.label).toBe("shopOwner-pages_index.jpg");
      expect(missing.left.url).toContain("projectId=project-a");
      expect(missing.right).toBeNull();
      expect(resolve).toHaveBeenCalledWith("project-a");
      expect(resolve).toHaveBeenCalledWith("project-b");

      const same = await app.inject({
        method: "POST",
        url: "/api/screenshot-comparisons",
        payload: {
          left: { projectId: "project-a", taskId: left.task.id },
          right: { projectId: "project-a", taskId: left.task.id },
        },
      });
      expect(same.statusCode).toBe(400);
      expect(same.json().error.code).toBe("SCREENSHOT_COMPARISON_INVALID");
    } finally {
      await Promise.all([left.tasks.shutdown(), right.tasks.shutdown()]);
      await app.close();
    }
  });

  it("源任务不存在时保留另一侧并返回可定位错误", async () => {
    const left = await createProjectFixture("project-a", "Main", PAGE_MATRIX_LABELS);
    const resolve = vi.fn(async () => left.runtime);
    const app = await createApp({
      config: left.config,
      devices: left.devices,
      tasks: left.tasks,
      taskResults: left.taskResults,
      resultBundles: left.resultBundles,
      runtimes: { resolve } as unknown as ProjectRuntimeRegistry,
    });
    try {
      const response = await app.inject({
        method: "POST",
        url: "/api/screenshot-comparisons",
        payload: {
          left: { projectId: "project-a", taskId: left.task.id },
          right: { projectId: "project-a", taskId: "missing-task" },
        },
      });
      expect(response.statusCode).toBe(200);
      expect(response.json().right.error).toContain("任务不存在");
      expect(response.json().pairs).toHaveLength(4);
      expect(response.json().pairs.every((pair: { presence: string }) => pair.presence === "left-only")).toBe(true);
    } finally {
      await left.tasks.shutdown();
      await app.close();
    }
  });
});

describe("真实巡检 Result Bundle 配对", () => {
  it("主仓 FEATURE-403 与 sp-org worktree 的四张角色截图全部配对", async () => {
    const [leftExists, rightExists] = await Promise.all([
      fs.access(LEFT_REAL_BUNDLE).then(() => true, () => false),
      fs.access(RIGHT_REAL_BUNDLE).then(() => true, () => false),
    ]);
    if (!leftExists || !rightExists) return;
    const left = itemsFromBundle(JSON.parse(await fs.readFile(LEFT_REAL_BUNDLE, "utf8")));
    const right = itemsFromBundle(JSON.parse(await fs.readFile(RIGHT_REAL_BUNDLE, "utf8")));
    expect(left.map(item => item.label).sort()).toEqual([...PAGE_MATRIX_LABELS]);
    expect(right.map(item => item.label).sort()).toEqual([...PAGE_MATRIX_LABELS]);
    const pairs = pairScreenshotComparisonItems(left, right);
    expect(pairs).toHaveLength(4);
    expect(pairs.every(pair => pair.presence === "both")).toBe(true);
  });
});

async function createProjectFixture(projectId: string, name: string, labels: readonly string[]) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), `mtc-compare-${projectId}-`));
  tempDirs.push(root);
  const artifactsRoot = path.join(root, "artifacts");
  const stateDir = path.join(root, "state");
  await fs.mkdir(artifactsRoot, { recursive: true });
  const artifacts = [];
  for (const label of labels) {
    const filePath = path.join(artifactsRoot, label);
    await fs.writeFile(filePath, `image:${label}`);
    artifacts.push({
      id: `artifact-${label}`,
      uri: `project://${projectId}/artifacts/${label}`,
      role: "screenshot" as const,
      label,
      mimeType: "image/jpeg",
    });
  }
  const resultBundles = new ResultBundleStore(stateDir);
  const ingestion = await resultBundles.ingest({
    schemaVersion: "test-analysis.run.v1",
    project: { id: projectId, name },
    target: { kind: "mini-program", runtime: "wechat-devtools", platform: "wechat" },
    run: {
      runId: `${projectId}-run`,
      status: "passed",
      environment: "e2e",
      startedAt: "2026-09-03T05:00:00.000Z",
      finishedAt: "2026-09-03T05:01:00.000Z",
    },
    cases: [{
      caseRunId: `${projectId}-case`,
      caseId: PAGE_MATRIX_CASE_ID,
      title: "页面巡检",
      status: "passed",
      targetPage: "pages/index",
      scenario: "page-matrix",
      evidenceRefs: artifacts.map(artifact => artifact.id),
    }],
    artifacts,
    warnings: [],
    provenance: { adapter: "test", adapterVersion: "1", generatedAt: "2026-09-03T05:01:00.000Z" },
    metadata: {},
  }, "test");
  const config = createConfig(root, stateDir, artifactsRoot, projectId, name);
  const task = createTask(projectId, ingestion.resultUri);
  const store = new StateStore(stateDir);
  await store.save([task]);
  const tasks = new TaskManager(config, store);
  await tasks.initialize();
  const taskResults = new TaskResultService(config, tasks, resultBundles);
  const devices = new DeviceDiscoveryService({ async capture() { return { code: 0, stdout: "", stderr: "" }; } } satisfies CommandRunner, []);
  const runtime: ProjectRuntime = {
    config,
    devices,
    tasks,
    taskResults,
    pageParameters: {} as ProjectRuntime["pageParameters"],
    accountProfiles: {} as ProjectRuntime["accountProfiles"],
    businessScripts: {} as ProjectRuntime["businessScripts"],
    resultBundles,
    artifacts: {} as ProjectRuntime["artifacts"],
    projectProviders: [],
    async shutdown() {},
  };
  return { root, config, tasks, task, taskResults, resultBundles, devices, runtime };
}

function createConfig(root: string, stateDir: string, artifactsRoot: string, projectId: string, name: string): LoadedProjectConfig {
  return {
    schemaVersion: "mobile-test-console.config.v1",
    configPath: path.join(root, "config.cjs"),
    project: { id: projectId, name, root },
    stateDir,
    deviceProviders: [],
    lifecycle: {},
    taskDeletion: {},
    taskResults: {
      artifactsRoot,
      provider: { executable: process.execPath, args: ["-e", "process.stdout.write(\"{}\")"] },
    },
    tests: [{
      id: "pages",
      label: "本地回放页面结构巡检",
      description: "",
      platforms: ["android"],
      parameters: [],
      commands: { default: { executable: process.execPath, args: ["-e", "process.exit(0)"] } },
    }],
  };
}

function createTask(projectId: string, resultUri: string): TestTask {
  return {
    id: `${projectId}-task`,
    runId: `${projectId}-run`,
    projectId,
    testId: "pages",
    testLabel: "本地回放页面结构巡检",
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
    createdAt: "2026-09-03T05:00:00.000Z",
    startedAt: "2026-09-03T05:00:00.000Z",
    finishedAt: "2026-09-03T05:01:00.000Z",
    exitCode: 0,
    error: "",
    logs: [],
    resultUri,
  };
}

function itemsFromBundle(bundle: {
  cases: Array<{ caseId: string; evidenceRefs: string[] }>;
  artifacts: Array<{ id: string; role?: string; label?: string }>;
}) {
  const artifacts = new Map(bundle.artifacts.map(artifact => [artifact.id, artifact]));
  return bundle.cases.flatMap(bundleCase => (
    bundleCase.evidenceRefs.flatMap(id => {
      const artifact = artifacts.get(id);
      if (!artifact || artifact.role !== "screenshot" || !artifact.label) return [];
      return [{ caseId: bundleCase.caseId, label: artifact.label, artifactId: artifact.id }];
    })
  ));
}
