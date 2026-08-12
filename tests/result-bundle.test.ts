import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { createApp } from "../src/server/app.js";
import type { CommandRunner } from "../src/server/command-runner.js";
import type { LoadedProjectConfig } from "../src/server/config.js";
import { DeviceDiscoveryService } from "../src/server/devices.js";
import { ResultBundleStore } from "../src/server/result-bundle-store.js";
import { StateStore } from "../src/server/state-store.js";
import { TaskManager } from "../src/server/task-manager.js";
import { ProjectCatalogService, ProjectCatalogStore } from "../src/server/project-catalog.js";
import { RESULT_BUNDLE_SCHEMA_VERSION } from "../src/shared/result-bundle.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true })));
});

describe("ResultBundleStore", () => {
  test("摄取 App 结果并对相同 runId 和内容保持幂等", async () => {
    const store = await createStore();
    const bundle = createBundle();

    const created = await store.ingest(bundle, "test");
    const duplicate = await store.ingest(structuredClone(bundle), "test");

    expect(created.status).toBe("created");
    expect(created.resultUri).toBe("result-bundle://runs/run-one");
    expect(duplicate.status).toBe("duplicate");
    expect(duplicate.fingerprint).toBe(created.fingerprint);
    expect(await store.getByUri(created.resultUri)).toMatchObject({ run: { runId: "run-one" } });
    await expect(store.getByUri("project://demo/run-one")).rejects.toMatchObject({
      code: "RESULT_BUNDLE_URI_INVALID",
    });
    expect(await store.get("run-one")).toMatchObject({
      schemaVersion: RESULT_BUNDLE_SCHEMA_VERSION,
      target: { kind: "app", platform: "ios" },
      run: { runId: "run-one", status: "passed" },
    });
    expect(await store.list()).toEqual([expect.objectContaining({
      runId: "run-one",
      caseCount: 1,
      passed: 1,
      failed: 0,
      artifactCount: 1,
    })]);
  });

  test("拒绝同一 runId 的冲突内容", async () => {
    const store = await createStore();
    await store.ingest(createBundle(), "test");

    await expect(store.ingest(createBundle({ run: { status: "failed" } }), "test"))
      .rejects.toMatchObject({ code: "RESULT_BUNDLE_CONFLICT", statusCode: 409 });
  });

  test("Provider 摄取在写入前校验任务上下文", async () => {
    const store = await createStore();
    const expected = { runId: "run-one", projectId: "demo", status: "passed" as const };

    await expect(store.ingest(
      createBundle({ run: { runId: "run-other" } }),
      "provider",
      expected,
    )).rejects.toMatchObject({ code: "RESULT_BUNDLE_CONTEXT_MISMATCH" });
    await expect(store.ingest(
      createBundle({ project: { id: "other", name: "Other" } }),
      "provider",
      expected,
    )).rejects.toMatchObject({ code: "RESULT_BUNDLE_CONTEXT_MISMATCH" });
    await expect(store.ingest(
      createBundle({ run: { status: "failed" } }),
      "provider",
      expected,
    )).rejects.toMatchObject({ code: "RESULT_BUNDLE_CONTEXT_MISMATCH" });
    expect(await store.list()).toEqual([]);
  });

  test("并发摄取相同结果时只创建一份状态文件", async () => {
    const store = await createStore();

    const results = await Promise.all([
      store.ingest(createBundle(), "parallel-a"),
      store.ingest(createBundle(), "parallel-b"),
    ]);

    expect(results.map(item => item.status).sort()).toEqual(["created", "duplicate"]);
    expect(await store.list()).toHaveLength(1);
  });

  test("从文件导入小程序结果并校验协议", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "mobile-test-result-bundle-file-"));
    roots.push(root);
    const store = new ResultBundleStore(path.join(root, "state"));
    const filePath = path.join(root, "mini-program.json");
    await fs.writeFile(filePath, JSON.stringify(createBundle({
      target: { kind: "mini-program", platform: "wechat", runtime: "wechat-devtools" },
      run: { runId: "mini-program-run" },
    })));

    const imported = await store.ingestFile(filePath);

    expect(imported.summary).toMatchObject({
      targetKind: "mini-program",
      platform: "wechat",
      runId: "mini-program-run",
    });
    await expect(store.ingest({ schemaVersion: "mobile-test-console.task-result.v1" }, "test"))
      .rejects.toMatchObject({ code: "RESULT_BUNDLE_INVALID", statusCode: 400 });
  });

  test("HTTP push、列表和详情共用同一摄取存储", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "mobile-test-result-bundle-api-"));
    roots.push(root);
    const config = createConfig(root);
    const runner: CommandRunner = {
      async capture() {
        return { code: 0, stdout: "", stderr: "" };
      },
    };
    const tasks = new TaskManager(config, new StateStore(root));
    await tasks.initialize();
    const projectCatalog = new ProjectCatalogService(new ProjectCatalogStore(path.join(root, "projects.json")));
    await projectCatalog.initialize(config);
    const app = await createApp({
      config,
      devices: new DeviceDiscoveryService(runner, []),
      tasks,
      resultBundles: new ResultBundleStore(root),
      projectCatalog,
    });

    try {
      const pushed = await app.inject({ method: "POST", url: "/api/result-bundles", payload: createBundle() });
      expect(pushed.statusCode).toBe(200);
      expect(pushed.json().ingestion).toMatchObject({ status: "created", summary: { runId: "run-one" } });
      expect(projectCatalog.snapshot().projects[0].onboarding.map(step => step.id)).toEqual([
        "project",
        "template",
        "devices",
        "capabilities",
      ]);

      const listed = await app.inject({ method: "GET", url: "/api/result-bundles" });
      expect(listed.statusCode).toBe(200);
      expect(listed.json().bundles).toEqual([expect.objectContaining({ runId: "run-one" })]);

      const detail = await app.inject({ method: "GET", url: "/api/result-bundles/run-one" });
      expect(detail.statusCode).toBe(200);
      expect(detail.json()).toMatchObject({ target: { kind: "app" }, run: { runId: "run-one" } });

      const missing = await app.inject({ method: "GET", url: "/api/result-bundles/missing" });
      expect(missing.statusCode).toBe(404);
      expect(missing.json().error.code).toBe("RESULT_BUNDLE_UNKNOWN");
    } finally {
      await app.close();
    }
  });
});

