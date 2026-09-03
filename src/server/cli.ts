#!/usr/bin/env node

import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import open from "open";
import { createApp } from "./app.js";
import { applyDeviceToolEnv, SystemCommandRunner } from "./command-runner.js";
import { ProjectCatalogService, ProjectCatalogStore } from "./project-catalog.js";
import { createProjectRuntime, ProjectRuntimeRegistry } from "./project-runtime.js";
import { TaskExecutionCoordinator } from "./task-execution-coordinator.js";
import { DirectoryPicker } from "./directory-picker.js";
import { isConfiguredProject, resolveProjectCatalogPath, resolveStartupProject } from "./startup-project.js";
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
const lifecycleManaged = process.env.MTC_LIFECYCLE_MANAGED === "1";
const executionCoordinator = new TaskExecutionCoordinator();
const createRuntime = (runtimeConfig: typeof config) => createProjectRuntime(runtimeConfig, {
  commandRunner: runner,
  executionCoordinator,
  lifecycleManaged: false,
  startLifecycle: true,
});
const defaultRuntime = await createProjectRuntime(config, {
  commandRunner: runner,
  executionCoordinator,
  lifecycleManaged,
  startLifecycle: isConfiguredProject(startupProject),
});
const runtimes = new ProjectRuntimeRegistry(defaultRuntime, projectCatalog, createRuntime);

const staticDir = productionBuild ? path.resolve(currentDir, "../web") : undefined;
const app = await createApp({
  config,
  devices: defaultRuntime.devices,
  tasks: defaultRuntime.tasks,
  taskResults: defaultRuntime.taskResults,
  repairs: defaultRuntime.repairs,
  artifacts: defaultRuntime.artifacts,
  resultBundles: defaultRuntime.resultBundles,
  projectProviders: defaultRuntime.projectProviders,
  runtimes,
  projectCatalog,
  directoryPicker,
  staticDir,
});
let address: string;
try {
  address = await app.listen({ host, port });
} catch (error) {
  try {
    await runtimes.shutdown();
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
const close = async (requestedExitCode = 0) => {
  if (closing) return;
  closing = true;
  let exitCode = requestedExitCode;
  for (const [label, action] of [
    ["关闭 HTTP 服务", () => app.close()],
    ["停止项目 Runtime", () => runtimes.shutdown()],
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
