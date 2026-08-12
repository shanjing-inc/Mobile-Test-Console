/* eslint-disable @typescript-eslint/no-require-imports */
const fs = require("node:fs");
const path = require("node:path");
const { readArgs, requireArg } = require("./cli-args.cjs");
const { resolveAndroidTool, runCommand } = require("./command.cjs");

const args = readArgs(process.argv.slice(2));
const runId = requireArg(args, "run-id");
const platform = requireArg(args, "platform");
const device = requireArg(args, "device");
const environment = requireArg(args, "environment");
if (!/^[A-Za-z0-9._-]+$/.test(runId)) throw new Error(`runId 无效: ${runId}`);
if (platform !== "android") throw new Error(`当前示例仅支持 Android: ${platform}`);

const adb = resolveAndroidTool("adb");
const startedAt = new Date().toISOString();
const outputDir = path.join(process.cwd(), "qa", "artifacts", runId);
fs.mkdirSync(outputDir, { recursive: true });

runCommand(adb, ["-s", device, "logcat", "-c"]);
runCommand(adb, ["-s", device, "shell", "am", "force-stop", "com.shanjing.example"]);
runCommand(adb, [
  "-s", device,
  "shell", "am", "start", "-W",
  "-a", "android.intent.action.VIEW",
  "-c", "android.intent.category.BROWSABLE",
  "-d", "example://lynx/main",
  "com.shanjing.example",
]);

const ready = waitForPageReady(adb, device, 15000);
const screenshot = runCommand(adb, ["-s", device, "exec-out", "screencap", "-p"], {
  capture: true,
  encoding: null,
});
fs.writeFileSync(path.join(outputDir, "page.png"), screenshot.stdout);

const logcat = runCommand(adb, ["-s", device, "logcat", "-d", "-s", "MTCExample:I", "*:S"], {
  capture: true,
}).stdout;
fs.writeFileSync(path.join(outputDir, "runtime.log"), logcat);
fs.writeFileSync(path.join(outputDir, "raw-result.json"), `${JSON.stringify({
  runId,
  platform,
  device,
  environment,
  outcome: ready ? "passed" : "failed",
  startedAt,
  finishedAt: new Date().toISOString(),
  events: Array.from(logcat.matchAll(/MTC_EVENT\s+([a-z_]+)/g), match => match[1]),
}, null, 2)}\n`);

if (!ready) {
  process.stderr.write("[example] 15 秒内未收到 page_ready\n");
  process.exitCode = 7;
}

function waitForPageReady(executable, targetDevice, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = runCommand(executable, ["-s", targetDevice, "logcat", "-d", "-s", "MTCExample:I", "*:S"], {
      capture: true,
    });
    if (String(result.stdout).includes("MTC_EVENT page_ready")) return true;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 400);
  }
  return false;
}
