/* eslint-disable @typescript-eslint/no-require-imports */
const fs = require("node:fs");
const path = require("node:path");
const { readArgs, requireArg } = require("./cli-args.cjs");
const {
  resolveAndroidTool,
  resolveAndroidSdk,
  resolveHdc,
  resolveHvigorw,
  resolveJavaHome,
  resolveOhpm,
  runCommand,
} = require("./command.cjs");

const projectRoot = path.resolve(__dirname, "..");
const args = readArgs(process.argv.slice(2));
const capabilities = requireArg(args, "capabilities").split(",").filter(Boolean);
const platform = requireArg(args, "platform");
const device = requireArg(args, "device");
const deviceType = String(args["device-type"] || "physical").trim();

if (!new Set(["android", "ios", "harmony"]).has(platform)) throw new Error(`不支持的平台: ${platform}`);

if (capabilities.includes("app.build")) {
  const bundle = buildLynxBundle();
  buildPlatformApp(bundle);
}

if (capabilities.includes("app.install")) {
  installPlatformApp();
}

if (capabilities.includes("account.preflight")) {
  process.stdout.write("[example] 单页示例无需登录账号\n");
}

if (capabilities.includes("page-parameters.resolve")) {
  process.stdout.write("[example] 页面入口 example://lynx/main\n");
}

function buildLynxBundle() {
  if (!fs.existsSync(path.join(projectRoot, "node_modules"))) {
    throw new Error(`缺少前端依赖，请先在 ${projectRoot} 执行 pnpm install`);
  }
  runCommand("pnpm", ["run", "build:lynx"], { cwd: projectRoot });
  return findBundle(path.join(projectRoot, "dist"));
}

function buildPlatformApp(bundle) {
  if (platform === "android") return buildAndroid(bundle);
  if (platform === "ios") return buildIos(bundle);
  return buildHarmony(bundle);
}

function installPlatformApp() {
  if (platform === "android") return installAndroid();
  if (platform === "ios") return installIos();
  return installHarmony();
}

function buildAndroid(bundle) {
  copyBundle(bundle, path.join(projectRoot, "android", "app", "src", "main", "assets", "main.bundle"));
  const javaHome = resolveJavaHome();
  const androidSdk = resolveAndroidSdk();
  runCommand("gradle", ["--no-daemon", ":app:assembleDebug"], {
    cwd: path.join(projectRoot, "android"),
    env: {
      ...process.env,
      ...(javaHome ? { JAVA_HOME: javaHome } : {}),
      ...(androidSdk ? { ANDROID_HOME: androidSdk, ANDROID_SDK_ROOT: androidSdk } : {}),
    },
  });
  process.stdout.write("[example] Android QA APK 构建完成\n");
}

function installAndroid() {
  const apk = path.join(projectRoot, "android", "app", "build", "outputs", "apk", "debug", "app-debug.apk");
  requireFile(apk, "Android APK");
  runCommand(resolveAndroidTool("adb"), ["-s", device, "install", "-r", apk]);
  process.stdout.write(`[example] Android App 已安装 (${device})\n`);
}

function buildIos(bundle) {
  copyBundle(bundle, path.join(projectRoot, "ios", "Example", "Resources", "main.bundle"));
  const iosRoot = path.join(projectRoot, "ios");
  if (!fs.existsSync(path.join(iosRoot, "Pods", "Manifest.lock"))) {
    runCommand("pod", ["install"], { cwd: iosRoot });
  }
  const simulator = deviceType === "simulator" || device === "local-build";
  const derivedData = path.join(iosRoot, "build", "DerivedData");
  const buildArgs = [
    "-workspace", "Example.xcworkspace",
    "-scheme", "Example",
    "-configuration", "Debug",
    "-derivedDataPath", derivedData,
    "-sdk", simulator ? "iphonesimulator" : "iphoneos",
    "-destination", device === "local-build"
      ? "generic/platform=iOS Simulator"
      : `id=${device}`,
  ];
  if (simulator) {
    buildArgs.push("CODE_SIGNING_ALLOWED=NO");
    if (device === "local-build") {
      buildArgs.push("ONLY_ACTIVE_ARCH=YES", `ARCHS=${process.arch === "arm64" ? "arm64" : "x86_64"}`);
    }
  } else {
    const team = String(process.env.MTC_IOS_DEVELOPMENT_TEAM || "").trim();
    if (!team) throw new Error("iOS 真机构建需要设置 MTC_IOS_DEVELOPMENT_TEAM");
    buildArgs.push("-allowProvisioningUpdates", `DEVELOPMENT_TEAM=${team}`, "CODE_SIGN_STYLE=Automatic");
  }
  buildArgs.push("build");
  runCommand("xcodebuild", buildArgs, { cwd: iosRoot, timeout: 20 * 60 * 1000 });
  process.stdout.write(`[example] iOS QA App 构建完成 (${simulator ? "模拟器" : "真机"})\n`);
}

