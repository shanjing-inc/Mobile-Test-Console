import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { CommandResult, CommandRunner } from "../runner/sdk.js";

export type { CommandResult, CommandRunner } from "../runner/sdk.js";

export interface DeviceExecutableResolverOptions {
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
  exists?: (candidate: string) => boolean;
  readDir?: (directory: string) => string[];
}

export function resolveDeviceExecutable(
  executable: string,
  options: DeviceExecutableResolverOptions = {},
): string {
  if (executable !== "adb" && executable !== "hdc") return executable;
  const env = options.env ?? process.env;
  const homeDir = options.homeDir ?? os.homedir();
  const exists = options.exists ?? (candidate => {
    try {
      return fs.statSync(candidate).isFile();
    } catch {
      return false;
    }
  });
  const firstExisting = (candidates: string[]) => candidates.find(exists) ?? executable;

  if (executable === "adb") {
    return firstExisting([
      env.ANDROID_ADB_PATH || "",
      env.ANDROID_SDK_ROOT ? path.join(env.ANDROID_SDK_ROOT, "platform-tools", "adb") : "",
      env.ANDROID_HOME ? path.join(env.ANDROID_HOME, "platform-tools", "adb") : "",
      path.join(homeDir, "Library", "Android", "sdk", "platform-tools", "adb"),
    ].filter(Boolean));
  }

  const readDir = options.readDir ?? (directory => {
    try {
      return fs.readdirSync(directory);
    } catch {
      return [];
    }
  });
  const harmonySdkRoot = path.join(homeDir, "Library", "OpenHarmony", "Sdk");
  const installedSdkVersions = readDir(harmonySdkRoot)
    .filter(version => /^\d+(?:\.\d+)*$/.test(version))
    .sort((left, right) => compareVersion(right, left));
  return firstExisting([
    env.HARMONY_HDC_PATH || "",
    env.HARMONY_SDK_HOME ? path.join(env.HARMONY_SDK_HOME, "toolchains", "hdc") : "",
    env.DEVECO_SDK_HOME ? path.join(env.DEVECO_SDK_HOME, "toolchains", "hdc") : "",
    ...installedSdkVersions.map(version => path.join(harmonySdkRoot, version, "toolchains", "hdc")),
    path.join(homeDir, "Applications", "command-line-tools", "sdk", "default", "openharmony", "toolchains", "hdc"),
    "/Applications/DevEco-Studio.app/Contents/sdk/default/openharmony/toolchains/hdc",
  ].filter(Boolean));
}

export function buildDeviceToolEnv(options: DeviceExecutableResolverOptions = {}): NodeJS.ProcessEnv {
  const env = { ...(options.env ?? process.env) };
  const toolDirectories = ["adb", "hdc"]
    .map(executable => resolveDeviceExecutable(executable, { ...options, env }))
    .filter(path.isAbsolute)
    .map(path.dirname);
  const currentDirectories = String(env.PATH || "").split(path.delimiter).filter(Boolean);
  env.PATH = [...new Set([...toolDirectories, ...currentDirectories])].join(path.delimiter);
  return env;
}

export function applyDeviceToolEnv(
  targetEnv: NodeJS.ProcessEnv = process.env,
  options: Omit<DeviceExecutableResolverOptions, "env"> = {},
): NodeJS.ProcessEnv {
  const resolved = buildDeviceToolEnv({ ...options, env: targetEnv });
  targetEnv.PATH = resolved.PATH;
  return targetEnv;
}

function compareVersion(left: string, right: string): number {
  const leftParts = left.split(".").map(Number);
  const rightParts = right.split(".").map(Number);
  const length = Math.max(leftParts.length, rightParts.length);
  for (let index = 0; index < length; index += 1) {
    const difference = (leftParts[index] ?? 0) - (rightParts[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

export class SystemCommandRunner implements CommandRunner {
  capture(
    executable: string,
    args: string[],
    timeoutMs = 15_000,
    options: { cwd?: string; env?: Record<string, string> } = {},
  ): Promise<CommandResult> {
    return new Promise(resolve => {
      const env = buildDeviceToolEnv({ env: { ...process.env, ...options.env } });
      execFile(resolveDeviceExecutable(executable, { env }), args, {
        encoding: "utf8",
        timeout: timeoutMs,
        maxBuffer: 16 * 1024 * 1024,
        cwd: options.cwd,
        env,
      }, (error, stdout, stderr) => {
        const code = typeof (error as NodeJS.ErrnoException & { code?: number })?.code === "number"
          ? Number((error as NodeJS.ErrnoException & { code?: number }).code)
          : error ? 1 : 0;
        resolve({
          code,
          stdout: String(stdout || ""),
          stderr: String(stderr || error?.message || ""),
        });
      });
    });
  }
}
