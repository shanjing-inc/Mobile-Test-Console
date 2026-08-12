import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  LEGACY_COMMAND_RUNNER_ID,
  type InProcessRunner,
  type RunPlan,
} from "../src/runner/sdk.js";
import { loadProjectConfig, type LoadedProjectConfig } from "../src/server/config.js";
import { createRunnerRuntime, loadRunnerRuntime } from "../src/server/runner-runtime.js";

const tempDirs: string[] = [];
const exampleConfigPath = fileURLToPath(new URL("../examples/com.shanjing.example/mobile-test.config.cjs", import.meta.url));

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true })));
});

describe("Runner CLI 运行时", () => {
  it("生产 CLI 与开发生命周期入口都在启动前创建 Runner Runtime", async () => {
    const [cliSource, lifecycleSource] = await Promise.all([
      fs.readFile(new URL("../src/server/cli.ts", import.meta.url), "utf8"),
      fs.readFile(new URL("../src/server/lifecycle-cli.ts", import.meta.url), "utf8"),
    ]);

    expect(cliSource).toContain("await loadRunnerRuntime(config, [], resultBundles)");
    expect(lifecycleSource).toContain('if (phase === "startup") await loadRunnerRuntime(config)');
    expect(cliSource.indexOf("applyDeviceToolEnv();")).toBeLessThan(cliSource.indexOf("await loadRunnerRuntime"));
    expect(lifecycleSource.indexOf("applyDeviceToolEnv();")).toBeLessThan(lifecycleSource.indexOf("await loadRunnerRuntime"));
  });

  it("注册 legacy runner 并按测试配置选择自定义 runner", () => {
    const customRunner = fakeRunner("custom-runner");
    const runtime = createRunnerRuntime(createConfig("custom-runner"), [customRunner]);

    expect(runtime.compatibilityRunner.id).toBe(LEGACY_COMMAND_RUNNER_ID);
    expect(runtime.resolver.resolve(createPlan("custom-runner"))).toBe(customRunner);
    expect(runtime.resolver.resolve(createPlan())).toBe(runtime.compatibilityRunner);
  });

  it("服务启动前拒绝测试引用未注册 runner", () => {
    expect(() => createRunnerRuntime(createConfig("missing-runner"))).toThrow(
      "测试引用了未注册 Runner: smoke=missing-runner",
    );
  });

  it("按配置文件相对路径加载 CJS/ESM Runner 插件并传入项目上下文", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mtc-runner-plugin-"));
    tempDirs.push(dir);
    await fs.writeFile(path.join(dir, "runner-plugin.cjs"), `module.exports = {
      apiVersion: "mobile-test-console.runner-plugin.v1",
      createRunners(context) {
        return [context.services.createCommandRunner(context.project.id + "-" + context.options.suffix)];
      }
    };`);
    await fs.writeFile(path.join(dir, "runner-plugin.mjs"), `export default {
      apiVersion: "mobile-test-console.runner-plugin.v1",
      createRunners(context) {
        return [{
          id: context.options.runnerId,
          async run(plan) { return { runId: plan.runId, status: "passed", exitCode: 0 }; }
        }];
      }
    };`);
    const configPath = path.join(dir, "mobile-test.config.cjs");
    await fs.writeFile(configPath, `module.exports = {
      schemaVersion: "mobile-test-console.config.v1",
      project: { id: "demo", name: "Demo", root: "." },
      runnerPlugins: [
        { module: "./runner-plugin.cjs", options: { suffix: "runner" } },
        { module: "./runner-plugin.mjs", options: { runnerId: "esm-plugin-runner" } }
      ],
      tests: [{ id: "smoke", label: "Smoke", runnerId: "demo-runner", platforms: ["android"] }]
    };`);

    const runtime = await loadRunnerRuntime(await loadProjectConfig(configPath));

    expect(runtime.resolver.resolve(createPlan("demo-runner")).id).toBe("demo-runner");
    expect(runtime.resolver.resolve(createPlan("esm-plugin-runner")).id).toBe("esm-plugin-runner");
  });

  it("加载仓库内独立示例的 Provider 与 Runner 配置", async () => {
    const config = await loadProjectConfig(exampleConfigPath);
    const runtime = await loadRunnerRuntime(config);

    expect(runtime.providers.manifests().map(item => item.providerId)).toEqual(["shanjing-example"]);
    expect(runtime.resolver.resolve(createPlan("shanjing-example-runner")).id).toBe("shanjing-example-runner");
    expect(runtime.providers.manifests()[0]?.capabilities.map(item => item.id)).toEqual([
      "app.build",
      "app.install",
      "account.preflight",
      "page-parameters.resolve",
      "result.analysis",
    ]);
  });

  it("拒绝不兼容或不存在的 Runner 插件", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mtc-runner-plugin-invalid-"));
    tempDirs.push(dir);
    await fs.writeFile(path.join(dir, "invalid.cjs"), `module.exports = { apiVersion: "v0" };`);

    await expect(loadRunnerRuntime({
      ...createConfig("plugin-runner"),
      configPath: path.join(dir, "mobile-test.config.cjs"),
      project: { id: "demo", name: "Demo", root: dir },
      stateDir: path.join(dir, "state"),
      runnerPlugins: [{ module: "./invalid.cjs" }],
    })).rejects.toMatchObject({ code: "CONFIG_INVALID" });
    await expect(loadRunnerRuntime({
      ...createConfig("plugin-runner"),
      configPath: path.join(dir, "mobile-test.config.cjs"),
      project: { id: "demo", name: "Demo", root: dir },
      stateDir: path.join(dir, "state"),
      runnerPlugins: [{ module: "./missing.cjs" }],
    })).rejects.toMatchObject({ code: "CONFIG_LOAD_FAILED" });
  });
});

function createConfig(runnerId?: string): Pick<LoadedProjectConfig, "tests"> {
  return {
    tests: [{
      id: "smoke",
      label: "Smoke",
      description: "",
      runnerId,
      platforms: ["android"],
      parameters: [],
      commands: { default: { executable: "node", args: ["--version"] } },
    }],
  };
}

function createPlan(runnerId?: string): RunPlan {
  return {
    runId: "run-1",
    projectId: "demo",
    testId: "smoke",
    runnerId,
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
  };
}

function fakeRunner(id: string): InProcessRunner {
  return {
    id,
    async run(plan) {
      return { runId: plan.runId, status: "passed", exitCode: 0 };
    },
  };
}
