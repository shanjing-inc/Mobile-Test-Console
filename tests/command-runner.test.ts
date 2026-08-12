import path from "node:path";
import { describe, expect, it } from "vitest";
import { applyDeviceToolEnv, buildDeviceToolEnv, resolveDeviceExecutable } from "../src/server/command-runner.js";

describe("本机设备工具解析", () => {
  it("从 Android SDK 默认目录解析 adb", () => {
    const homeDir = "/Users/demo";
    const adbPath = path.join(homeDir, "Library", "Android", "sdk", "platform-tools", "adb");

    expect(resolveDeviceExecutable("adb", {
      homeDir,
      exists: candidate => candidate === adbPath,
    })).toBe(adbPath);
  });

  it("优先使用显式环境变量并从新版 OpenHarmony SDK 解析 hdc", () => {
    const homeDir = "/Users/demo";
    const explicitPath = "/tools/hdc";
    const latestPath = path.join(homeDir, "Library", "OpenHarmony", "Sdk", "23", "toolchains", "hdc");

    expect(resolveDeviceExecutable("hdc", {
      env: { HARMONY_HDC_PATH: explicitPath },
      homeDir,
      exists: candidate => candidate === explicitPath,
      readDir: () => ["10", "23", "14"],
    })).toBe(explicitPath);
    expect(resolveDeviceExecutable("hdc", {
      homeDir,
      exists: candidate => candidate === latestPath,
      readDir: () => ["10", "23", "14"],
    })).toBe(latestPath);
  });

  it("保留 PATH 可解析的命令名", () => {
    expect(resolveDeviceExecutable("git")).toBe("git");
    expect(resolveDeviceExecutable("adb", { exists: () => false })).toBe("adb");
  });

  it("将 SDK 工具目录传递给项目子进程", () => {
    const homeDir = "/Users/demo";
    const adbPath = path.join(homeDir, "Library", "Android", "sdk", "platform-tools", "adb");
    const hdcPath = path.join(homeDir, "Library", "OpenHarmony", "Sdk", "23", "toolchains", "hdc");
    const env = buildDeviceToolEnv({
      env: { PATH: "/usr/bin" },
      homeDir,
      exists: candidate => candidate === adbPath || candidate === hdcPath,
      readDir: () => ["23"],
    });

    expect(env.PATH?.split(path.delimiter)).toEqual([
      path.dirname(adbPath),
      path.dirname(hdcPath),
      "/usr/bin",
    ]);
  });

  it("将设备工具目录应用到共享进程环境", () => {
    const homeDir = "/Users/demo";
    const adbPath = path.join(homeDir, "Library", "Android", "sdk", "platform-tools", "adb");
    const targetEnv = { PATH: "/usr/bin" };

    expect(applyDeviceToolEnv(targetEnv, {
      homeDir,
      exists: candidate => candidate === adbPath,
      readDir: () => [],
    })).toBe(targetEnv);
    expect(targetEnv.PATH?.split(path.delimiter)).toEqual([
      path.dirname(adbPath),
      "/usr/bin",
    ]);
  });
});
