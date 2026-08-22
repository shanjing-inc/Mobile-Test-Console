#!/usr/bin/env node

import { parseArgs } from "node:util";
import { loadMtcConfig } from "./mtc-config.js";

const { values } = parseArgs({
  args: process.argv.slice(2),
  options: { config: { type: "string" }, optional: { type: "boolean", default: false } },
});

const config = await loadMtcConfig(values.config, { optional: values.optional });
process.stdout.write(`${JSON.stringify(config)}\n`);
