import type { ResultAnalysisAdapterManifest, TaskResultApiCall, TaskResultRun } from "../shared/contracts";

export interface SuiteTestPoint {
  durationMs: number | null;
  errorSummary: string;
  fullName: string;
  name: string;
  status: string;
}

export interface SuiteTestSummary {
  durationMs: number;
  failed: number;
  passed: number;
  skipped: number;
  tests: SuiteTestPoint[];
  total: number;
}

export function taskResultRunKey(run: Pick<TaskResultRun, "runId" | "caseId">): string {
  return `${run.runId}:${run.caseId}`;
}

export function isFailedApiCall(call: Pick<TaskResultApiCall, "result" | "status">): boolean {
  const result = String(call.result || "").toLowerCase();
  if (result && !["success", "passed", "ok"].includes(result)) return true;
  const status = Number(call.status);
  return Number.isFinite(status) && status >= 400;
}

export function isSuiteResultRun(run: Pick<TaskResultRun, "executionKind">): boolean {
  return run.executionKind === "suite";
}

export function suiteTestSummary(run: Pick<TaskResultRun, "assertions">): SuiteTestSummary {
  const tests = (run.assertions ?? []).map((assertion, index) => normalizeSuiteTestPoint(assertion, index));
  return {
    durationMs: tests.reduce((total, test) => total + (test.durationMs ?? 0), 0),
    failed: tests.filter(test => test.status === "failed").length,
    passed: tests.filter(test => test.status === "passed").length,
    skipped: tests.filter(test => test.status === "skipped").length,
    tests,
    total: tests.length,
  };
}

export function diagnoseTaskResultRun(
  run: TaskResultRun,
  adapter?: Pick<ResultAnalysisAdapterManifest, "pageOpenedEvents">,
): Array<{ label: string; tone: "passed" | "failed" | "warning" }> {
  if (isSuiteResultRun(run)) {
    if (run.status === "passed") return [{ label: "测试通过", tone: "passed" }];
    if (run.status === "skipped") return [{ label: "测试已跳过", tone: "warning" }];
    if (run.status === "failed") return [{ label: "单元测试失败", tone: "failed" }];
    return [{ label: "测试状态异常", tone: "warning" }];
  }
  if (run.status === "passed") return [{ label: "测试通过", tone: "passed" }];
  const diagnostics: Array<{ label: string; tone: "passed" | "failed" | "warning" }> = [];
  const evidenceText = [
    run.errorSummary,
    run.failureLogExcerpt,
    ...run.missingEvents,
    ...(run.passBasis || []).filter(item => !item.passed).map(item => `${item.kind} ${item.description}`),
  ].join(" ");
  if (/参数画像|路由参数|参数校验|必填参数|必要参数|required parameter|routeparams|qarouteparams/i.test(evidenceText)) {
    diagnostics.push({ label: "参数问题", tone: "failed" });
  }
  const expectedPage = run.expectedFinalPage || run.targetPage;
  if (run.missingEvents.some(event => (adapter?.pageOpenedEvents ?? []).includes(event))
    || !run.actualFinalPage
    || Boolean(expectedPage && run.actualFinalPage !== expectedPage)) {
    diagnostics.push({ label: "页面打开失败", tone: "failed" });
  }
  if (run.apiCalls.some(isFailedApiCall)) diagnostics.push({ label: "接口失败", tone: "failed" });
  if ((run.passBasis || []).some(item => !item.passed && /action|assert|动作|断言|交互/i.test(`${item.kind} ${item.description}`))) {
    diagnostics.push({ label: "动作或断言失败", tone: "failed" });
  }
  if (diagnostics.length === 0) diagnostics.push({ label: "运行证据异常", tone: "warning" });
  return diagnostics;
}

function normalizeSuiteTestPoint(assertion: Record<string, unknown>, index: number): SuiteTestPoint {
  const durationMs = typeof assertion.durationMs === "number" && Number.isFinite(assertion.durationMs)
    ? Math.max(0, assertion.durationMs)
    : null;
  const name = stringValue(assertion.name) || `测试点 ${index + 1}`;
  return {
    durationMs,
    errorSummary: stringValue(assertion.errorSummary),
    fullName: stringValue(assertion.fullName) || name,
    name,
    status: normalizeSuiteTestStatus(assertion.status),
  };
}

function normalizeSuiteTestStatus(status: unknown): string {
  if (status === "pending" || status === "todo") return "skipped";
  return typeof status === "string" && status ? status : "unknown";
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}
