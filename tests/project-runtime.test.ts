import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { LoadedProjectConfig } from "../src/server/config.js";
import type { ProjectCatalogService } from "../src/server/project-catalog.js";
import { ProjectRuntimeRegistry, type ProjectRuntime } from "../src/server/project-runtime.js";

describe("项目 Runtime 注册表", () => {
  it("并发加载同一项目时只初始化一次", async () => {
    const defaultRuntime = fakeRuntime(config("default"));
    const candidateConfig = config("candidate");
    const candidateRuntime = fakeRuntime(candidateConfig);
    const loadRuntimeConfig = vi.fn(async () => candidateConfig);
    const factory = vi.fn(async () => candidateRuntime);
    const registry = new ProjectRuntimeRegistry(
      defaultRuntime,
      { loadRuntimeConfig } as unknown as ProjectCatalogService,
      factory,
    );

    const [first, second] = await Promise.all([
      registry.resolve("candidate"),
      registry.resolve("candidate"),
    ]);

    expect(first).toBe(candidateRuntime);
    expect(second).toBe(candidateRuntime);
    expect(loadRuntimeConfig).toHaveBeenCalledTimes(1);
    expect(factory).toHaveBeenCalledTimes(1);
    expect(registry.loaded()).toEqual([defaultRuntime, candidateRuntime]);
  });

  it("初始化失败后允许重试", async () => {
    const defaultRuntime = fakeRuntime(config("default"));
    const candidateConfig = config("candidate");
    const candidateRuntime = fakeRuntime(candidateConfig);
    const factory = vi.fn()
      .mockRejectedValueOnce(new Error("temporary failure"))
      .mockResolvedValueOnce(candidateRuntime);
    const registry = new ProjectRuntimeRegistry(
      defaultRuntime,
      { loadRuntimeConfig: vi.fn(async () => candidateConfig) } as unknown as ProjectCatalogService,
      factory,
    );

    await expect(registry.resolve("candidate")).rejects.toThrow("temporary failure");
    await expect(registry.resolve("candidate")).resolves.toBe(candidateRuntime);
    expect(factory).toHaveBeenCalledTimes(2);
  });
});

function config(projectId: string): LoadedProjectConfig {
  const root = path.join("/tmp", projectId);
  return {
    schemaVersion: "mobile-test-console.config.v1",
    configPath: path.join(root, "mobile-test.config.cjs"),
    project: { id: projectId, name: projectId, root },
    stateDir: path.join(root, ".mtc-state"),
    deviceProviders: [],
    lifecycle: {},
    taskDeletion: {},
    tests: [],
  };
}

function fakeRuntime(runtimeConfig: LoadedProjectConfig): ProjectRuntime {
  return {
    config: runtimeConfig,
    devices: {} as ProjectRuntime["devices"],
    tasks: {} as ProjectRuntime["tasks"],
    taskResults: {} as ProjectRuntime["taskResults"],
    pageParameters: {} as ProjectRuntime["pageParameters"],
    accountProfiles: {} as ProjectRuntime["accountProfiles"],
    businessScripts: {} as ProjectRuntime["businessScripts"],
    resultBundles: {} as ProjectRuntime["resultBundles"],
    artifacts: {} as ProjectRuntime["artifacts"],
    projectProviders: [],
    async shutdown() {},
  };
}
