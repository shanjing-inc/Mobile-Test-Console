import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  ProjectProviderRegistry,
  type ProjectProvider,
} from "../src/runner/project-provider.js";
import { loadProjectConfig } from "../src/server/config.js";
import { loadProjectProviderRuntime } from "../src/server/project-provider-runtime.js";
import { loadRunnerRuntime } from "../src/server/runner-runtime.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true })));
});

describe("项目 Provider 运行时", () => {
  it("注册并按能力校验项目 Provider", () => {
    const registry = new ProjectProviderRegistry();
    const provider = fakeProvider("demo-app", ["app.build", "result.analysis"]);
    registry.register(provider);

    expect(registry.require("demo-app", ["app.build"])).toBe(provider);
    expect(registry.manifests()).toEqual([provider.manifest]);
    expect(() => registry.require("demo-app", ["app.install"])).toThrow(
      "项目 Provider 缺少能力: demo-app=app.install",
    );
    expect(() => registry.register(provider)).toThrow("项目 Provider 已注册: demo-app");
    expect(() => registry.register({
      ...fakeProvider("invalid-app", ["app.build"]),
      manifest: {
        ...fakeProvider("invalid-app", ["app.build"]).manifest,
        scope: { targetKinds: ["app", "app"] },
      },
    })).toThrow("项目 Provider 目标类型重复: app");
    const missingCollector = fakeProvider("missing-collector", ["app.build"]);
    missingCollector.manifest.capabilities.push({ id: "result.analysis", version: 1 });
    expect(() => registry.register(missingCollector)).toThrow(
      "项目 Provider 缺少 collectResult(): missing-collector",
    );
  });

  it("按配置文件相对路径加载 CJS/ESM Provider 插件并注入 Runner", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mtc-project-provider-"));
    tempDirs.push(dir);
    await fs.writeFile(path.join(dir, "provider.cjs"), `module.exports = {
      apiVersion: "mobile-test-console.project-provider-plugin.v1",
      createProviders(context) {
        return [{
          id: context.project.id + "-app",
          manifest: {
            schemaVersion: "mobile-test-console.project-provider.v1",
            providerId: context.project.id + "-app",
            scope: { targetKinds: ["app"], runtimes: [context.options.runtime] },
            capabilities: context.options.capabilities.map(id => ({ id, version: 1 }))
          },
          prepareRun() { return { commands: [] }; },
          collectResult() { return { bundle: {} }; }
        }];
      }
    };`);
    await fs.writeFile(path.join(dir, "runner.cjs"), `module.exports = {
      apiVersion: "mobile-test-console.runner-plugin.v1",
      createRunners(context) {
        context.services.requireProjectProvider("demo-app", ["app.build", "result.analysis"]);
        return [context.services.createProviderCommandRunner("demo-runner", "demo-app", ["app.build"] )];
      }
    };`);
    await fs.writeFile(path.join(dir, "provider.mjs"), `export default {
      apiVersion: "mobile-test-console.project-provider-plugin.v1",
      createProviders(context) {
        return [{
          id: context.options.providerId,
          manifest: {
            schemaVersion: "mobile-test-console.project-provider.v1",
            providerId: context.options.providerId,
            scope: { targetKinds: ["app"] },
            capabilities: [{ id: "page-parameters.resolve", version: 1 }]
          }
        }];
      }
    };`);
    const configPath = path.join(dir, "mobile-test.config.cjs");
    await fs.writeFile(configPath, `module.exports = {
      schemaVersion: "mobile-test-console.config.v1",
      project: { id: "demo", name: "Demo", root: "." },
      projectProviderPlugins: [{
        module: "./provider.cjs",
        options: { runtime: "demo", capabilities: ["app.build", "result.analysis"] }
      }, { module: "./provider.mjs", options: { providerId: "demo-pages" } }],
      runnerPlugins: [{ module: "./runner.cjs" }],
      tests: [{ id: "smoke", label: "Smoke", runnerId: "demo-runner", platforms: ["android"],
        commands: { default: { executable: "node", args: ["--version"] } } }]
    };`);
    const config = await loadProjectConfig(configPath);

    const runtime = await loadRunnerRuntime(config);

    expect(runtime.providers.require("demo-app").manifest.scope.runtimes).toEqual(["demo"]);
    expect(runtime.providers.require("demo-pages", ["page-parameters.resolve"]).id).toBe("demo-pages");
    expect(runtime.resolver.get("demo-runner")?.id).toBe("demo-runner");
  });

  it("缺少能力时在 Runner 初始化阶段拒绝配置", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mtc-project-provider-missing-"));
    tempDirs.push(dir);
    await fs.writeFile(path.join(dir, "provider.cjs"), `module.exports = {
      apiVersion: "mobile-test-console.project-provider-plugin.v1",
      createProviders() { return [{
        id: "demo-app",
        manifest: {
          schemaVersion: "mobile-test-console.project-provider.v1",
          providerId: "demo-app",
          scope: { targetKinds: ["app"] },
          capabilities: [{ id: "app.build", version: 1 }]
        }
      }]; }
    };`);
    await fs.writeFile(path.join(dir, "runner.cjs"), `module.exports = {
      apiVersion: "mobile-test-console.runner-plugin.v1",
      createRunners(context) {
        context.services.requireProjectProvider("demo-app", ["app.install"]);
        return [];
      }
    };`);
    const configPath = path.join(dir, "mobile-test.config.cjs");
    await fs.writeFile(configPath, `module.exports = {
      schemaVersion: "mobile-test-console.config.v1",
      project: { id: "demo", name: "Demo", root: "." },
      projectProviderPlugins: [{ module: "./provider.cjs" }],
      runnerPlugins: [{ module: "./runner.cjs" }],
      tests: [{ id: "smoke", label: "Smoke", platforms: ["android"],
        commands: { default: { executable: "node", args: ["--version"] } } }]
    };`);

    await expect(loadRunnerRuntime(await loadProjectConfig(configPath))).rejects.toMatchObject({
      code: "CONFIG_INVALID",
      message: expect.stringContaining("项目 Provider 缺少能力: demo-app=app.install"),
    });
  });

  it("组合 Runner 在启动阶段拒绝仅声明清单的 Provider", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mtc-project-provider-manifest-only-"));
    tempDirs.push(dir);
    await fs.writeFile(path.join(dir, "provider.cjs"), `module.exports = {
      apiVersion: "mobile-test-console.project-provider-plugin.v1",
      createProviders() { return [{
        id: "demo-app",
        manifest: {
          schemaVersion: "mobile-test-console.project-provider.v1",
          providerId: "demo-app",
          scope: { targetKinds: ["app"] },
          capabilities: [{ id: "app.build", version: 1 }]
        }
      }]; }
    };`);
    await fs.writeFile(path.join(dir, "runner.cjs"), `module.exports = {
      apiVersion: "mobile-test-console.runner-plugin.v1",
      createRunners(context) {
        return [context.services.createProviderCommandRunner("demo-runner", "demo-app", ["app.build"])];
      }
    };`);
    const configPath = path.join(dir, "mobile-test.config.cjs");
    await fs.writeFile(configPath, `module.exports = {
      schemaVersion: "mobile-test-console.config.v1",
      project: { id: "demo", name: "Demo", root: "." },
      projectProviderPlugins: [{ module: "./provider.cjs" }],
      runnerPlugins: [{ module: "./runner.cjs" }],
      tests: [{ id: "smoke", label: "Smoke", runnerId: "demo-runner", platforms: ["android"],
        commands: { default: { executable: "node", args: ["--version"] } } }]
    };`);

    await expect(loadRunnerRuntime(await loadProjectConfig(configPath))).rejects.toMatchObject({
      code: "CONFIG_INVALID",
      message: expect.stringContaining("项目 Provider 缺少 prepareRun(): demo-app"),
    });
  });

  it("拒绝无效协议、重复 Provider 与缺失模块", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mtc-project-provider-invalid-"));
    tempDirs.push(dir);
    await fs.writeFile(path.join(dir, "invalid.cjs"), "module.exports = { apiVersion: 'v0' };\n");
    const base = {
      configPath: path.join(dir, "mobile-test.config.cjs"),
      project: { id: "demo", name: "Demo", root: dir },
      stateDir: path.join(dir, "state"),
    };

    await expect(loadProjectProviderRuntime({
      ...base,
      projectProviderPlugins: [{ module: "./invalid.cjs" }],
    })).rejects.toMatchObject({ code: "CONFIG_INVALID" });
    await expect(loadProjectProviderRuntime({
      ...base,
      projectProviderPlugins: [{ module: "./missing.cjs" }],
    })).rejects.toMatchObject({ code: "CONFIG_LOAD_FAILED" });
  });

  it("配置加载阶段拒绝重复插件模块", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mtc-project-provider-duplicate-"));
    tempDirs.push(dir);
    const configPath = path.join(dir, "mobile-test.config.cjs");
    await fs.writeFile(configPath, `module.exports = {
      schemaVersion: "mobile-test-console.config.v1",
      project: { id: "demo", name: "Demo", root: "." },
      projectProviderPlugins: [{ module: "./provider.cjs" }, { module: "./provider.cjs" }],
      tests: [{ id: "smoke", label: "Smoke", platforms: ["android"],
        commands: { default: { executable: "node", args: ["--version"] } } }]
    };`);

    await expect(loadProjectConfig(configPath)).rejects.toMatchObject({
      code: "CONFIG_INVALID",
      message: expect.stringContaining("项目 Provider 插件模块重复"),
    });
  });
});

function fakeProvider(id: string, capabilities: string[]): ProjectProvider {
  const provider: ProjectProvider = {
    id,
    manifest: {
      schemaVersion: "mobile-test-console.project-provider.v1",
      providerId: id,
      scope: { targetKinds: ["app"], runtimes: ["demo"], platforms: ["android"] },
      capabilities: capabilities.map(capabilityId => ({ id: capabilityId, version: 1 })),
    },
  };
  if (capabilities.includes("result.analysis")) provider.collectResult = () => ({ bundle: {} });
  return provider;
}
