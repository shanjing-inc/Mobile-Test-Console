import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { TaskResult } from "../src/shared/contracts.js";
import { ResultPanel } from "../src/web/App.js";

const failedResult: TaskResult = {
  schemaVersion: "mobile-test-console.task-result.v1",
  generatedAt: "2026-08-31T00:00:00.000Z",
  taskId: "task-one",
  runId: "run-one",
  total: 1,
  caseRunCount: 1,
  passed: 0,
  failed: 1,
  warnings: [],
  runs: [{
    runId: "run-one-case-one",
    caseRunId: "run-one-case-one",
    caseRunCount: 1,
    caseId: "case-one",
    targetPage: "pages/example/index",
    launchPage: "pages/example/index",
    scenario: "render",
    fixture: "demo-v1",
    platform: "android",
    device: "Pixel 8",
    status: "failed",
    errorSummary: "页面断言失败",
    requiredEvents: [],
    missingEvents: [],
    runtimeEventCount: 0,
    uiActionCount: 0,
    screenshots: [],
    apiCalls: [],
    evidenceFiles: [],
    failureLogExcerpt: "页面断言失败",
  }],
};

describe("结果批量重试入口", () => {
  it("App 保留按失败用例批量重试的入口", () => {
    const markup = renderToStaticMarkup(React.createElement(ResultPanel, {
      taskId: failedResult.taskId,
      tab: "overview",
      state: { taskId: failedResult.taskId, loading: false, result: failedResult, error: "" },
      pageRetryEnabled: false,
      onRetryTask: vi.fn(),
      onCopy: vi.fn(),
    }));

    expect(markup).toContain("重试全部失败用例");
    expect(markup).not.toContain("重试全部失败页面");
  });

  it("小程序按失败页面批量重试", () => {
    const markup = renderToStaticMarkup(React.createElement(ResultPanel, {
      taskId: failedResult.taskId,
      tab: "overview",
      state: { taskId: failedResult.taskId, loading: false, result: failedResult, error: "" },
      pageRetryEnabled: true,
      onRetryTask: vi.fn(),
      onCopy: vi.fn(),
    }));

    expect(markup).toContain("重试全部失败页面");
    expect(markup).not.toContain("重试全部失败用例");
  });
});
