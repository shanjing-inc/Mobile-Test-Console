import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "../src/server/app.js";
import type { CommandRunner } from "../src/server/command-runner.js";
import type { LoadedProjectConfig } from "../src/server/config.js";
import { DeviceDiscoveryService } from "../src/server/devices.js";
import { StateStore } from "../src/server/state-store.js";
import { TaskManager } from "../src/server/task-manager.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true })));
});

describe("HTTP API", () => {
  it("返回统一快照并拒绝未知测试", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mtc-api-"));
    tempDirs.push(dir);
    const config = createConfig(dir);
    const runner: CommandRunner = {
      async capture() {
        return { code: 0, stdout: "device-1 device model:Pixel_8\n", stderr: "" };
      },
    };
    const tasks = new TaskManager(config, new StateStore(dir));
    await tasks.initialize();
    const app = await createApp({
      config,
      devices: new DeviceDiscoveryService(runner, ["android"]),
      tasks,
    });

    const snapshot = await app.inject({ method: "GET", url: "/api/snapshot" });
    expect(snapshot.statusCode).toBe(200);
    expect(snapshot.json()).toMatchObject({
      project: { id: "demo" },
      devices: [expect.objectContaining({ key: "android:device-1" })],
      tests: [expect.objectContaining({ id: "pass" })],
    });

    const invalid = await app.inject({
      method: "POST",
      url: "/api/tasks",
      payload: { testId: "missing", deviceKeys: ["android:device-1"], parameters: {} },
    });
    expect(invalid.statusCode).toBe(404);
    expect(invalid.json().error.code).toBe("TEST_UNKNOWN");
    await app.close();
  });
});

function createConfig(stateDir: string): LoadedProjectConfig {
  return {
    schemaVersion: "mobile-test-console.config.v1",
    configPath: path.join(stateDir, "config.cjs"),
    project: { id: "demo", name: "Demo", root: stateDir },
    stateDir,
    deviceProviders: ["android"],
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
