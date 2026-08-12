#!/usr/bin/env node

import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import open from "open";
import { createApp } from "./app.js";
import { SystemCommandRunner } from "./command-runner.js";
import { loadProjectConfig } from "./config.js";
import { DeviceDiscoveryService } from "./devices.js";
import { ProjectLifecycle } from "./lifecycle.js";
import { StateStore } from "./state-store.js";
import { TaskManager } from "./task-manager.js";
import { RepairJobStore } from "./repair-job-store.js";
import { RepairJobManager } from "./repair-job-manager.js";
import { TaskResultService } from "./task-results.js";

const { values } = parseArgs({
  args: process.argv.slice(2).filter(argument => argument !== "--"),
  options: {
    config: { type: "string", short: "c" },
    host: { type: "string", default: "127.0.0.1" },
    port: { type: "string", default: "4310" },
    open: { type: "boolean", default: false },
    help: { type: "boolean", short: "h", default: false },
  },
});

if (values.help) {
  process.stdout.write(`用法：mobile-test-console --config <path> [--host 127.0.0.1] [--port 4310] [--open]\n`);
  process.exit(0);
}

const configPath = String(values.config || process.env.MTC_CONFIG || "").trim();
if (!configPath) {
  process.stderr.write("缺少项目配置，请传入 --config 或设置 MTC_CONFIG\n");
  process.exit(2);
}

const port = Number(values.port);
if (!Number.isInteger(port) || port < 1 || port > 65_535) {
  process.stderr.write(`端口无效: ${values.port}\n`);
  process.exit(2);
}

const config = await loadProjectConfig(configPath);
const runner = new SystemCommandRunner();
const devices = new DeviceDiscoveryService(runner, config.deviceProviders, config.iosSimulator, config);
const tasks = new TaskManager(config, new StateStore(config.stateDir));
await tasks.initialize();
const taskResults = new TaskResultService(config, tasks);
const repairs = config.codexRepair?.enabled
  ? new RepairJobManager(config, new RepairJobStore(config.stateDir), tasks, taskResults, devices, runner)
  : undefined;
if (repairs) await repairs.initialize();
const lifecycle = new ProjectLifecycle(config);
const lifecycleManaged = process.env.MTC_LIFECYCLE_MANAGED === "1";
if (!lifecycleManaged) await lifecycle.startup();

const currentDir = path.dirname(fileURLToPath(import.meta.url));
const productionBuild = path.basename(path.dirname(currentDir)) === "dist";
const staticDir = productionBuild ? path.resolve(currentDir, "../web") : undefined;
const app = await createApp({ config, devices, tasks, taskResults, repairs, staticDir });
const host = String(values.host);
let address: string;
try {
  address = await app.listen({ host, port });
} catch (error) {
  try {
    await lifecycle.shutdown();
  } catch (cleanupError) {
    process.stderr.write(`[lifecycle] ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}\n`);
  }
  throw error;
}
const webAddress = productionBuild ? address : `http://${host}:4311`;
process.stdout.write(`Mobile Test Console 已启动: ${webAddress}\n`);
if (!productionBuild) process.stdout.write(`API: ${address}\n`);
process.stdout.write(`项目: ${config.project.name}\n`);

if (values.open) await open(webAddress);

let closing = false;
const close = async () => {
  if (closing) return;
  closing = true;
  let exitCode = 0;
  for (const [label, action] of [
    ...(repairs ? [["停止 Codex 修复", () => repairs.shutdown()]] as const : []),
    ["停止任务", () => tasks.shutdown()],
    ["关闭 HTTP 服务", () => app.close()],
    ["清理项目", () => lifecycleManaged ? Promise.resolve() : lifecycle.shutdown()],
  ] as const) {
    try {
      await action();
    } catch (error) {
      exitCode = 1;
      process.stderr.write(`[shutdown] ${label}失败: ${error instanceof Error ? error.message : String(error)}\n`);
    }
  }
  process.exit(exitCode);
};
process.once("SIGINT", () => void close());
process.once("SIGTERM", () => void close());
