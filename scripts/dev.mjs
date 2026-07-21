#!/usr/bin/env node

import { spawn } from "node:child_process";

const forwarded = process.argv.slice(2).filter(argument => argument !== "--");
const configIndex = forwarded.indexOf("--config");
const config = configIndex >= 0 ? forwarded[configIndex + 1] : process.env.MTC_CONFIG;
if (!config) {
  process.stderr.write("开发模式需要 --config <path> 或 MTC_CONFIG\n");
  process.exit(2);
}

const child = spawn("pnpm", ["exec", "concurrently", "-k", "-n", "server,web", "-c", "green,cyan", "pnpm dev:server", "pnpm dev:web"], {
  stdio: "inherit",
  env: { ...process.env, MTC_CONFIG: config },
});

const stop = signal => {
  if (!child.killed) child.kill(signal);
};
process.once("SIGINT", () => stop("SIGINT"));
process.once("SIGTERM", () => stop("SIGTERM"));
child.once("exit", (code, signal) => {
  process.exit(signal ? 1 : (code ?? 1));
});