function installIos() {
  const simulator = deviceType === "simulator";
  const appPath = iosAppPath(simulator);
  requireFile(appPath, "iOS App");
  if (simulator) {
    runCommand("xcrun", ["simctl", "install", device, appPath]);
  } else {
    runCommand("xcrun", ["devicectl", "device", "install", "app", "--device", device, appPath], {
      timeout: 5 * 60 * 1000,
    });
  }
  process.stdout.write(`[example] iOS App 已安装 (${device})\n`);
}

function buildHarmony(bundle) {
  const harmonyRoot = path.join(projectRoot, "harmony");
  copyBundle(bundle, path.join(harmonyRoot, "entry", "src", "main", "resources", "rawfile", "main.bundle"));
  if (!fs.existsSync(path.join(harmonyRoot, "oh_modules"))) {
    runCommand(resolveOhpm(), ["install"], { cwd: harmonyRoot, timeout: 10 * 60 * 1000 });
  }
  runCommand(resolveHvigorw(), [
    "--mode", "project",
    "-p", "product=default",
    "-p", "buildMode=debug",
    "assembleHap",
    "--no-daemon",
    "--stacktrace",
  ], {
    cwd: harmonyRoot,
    env: harmonyBuildEnvironment(),
    timeout: 20 * 60 * 1000,
  });
  process.stdout.write("[example] HarmonyOS QA HAP 构建完成\n");
}

function installHarmony() {
  const hap = resolveHarmonyHap();
  requireFile(hap, "HarmonyOS HAP");
  if (!/signed/i.test(path.basename(hap)) && process.env.MTC_HARMONY_ALLOW_UNSIGNED_HAP !== "1") {
    throw new Error(`HarmonyOS 设备安装需要签名 HAP，请在 DevEco Studio 配置自动签名，或通过 MTC_HARMONY_HAP_PATH 指定签名产物: ${hap}`);
  }
  runCommand(resolveHdc(), ["-t", device, "install", "-r", hap], { timeout: 5 * 60 * 1000 });
  process.stdout.write(`[example] HarmonyOS App 已安装 (${device})\n`);
}

function copyBundle(source, target) {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.copyFileSync(source, target);
}

function iosAppPath(simulator) {
  return path.join(
    projectRoot,
    "ios",
    "build",
    "DerivedData",
    "Build",
    "Products",
    simulator ? "Debug-iphonesimulator" : "Debug-iphoneos",
    "Example.app",
  );
}

function resolveHarmonyHap() {
  const configured = String(process.env.MTC_HARMONY_HAP_PATH || "").trim();
  if (configured) return path.resolve(projectRoot, configured);
  const buildRoot = path.join(projectRoot, "harmony", "entry", "build");
  const candidates = findFiles(buildRoot, file => file.endsWith(".hap"));
  return candidates.sort((left, right) => Number(/signed/i.test(right)) - Number(/signed/i.test(left)))[0]
    || path.join(buildRoot, "default", "outputs", "default", "entry-default-signed.hap");
}

function findFiles(directory, predicate) {
  if (!fs.existsSync(directory)) return [];
  const files = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...findFiles(target, predicate));
    if (entry.isFile() && predicate(target)) files.push(target);
  }
  return files;
}

function harmonyBuildEnvironment() {
  return {
    ...process.env,
    ...(process.env.HARMONY_NODE_HOME ? { NODE_HOME: process.env.HARMONY_NODE_HOME } : {}),
    ...(process.env.DEVECO_SDK_HOME ? { DEVECO_SDK_HOME: process.env.DEVECO_SDK_HOME } : {}),
  };
}

function requireFile(filePath, label) {
  if (!fs.existsSync(filePath)) throw new Error(`缺少 ${label}: ${filePath}`);
}

function findBundle(directory) {
  if (!fs.existsSync(directory)) throw new Error(`Lynx 构建目录不存在: ${directory}`);
  const candidates = [];
  const visit = current => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const target = path.join(current, entry.name);
      if (entry.isDirectory()) visit(target);
      if (entry.isFile() && (entry.name === "main.bundle" || entry.name === "main.lynx.bundle")) {
        candidates.push(target);
      }
    }
  };
  visit(directory);
  if (candidates.length === 0) throw new Error(`Lynx 构建产物中缺少 main.bundle: ${directory}`);
  return candidates.sort((left, right) => left.length - right.length)[0];
}
