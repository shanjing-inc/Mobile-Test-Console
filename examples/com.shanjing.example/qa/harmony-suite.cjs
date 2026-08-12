/* eslint-disable @typescript-eslint/no-require-imports */
const fs = require("node:fs");
const path = require("node:path");
const { resolveHdc, runCommand, sleep } = require("./command.cjs");
const { createSuiteContext, parseEvents, writeRawResult } = require("./suite-support.cjs");

const context = createSuiteContext("harmony");
const bundleId = "com.shanjing.example";
const hdc = resolveHdc();

runCommand(hdc, ["-t", context.device, "shell", "hilog", "-r"], { allowFailure: true, capture: true });
runCommand(hdc, ["-t", context.device, "shell", "aa", "force-stop", bundleId], { allowFailure: true, capture: true });
runCommand(hdc, [
  "-t", context.device,
  "shell", "aa", "start",
  "-a", "EntryAbility",
  "-b", bundleId,
]);

const runtimeLog = waitForRuntimeLog(15000);
fs.writeFileSync(path.join(context.outputDir, "runtime.log"), runtimeLog);
captureScreenshot();
const events = parseEvents(runtimeLog);
writeRawResult(context, events, events.includes("page_ready"));

function waitForRuntimeLog(timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let latest = "";
  while (Date.now() < deadline) {
    const result = runCommand(hdc, ["-t", context.device, "shell", "hilog", "-x"], {
      allowFailure: true,
      capture: true,
      maxBuffer: 32 * 1024 * 1024,
    });
    latest = String(result.stdout || "");
    if (latest.includes("MTC_EVENT page_ready")) return latest;
    sleep(500);
  }
  return latest;
}

function captureScreenshot() {
  const remote = `/data/local/tmp/${context.runId}-page.jpeg`;
  const local = path.join(context.outputDir, "page.jpeg");
  const captured = runCommand(hdc, ["-t", context.device, "shell", "snapshot_display", "-f", remote], {
    allowFailure: true,
    capture: true,
    timeout: 30000,
  });
  if (captured.status !== 0) return;
  runCommand(hdc, ["-t", context.device, "file", "recv", remote, local], {
    allowFailure: true,
    capture: true,
    timeout: 60000,
  });
  runCommand(hdc, ["-t", context.device, "shell", "rm", "-f", remote], { allowFailure: true, capture: true });
}
