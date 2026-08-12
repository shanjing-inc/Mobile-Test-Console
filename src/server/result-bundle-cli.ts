#!/usr/bin/env node

import { parseArgs } from "node:util";
import { loadProjectConfig } from "./config.js";
import { ResultBundleStore } from "./result-bundle-store.js";

const { values } = parseArgs({
  options: {
    config: { type: "string", short: "c" },
    file: { type: "string" },
    help: { type: "boolean", short: "h", default: false },
  },
});

if (values.help) {
  process.stdout.write("用法：mobile-test-console-result --config <project-config> --file <result-bundle.json>\n");
  process.exit(0);
}

const configPath = String(values.config || process.env.MTC_CONFIG || "").trim();
const filePath = String(values.file || "").trim();
if (!configPath || !filePath) {
  process.stderr.write("缺少 --config 或 --file\n");
  process.exit(2);
}

try {
  const config = await loadProjectConfig(configPath);
  const result = await new ResultBundleStore(config.stateDir).ingestFile(filePath);
  process.stdout.write(`${JSON.stringify(result)}\n`);
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
