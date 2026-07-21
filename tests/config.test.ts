import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Device } from "../src/shared/contracts.js";
import {
  loadProjectConfig,
  resolveCommand,
  validateParameters,
  type LoadedProjectConfig,
} from "../src/server/config.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true })));
});

describe("项目配置", () => {
  it("加载独立 CJS 配置并解析相对项目路径", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mtc-config-"));
    tempDirs.push(dir);
    const configPath = path.join(dir, "mobile-test.config.cjs");
    await fs.writeFile(configPath, `module.exports = {
      schemaVersion: "mobile-test-console.config.v1",
      project: { id: "demo", name: "Demo App", root: "../app" },
      deviceProviders: ["android"],
      tests: [{
        id: "smoke",
        label: "Smoke",
        platforms: ["android"],
        commands: { default: { executable: "node", args: ["--version"] } }
      }]
    };`);

    const config = await loadProjectConfig(configPath);
    expect(config.project.root).toBe(path.resolve(dir, "../app"));
    expect(config.tests[0].description).toBe("");
  });

  it("校验枚举参数并解析命令模板", () => {
    const config = createConfig();
    const test = config.tests[0];
    const parameters = validateParameters(test, { suite: "p0" });
    const command = resolveCommand(config, test, createDevice(), { id: "task-1", runId: "run-1" }, parameters);

    expect(command.args).toEqual(["--suite", "p0", "--device", "android-1", "--run", "run-1"]);
    expect(() => validateParameters(test, { suite: "custom" })).toThrow("测试套件 的值无效");
    expect(() => validateParameters(test, { unknown: "x" })).toThrow("测试参数未声明");
  });
});

function createConfig(): LoadedProjectConfig {
  return {
    schemaVersion: "mobile-test-console.config.v1",
    configPath: "/tmp/config.cjs",
    project: { id: "demo", name: "Demo", root: "/tmp/demo" },
    stateDir: "/tmp/state",
    deviceProviders: ["android"],
    tests: [{
      id: "suite",
      label: "Suite",
      description: "",
      platforms: ["android"],
      parameters: [{
        id: "suite",
        label: "测试套件",
        type: "select",
        defaultValue: "smoke",
        options: [{ value: "smoke", label: "Smoke" }, { value: "p0", label: "P0" }],
      }],
      commands: {
        default: {
          executable: "runner",
          args: ["--suite", "{{params.suite}}", "--device", "{{device.id}}", "--run", "{{task.runId}}"],
        },
      },
    }],
  };
}

function createDevice(): Device {
  return {
    key: "android:android-1",
    id: "android-1",
    name: "Android 1",
    platform: "android",
    type: "physical",
    connectionState: "available",
    osVersion: "14",
    detail: "",
  };
}
