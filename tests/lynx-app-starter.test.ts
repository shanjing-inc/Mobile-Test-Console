import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import type { RunPlan, RunnerEvent } from "../src/runner/sdk.js";
import { loadProjectConfig } from "../src/server/config.js";
import { ResultBundleStore } from "../src/server/result-bundle-store.js";
import { loadRunnerRuntime } from "../src/server/runner-runtime.js";
import { SystemCommandRunner } from "../src/server/command-runner.js";

const tempDirs: string[] = [];
const starterRoot = fileURLToPath(new URL("../examples/lynx-app-starter", import.meta.url));

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true })));
});

describe("Lynx App Starter", () => {
  it("加载完整 Provider/Runner 并摄取 Smoke Result Bundle", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "mtc-lynx-starter-"));
    tempDirs.push(root);
    await fs.cp(starterRoot, root, { recursive: true });
    const config = await loadProjectConfig(path.join(root, "mobile-test.config.cjs"));
    expect(config.project.integrationType).toBe("lynx-app");
    expect(config.artifactRetention?.artifactsRoot).toBe(path.join(root, "qa", "artifacts"));
    const bundles = new ResultBundleStore(config.stateDir);
    const runtime = await loadRunnerRuntime(config, [], bundles);
    const events: RunnerEvent[] = [];
    const plan: RunPlan = {
      runId: "starter-run-one",
      projectId: config.project.id,
      testId: "lynx-smoke",
      runnerId: "lynx-app-starter-runner",
      device: {
        key: "android:pixel-8",
        id: "pixel-8",
        name: "Pixel 8",
        platform: "android",
        type: "physical",
        connectionState: "available",
        controlState: "ready",
        controlReason: "",
        osVersion: "15",
        detail: "",
      },
      command: {
        executable: process.execPath,
        args: [
          "qa/lynx-suite.cjs",
          "--platform", "android",
          "--device", "pixel-8",
          "--run-id", "starter-run-one",
          "--environment", "qa",
          "--outcome", "passed",
        ],
        cwd: root,
      },
      metadata: { parameters: { environment: "qa", outcome: "passed" } },
    };

    const result = await runtime.resolver.resolve(plan).run(plan, {
      signal: new AbortController().signal,
      emit: event => events.push(event),
    });

    expect(runtime.providers.manifests()).toEqual([
      expect.objectContaining({
        providerId: "lynx-app-starter",
        scope: expect.objectContaining({ runtimes: ["lynx"] }),
      }),
    ]);
    expect(result).toMatchObject({
      status: "passed",
      resultUri: "result-bundle://runs/starter-run-one",
    });
    expect(events.map(event => event.message)).toEqual(expect.arrayContaining([
      "项目能力准备开始",
      "项目能力准备完成",
      "项目结果分析完成",
    ]));
    expect(await bundles.get("starter-run-one")).toMatchObject({
      project: { id: "lynx-app-starter" },
      target: { kind: "app", runtime: "lynx", platform: "android" },
      run: { runId: "starter-run-one", status: "passed" },
      cases: [{ caseId: "home-render", status: "passed" }],
    });
  });

  it("项目清理适配器支持 dry-run 和受限 apply", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "mtc-lynx-starter-cleanup-"));
    tempDirs.push(root);
    await fs.cp(starterRoot, root, { recursive: true });
    const artifactsRoot = path.join(root, "qa", "artifacts");
    const runDirectory = path.join(artifactsRoot, "starter-old-run");
    await fs.mkdir(runDirectory, { recursive: true });
    await fs.writeFile(path.join(runDirectory, "evidence.json"), "{}\n");
    const requestPath = path.join(root, "cleanup-request.json");
    const runner = new SystemCommandRunner();
    const run = async (mode: "plan" | "apply") => {
      await fs.writeFile(requestPath, `${JSON.stringify({
        schemaVersion: "mobile-test-console.artifact-cleanup-request.v1",
        mode,
        candidateRunIds: ["starter-old-run"],
        protectedRunIds: [],
      })}\n`);
      const result = await runner.capture(process.execPath, [
        "qa/artifact-cleanup.cjs",
        "--request", requestPath,
        "--artifacts-root", artifactsRoot,
      ], 10_000, { cwd: root });
      expect(result.code).toBe(0);
      return JSON.parse(result.stdout) as { items: Array<{ status: string }>; bytesFreed: number };
    };

    await fs.writeFile(requestPath, `${JSON.stringify({
      schemaVersion: "mobile-test-console.artifact-cleanup-request.v1",
      mode: "plan",
      candidateRunIds: [],
      protectedRunIds: [],
      discoverCandidates: true,
    })}\n`);
    const inventoryResult = await runner.capture(process.execPath, [
      "qa/artifact-cleanup.cjs",
      "--request", requestPath,
      "--artifacts-root", artifactsRoot,
    ], 10_000, { cwd: root });
    expect(inventoryResult.code).toBe(0);
    expect(JSON.parse(inventoryResult.stdout)).toMatchObject({
      items: [{ runId: "starter-old-run", status: "planned" }],
    });

    expect((await run("plan")).items[0].status).toBe("planned");
    expect(await fs.stat(runDirectory)).toBeTruthy();
    const applied = await run("apply");
    expect(applied.items[0].status).toBe("deleted");
    expect(applied.bytesFreed).toBeGreaterThan(0);
    await expect(fs.stat(runDirectory)).rejects.toMatchObject({ code: "ENOENT" });
  });
});
