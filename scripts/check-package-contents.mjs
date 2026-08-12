import process from "node:process";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

const packed = spawnSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], {
  cwd: process.cwd(),
  encoding: "utf8",
});
if (packed.status !== 0) {
  console.error(packed.stderr.trim() || packed.stdout.trim());
  process.exit(1);
}

const reports = JSON.parse(packed.stdout);
const files = new Set((reports[0]?.files ?? []).map(item => item.path));
const required = [
  "LICENSE",
  "README.md",
  "dist/server/cli.js",
  "dist/sdk/index.js",
  "dist/sdk/index.d.ts",
  "dist/runner/index.js",
  "schemas/mobile-test.config.v1.schema.json",
  "schemas/test-analysis.run.v1.schema.json",
];
const errors = required.filter(file => !files.has(file)).map(file => `发布包缺少文件: ${file}`);
for (const file of files) {
  if (/^(?:src|tests|\.trellis|node_modules|\.mtc-state)(?:\/|$)|\/(?:node_modules|\.mtc-state)\/|(^|\/)\.DS_Store$/.test(file)) {
    errors.push(`发布包包含内部文件: ${file}`);
  }
}

try {
  const sdk = await import(pathToFileURL(path.resolve(process.cwd(), "dist/sdk/index.js")).href);
  if (sdk.RUNNER_PLUGIN_API_VERSION !== "mobile-test-console.runner-plugin.v1"
    || sdk.PROJECT_PROVIDER_PLUGIN_API_VERSION !== "mobile-test-console.project-provider-plugin.v1"
    || sdk.RESULT_BUNDLE_SCHEMA_VERSION !== "test-analysis.run.v1") {
    errors.push("构建后的 SDK 协议常量不完整");
  }
} catch (error) {
  errors.push(`构建后的 SDK 无法加载: ${error instanceof Error ? error.message : String(error)}`);
}

if (errors.length > 0) {
  for (const error of errors) console.error(`- ${error}`);
  process.exit(1);
}
console.log(`发布包内容检查通过，共 ${files.size} 个文件`);
