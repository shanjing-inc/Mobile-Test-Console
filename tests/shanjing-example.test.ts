import fs from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { loadProjectConfig } from "../src/server/config.js";
import { loadRunnerRuntime } from "../src/server/runner-runtime.js";
import { parseResultBundle } from "../src/shared/result-bundle.js";

const exampleRoot = fileURLToPath(new URL("../examples/com.shanjing.example", import.meta.url));
const require = createRequire(import.meta.url);

describe("com.shanjing.example", () => {
  it("加载最小 Lynx App 配置、Provider 与 Runner", async () => {
    const config = await loadProjectConfig(path.join(exampleRoot, "mobile-test.config.cjs"));
    const runtime = await loadRunnerRuntime(config);

    expect(config.project).toMatchObject({
      id: "shanjing-example",
      name: "com.shanjing.example",
      root: exampleRoot,
      integrationType: "lynx-app",
    });
    expect(config.deviceProviders).toEqual(["android"]);
    expect(config.tests).toEqual([
      expect.objectContaining({ id: "lynx-smoke", runnerId: "shanjing-example-runner" }),
    ]);
    expect(runtime.providers.manifests()).toEqual([
      expect.objectContaining({
        providerId: "shanjing-example",
        scope: expect.objectContaining({ platforms: ["android"], runtimes: ["lynx"] }),
      }),
    ]);
    expect(runtime.resolver.get("shanjing-example-runner")).toBeDefined();
  });

  it("Android 包名和 Result Bundle 使用同一项目身份", async () => {
    const androidBuild = await fs.readFile(path.join(exampleRoot, "android/app/build.gradle.kts"), "utf8");
    expect(androidBuild).toContain('applicationId = "com.shanjing.example"');

    const provider = require(path.join(exampleRoot, "qa/result-bundle.cjs")) as {
      buildResultBundle(projectRoot: string, request: Record<string, unknown>): unknown;
    };
    const bundle = parseResultBundle(provider.buildResultBundle(exampleRoot, {
      plan: {
        runId: "example-contract-run",
        projectId: "shanjing-example",
        device: { platform: "android", id: "contract-device" },
        metadata: { parameters: { environment: "qa" } },
      },
      result: { status: "passed" },
    }));

    expect(bundle).toMatchObject({
      project: { id: "shanjing-example", name: "com.shanjing.example" },
      target: { kind: "app", runtime: "lynx", platform: "android", appId: "com.shanjing.example" },
      run: { runId: "example-contract-run", status: "passed" },
      cases: [{ caseId: "main-render", status: "passed" }],
    });
  });
});
