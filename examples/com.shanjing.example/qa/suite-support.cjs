/* eslint-disable @typescript-eslint/no-require-imports */
const fs = require("node:fs");
const path = require("node:path");
const { readArgs, requireArg } = require("./cli-args.cjs");

function createSuiteContext(expectedPlatform) {
  const args = readArgs(process.argv.slice(2));
  const runId = requireArg(args, "run-id");
  const platform = requireArg(args, "platform");
  const device = requireArg(args, "device");
  const environment = requireArg(args, "environment");
  const deviceType = String(args["device-type"] || "physical").trim();
  if (!/^[A-Za-z0-9._-]+$/.test(runId)) throw new Error(`runId 无效: ${runId}`);
  if (platform !== expectedPlatform) throw new Error(`平台参数应为 ${expectedPlatform}: ${platform}`);
  const outputDir = path.join(process.cwd(), "qa", "artifacts", runId);
  fs.mkdirSync(outputDir, { recursive: true });
  return { args, device, deviceType, environment, outputDir, platform, runId, startedAt: new Date().toISOString() };
}

function writeRawResult(context, events, ready) {
  fs.writeFileSync(path.join(context.outputDir, "raw-result.json"), `${JSON.stringify({
    runId: context.runId,
    platform: context.platform,
    device: context.device,
    environment: context.environment,
    outcome: ready ? "passed" : "failed",
    startedAt: context.startedAt,
    finishedAt: new Date().toISOString(),
    events,
  }, null, 2)}\n`);
  if (!ready) {
    process.stderr.write(`[example] 15 秒内未收到 page_ready (${context.platform}/${context.device})\n`);
    process.exitCode = 7;
  }
}

function parseEvents(output) {
  return Array.from(String(output || "").matchAll(/MTC_EVENT\s+([a-z_]+)/g), match => match[1]);
}

module.exports = { createSuiteContext, parseEvents, writeRawResult };
