/* eslint-disable @typescript-eslint/no-require-imports */
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

function runCommand(executable, args, options = {}) {
  const result = spawnSync(executable, args, {
    cwd: options.cwd,
    env: options.env || process.env,
    encoding: options.encoding === undefined ? "utf8" : options.encoding,
    stdio: options.capture ? "pipe" : "inherit",
  });
  if (result.error) throw new Error(`${executable} 启动失败: ${result.error.message}`);
  if (result.status !== 0) {
    const detail = options.capture ? String(result.stderr || result.stdout || "").trim() : "";
    throw new Error(`${executable} 执行失败 (${result.status})${detail ? `: ${detail}` : ""}`);
  }
  return result;
}

function resolveAndroidTool(name) {
  const executable = process.platform === "win32" ? `${name}.exe` : name;
  const roots = [process.env.ANDROID_HOME, process.env.ANDROID_SDK_ROOT].filter(Boolean);
  for (const root of roots) {
    const candidate = path.join(root, "platform-tools", executable);
    if (fs.existsSync(candidate)) return candidate;
  }
  return executable;
}

function resolveJavaHome() {
  if (process.env.JAVA_HOME) return process.env.JAVA_HOME;
  const candidates = [
    "/Applications/Android Studio.app/Contents/jbr/Contents/Home",
    "C:\\Program Files\\Android\\Android Studio\\jbr",
  ];
  return candidates.find(candidate => fs.existsSync(path.join(candidate, "bin", process.platform === "win32" ? "java.exe" : "java")));
}

module.exports = { resolveAndroidTool, resolveJavaHome, runCommand };
