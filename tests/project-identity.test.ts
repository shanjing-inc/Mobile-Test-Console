import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadProjectConfig } from "../src/server/config.js";
import { ProjectCatalogService, ProjectCatalogStore } from "../src/server/project-catalog.js";
import { projectIdFromRoot, resolveProjectIdentity } from "../src/server/project-identity.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map(directory => fs.rm(directory, { recursive: true, force: true })));
});

describe("项目路径身份", () => {
  it("同一配置 ID 的两个 worktree 生成不同且稳定的运行身份", async () => {
    const parent = await fs.mkdtemp(path.join(os.tmpdir(), "mtc-project-worktrees-"));
    tempDirs.push(parent);
    const roots = [path.join(parent, "worktree-a"), path.join(parent, "worktree-b")];
    await Promise.all(roots.map(async root => {
      await fs.mkdir(root);
      await writeConfig(root, "shared-config-id");
    }));

    const [first, second] = await Promise.all(roots.map(root => loadProjectConfig(path.join(root, "mobile-test.config.cjs"))));
    expect(first.configuredProjectId).toBe("shared-config-id");
    expect(second.configuredProjectId).toBe("shared-config-id");
    expect(first.project.id).not.toBe(second.project.id);
    await expect(loadProjectConfig(path.join(roots[0]!, "mobile-test.config.cjs"))).resolves.toMatchObject({
      project: { id: first.project.id },
    });
  });

  it("同名不同父目录不会冲突，符号链接与真实路径共享身份", async () => {
    const parent = await fs.mkdtemp(path.join(os.tmpdir(), "mtc-project-paths-"));
    tempDirs.push(parent);
    const firstRoot = path.join(parent, "one", "app");
    const secondRoot = path.join(parent, "two", "app");
    const symlinkRoot = path.join(parent, "app-link");
    await fs.mkdir(firstRoot, { recursive: true });
    await fs.mkdir(secondRoot, { recursive: true });
    await fs.symlink(firstRoot, symlinkRoot);

    const first = await resolveProjectIdentity(firstRoot);
    const second = await resolveProjectIdentity(secondRoot);
    const linked = await resolveProjectIdentity(symlinkRoot);
    expect(first.id).not.toBe(second.id);
    expect(linked).toEqual(first);
  });

  it("加载缺少 project.id 的配置并迁移目录 key 与元数据", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "mtc-project-migration-"));
    tempDirs.push(root);
    await writeConfig(root);
    const config = await loadProjectConfig(path.join(root, "mobile-test.config.cjs"));
    expect(config.configuredProjectId).toBeUndefined();
    expect(config.project.id).toBe(projectIdFromRoot(await fs.realpath(root)));

    const catalogPath = path.join(root, "catalog.json");
    const createdAt = "2026-08-01T00:00:00.000Z";
    await fs.writeFile(catalogPath, JSON.stringify({
      schemaVersion: "mobile-test-console.project-catalog.v1",
      activeProjectId: "legacy-id",
      projects: [{
        id: "legacy-id",
        name: "保留名称",
        root,
        configPath: path.join(root, "mobile-test.config.cjs"),
        integrationType: "app",
        platforms: ["android"],
        active: true,
        createdAt,
        updatedAt: createdAt,
        onboarding: [],
      }],
    }));
    const service = new ProjectCatalogService(new ProjectCatalogStore(catalogPath));
    await service.initialize();

    expect(service.snapshot()).toMatchObject({
      activeProjectId: config.project.id,
      projects: [{ id: config.project.id, name: "保留名称", createdAt, active: true }],
    });
    const stored = JSON.parse(await fs.readFile(catalogPath, "utf8")) as { activeProjectId: string };
    expect(stored.activeProjectId).toBe(config.project.id);
  });
});

async function writeConfig(root: string, configuredId?: string): Promise<void> {
  await fs.writeFile(path.join(root, "mobile-test.config.cjs"), `module.exports = {
    schemaVersion: "mobile-test-console.config.v1",
    project: { ${configuredId ? `id: ${JSON.stringify(configuredId)}, ` : ""}name: "Demo", root: "." },
    deviceProviders: ["android"],
    tests: [{ id: "smoke", label: "Smoke", platforms: ["android"], commands: { default: { executable: "node", args: ["--version"] } } }],
  };\n`);
}
