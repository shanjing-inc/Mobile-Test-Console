/* eslint-disable @typescript-eslint/no-require-imports */
const fs = require("node:fs");
const path = require("node:path");
const { readArgs, requireArg } = require("./cli-args.cjs");
const { resolveAndroidTool, resolveJavaHome, runCommand } = require("./command.cjs");

const projectRoot = path.resolve(__dirname, "..");
const args = readArgs(process.argv.slice(2));
const capabilities = requireArg(args, "capabilities").split(",").filter(Boolean);
const platform = requireArg(args, "platform");
const device = requireArg(args, "device");

if (platform !== "android") throw new Error(`当前示例仅支持 Android: ${platform}`);

if (capabilities.includes("app.build")) {
  if (!fs.existsSync(path.join(projectRoot, "node_modules"))) {
    throw new Error(`缺少前端依赖，请先在 ${projectRoot} 执行 pnpm install`);
  }
  runCommand("pnpm", ["run", "build:lynx"], { cwd: projectRoot });
  const bundle = findBundle(path.join(projectRoot, "dist"));
  const assetDir = path.join(projectRoot, "android", "app", "src", "main", "assets");
  fs.mkdirSync(assetDir, { recursive: true });
  fs.copyFileSync(bundle, path.join(assetDir, "main.bundle"));

  const javaHome = resolveJavaHome();
  runCommand("gradle", ["--no-daemon", ":app:assembleDebug"], {
    cwd: path.join(projectRoot, "android"),
    env: javaHome ? { ...process.env, JAVA_HOME: javaHome } : process.env,
  });
  process.stdout.write("[example] Android QA APK 构建完成\n");
}

if (capabilities.includes("app.install")) {
  const apk = path.join(projectRoot, "android", "app", "build", "outputs", "apk", "debug", "app-debug.apk");
  if (!fs.existsSync(apk)) throw new Error(`缺少 APK: ${apk}`);
  runCommand(resolveAndroidTool("adb"), ["-s", device, "install", "-r", apk]);
  process.stdout.write(`[example] 已安装 com.shanjing.example (${device})\n`);
}

if (capabilities.includes("account.preflight")) {
  process.stdout.write("[example] 单页示例无需登录账号\n");
}

if (capabilities.includes("page-parameters.resolve")) {
  process.stdout.write("[example] 页面入口 example://lynx/main\n");
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