async function createStore(): Promise<ResultBundleStore> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "mobile-test-result-bundle-"));
  roots.push(root);
  return new ResultBundleStore(path.join(root, "state"));
}

function createBundle(overrides: {
  project?: Partial<{ id: string; name: string }>;
  target?: Partial<{ kind: "app" | "mini-program"; platform: string; runtime: string }>;
  run?: Partial<{ runId: string; status: "passed" | "failed" }>;
} = {}) {
  return {
    schemaVersion: RESULT_BUNDLE_SCHEMA_VERSION,
    project: { id: "demo", name: "Demo", ...overrides.project },
    target: { kind: "app" as const, platform: "ios", runtime: "native", ...overrides.target },
    run: {
      runId: "run-one",
      status: "passed" as const,
      environment: "qa",
      startedAt: "2026-08-05T00:00:00.000Z",
      finishedAt: "2026-08-05T00:01:00.000Z",
      ...overrides.run,
    },
    cases: [{
      caseRunId: "run-one-case-one",
      caseId: "case-one",
      title: "Case one",
      status: "passed",
      assertions: [{ assertionId: "ready", kind: "runtimeEvent", passed: true }],
      evidenceRefs: ["screen-one"],
    }],
    artifacts: [{
      id: "screen-one",
      uri: "project://demo/artifacts/run-one/screen.png",
      role: "screenshot" as const,
      mimeType: "image/png",
    }],
    provenance: { adapter: "demo", adapterVersion: "1", generatedAt: "2026-08-05T00:01:00.000Z" },
  };
}

function createConfig(stateDir: string): LoadedProjectConfig {
  return {
    schemaVersion: "mobile-test-console.config.v1",
    configPath: path.join(stateDir, "config.cjs"),
    project: { id: "demo", name: "Demo", root: stateDir },
    stateDir,
    deviceProviders: [],
    lifecycle: {},
    taskDeletion: {},
    tests: [{
      id: "pass",
      label: "Pass",
      description: "",
      platforms: ["android"],
      parameters: [],
      commands: { default: { executable: process.execPath, args: ["-e", "process.exit(0)"] } },
    }],
  };
}
