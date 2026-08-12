#!/usr/bin/env node

import { parseArgs } from "node:util";
import { loadProjectConfig } from "./config.js";
import { ProjectLifecycle } from "./lifecycle.js";

const { values } = parseArgs({
  args: process.argv.slice(2).filter(argument => argument !== "--"),
  options: {
    config: { type: "string", short: "c" },
    phase: { type: "string" },
    "owner-pid": { type: "string" },
  },
});

const configPath = String(values.config || process.env.MTC_CONFIG || "").trim();
if (!configPath) throw new Error("缺少项目配置，请传入 --config 或设置 MTC_CONFIG");

const phase = String(values.phase || "");
if (phase !== "startup" && phase !== "shutdown") {
  throw new Error(`--phase 仅支持 startup、shutdown: ${phase}`);
}

const ownerPid = Number(values["owner-pid"]);
if (!Number.isInteger(ownerPid) || ownerPid <= 0) {
  throw new Error(`--owner-pid 必须为正整数: ${values["owner-pid"] || ""}`);
}

const lifecycle = new ProjectLifecycle(await loadProjectConfig(configPath), ownerPid);
if (phase === "startup") {
  await lifecycle.startup();
} else {
  await lifecycle.cleanup();
}
