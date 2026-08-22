#!/usr/bin/env node

import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import open from "open";
import { createApp } from "./app.js";
import { applyDeviceToolEnv, SystemCommandRunner } from "./command-runner.js";
import { DeviceDiscoveryService } from "./devices.js";
import { ProjectLifecycle } from "./lifecycle.js";
import { StateStore } from "./state-store.js";
import { TaskManager } from "./task-manager.js";
import { RepairJobStore } from "./repair-job-store.js";
import { RepairJobManager } from "./repair-job-manager.js";
import { TaskResultService } from "./task-results.js";
import { ResultBundleStore } from "./result-bundle-store.js";
import { loadRunnerRuntime } from "./runner-runtime.js";
import { ProjectCatalogService, ProjectCatalogStore } from "./project-catalog.js";
import { DirectoryPicker } from "./directory-picker.js";
import { isConfiguredProject, resolveProjectCatalogPath, resolveStartupProject } from "./startup-project.js";
import { ArtifactRetentionService, ArtifactRetentionStore } from "./artifact-retention.js";
import { loadMtcConfig } from "./mtc-config.js";

applyDeviceToolEnv();

const { values } = parseArgs({
  args: process.argv.slice(2).filter(argument => argument !== "--"),
  options: {
    config: { type: "string", short: "c" },
    "project-catalog": { type: "string" },
    host: { type: "string" },
    port: { type: "string" },
    "mtc-config": { type: "string" },
    open: { type: "boolean", default: false },
    help: { type: "boolean", short: "h", default: false },
  },
});

if (values.help) {
  process.stdout.write(`用法：mobile-test-console [--config <path>] [--mtc-config <path>] [--project-catalog <path>] [--host 127.0.0.1] [--port 4310] [--open]\n`);
  process.exit(0);
}

const currentDir = path.dirname(fileURLToPath(import.meta.url));
const productionBuild = path.basename(path.dirname(currentDir)) === "dist";
const platformRoot = path.resolve(currentDir, "../..");
const projectCatalogPath = resolveProjectCatalogPath(values["project-catalog"]);
const mtcConfigPath = String(values["mtc-config"] || process.env.MTC_CONFIG_FILE || "").trim();
const mtcConfig = await loadMtcConfig(mtcConfigPath || undefined, { optional: !mtcConfigPath });
const projectCatalogStore = new ProjectCatalogStore(projectCatalogPath);
const startupProject = await resolveStartupProject({
  configPath: String(values.config || process.env.MTC_CONFIG || "").trim(),
  platformRoot,
});
const config = startupProject.config;
const host = String(values.host || process.env.MTC_CONSOLE_HOST || mtcConfig.host);
const portInput = values.port || process.env.MTC_CONSOLE_PORT || String(mtcConfig.port);
const port = Number(portInput);
if (!Number.isInteger(port) || port < 1 || port > 65_535) {
  process.stderr.write(`端口无效: ${portInput}\n`);
  process.exit(2);
}
const runner = new SystemCommandRunner();
const directoryPicker = new DirectoryPicker(runner);
const projectCatalog = new ProjectCatalogService(projectCatalogStore, runner);
await projectCatalog.initialize(isConfiguredProject(startupProject) ? config : undefined);
const devices = new DeviceDiscoveryService(runner, config.deviceProviders, config.iosSimulator, config);
const resultBundles = new ResultBundleStore(config.stateDir);
const runnerRuntime = await loadRunnerRuntime(config, [], resultBundles);
const tasks = new TaskManager(
  config,
  new StateStore(config.stateDir),
  runnerRuntime.compatibilityRunner,
  runnerRuntime.resolver,
);
await tasks.initialize();
const taskResults = new TaskResultService(config, tasks, resultBundles);
const repairs = config.codexRepair?.enabled
  ? new RepairJobManager(config, new RepairJobStore(config.stateDir), tasks, taskResults, devices, runner)
  : undefined;
