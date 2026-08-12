import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const packageJson = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const errors = [];

check(packageJson.private !== true, "package.json 仍标记为 private");
check(packageJson.license === "MIT", "package.json 缺少 MIT license");
check(packageJson.exports?.["./sdk"], "package.json 缺少 ./sdk 导出");
check(packageJson.exports?.["./schemas/mobile-test.config.v1.json"], "package.json 缺少项目配置 Schema 导出");
check(packageJson.exports?.["./schemas/test-analysis.run.v1.json"], "package.json 缺少 Result Bundle Schema 导出");

const listed = spawnSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z"], {
  cwd: root,
  encoding: "utf8",
});
if (listed.status !== 0) {
  errors.push(`无法读取发布文件列表: ${listed.stderr.trim()}`);
} else {
  const files = listed.stdout.split("\0").filter(Boolean);
  for (const file of files) {
    if (/(^|\/)(?:node_modules|\.mtc-state)(\/|$)|(^|\/)\.DS_Store$/.test(file)) {
      errors.push(`发布范围包含本地产物: ${file}`);
    }
  }
  for (const file of files.filter(isAuditedTextFile)) auditFile(file);
}

const platformSourceFiles = listFiles(path.join(root, "src"));
for (const file of platformSourceFiles) {
  const content = fs.readFileSync(file, "utf8");
  if (/fanli|huigou|返利/i.test(content)) {
    errors.push(`平台源码包含项目领域词: ${path.relative(root, file)}`);
  }
}

if (errors.length > 0) {
  for (const error of errors) console.error(`- ${error}`);
  process.exitCode = 1;
} else {
  console.log("开源发布检查通过");
}

function check(condition, message) {
  if (!condition) errors.push(message);
}

function isAuditedTextFile(file) {
  if (file === "scripts/check-open-source.mjs") return false;
  if (!/^(?:src|scripts|docs|examples|tests|\.github)\//.test(file)
    && !["README.md", "CONTRIBUTING.md", "SECURITY.md", "package.json"].includes(file)) return false;
  return /\.(?:[cm]?[jt]sx?|json|md|ya?ml|css|scss|html|txt)$/.test(file);
}

function auditFile(file) {
  const content = fs.readFileSync(path.join(root, file), "utf8");
  const checks = [
    { pattern: /\/Users\/(?!demo(?:\/|\b)|example(?:\/|\b)|user(?:\/|\b))[A-Za-z0-9._-]+\//, label: "macOS 本机绝对路径" },
    { pattern: /\/home\/(?!demo(?:\/|\b)|example(?:\/|\b)|user(?:\/|\b))[A-Za-z0-9._-]+\//, label: "Linux 本机绝对路径" },
    { pattern: /AKIA[0-9A-Z]{16}/, label: "AWS access key" },
    { pattern: /\bghp_[A-Za-z0-9]{20,}\b/, label: "GitHub token" },
    { pattern: /\bnpm_[A-Za-z0-9]{20,}\b/, label: "npm token" },
    { pattern: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/, label: "private key" },
  ];
  for (const item of checks) {
    if (item.pattern.test(content)) errors.push(`${file} 包含${item.label}`);
  }
}

function listFiles(directory) {
  const output = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) output.push(...listFiles(target));
    else if (/\.(?:[cm]?[jt]sx?)$/.test(entry.name)) output.push(target);
  }
  return output;
}
