import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadProjectConfig } from "../src/server/config.js";
import { ProjectCatalogService, ProjectCatalogStore } from "../src/server/project-catalog.js";
import { isConfiguredProject, resolveStartupProject } from "../src/server/startup-project.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map(directory => fs.rm(directory, { recursive: true, force: true })));
});

describe("MTC 启动项目解析", () => {
  it("没有登记项目时启动平台壳", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mtc-startup-empty-"));
    tempDirs.push(dir);
    const resolution = await resolveStartupProject({
      platformRoot: dir,
    });

    expect(resolution.source).toBe("platform");
    expect(isConfiguredProject(resolution)).toBe(false);
    expect(resolution.config.project.id).toBe("mobile-test-console");
    expect(resolution.config.tests).toEqual([]);
  });

  it("目录已有活跃项目时仍启动平台壳并保留目录状态", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mtc-startup-catalog-"));
    tempDirs.push(dir);
    const projectRoot = path.join(dir, "project");
    await fs.mkdir(projectRoot);
    const configPath = path.join(projectRoot, "mobile-test.config.cjs");
    await fs.writeFile(configPath, `module.exports = {
      schemaVersion: "mobile-test-console.config.v1",
      project: { id: "catalog-app", name: "Catalog App", root: "." },
      deviceProviders: ["android"],
      tests: [{ id: "smoke", label: "Smoke", platforms: ["android"], commands: { default: { executable: "node", args: ["--version"] } } }],
    };\n`);
    const config = await loadProjectConfig(configPath);
    const store = new ProjectCatalogStore(path.join(dir, "projects.json"));
    await new ProjectCatalogService(store).initialize(config);

    const resolution = await resolveStartupProject({ platformRoot: dir });
    expect(resolution.source).toBe("platform");
    expect(resolution.config.project.id).toBe("mobile-test-console");

    const restoredCatalog = new ProjectCatalogService(store);
    await restoredCatalog.initialize();
    expect(restoredCatalog.snapshot().activeProjectId).toBe("catalog-app");
    expect(restoredCatalog.snapshot().projects[0]?.active).toBe(true);
  });

  it("显式配置优先于目录中的活跃配置", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mtc-startup-explicit-"));
    tempDirs.push(dir);
    const configPath = path.join(dir, "explicit.cjs");
    await fs.writeFile(configPath, `module.exports = {
      schemaVersion: "mobile-test-console.config.v1",
      project: { id: "explicit-app", name: "Explicit App", root: "." },
      deviceProviders: ["android"],
      tests: [{ id: "smoke", label: "Smoke", platforms: ["android"], commands: { default: { executable: "node", args: ["--version"] } } }],
    };\n`);

    const resolution = await resolveStartupProject({
      configPath,
      platformRoot: dir,
    });
    expect(resolution.source).toBe("explicit");
    expect(resolution.config.project.id).toBe("explicit-app");
    expect(isConfiguredProject(resolution)).toBe(true);
  });

  it("无参数启动不读取失效的目录配置", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mtc-startup-stale-"));
    tempDirs.push(dir);
    const projectRoot = path.join(dir, "project");
    await fs.mkdir(projectRoot);
    const configPath = path.join(projectRoot, "mobile-test.config.cjs");
    await fs.writeFile(configPath, `module.exports = {
      schemaVersion: "mobile-test-console.config.v1",
      project: { id: "stale-app", name: "Stale App", root: "." },
      deviceProviders: ["android"],
      tests: [{ id: "smoke", label: "Smoke", platforms: ["android"], commands: { default: { executable: "node", args: ["--version"] } } }],
    };\n`);
    const store = new ProjectCatalogStore(path.join(dir, "projects.json"));
    await new ProjectCatalogService(store).initialize(await loadProjectConfig(configPath));
    await fs.rm(configPath);

    const resolution = await resolveStartupProject({ platformRoot: dir });
    expect(resolution.source).toBe("platform");
    expect(resolution.diagnostic).toBe("");

    const restoredCatalog = new ProjectCatalogService(store);
    await restoredCatalog.initialize();
    expect(restoredCatalog.snapshot().projects.map(project => project.id)).toEqual(["stale-app"]);
  });
});
