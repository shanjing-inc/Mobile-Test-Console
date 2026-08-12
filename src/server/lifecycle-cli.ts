#!/usr/bin/env node

import { parseArgs } from "node:util";
import { applyDeviceToolEnv } from "./command-runner.js";
import { ProjectLifecycle } from "./lifecycle.js";
import { loadRunnerRuntime } from "./runner-runtime.js";
import { isConfiguredProject, resolveStartupProject } from "./startup-project.js";

applyDeviceToolEnv();

const { values } = parseArgs({
  args: process.argv.slice(2).filter(argument => argument !== "--"),
  options: {
    config: { type: "string", short: "c" },
    "project-catalog": { type: "string" },
    phase: { type: "string" },
    "owner-pid": { type: "string" },
  },
});

const phase = String(values.phase || "");
if (phase !== "startup" && phase !== "shutdown") {
  throw new Error(`--phase 仅支持 startup、shutdown: ${phase}`);
}

const ownerPid = Number(values["owner-pid"]);
if (!Number.isInteger(ownerPid) || ownerPid <= 0) {
  throw new Error(`--owner-pid 必须为正整数: ${values["owner-pid"] || ""}`);
}

const startupProject = await resolveStartupProject({
  configPath: String(values.config || process.env.MTC_CONFIG || "").trim(),
  platformRoot: process.cwd(),
});
if (!isConfiguredProject(startupProject)) process.exit(0);

const config = startupProject.config;
if (phase === "startup") await loadRunnerRuntime(config);
const lifecycle = new ProjectLifecycle(config, ownerPid);
if (phase === "startup") {
  await lifecycle.startup();
} else {
  await lifecycle.cleanup();
}
