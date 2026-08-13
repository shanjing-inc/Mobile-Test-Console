/* eslint-disable @typescript-eslint/no-require-imports */
const fs = require("node:fs");
const path = require("node:path");
const { readArgs, requireArg } = require("./cli-args.cjs");

const args = readArgs(process.argv.slice(2));
const runId = requireArg(args, "run-id");
const platform = requireArg(args, "platform");
const device = requireArg(args, "device");
const environment = requireArg(args, "environment");
const outcome = requireArg(args, "outcome");
if (!/^[A-Za-z0-9._-]+$/.test(runId)) throw new Error(`runId 无效: ${runId}`);
if (!new Set(["passed", "failed"]).has(outcome)) throw new Error(`outcome 无效: ${outcome}`);
const retryPages = String(process.env.MTC_RETRY_TARGET_PAGES || "").split(",").map(item => item.trim()).filter(Boolean);
const retryCases = parseRetryCases();
const pages = retryCases.length > 0
  ? retryCases.map(item => item.targetPage).filter(Boolean)
  : retryPages.length > 0 ? retryPages : ["home.bundle"];

const startedAt = new Date().toISOString();
for (const page of pages) {
  const retryCase = retryCases.find(item => item.targetPage === page);
  const launchPage = retryCase?.launchPage || page;
  const routeParams = retryCase?.routeParams || {};
  const query = new URLSearchParams({ bundle: launchPage, ...routeParams }).toString();
  process.stdout.write(`[starter] 打开 Lynx 页面 demo://lynx?${query} (${platform}/${device})\n`);
  process.stdout.write("[starter] runtime event: page_opened\n");
  process.stdout.write(`[starter] runtime event: ${outcome === "passed" ? "page_ready" : "page_open_failed"}\n`);
}

const outputDir = path.join(process.cwd(), "qa", "artifacts", runId);
fs.mkdirSync(outputDir, { recursive: true });
fs.writeFileSync(path.join(outputDir, "raw-result.json"), JSON.stringify({
  runId,
  platform,
  device,
  environment,
  outcome,
  pages,
  startedAt,
  finishedAt: new Date().toISOString(),
}, null, 2));

process.exitCode = outcome === "passed" ? 0 : 7;

function parseRetryCases() {
  const raw = String(process.env.MTC_RETRY_CASES || "").trim();
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter(item => item && typeof item === "object") : [];
  } catch {
    return [];
  }
}
