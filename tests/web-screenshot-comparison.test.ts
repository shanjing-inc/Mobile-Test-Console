import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { RunRow } from "../src/web/App.js";
import { ComparisonImagePane, ComparisonPairView, ComparisonSlider } from "../src/web/ScreenshotComparisonWorkspace.js";
import type { ScreenshotComparisonPair, TestTask } from "../src/shared/contracts.js";

describe("截图对比界面", () => {
  it("并排模式对缺失页显示仅一侧存在", () => {
    const markup = renderToStaticMarkup(createElement(ComparisonPairView, {
      pair: missingPair(),
      mode: "side-by-side",
      slider: 50,
      onSlider: vi.fn(),
    }));
    expect(markup).toContain("仅左侧存在");
    expect(markup).toContain("左侧");
    expect(markup).toContain("/api/tasks/task-a/artifacts/shot-a?projectId=project-a");
    expect(markup).not.toContain("对比滑杆");
  });

  it("两侧都有截图时渲染滑杆", () => {
    const markup = renderToStaticMarkup(createElement(ComparisonSlider, {
      left: "/left.jpg",
      right: "/right.jpg",
      label: "newCustomer / pages/index",
      value: 40,
      onChange: vi.fn(),
    }));
    expect(markup).toContain('aria-label="对比滑杆"');
    expect(markup).toContain("inset(0 60% 0 0)");
    expect(markup).toContain("/left.jpg");
    expect(markup).toContain("/right.jpg");
  });

  it("图片不可用时显示源截图已清理", () => {
    const markup = renderToStaticMarkup(createElement(ComparisonImagePane, {
      image: {
        projectId: "project-a",
        taskId: "task-a",
        artifactId: "shot-a",
        url: "/missing.jpg",
        available: false,
        missingReason: "源截图已清理",
      },
      fallback: "仅右侧存在",
      caption: "左侧",
    }));
    expect(markup).toContain("源截图已清理");
    expect(markup).not.toContain("<img");
  });

  it("终态运行提供加入对比入口", () => {
    const markup = renderToStaticMarkup(createElement(RunRow, {
      task: terminalTask(),
      focused: false,
      onFocus: vi.fn(),
      onStop: vi.fn(),
      onRetain: vi.fn(),
      onCompare: vi.fn(),
      onDelete: vi.fn(),
      pending: false,
    }));
    expect(markup).toContain("加入截图对比");
    expect(markup).toContain("compare-button");
  });
});

function missingPair(): ScreenshotComparisonPair {
  return {
    key: "case::newCustomer-pages_index.jpg",
    caseId: "case",
    label: "newCustomer-pages_index.jpg",
    title: "newCustomer / pages/index",
    presence: "left-only",
    left: {
      projectId: "project-a",
      taskId: "task-a",
      artifactId: "shot-a",
      url: "/api/tasks/task-a/artifacts/shot-a?projectId=project-a",
      available: true,
      missingReason: "",
    },
    right: null,
  };
}

function terminalTask(): TestTask {
  return {
    id: "task-one",
    runId: "run-one",
    projectId: "demo",
    testId: "pages",
    testLabel: "本地回放页面结构巡检",
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
    createdAt: "2026-09-03T05:00:00.000Z",
    startedAt: "2026-09-03T05:00:00.000Z",
    finishedAt: "2026-09-03T05:01:00.000Z",
    exitCode: 0,
    error: "",
    logs: [],
  };
}
