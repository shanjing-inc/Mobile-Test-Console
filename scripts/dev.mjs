#!/usr/bin/env node

import { spawn } from "node:child_process";
import { assertPortsAvailable, isConsoleRunning } from "./dev-ports.mjs";

const forwarded = process.argv.slice(2).filter(argument => argument !== "--");
const configIndex = forwarded.indexOf("--config");
const config = configIndex >= 0 ? forwarded[configIndex + 1] : process.env.MTC_CONFIG;
if (!config) {
  process.stderr.write("开发模式需要 --config <path> 或 MTC_CONFIG\n");
  process.exit(2);
}

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

const lifecycleArgs = phase => [
  "exec", "tsx", "src/server/lifecycle-cli.ts",
  "--config", config,
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

await runLifecycle("startup");

const child = spawn("pnpm", ["exec", "concurrently", "-k", "-n", "server,web", "-c", "green,cyan", "pnpm dev:server", "pnpm dev:web"], {
  stdio: "inherit",
  env: {
    ...process.env,
    MTC_CONFIG: config,
    MTC_LIFECYCLE_MANAGED: "1",
  },
});

let closing = false;
const close = async (signal, childCode = null) => {
  if (closing) return;
  closing = true;
  if (child.exitCode === null && signal) {
    await new Promise(resolve => {
      child.once("exit", resolve);
      child.kill(signal);
    });
  }
  let exitCode = childCode ?? child.exitCode ?? 0;
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
child.once("error", error => {
  process.stderr.write(`开发服务启动失败: ${error.message}\n`);
  void close(null, 1);
});
child.once("exit", code => void close(null, code ?? 1));
