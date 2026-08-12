/* eslint-disable @typescript-eslint/no-require-imports */
const fs = require("node:fs");
const path = require("node:path");
const { commandExists, runCommand, sleep } = require("./command.cjs");
const { createSuiteContext, parseEvents, writeRawResult } = require("./suite-support.cjs");

const context = createSuiteContext("ios");
const bundleId = "com.shanjing.example";

launchApp();
const runtimeLog = waitForRuntimeLog(15000);
fs.writeFileSync(path.join(context.outputDir, "runtime.log"), runtimeLog);
sleep(500);
captureScreenshot();
const events = parseEvents(runtimeLog);
writeRawResult(context, events, events.includes("page_ready"));

function launchApp() {
  if (context.deviceType === "simulator") {
    runCommand("xcrun", ["simctl", "terminate", context.device, bundleId], { allowFailure: true, capture: true });
    runCommand("xcrun", ["simctl", "launch", "--terminate-running-process", context.device, bundleId]);
    return;
  }
  runCommand("xcrun", [
    "devicectl", "device", "process", "launch",
    "--device", context.device,
    "--terminate-existing",
    bundleId,
  ], { timeout: 2 * 60 * 1000 });
}

function waitForRuntimeLog(timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let latest = "";
  while (Date.now() < deadline) {
    latest = context.deviceType === "simulator" ? readSimulatorLog() : readPhysicalLog();
    if (latest.includes("MTC_EVENT page_ready")) return latest;
    sleep(500);
  }
  return latest;
}

function readSimulatorLog() {
  const container = runCommand("xcrun", ["simctl", "get_app_container", context.device, bundleId, "data"], {
    allowFailure: true,
    capture: true,
  });
  const root = String(container.stdout || "").trim();
  const logPath = root && path.join(root, "Documents", "mtc-runtime.log");
  return logPath && fs.existsSync(logPath) ? fs.readFileSync(logPath, "utf8") : "";
}

function readPhysicalLog() {
  const target = path.join(context.outputDir, "runtime-device.log");
  fs.rmSync(target, { force: true });
  runCommand("xcrun", [
    "devicectl", "device", "copy", "from",
    "--device", context.device,
    "--domain-type", "appDataContainer",
    "--domain-identifier", bundleId,
    "--source", "Documents/mtc-runtime.log",
    "--destination", target,
  ], { allowFailure: true, capture: true, timeout: 30000 });
  return fs.existsSync(target) ? fs.readFileSync(target, "utf8") : "";
}

function captureScreenshot() {
  const png = path.join(context.outputDir, "page.png");
  if (context.deviceType === "simulator") {
    runCommand("xcrun", ["simctl", "io", context.device, "screenshot", png], { timeout: 60000 });
    return;
  }
  if (!commandExists("idevicescreenshot")) return;
  const tiff = path.join(context.outputDir, "page.tiff");
  const screenshot = runCommand("idevicescreenshot", ["-u", context.device, tiff], {
    allowFailure: true,
    capture: true,
    timeout: 60000,
  });
  if (screenshot.status === 0 && fs.existsSync(tiff) && commandExists("sips")) {
    runCommand("sips", ["-s", "format", "png", tiff, "--out", png], { capture: true });
    fs.rmSync(tiff, { force: true });
  }
}
