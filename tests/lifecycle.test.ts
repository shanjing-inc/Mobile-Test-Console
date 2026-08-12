import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { LoadedProjectConfig } from "../src/server/config.js";
import { ProjectLifecycle } from "../src/server/lifecycle.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true })));
});

describe("项目生命周期", () => {
  it("服务启动和关闭各执行一次配置命令", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mtc-lifecycle-"));
    tempDirs.push(dir);
    const config = createConfig(dir);
    const lifecycle = new ProjectLifecycle(config, 2468);

    await lifecycle.startup();
    expect(await fs.readFile(path.join(dir, "startup.txt"), "utf8")).toBe("2468");

    await lifecycle.shutdown();
    await lifecycle.shutdown();
    expect(await fs.readFile(path.join(dir, "shutdown.txt"), "utf8")).toBe("done");
  });

  it("开发模式可由独立进程使用同一 owner pid 完成清理", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mtc-lifecycle-owner-"));
    tempDirs.push(dir);
    const config = createConfig(dir);

    await new ProjectLifecycle(config, 2468).startup();
    await new ProjectLifecycle(config, 2468).cleanup();

    expect(await fs.readFile(path.join(dir, "startup.txt"), "utf8")).toBe("2468");
    expect(await fs.readFile(path.join(dir, "shutdown.txt"), "utf8")).toBe("done");
  });

  it("准备命令失败时终止服务启动", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mtc-lifecycle-"));
    tempDirs.push(dir);
    const config = createConfig(dir);
    config.lifecycle.startup = {
      executable: process.execPath,
      args: ["-e", "process.exit(7)"],
    };

    await expect(new ProjectLifecycle(config).startup()).rejects.toMatchObject({
      code: "LIFECYCLE_STARTUP_FAILED",
    });
  });

  it("清理失败后保留再次执行能力", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mtc-lifecycle-"));
    tempDirs.push(dir);
    const config = createConfig(dir);
    const lifecycle = new ProjectLifecycle(config);
    await lifecycle.startup();
    config.lifecycle.shutdown = {
      executable: process.execPath,
      args: ["-e", "process.exit(8)"],
    };

    await expect(lifecycle.shutdown()).rejects.toMatchObject({ code: "LIFECYCLE_SHUTDOWN_FAILED" });
    config.lifecycle.shutdown = {
      executable: process.execPath,
      args: ["-e", "require('fs').writeFileSync('shutdown-retry.txt', 'done')"],
    };
    await lifecycle.shutdown();
    expect(await fs.readFile(path.join(dir, "shutdown-retry.txt"), "utf8")).toBe("done");
  });
});

function createConfig(root: string): LoadedProjectConfig {
  return {
    schemaVersion: "mobile-test-console.config.v1",
    configPath: path.join(root, "config.cjs"),
    project: { id: "demo", name: "Demo", root },
    stateDir: path.join(root, "state"),
    deviceProviders: ["android"],
    lifecycle: {
      startup: {
        executable: process.execPath,
        args: ["-e", "require('fs').writeFileSync('startup.txt', process.argv[1])", "{{process.pid}}"],
      },
      shutdown: {
        executable: process.execPath,
        args: ["-e", "require('fs').writeFileSync('shutdown.txt', 'done')"],
      },
    },
    taskDeletion: {},
    tests: [{
      id: "smoke",
      label: "Smoke",
      description: "",
      platforms: ["android"],
      parameters: [],
      commands: { default: { executable: process.execPath, args: ["--version"] } },
    }],
  };
}
