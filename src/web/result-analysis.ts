import type { ResultAnalysisAdapterManifest, TaskResultApiCall, TaskResultRun } from "../shared/contracts";

export function taskResultRunKey(run: Pick<TaskResultRun, "runId" | "caseId">): string {
  return `${run.runId}:${run.caseId}`;
}

export function isFailedApiCall(call: Pick<TaskResultApiCall, "result" | "status">): boolean {
  const result = String(call.result || "").toLowerCase();
  if (result && !["success", "passed", "ok"].includes(result)) return true;
  const status = Number(call.status);
  return Number.isFinite(status) && status >= 400;
}

export function diagnoseTaskResultRun(
  run: TaskResultRun,
  adapter?: Pick<ResultAnalysisAdapterManifest, "pageOpenedEvents">,
): Array<{ label: string; tone: "passed" | "failed" | "warning" }> {
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
