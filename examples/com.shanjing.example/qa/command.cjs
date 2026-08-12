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
    timeout: options.timeout,
    maxBuffer: options.maxBuffer,
  });
  if (result.error) throw new Error(`${executable} 启动失败: ${result.error.message}`);
  if (result.status !== 0 && !options.allowFailure) {
    const detail = options.capture ? String(result.stderr || result.stdout || "").trim() : "";
    throw new Error(`${executable} 执行失败 (${result.status})${detail ? `: ${detail}` : ""}`);
  }
  return result;
}

function commandExists(executable) {
  if (path.isAbsolute(executable)) return fs.existsSync(executable);
  const result = spawnSync(process.platform === "win32" ? "where" : "which", [executable], {
    encoding: "utf8",
    stdio: "pipe",
  });
  return result.status === 0;
}

function resolveExecutable(name, candidates = []) {
  const configured = candidates.filter(Boolean).find(candidate => path.isAbsolute(candidate) && fs.existsSync(candidate));
  if (configured) return configured;
  if (commandExists(name)) return name;
  throw new Error(`缺少 ${name}，请安装工具或通过环境变量配置可执行文件路径`);
}

function resolveAndroidTool(name) {
  const executable = process.platform === "win32" ? `${name}.exe` : name;
  const roots = [
    process.env.ANDROID_HOME,
    process.env.ANDROID_SDK_ROOT,
    path.join(process.env.HOME || "", "Library/Android/sdk"),
  ].filter(Boolean);
  for (const root of roots) {
    const candidate = path.join(root, "platform-tools", executable);
    if (fs.existsSync(candidate)) return candidate;
  }
  return executable;
}

function resolveAndroidSdk() {
  const candidates = [process.env.ANDROID_HOME, process.env.ANDROID_SDK_ROOT, path.join(process.env.HOME || "", "Library/Android/sdk")]
    .filter(Boolean);
  return candidates.find(candidate => fs.existsSync(path.join(candidate, "platform-tools")));
}

function resolveJavaHome() {
  if (process.env.JAVA_HOME) return process.env.JAVA_HOME;
  const candidates = [
    "/Applications/Android Studio.app/Contents/jbr/Contents/Home",
    "C:\\Program Files\\Android\\Android Studio\\jbr",
  ];
  return candidates.find(candidate => fs.existsSync(path.join(candidate, "bin", process.platform === "win32" ? "java.exe" : "java")));
}

function resolveHdc() {
  return resolveExecutable("hdc", [
    process.env.HDC_PATH,
    process.env.HARMONY_HDC,
    path.join(process.env.HOME || "", "Library/OpenHarmony/Sdk/default/openharmony/toolchains/hdc"),
    path.join(process.env.HOME || "", "Applications/command-line-tools/sdk/default/openharmony/toolchains/hdc"),
  ]);
}

function resolveHvigorw() {
  return resolveExecutable("hvigorw", [
    process.env.HARMONY_HVIGORW,
    "/Applications/DevEco-Studio.app/Contents/tools/hvigor/bin/hvigorw",
  ]);
}

function resolveOhpm() {
  return resolveExecutable("ohpm", [
    process.env.HARMONY_OHPM,
    "/Applications/DevEco-Studio.app/Contents/tools/ohpm/bin/ohpm",
  ]);
}

function sleep(milliseconds) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

module.exports = {
  commandExists,
  resolveAndroidTool,
  resolveAndroidSdk,
  resolveExecutable,
  resolveHdc,
  resolveHvigorw,
  resolveJavaHome,
  resolveOhpm,
  runCommand,
  sleep,
};
