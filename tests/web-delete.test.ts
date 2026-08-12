import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { ConsoleSnapshot, TestTask } from "../src/shared/contracts.js";
import {
  clearDeletedFocusedTaskId,
  DeleteConfirmation,
  excludeDeletedTasks,
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
    devices: [],
    deviceErrors: {},
    tests: [],
    tasks,
    updatedAt: "2026-07-21T00:00:00.000Z",
  };
}
