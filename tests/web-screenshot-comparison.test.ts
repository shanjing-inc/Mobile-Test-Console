import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { RunRow } from "../src/web/App.js";
import fs from "node:fs";
import path from "node:path";
import { ComparisonImagePane, ComparisonPairView, ComparisonSlider, ScreenshotComparisonWorkspace } from "../src/web/ScreenshotComparisonWorkspace.js";
import { activeComparisonKeyAtOffset, adjacentComparisonKey } from "../src/web/screenshot-comparison-scroll.js";
import type { ScreenshotComparisonPair, TestTask } from "../src/shared/contracts.js";

const styles = fs.readFileSync(path.resolve("src/web/styles.css"), "utf8");

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
    expect(markup.match(/loading="lazy"/g)).toHaveLength(2);
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

  it("根据连续滚动位置同步当前页面", () => {
    const positions = [
      { key: "new-customer", top: 0 },
      { key: "employee", top: 640 },
      { key: "manager", top: 1280 },
    ];
    expect(activeComparisonKeyAtOffset(positions, 120)).toBe("new-customer");
    expect(activeComparisonKeyAtOffset(positions, 760)).toBe("employee");
    expect(activeComparisonKeyAtOffset(positions, 1600)).toBe("manager");
  });

  it("按上下方向在页面间移动并停留在边界", () => {
    const keys = ["new-customer", "employee", "manager"];
    expect(adjacentComparisonKey(keys, "new-customer", 1)).toBe("employee");
    expect(adjacentComparisonKey(keys, "manager", -1)).toBe("employee");
    expect(adjacentComparisonKey(keys, "new-customer", -1)).toBe("new-customer");
    expect(adjacentComparisonKey(keys, "manager", 1)).toBe("manager");
    expect(adjacentComparisonKey(keys, "unknown", 1)).toBe("new-customer");
    expect(adjacentComparisonKey([], "", 1)).toBe("");
  });

  it("截图对比配置默认展开并提供可访问的折叠控制", () => {
    const markup = renderToStaticMarkup(createElement(ScreenshotComparisonWorkspace, {
      catalog: null,
      currentProjectId: "",
      onMessage: vi.fn(),
    }));
    expect(markup).toContain('aria-expanded="true"');
    expect(markup).toContain('aria-controls="screenshot-compare-settings"');
    expect(markup).toContain('id="screenshot-compare-settings"');
    expect(markup).toContain("折叠截图对比配置");
    expect(markup).not.toContain('id="screenshot-compare-settings" hidden');
  });

  it("对比区域自适应撑满可用高度且图片自适应容器尺寸", () => {
    expect(styles).toContain(".content.content-screenshot-compare");
    expect(styles).toContain(".screenshot-compare-result");
    expect(styles).toContain(".screenshot-compare-pair-stream");
    expect(styles).toContain("scroll-snap-type: y proximity");
    expect(styles).toContain(".screenshot-compare-pane img");
    expect(styles).toContain("object-fit: contain");
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
