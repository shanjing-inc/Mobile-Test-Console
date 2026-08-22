#!/usr/bin/env node

import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { assertPortsAvailable, isConsoleRunning, waitForPortsAvailable } from "./dev-ports.mjs";

const forwarded = process.argv.slice(2).filter(argument => argument !== "--");
const configIndex = forwarded.indexOf("--config");
let config = configIndex >= 0 ? forwarded[configIndex + 1] : process.env.MTC_CONFIG;
const mtcConfigIndex = forwarded.indexOf("--mtc-config");
const mtcConfigExplicit = mtcConfigIndex >= 0 || Boolean(process.env.MTC_CONFIG_FILE);
const mtcConfigPath = mtcConfigIndex >= 0
  ? forwarded[mtcConfigIndex + 1]
  : process.env.MTC_CONFIG_FILE || "mtc.config.cjs";
const catalogIndex = forwarded.indexOf("--project-catalog");
const projectCatalog = catalogIndex >= 0
  ? forwarded[catalogIndex + 1]
  : process.env.MTC_PROJECT_CATALOG;
const hostIndex = forwarded.indexOf("--host");
const hostOverride = hostIndex >= 0 ? forwarded[hostIndex + 1] : undefined;
const portIndex = forwarded.indexOf("--port");
const portOverride = portIndex >= 0 ? forwarded[portIndex + 1] : undefined;
let consoleOptions = applyCliOverrides(await loadMtcOptions(mtcConfigPath));

const switchFile = path.join(os.tmpdir(), `mtc-dev-switch-${process.pid}.json`);

await ensurePortsAvailable();

const lifecycleArgs = phase => [
  "exec", "tsx", "src/server/lifecycle-cli.ts",
  ...(config ? ["--config", config] : []),
  ...(projectCatalog ? ["--project-catalog", projectCatalog] : []),
  "--phase", phase,
  "--owner-pid", String(process.pid),
];

const runLifecycle = phase => new Promise((resolve, reject) => {
  const lifecycle = spawn("pnpm", lifecycleArgs(phase), { stdio: "inherit", env: process.env });
  lifecycle.once("error", reject);
  lifecycle.once("exit", (code, signal) => {
    if (code === 0) resolve();
    else reject(new Error(`项目生命周期 ${phase} 失败: ${signal || code || "unknown"}`));
  });
});

let closing = false;
let child = null;
const close = async (signal, childCode = null) => {
  if (closing) return;
  closing = true;
  if (child?.exitCode === null && signal) {
    await new Promise(resolve => {
      child.once("exit", resolve);
      child.kill(signal);
    });
  }
  let exitCode = childCode ?? child?.exitCode ?? 0;
  try {
    await runLifecycle("shutdown");
  } catch (error) {
    exitCode = 1;
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  }
  process.exit(exitCode);
};
process.once("SIGINT", () => void close("SIGINT"));
process.once("SIGTERM", () => void close("SIGTERM"));

await runCurrentProject();

async function runCurrentProject() {
  await fs.rm(switchFile, { force: true });
  await runLifecycle("startup");
  child = spawn("pnpm", ["exec", "concurrently", "-k", "-n", "server,web", "-c", "green,cyan", "pnpm dev:server", "pnpm dev:web"], {
    stdio: "inherit",
    env: {
      ...process.env,
      ...(config ? { MTC_CONFIG: config } : {}),
      ...(projectCatalog ? { MTC_PROJECT_CATALOG: projectCatalog } : {}),
      MTC_CONFIG_FILE: mtcConfigPath,
      MTC_CONSOLE_HOST: consoleOptions.host,
      MTC_CONSOLE_PORT: String(consoleOptions.port),
      MTC_CONSOLE_WEB_PORT: String(consoleOptions.webPort),
      MTC_LIFECYCLE_MANAGED: "1",
      MTC_DEV_SWITCH_FILE: switchFile,
    },
  });
  child.once("error", error => {
    process.stderr.write(`开发服务启动失败: ${error.message}\n`);
    void close(null, 1);
  });
  child.once("exit", code => void handleChildExit(code));
}

async function handleChildExit(code) {
  const switchRequested = !closing && await fs.stat(switchFile).then(stat => stat.isFile(), () => false);
  if (switchRequested) {
    await restartForProject();
    return;
  }
  await close(null, code ?? 1);
}

async function restartForProject() {
  let nextConfig;
  try {
    const payload = JSON.parse(await fs.readFile(switchFile, "utf8"));
    nextConfig = String(payload.configPath || "").trim();
    if (!nextConfig) throw new Error("切换请求缺少项目配置");
  } catch (error) {
    process.stderr.write(`读取项目切换请求失败: ${error instanceof Error ? error.message : String(error)}\n`);
    await close(null, 1);
    return;
  }

  try {
    await runLifecycle("shutdown");
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  }
  config = nextConfig;
  // concurrently 已发出停止信号，端口释放需要等待子进程完全退出。
  await waitForPortsAvailable([consoleOptions.port, consoleOptions.webPort], { host: consoleOptions.host });
  await runCurrentProject();
}

async function ensurePortsAvailable() {
  try {
    await assertPortsAvailable([consoleOptions.port, consoleOptions.webPort], { host: consoleOptions.host });
  } catch (error) {
    if (await isConsoleRunning(globalThis.fetch, consoleOptions.port, consoleOptions.host)) {
      process.stdout.write(`Mobile Test Console 已在运行: http://${consoleOptions.host}:${consoleOptions.webPort}/\n`);
      process.exit(0);
    }
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(2);
  }
}

function loadMtcOptions(configPath) {
  return new Promise((resolve, reject) => {
    const child = spawn("pnpm", ["exec", "tsx", "src/server/mtc-options-cli.ts", "--config", configPath, ...(!mtcConfigExplicit ? ["--optional"] : [])], {
      stdio: ["ignore", "pipe", "pipe"],
      env: process.env,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", chunk => { stdout += chunk; });
    child.stderr.on("data", chunk => { stderr += chunk; });
    child.once("error", reject);
    child.once("exit", code => {
      if (code !== 0) {
        reject(new Error(stderr.trim() || `读取 MTC 启动配置失败: ${code}`));
        return;
      }
      try {
        resolve(JSON.parse(stdout));
      } catch (error) {
        reject(new Error(`读取 MTC 启动配置失败: ${error instanceof Error ? error.message : String(error)}`));
      }
    });
  });
}

function applyCliOverrides(options) {
  const port = portOverride === undefined ? options.port : Number(portOverride);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`端口无效: ${portOverride}`);
  }
  return { ...options, ...(hostOverride ? { host: hostOverride } : {}), port };
}
