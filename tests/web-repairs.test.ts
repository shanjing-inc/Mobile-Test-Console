import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { RepairJob, RepairJobPreview } from "../src/shared/contracts.js";
import { RepairPanel, RepairPromptConfirmation } from "../src/web/App.js";
import { createRepairJob, fetchRepairJobPreview, openRepairTask, retryRepairTest } from "../src/web/api.js";

describe("Codex 修复交互", () => {
  it("失败任务展示人工触发入口", () => {
    const markup = renderToStaticMarkup(createElement(RepairPanel, {
      pending: false,
      onCreate: vi.fn(),
    }));

    expect(markup).toContain("交给 Codex 修复");
    expect(markup).toContain("原设备、账号和参数");
  });

  it("修复任务展示轮次、复测状态和重新复测入口", () => {
    const markup = renderToStaticMarkup(createElement(RepairPanel, {
      job,
      pending: false,
      onCreate: vi.fn(),
      onRetry: vi.fn(),
      onOpen: vi.fn(),
    }));

    expect(markup).toContain("第 2/2 轮");
    expect(markup).toContain("复测：失败");
    expect(markup).toContain("重新复测");
    expect(markup).toContain("打开修复任务");
  });

  it("代码修复失败后展示重新修复入口", () => {
    const markup = renderToStaticMarkup(createElement(RepairPanel, {
      job: { ...job, verificationStatus: "pending" },
      pending: false,
      onCreate: vi.fn(),
      onRetry: vi.fn(),
    }));

    expect(markup).toContain("重新修复");
    expect(markup).not.toContain("重新复测");
  });

  it("页面断言复测失败后同时支持重新修复和重新复测", () => {
    const markup = renderToStaticMarkup(createElement(RepairPanel, {
      job: { ...job, verificationFailureKind: "assertion" },
      pending: false,
      onCreate: vi.fn(),
      onRetry: vi.fn(),
    }));

    expect(markup).toContain("重新修复");
    expect(markup).toContain("重新复测");
  });

  it("复测前置条件失败时只提示重新复测", () => {
    const markup = renderToStaticMarkup(createElement(RepairPanel, {
      job: { ...job, status: "blocked", verificationFailureKind: "precondition" },
      pending: false,
      onCreate: vi.fn(),
      onRetry: vi.fn(),
    }));

    expect(markup).not.toContain("重新修复");
    expect(markup).toContain("重新复测");
  });

  it("创建修复前展示服务端生成的 Codex 提交内容", () => {
    const markup = renderToStaticMarkup(createElement(RepairPromptConfirmation, {
      preview,
      pending: false,
      onCancel: vi.fn(),
      onConfirm: vi.fn(),
    }));

    expect(markup).toContain("确认创建 Codex 修复任务");
    expect(markup).toContain("pageSearchIndex");
    expect(markup).toContain("pageGoodsDetail");
    expect(markup).toContain("errorSummary: 执行 Android Lynx Maestro 流程失败");
    expect(markup).toContain("确认并创建");
  });

  it("修复 API 使用编码标识并保持无请求体 POST", async () => {
    const fetchMock = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>(async () => new Response(JSON.stringify({ job }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }));
    vi.stubGlobal("fetch", fetchMock);

    await fetchRepairJobPreview("task/preview", "case/preview");
    await createRepairJob("task/one", "case/one");
    await retryRepairTest("repair/one");
    await openRepairTask("repair/one");
    await createRepairJob("task/two", "case/two", "/workspace/sample-app");
    expect(fetchMock).toHaveBeenNthCalledWith(1, "/api/tasks/task%2Fpreview/repairs/preview", expect.objectContaining({
      method: "POST",
      body: JSON.stringify({ caseRunId: "case/preview" }),
    }));
    expect(fetchMock).toHaveBeenNthCalledWith(2, "/api/tasks/task%2Fone/repairs", expect.objectContaining({
      method: "POST",
      body: JSON.stringify({ caseRunId: "case/one" }),
    }));
    expect(fetchMock).toHaveBeenNthCalledWith(3, "/api/repairs/repair%2Fone/retry-test", expect.objectContaining({ method: "POST" }));
    expect(fetchMock).toHaveBeenNthCalledWith(4, "/api/repairs/repair%2Fone/open-task", expect.objectContaining({ method: "POST" }));
    expect(fetchMock).toHaveBeenNthCalledWith(5, "/api/tasks/task%2Ftwo/repairs", expect.objectContaining({
      method: "POST",
      body: JSON.stringify({ caseRunId: "case/two", projectDirectory: "/workspace/sample-app" }),
    }));
    expect(new Headers(fetchMock.mock.calls[1]?.[1]?.headers).get("Content-Type")).toBe("application/json");
    expect(new Headers(fetchMock.mock.calls[2]?.[1]?.headers).has("Content-Type")).toBe(false);
    vi.unstubAllGlobals();
  });
});

const job = {
  repairJobId: "repair/one",
  projectId: "demo",
  taskId: "task/one",
  runId: "run-one",
  caseRunId: "case-one",
  testId: "suite",
  testLabel: "Lynx 页面套件",
  targetPage: "loginIndex",
  platform: "ios",
  status: "failed",
  verificationStatus: "failed",
  attempt: 2,
  maxAttempts: 2,
  createdAt: "2026-08-04T00:00:00.000Z",
  updatedAt: "2026-08-04T00:01:00.000Z",
  baselineCommit: "1234567890abcdef",
  dirtyFingerprint: "fingerprint",
  worktreePath: "/tmp/worktree",
  patchPath: "/tmp/worktree/repair.patch",
  diff: "diff",
  replayTaskId: "replay-one",
  codexThreadId: "thread-one",
  error: "第二轮复测失败",
  logs: [],
  events: [{ at: "2026-08-04T00:01:00.000Z", status: "failed", message: "第二轮复测失败" }],
  snapshot: {},
} as unknown as RepairJob;

const preview = {
  schemaVersion: "mobile-test-console.repair-preview.v1",
  taskId: "task/preview",
  caseRunId: "case/preview",
  targetPage: "pageGoodsDetail",
  launchPage: "pageSearchIndex",
  platform: "android",
  device: { id: "android-1", name: "Redmi K20", type: "physical", manufacturer: "Xiaomi" },
  parameters: { suite: "all-pages", environment: "qa" },
  failureContext: "errorSummary: 执行 Android Lynx Maestro 流程失败",
  prompt: "errorSummary: 执行 Android Lynx Maestro 流程失败",
} satisfies RepairJobPreview;
