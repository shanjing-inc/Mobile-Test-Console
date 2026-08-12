/* eslint-disable @typescript-eslint/no-require-imports */
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

function buildResultBundle(projectRoot, request) {
  const artifactRoot = path.join(projectRoot, "qa", "artifacts", request.plan.runId);
  const resultPath = path.join(artifactRoot, "raw-result.json");
  const raw = fs.existsSync(resultPath)
    ? JSON.parse(fs.readFileSync(resultPath, "utf8"))
    : {
        platform: request.plan.device.platform,
        device: request.plan.device.id,
        environment: request.plan.metadata?.parameters?.environment || "qa",
        startedAt: new Date().toISOString(),
        finishedAt: new Date().toISOString(),
        events: [],
      };
  const passed = request.result.status === "passed";
  const screenshotPath = path.join(artifactRoot, "page.png");
  const logPath = path.join(artifactRoot, "runtime.log");
  const artifacts = [
    buildArtifact(projectRoot, screenshotPath, "page-screenshot", "页面截图", "screenshot", "image/png"),
    buildArtifact(projectRoot, logPath, "runtime-log", "Lynx Runtime 日志", "log", "text/plain"),
  ].filter(Boolean);
  const evidenceRefs = artifacts.map(artifact => artifact.id);

  return {
    schemaVersion: "test-analysis.run.v1",
    project: { id: request.plan.projectId, name: "com.shanjing.example" },
    target: {
      kind: "app",
      runtime: "lynx",
      platform: raw.platform,
      appId: "com.shanjing.example",
      version: "0.1.0",
    },
    run: {
      runId: request.plan.runId,
      status: request.result.status,
      environment: raw.environment,
      startedAt: raw.startedAt,
      finishedAt: raw.finishedAt,
    },
    cases: [{
      caseRunId: `${request.plan.runId}-main-render`,
      caseId: "main-render",
      title: "单页 Lynx 渲染",
      status: request.result.status,
      targetPage: "main.bundle",
      scenario: "启动 com.shanjing.example 并等待 page_ready",
      steps: [{
        stepId: "open-main",
        name: "打开单页 Lynx App",
        status: request.result.status,
        evidenceRefs,
      }],
      assertions: [{
        assertionId: "page-ready",
        kind: "runtimeEvent",
        passed,
        description: "Android 日志收到 page_ready",
        evidenceRefs,
      }],
      evidenceRefs,
      errorSummary: passed ? "" : request.result.error || "Lynx 页面未就绪",
      metadata: {
        platform: raw.platform,
        device: raw.device,
        requiredEvents: ["page_opened", "page_ready"],
        missingEvents: passed ? [] : ["page_ready"],
        runtimeEventCount: Array.isArray(raw.events) ? raw.events.length : 0,
        uiActionCount: 0,
      },
    }],
    artifacts,
    warnings: fs.existsSync(resultPath) ? [] : ["测试命令未生成 raw-result.json"],
    provenance: {
      adapter: "shanjing-example",
      adapterVersion: "1",
      generatedAt: new Date().toISOString(),
    },
  };
}

function buildArtifact(projectRoot, filePath, id, label, role, mimeType) {
  if (!fs.existsSync(filePath)) return null;
  const content = fs.readFileSync(filePath);
  const relativePath = path.relative(projectRoot, filePath).split(path.sep).join("/");
  return {
    id,
    uri: `project://shanjing-example/${relativePath}`,
    label,
    role,
    mimeType,
    sizeBytes: content.length,
    sha256: crypto.createHash("sha256").update(content).digest("hex"),
  };
}

module.exports = { buildResultBundle };
