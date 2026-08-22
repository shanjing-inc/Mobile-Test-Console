#!/usr/bin/env node

import { parseArgs } from "node:util";
import { loadProjectConfig } from "./config.js";

const { values } = parseArgs({
  args: process.argv.slice(2),
  options: { config: { type: "string", short: "c" } },
});

if (!values.config) {
  process.stdout.write(`${JSON.stringify({ host: "127.0.0.1", port: 4310, webPort: 4311 })}\n`);
} else {
  const consoleOptions = (await loadProjectConfig(values.config)).console;
  process.stdout.write(`${JSON.stringify(consoleOptions || { host: "127.0.0.1", port: 4310, webPort: 4311 })}\n`);
}
