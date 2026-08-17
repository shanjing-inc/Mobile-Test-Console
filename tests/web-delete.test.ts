import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { ConsoleSnapshot, TestTask } from "../src/shared/contracts.js";
import {
  activeRetryRootTaskIds,
  clearDeletedFocusedTaskId,
  collapseRetryTasks,
  DeleteConfirmation,
  excludeDeletedTasks,
  latestRetryStatus,
  reconcileFocusedTaskId,
  RunRow,
} from "../src/web/App.js";
import { deleteTask, startTasks } from "../src/web/api.js";

describe("运行记录删除交互", () => {
  it("页面内确认框明确展示记录与本地文件删除范围", () => {
    const markup = renderToStaticMarkup(createElement(DeleteConfirmation, {
      task,
      pending: false,
      onCancel: vi.fn(),
      onConfirm: vi.fn(),
    }));

    expect(markup).toContain('role="dialog"');
    expect(markup).toContain("记录及本地测试文件");
    expect(markup).toContain(">取消<");
    expect(markup).toContain(">删除<");
  });

  it("删除后在焦点记录消失时关闭详情", () => {
    expect(clearDeletedFocusedTaskId(task.id, task.id)).toBe("");
    expect(clearDeletedFocusedTaskId("other-task", task.id)).toBe("other-task");
    expect(reconcileFocusedTaskId("", [task])).toBe("");
  });

  it("删除成功后立即移除记录并拦截旧轮询快照", () => {
    const snapshot = createSnapshot([task, { ...task, id: "task-two" }]);
    const deletedTaskIds = new Set([task.id]);

    expect(excludeDeletedTasks(snapshot, deletedTaskIds).tasks.map(item => item.id)).toEqual(["task-two"]);
    expect(excludeDeletedTasks(snapshot, deletedTaskIds).tasks.map(item => item.id)).toEqual(["task-two"]);
  });

  it("运行列表只展示来源任务", () => {
    const retry = { ...task, id: "task-retry", runId: "run-retry", createdAt: "2026-08-13T00:01:00.000Z", retryOf: { taskId: task.id, runId: task.runId, scope: "cases" as const, attempt: 1, caseRunIds: ["case-run"], caseIds: ["case-one"] } };
    expect(collapseRetryTasks([task, retry]).map(item => item.id)).toEqual([task.id]);
  });

  it("重试链存在中间 attempt 时继续展示来源任务", () => {
    const retry = { ...task, id: "task-retry", runId: "run-retry", createdAt: "2026-08-13T00:01:00.000Z", retryOf: { taskId: task.id, runId: task.runId, scope: "cases" as const, attempt: 1, caseRunIds: ["case-run"], caseIds: ["case-one"] } };
    const retryAgain = { ...retry, id: "task-retry-again", runId: "run-retry-again", createdAt: "2026-08-13T00:02:00.000Z", retryOf: { ...retry.retryOf, taskId: retry.id, runId: retry.runId, attempt: 2 } };
    expect(collapseRetryTasks([task, retry, retryAgain]).map(item => item.id)).toEqual([task.id]);
  });

  it("将活动重试归并到来源测试组", () => {
    const terminalRetry = { ...task, id: "task-retry", runId: "run-retry", createdAt: "2026-08-13T00:01:00.000Z", retryOf: { taskId: task.id, runId: task.runId, scope: "cases" as const, attempt: 1, caseRunIds: ["case-run"] } };
    const activeRetry = { ...terminalRetry, id: "task-retry-again", runId: "run-retry-again", status: "running" as const, retryOf: { ...terminalRetry.retryOf, taskId: terminalRetry.id, runId: terminalRetry.runId, attempt: 2 } };

    expect([...activeRetryRootTaskIds([task, terminalRetry, activeRetry])]).toEqual([task.id]);
    expect(activeRetryRootTaskIds([task, terminalRetry])).toEqual(new Set());
    expect(latestRetryStatus([task, terminalRetry, activeRetry], task.id)).toBe("running");
    expect(latestRetryStatus([task, terminalRetry, { ...activeRetry, status: "passed" }], task.id)).toBe("passed");
  });

  it("终态行显示删除按钮，活动行保留停止按钮", () => {
    const terminal = renderRow(task);
    const active = renderRow({ ...task, status: "running" });

    expect(terminal).toContain('class="delete-button"');
    expect(terminal).toContain('title="删除此运行记录"');
    expect(terminal).toContain(`aria-label="删除 ${task.device.name} 的运行记录"`);
    expect(terminal).not.toContain('class="stop-button"');
    expect(active).toContain('class="stop-button"');
    expect(active).not.toContain('class="delete-button"');
  });

  it("来源测试组重试期间显示提示并锁定删除", () => {
    const row = renderToStaticMarkup(createElement(RunRow, {
      task,
      focused: false,
      retrying: true,
      onFocus: vi.fn(),
      onStop: vi.fn(),
      onRetain: vi.fn(),
      onDelete: vi.fn(),
      pending: false,
    }));
    const confirmation = renderToStaticMarkup(createElement(DeleteConfirmation, {
      task,
      retrying: true,
      pending: false,
      onCancel: vi.fn(),
      onConfirm: vi.fn(),
    }));

    expect(row).toContain("正在重试");
    expect(row).toContain('title="正在重试，完成后可删除"');
    expect(row).toContain('title="正在重试，完成后可修改保留策略"');
    expect(row).toContain('class="delete-button" disabled=""');
    expect(confirmation).toContain("该测试组正在重试，完成后可删除");
    expect(confirmation).toContain('class="danger-button" disabled=""');
  });

  it("运行记录展示 iOS 模拟器和真机类型", () => {
    const simulator = renderRow({
      ...task,
      device: { ...task.device, name: "iPhone 14 Pro Max", platform: "ios", type: "simulator" },
    });
    const physical = renderRow({
      ...task,
      device: { ...task.device, name: "熊宝贝的iPhone", platform: "ios", type: "physical" },
    });

    expect(simulator).toContain("iPhone 14 Pro Max");
    expect(simulator).toContain("iOS · 模拟器");
    expect(physical).toContain("熊宝贝的iPhone");
    expect(physical).toContain("iOS · 真机");
  });

  it("API 使用编码后的任务 ID 发送 DELETE 请求", async () => {
    const fetchMock = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>(async () => new Response(JSON.stringify({ task }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(deleteTask("task/one")).resolves.toMatchObject({ task: { id: task.id } });
    expect(fetchMock).toHaveBeenCalledWith("/api/tasks/task%2Fone", expect.objectContaining({ method: "DELETE" }));
    const requestInit = fetchMock.mock.calls[0]?.[1];
    expect(requestInit?.body).toBeUndefined();
    expect(new Headers(requestInit?.headers).has("Content-Type")).toBe(false);
    vi.unstubAllGlobals();
  });

  it("带请求体的 API 请求声明 JSON 内容类型", async () => {
    const fetchMock = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>(async () => new Response(JSON.stringify({ tasks: [task] }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(startTasks({
      testId: task.testId,
      deviceKeys: [task.device.key],
      parameters: {},
    })).resolves.toMatchObject({ tasks: [{ id: task.id }] });
    const requestInit = fetchMock.mock.calls[0]?.[1];
    expect(requestInit?.body).toBe(JSON.stringify({
      testId: task.testId,
      deviceKeys: [task.device.key],
      parameters: {},
    }));
    expect(new Headers(requestInit?.headers).get("Content-Type")).toBe("application/json");
    vi.unstubAllGlobals();
  });
});

const task: TestTask = {
  id: "task-one",
  runId: "run-one",
  projectId: "demo",
  testId: "pass",
  testLabel: "冒烟测试",
  device: {
    key: "android:device-1",
    id: "device-1",
    name: "Pixel 8",
    platform: "android",
    type: "physical",
    connectionState: "available",
    controlState: "ready",
    controlReason: "",
    osVersion: "14",
    detail: "",
  },
  parameters: {},
  status: "passed",
  phase: "测试通过",
  createdAt: "2026-07-21T00:00:00.000Z",
  startedAt: "2026-07-21T00:00:00.000Z",
  finishedAt: "2026-07-21T00:00:01.000Z",
  exitCode: 0,
  error: "",
  logs: [],
};

function renderRow(value: TestTask): string {
  return renderToStaticMarkup(createElement(RunRow, {
    task: value,
    focused: false,
    onFocus: () => undefined,
    onStop: () => undefined,
    onDelete: () => undefined,
    pending: false,
  }));
}

function createSnapshot(tasks: TestTask[]): ConsoleSnapshot {
  return {
    project: { id: "demo", name: "Demo", root: "/tmp/demo" },
    testing: { environments: [], capabilities: [] },
    devices: [],
    deviceErrors: {},
    tests: [],
    tasks,
    updatedAt: "2026-07-21T00:00:00.000Z",
  };
}
