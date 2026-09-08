import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { TaskResultRun, TestTask } from "../src/shared/contracts.js";
import { ScreenshotReader } from "../src/web/ScreenshotReader.js";
import { liveScreenshotItems, resultScreenshotItems, survivingScreenshotKey } from "../src/web/screenshot-reader-items.js";
import { setApiProjectId } from "../src/web/api.js";

describe("screenshot reader data", () => {
  it("keeps artifact order and distinct run/artifact identities with matching labels", () => {
    const runs = [run("run:a", "case-b", ["first", "second"]), run("run", "a:case-b", ["first"])];
    const items = resultScreenshotItems("task", runs);
    expect(items.map(item => item.url)).toEqual([
      "/api/tasks/task/artifacts/first", "/api/tasks/task/artifacts/second", "/api/tasks/task/artifacts/first",
    ]);
    expect(new Set(items.map(item => item.key)).size).toBe(3);
    expect(resultScreenshotItems("task", runs.slice().reverse()).map(item => item.key)).toEqual([items[2].key, items[0].key, items[1].key]);
    expect(resultScreenshotItems("another-task", runs)[0].key).not.toBe(items[0].key);
  });

  it("uses recognized role/theme labels and retains raw labels with a safe fallback", () => {
    const source = run("run", "case", ["first", "second"]);
    source.targetPage = "";
    source.screenshots[0].label = "newCustomer-dark-pages_forum_index.png";
    source.screenshots[1].label = "arbitrary_capture_name.png";
    const items = resultScreenshotItems("task", [source]);
    expect(items[0].title).toBe("newCustomer / dark / pages/forum/index");
    expect(items[0].label).toBe("newCustomer-dark-pages_forum_index.png");
    expect(items[1].title).toBe("arbitrary_capture_name");
  });

  it("keeps project/task scoping and URI encoding for terminal and live images", () => {
    setApiProjectId("project/one");
    try {
      const terminal = resultScreenshotItems("task/one", [run("run", "case", ["artifact/one"])])[0];
      const live = liveScreenshotItems({ id: "task/one", artifacts: [artifact("artifact/one")] })[0];
      expect(terminal.url).toBe("/api/tasks/task%2Fone/artifacts/artifact%2Fone?projectId=project%2Fone");
      expect(live.url).toBe(terminal.url);
    } finally {
      setApiProjectId("");
    }
  });

  it("omits suite source paths and repeated routes from directory subtitles", () => {
    const source = run("run", "tests/e2e/specs/page-matrix.spec.ts 巡检程序", ["first"]);
    source.screenshots[0].label = "newCustomer-dark-pages_forum_index.png";
    source.targetPage = "pages/forum/index";
    const matching = resultScreenshotItems("task", [source])[0];
    expect(matching.subtitle).toBeUndefined();
    expect(matching.alt).toBe("newCustomer / dark / pages/forum/index newCustomer-dark-pages_forum_index.png");
    const markup = renderToStaticMarkup(createElement(ScreenshotReader, { items: [matching] }));
    const directory = markup.slice(markup.indexOf("<nav"), markup.indexOf("</nav>"));
    expect(directory).not.toContain("<small");
    expect(directory).not.toContain(source.caseId);
    expect(directory).toContain(`title="${matching.label}"`);
    source.targetPage = "pages/launch/index";
    expect(resultScreenshotItems("task", [source])[0].subtitle).toBe("pages/launch/index");
    source.targetPage = "tests/e2e/specs/wechatide-page-matrix.e2e.test.ts";
    const sourcePath = resultScreenshotItems("task", [source])[0];
    expect(sourcePath.subtitle).toBeUndefined();
    expect(sourcePath.title).toBe(matching.title);
    const sourceMarkup = renderToStaticMarkup(createElement(ScreenshotReader, { items: [sourcePath] }));
    expect(sourceMarkup).not.toContain(source.targetPage);
    source.screenshots[0].label = "capture.png";
    expect(resultScreenshotItems("task", [source])[0].title).toBe("capture");
    for (const page of ["pages/test/index", "pages/spec/index"]) {
      source.targetPage = page;
      expect(resultScreenshotItems("task", [source])[0].title).toBe(`capture · ${page}`);
    }
  });

  it("keeps live selection on append and falls back when its artifact disappears", () => {
    const initial = liveScreenshotItems({ id: "task", artifacts: [artifact("one"), artifact("two")] });
    const appended = liveScreenshotItems({ id: "task", artifacts: [artifact("one"), artifact("two"), artifact("three")] });
    expect(appended.slice(0, 2).map(item => item.key)).toEqual(initial.map(item => item.key));
    expect(survivingScreenshotKey(appended, initial[1].key)).toBe(initial[1].key);
    expect(survivingScreenshotKey(appended.filter(item => item.key !== initial[1].key), initial[1].key)).toBe(initial[0].key);
    expect(survivingScreenshotKey([], initial[1].key)).toBe("");
    expect(liveScreenshotItems({ id: "task" })).toEqual([]);
  });
});

describe("screenshot reader markup", () => {
  it("defaults to ordered reader pages, with first-page navigation and original access", () => {
    const items = resultScreenshotItems("task", [run("run", "case", ["one", "two"])]);
    const markup = renderToStaticMarkup(createElement(ScreenshotReader, { items }));
    expect(markup).toContain('aria-label="截图页面"');
    expect(markup).toContain('aria-current="page"');
    expect(markup).toMatch(/aria-label="上一张"[^>]*disabled=""/);
    expect(markup).toMatch(/aria-label="下一张"[^>]*>/);
    expect(markup).toContain('aria-label="当前截图" aria-live="polite">1 / 2');
    expect(markup).toContain('href="/api/tasks/task/artifacts/one"');
    expect(markup).toContain('loading="lazy"');
    expect(markup).toContain("专注阅读");
    expect(markup).toContain("正在加载截图");
    expect(markup).not.toContain('class="screenshot-reader-overview"');
    expect(markup.indexOf('artifacts/one')).toBeLessThan(markup.indexOf('artifacts/two'));
  });

  it("shows waiting and terminal empty states without image nodes", () => {
    const empty = renderToStaticMarkup(createElement(ScreenshotReader, { items: [] }));
    const waiting = renderToStaticMarkup(createElement(ScreenshotReader, { items: [], waiting: true }));
    expect(empty).toContain("没有截图");
    expect(waiting).toContain("等待首张截图");
    expect(empty + waiting).not.toContain("<img");
  });
});

function artifact(id: string): NonNullable<TestTask["artifacts"]>[number] {
  return { id, label: `${id}.png`, role: "screenshot", uri: `project://test/${id}.png`, mimeType: "image/png", createdAt: "2026-09-08T00:00:00Z" };
}

function run(runId: string, caseId: string, artifactIds: string[]): TaskResultRun {
  return {
    runId, caseRunId: runId, caseRunCount: 1, caseId, targetPage: "pages/index", launchPage: "pages/index",
    scenario: "render", fixture: "", platform: "mini-program", device: "simulator", status: "passed", errorSummary: "",
    requiredEvents: [], missingEvents: [], runtimeEventCount: 0, uiActionCount: 0, apiCalls: [],
    screenshots: artifactIds.map(id => ({ id, label: "page.png", mimeType: "image/png", sizeBytes: 10 })),
    evidenceFiles: [], failureLogExcerpt: "",
  };
}