if (repairs) await repairs.initialize();
const artifacts = new ArtifactRetentionService(
  config,
  tasks,
  new ArtifactRetentionStore(config.stateDir),
  repairs,
  runner,
);
await artifacts.initialize();
const lifecycle = new ProjectLifecycle(config);
const lifecycleManaged = process.env.MTC_LIFECYCLE_MANAGED === "1";
if (!lifecycleManaged && isConfiguredProject(startupProject)) await lifecycle.startup();

const staticDir = productionBuild ? path.resolve(currentDir, "../web") : undefined;
const app = await createApp({
  config,
  devices,
  tasks,
  taskResults,
  repairs,
  artifacts,
  resultBundles,
  projectProviders: runnerRuntime.providers.manifests(),
  projectCatalog,
  directoryPicker,
  onProjectSwitch: async configPathToSwitch => {
    restartConfigPath = configPathToSwitch;
    const developmentSwitchFile = process.env.MTC_DEV_SWITCH_FILE;
    if (developmentSwitchFile) {
      await fs.writeFile(developmentSwitchFile, `${JSON.stringify({ configPath: configPathToSwitch })}\n`);
      setTimeout(() => void close(), 0).unref?.();
      return;
    }
    setTimeout(() => void close(), 0).unref?.();
  },
  staticDir,
});
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
const webPort = Number(process.env.MTC_CONSOLE_WEB_PORT || mtcConfig.webPort || port + 1);
if (!Number.isInteger(webPort) || webPort < 1 || webPort > 65_535 || webPort === port) {
  process.stderr.write(`页面端口无效: ${webPort}\n`);
  process.exit(2);
}
const webAddress = productionBuild ? address : `http://${host}:${webPort}`;
process.stdout.write(`Mobile Test Console 已启动: ${webAddress}\n`);
if (!productionBuild) process.stdout.write(`API: ${address}\n`);
if (startupProject.diagnostic) process.stderr.write(`[startup] ${startupProject.diagnostic}\n`);
process.stdout.write(isConfiguredProject(startupProject)
  ? `项目: ${config.project.name}\n`
  : "项目: 尚未选择，请在项目概览添加并激活项目\n");

if (values.open) await open(webAddress);

let closing = false;
let restartConfigPath = "";
const close = async (requestedExitCode = 0) => {
  if (closing) return;
  closing = true;
  let exitCode = requestedExitCode;
  for (const [label, action] of [
    ...(repairs ? [["停止 Codex 修复", () => repairs.shutdown()]] as const : []),
    ["停止产物治理", () => artifacts.shutdown()],
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
  if (restartConfigPath && !process.env.MTC_DEV_SWITCH_FILE) {
    const child = spawn(process.execPath, replaceConfigArgument(restartConfigPath), {
      detached: true,
      stdio: "ignore",
      env: { ...process.env, MTC_CONFIG: restartConfigPath },
    });
    child.once("error", error => process.stderr.write(`[switch] 项目重启失败: ${error.message}\n`));
    child.unref();
  }
  if (restartConfigPath && process.env.MTC_DEV_SWITCH_FILE && process.ppid > 1) {
    // tsx watch 会继续驻留等待文件变化，主动结束它才能让 dev.mjs 接管重启。
    try {
      process.kill(process.ppid, "SIGTERM");
    } catch {
      // 父进程已经退出时，当前进程仍按原有退出流程结束。
    }
  }
  process.exit(exitCode);
};
process.once("SIGINT", () => void close());
process.once("SIGTERM", () => void close());

function replaceConfigArgument(nextConfigPath: string): string[] {
  const args = process.argv.slice(1);
  const longIndex = args.indexOf("--config");
  if (longIndex >= 0) {
    args[longIndex + 1] = nextConfigPath;
    return args;
  }
  const shortIndex = args.indexOf("-c");
  if (shortIndex >= 0) {
    args[shortIndex + 1] = nextConfigPath;
    return args;
  }
  args.push("--config", nextConfigPath);
  return args;
}
