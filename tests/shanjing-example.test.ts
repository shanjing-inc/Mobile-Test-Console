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
    expect(config.deviceProviders).toEqual(["android", "ios", "harmony"]);
    expect(config.iosSimulator).toEqual({
      workspace: path.join(exampleRoot, "ios/Example.xcworkspace"),
      scheme: "Example",
    });
    expect(config.tests).toEqual([
      expect.objectContaining({
        id: "lynx-smoke",
        runnerId: "shanjing-example-runner",
        platforms: ["android", "ios", "harmony"],
        commands: {
          android: expect.objectContaining({ args: expect.arrayContaining(["qa/android-suite.cjs"]) }),
          ios: expect.objectContaining({ args: expect.arrayContaining(["qa/ios-suite.cjs"]) }),
          harmony: expect.objectContaining({ args: expect.arrayContaining(["qa/harmony-suite.cjs"]) }),
        },
      }),
    ]);
    expect(runtime.providers.manifests()).toEqual([
      expect.objectContaining({
        providerId: "shanjing-example",
        scope: expect.objectContaining({ platforms: ["android", "ios", "harmony"], runtimes: ["lynx"] }),
      }),
    ]);
    expect(runtime.resolver.get("shanjing-example-runner")).toBeDefined();
  });

  it("三端宿主使用同一项目身份", async () => {
    const [androidBuild, iosProject, harmonyApp] = await Promise.all([
      fs.readFile(path.join(exampleRoot, "android/app/build.gradle.kts"), "utf8"),
      fs.readFile(path.join(exampleRoot, "ios/Example.xcodeproj/project.pbxproj"), "utf8"),
      fs.readFile(path.join(exampleRoot, "harmony/AppScope/app.json5"), "utf8"),
    ]);
    expect(androidBuild).toContain('applicationId = "com.shanjing.example"');
    expect(iosProject).toContain("PRODUCT_BUNDLE_IDENTIFIER = com.shanjing.example");
    expect(harmonyApp).toContain('"bundleName": "com.shanjing.example"');
  });

  it.each(["android", "ios", "harmony"] as const)("%s Result Bundle 保持通用 Lynx App 契约", (platform) => {
    const provider = require(path.join(exampleRoot, "qa/result-bundle.cjs")) as {
      buildResultBundle(projectRoot: string, request: Record<string, unknown>): unknown;
    };
    const bundle = parseResultBundle(provider.buildResultBundle(exampleRoot, {
      plan: {
        runId: "example-contract-run",
        projectId: "shanjing-example",
        device: { platform, id: "contract-device" },
        metadata: { parameters: { environment: "qa" } },
      },
      result: { status: "passed" },
    }));

    expect(bundle).toMatchObject({
      project: { id: "shanjing-example", name: "com.shanjing.example" },
      target: { kind: "app", runtime: "lynx", platform, appId: "com.shanjing.example" },
      run: { runId: "example-contract-run", status: "passed" },
      cases: [{ caseId: "main-render", status: "passed" }],
    });
  });

  it("Provider 对三平台生成项目内准备命令", () => {
    const plugin = require(path.join(exampleRoot, "qa/lynx-project-provider.cjs")) as {
      createProviders(context: { project: { root: string } }): Array<{
        prepareRun(request: Record<string, unknown>): { commands: Array<{ args: string[]; cwd: string }> };
      }>;
    };
    const provider = plugin.createProviders({ project: { root: exampleRoot } })[0];

    for (const platform of ["android", "ios", "harmony"] as const) {
      const result = provider.prepareRun({
        capabilities: ["app.build", "app.install"],
        plan: { device: { platform, id: `${platform}-device`, type: platform === "ios" ? "simulator" : "physical" } },
      });
      expect(result.commands).toEqual([expect.objectContaining({
        cwd: exampleRoot,
        args: [
          "qa/prepare.cjs",
          "--capabilities", "app.build,app.install",
          "--platform", platform,
          "--device", `${platform}-device`,
          "--device-type", platform === "ios" ? "simulator" : "physical",
        ],
      })]);
    }
  });

  it("MTC 核心不包含 example 项目身份、路由或原生命令特判", async () => {
    const source = await readSourceTree(path.join(exampleRoot, "../../src"));
    for (const projectSpecificValue of [
      "com.shanjing.example",
      "example://lynx",
      "qa/ios-suite.cjs",
      "qa/harmony-suite.cjs",
    ]) {
      expect(source).not.toContain(projectSpecificValue);
    }
  });
});

async function readSourceTree(root: string): Promise<string> {
  const entries = await fs.readdir(root, { withFileTypes: true });
  const parts = await Promise.all(entries.map(async (entry) => {
    const target = path.join(root, entry.name);
    return entry.isDirectory() ? readSourceTree(target) : fs.readFile(target, "utf8");
  }));
  return parts.join("\n");
}
