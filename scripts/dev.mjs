#!/usr/bin/env node

import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { assertPortsAvailable, isConsoleRunning, waitForPortsAvailable } from "./dev-ports.mjs";

const forwarded = process.argv.slice(2).filter(argument => argument !== "--");
const configIndex = forwarded.indexOf("--config");
let config = configIndex >= 0 ? forwarded[configIndex + 1] : process.env.MTC_CONFIG;
const catalogIndex = forwarded.indexOf("--project-catalog");
const projectCatalog = catalogIndex >= 0
  ? forwarded[catalogIndex + 1]
  : process.env.MTC_PROJECT_CATALOG;

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
  await waitForPortsAvailable([4310, 4311]);
  await runCurrentProject();
}

async function ensurePortsAvailable() {
  try {
    await assertPortsAvailable([4310, 4311]);
  } catch (error) {
    if (await isConsoleRunning()) {
      process.stdout.write("Mobile Test Console 已在运行: http://127.0.0.1:4311/\n");
      process.exit(0);
    }
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(2);
  }
}
