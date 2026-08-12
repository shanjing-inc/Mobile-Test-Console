/* eslint-disable @typescript-eslint/no-require-imports */
const fs = require("node:fs");
const path = require("node:path");

function buildResultBundle(projectRoot, request) {
  const resultPath = path.join(projectRoot, "qa", "artifacts", request.plan.runId, "raw-result.json");
  const raw = fs.existsSync(resultPath)
    ? JSON.parse(fs.readFileSync(resultPath, "utf8"))
    : {
        platform: request.plan.device.platform,
        device: request.plan.device.id,
        environment: request.plan.metadata?.parameters?.environment || "qa",
        startedAt: new Date().toISOString(),
        finishedAt: new Date().toISOString(),
      };
  const passed = request.result.status === "passed";
  return {
    schemaVersion: "test-analysis.run.v1",
    project: { id: request.plan.projectId, name: "Lynx App Starter" },
    target: { kind: "app", runtime: "lynx", platform: raw.platform },
    run: {
      runId: request.plan.runId,
      status: request.result.status,
      environment: raw.environment,
      startedAt: raw.startedAt,
      finishedAt: raw.finishedAt,
    },
    cases: [{
      caseRunId: `${request.plan.runId}-home-render`,
      caseId: "home-render",
      title: "Lynx 首页渲染",
      status: request.result.status,
      targetPage: "home.bundle",
      scenario: "打开首页并等待 page_ready",
      steps: [{
        stepId: "open-home",
        name: "打开 Lynx 首页",
        status: request.result.status,
      }],
      assertions: [{
        assertionId: "page-ready",
        kind: "runtimeEvent",
        passed,
        description: "收到 page_ready",
      }],
      evidenceRefs: [],
      errorSummary: passed ? "" : request.result.error || "页面未就绪",
      metadata: {
        platform: raw.platform,
        device: raw.device,
        requiredEvents: ["page_ready"],
        missingEvents: passed ? [] : ["page_ready"],
        runtimeEventCount: 2,
        uiActionCount: 0,
      },
    }],
    artifacts: [],
    warnings: fs.existsSync(resultPath) ? [] : ["测试命令未生成 raw-result.json"],
    provenance: {
      adapter: "lynx-app-starter",
      adapterVersion: "1",
      generatedAt: new Date().toISOString(),
    },
  };
}

module.exports = { buildResultBundle };
