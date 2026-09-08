import { createElement, isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { TaskResult } from "../src/shared/contracts.js";
import { LiveScreenshotResult, OverviewResult, ResultPanel } from "../src/web/App.js";
import { fetchSnapshot, fetchTaskResult, retryTask, taskArtifactUrl } from "../src/web/api.js";
import { diagnoseTaskResultRun, isFailedApiCall, suiteTestSummary, uniqueFailedTargetPages } from "../src/web/result-analysis.js";

describe("QA 结果分析界面", () => {
  it("活动任务等待 Runner 发布首张截图", () => {
    const markup = renderToStaticMarkup(createElement(LiveScreenshotResult, {
      task: { id: "task-live", artifacts: [] },
    }));

    expect(markup).toContain("等待首张截图");
    expect(markup).toContain("Runner 发布截图后会在这里实时展示");
    expect(markup).not.toContain("<img");
  });

  it("活动任务按任务附件 URL 展示 Runner 截图", () => {
    const markup = renderToStaticMarkup(createElement(LiveScreenshotResult, {
      task: {
        id: "task/live",
        artifacts: [
          {
            id: "artifact/one",
            uri: "project://demo/.test/results/live/one.jpg",
            role: "screenshot",
            label: "one.jpg",
            mimeType: "image/jpeg",
            createdAt: "2026-09-01T00:00:00.000Z",
          },
          {
            id: "artifact-two",
            uri: "project://demo/.test/results/live/two.png",
            role: "screenshot",
            label: "two.png",
            mimeType: "image/png",
            createdAt: "2026-09-01T00:00:01.000Z",
          },
        ],
      },
    }));

    expect(markup).toContain("/api/tasks/task%2Flive/artifacts/artifact%2Fone");
    expect(markup).toContain("/api/tasks/task%2Flive/artifacts/artifact-two");
    expect(markup).toContain('alt="one.jpg"');
    expect(markup).toContain('alt="two.png"');
    expect(markup).toContain("运行中截图");
  });

  it("概览展示用例、截图和接口统计", () => {
    const markup = renderResult("overview");

    expect(markup).toContain("用例");
    expect(markup).toContain("case-one");
    expect(markup).toContain("1 接口");
    expect(markup).toContain("1 截图");
    expect(markup).toContain('aria-label="查看 case-one 失败详情"');
    expect(markup).toContain('aria-expanded="false"');
    expect(markup).toContain("测试条目");
    expect(markup).toContain('aria-pressed="false"');
    expect(markup).toContain("失败");
    expect(markup).toContain("隐藏图片");
    expect(markup).toContain('aria-controls="analysis-run-list"');
    expect(markup).toContain('/api/tasks/task-one/artifacts/artifact-one');
    expect(markup).toContain('class="analysis-run-preview"');
  });

  it("概览支持隐藏图片并停止渲染图片节点", () => {
    const markup = renderToStaticMarkup(createElement(ResultPanel, {
      taskId: "task-one",
      tab: "overview",
      state: { taskId: "task-one", loading: false, result, error: "" },
      initialOverviewImagesVisible: false,
      onCopy: vi.fn(),
    }));

    expect(markup).toContain("显示图片");
    expect(markup).toContain('aria-expanded="false"');
    expect(markup).not.toContain("<img");
  });

  it("概览按测试条目展示各自的截图", () => {
    const resultWithMultipleRuns: TaskResult = {
      ...result,
      total: 2,
      caseRunCount: 2,
      runs: [
        result.runs[0],
        {
          ...result.runs[0],
          runId: "run-one-case-two",
          caseRunId: "run-one-case-two",
          caseId: "case-two",
          screenshots: [{ id: "artifact-two", label: "case-two.png", mimeType: "image/png", sizeBytes: 200 }],
        },
      ],
    };
    const markup = renderResult("overview", "", resultWithMultipleRuns);

    expect(markup).toContain('alt="case-one screen.png"');
    expect(markup).toContain('/api/tasks/task-one/artifacts/artifact-one');
    expect(markup).toContain('alt="case-two case-two.png"');
    expect(markup).toContain('/api/tasks/task-one/artifacts/artifact-two');
  });

  it("选中失败用例后展示参数、页面事件和定位分类", () => {
    const markup = renderResult("overview", "run-one-case-one:case-one");

    expect(markup).toContain("用例诊断");
    expect(markup).toContain("页面打开失败");
    expect(markup).toContain("画像 recorded-search");
    expect(markup).toContain('&quot;q&quot;: &quot;牙膏&quot;');
    expect(markup).toContain("缺失事件：page_ready");
    expect(markup).toContain("查看接口");
  });

  it("失败用例诊断区只保留完整错误复制入口", () => {
    const markup = renderToStaticMarkup(createElement(ResultPanel, {
      taskId: "task-one",
      tab: "overview",
      state: { taskId: "task-one", loading: false, result, error: "" },
      initialSelectedRunKey: "run-one-case-one:case-one",
      codexRepairEnabled: true,
      repairPending: false,
      onCreateRepair: vi.fn(),
      onTab: vi.fn(),
      onCopy: vi.fn(),
    }));
    expect(markup).toContain("复制错误");
    expect(markup).not.toContain("交给 Codex 修复");
  });

  it("结果提供整批失败与单模块重新测试入口", () => {
    const markup = renderToStaticMarkup(createElement(ResultPanel, {
      taskId: "task-one",
      tab: "overview",
      state: { taskId: "task-one", loading: false, result, error: "" },
      initialSelectedRunKey: "run-one-case-one:case-one",
      retryPending: true,
      onRetryTask: vi.fn(),
      onCopy: vi.fn(),
    }));

    expect(markup).toContain("重试全部失败页面");
    expect(markup).toContain("重新测试");
    expect(markup).toContain('aria-label="重新测试 case-one"');
  });

  it("通过结果保留单模块重新测试入口", () => {
    const passedResult: TaskResult = {
      ...result,
      passed: 1,
      failed: 0,
      runs: [{ ...result.runs[0], status: "passed", errorSummary: "" }],
    };
    const markup = renderToStaticMarkup(createElement(ResultPanel, {
      taskId: "task-one",
      tab: "overview",
      state: { taskId: "task-one", loading: false, result: passedResult, error: "" },
      onRetryTask: vi.fn(),
      onCopy: vi.fn(),
    }));

    expect(markup).not.toContain("重试全部失败页面");
    expect(markup).toContain("重新测试");
  });

  it("选中用例后接口页保留用例范围", () => {
    const markup = renderResult("api", "run-one-case-one:case-one");

    expect(markup).toContain("当前用例：");
    expect(markup).toContain("查看全部用例");
    expect(markup).toContain("DemoQuery");
  });

  it("失败结果按首次出现顺序生成唯一页面重试范围", () => {
    const duplicatePageResult: TaskResult = {
      ...result,
      total: 4,
      caseRunCount: 4,
      runs: [
        result.runs[0],
        { ...result.runs[0], runId: "run-one-case-two", caseRunId: "run-one-case-two", caseId: "case-two" },
        { ...result.runs[0], runId: "run-two-case-three", caseRunId: "run-two-case-three", caseId: "case-three", targetPage: "pages/second/index" },
        { ...result.runs[0], runId: "run-three-case-four", caseRunId: "run-three-case-four", caseId: "case-four", status: "passed", targetPage: "pages/passed/index" },
      ],
    };
    expect(uniqueFailedTargetPages(duplicatePageResult.runs)).toEqual([
      "pageDemo",
      "pages/second/index",
    ]);

    const onRetryTask = vi.fn();
    const overview = OverviewResult({
      taskId: "task-one",
      result: duplicatePageResult,
      filter: "all",
      onFilterChange: vi.fn(),
      selectedRunKey: "",
      onSelectRun: vi.fn(),
      imagesVisible: true,
      onToggleImages: vi.fn(),
      onCopy: vi.fn(),
      repairJobs: [],
      codexRepairEnabled: false,
      repairPending: false,
      retryPending: false,
      pageRetryEnabled: true,
      onRetryTask,
    });
    const retryButton = findElement(overview, element => (
      element.type === "button" && element.props["aria-label"] === "重试全部失败页面"
    ));
    expect(retryButton).toBeDefined();
    (retryButton?.props.onClick as (() => void) | undefined)?.();
    expect(onRetryTask).toHaveBeenCalledOnce();
    expect(onRetryTask).toHaveBeenCalledWith({
      targetPages: ["pageDemo", "pages/second/index"],
    });
  });

  it("历史结果缺少参数字段时明确提示未记录", () => {
    const historicalResult: TaskResult = {
      ...result,
      runs: [{ ...result.runs[0], routeParams: undefined, parameterProfileId: undefined }],
    };
    const markup = renderResult("overview", "run-one-case-one:case-one", historicalResult);

    expect(markup).toContain("历史结果未记录");
    expect(markup).toContain("下次测试会记录实际传入值");
  });

  it("截图通过任务范围内的附件 URL 展示", () => {
    const markup = renderResult("screenshots");

    expect(markup).toContain('/api/tasks/task-one/artifacts/artifact-one');
    expect(markup).toContain('alt="screen · pageDemo screen.png"');
  });

  it("接口详情展示格式化请求与响应并提供复制按钮", () => {
    const markup = renderResult("api");

    expect(markup).toContain("DemoQuery");
    expect(markup).toContain("请求参数");
    expect(markup).toContain("响应结果");
    expect(markup).toContain('&quot;page&quot;: 1');
    expect(markup).toContain('&quot;ok&quot;: true');
    expect(markup).toContain('aria-label="复制请求参数"');
  });

  it("证据视图展示事件、动作、文件和失败摘要", () => {
    const markup = renderResult("evidence");

    expect(markup).toContain("3 事件 · 2 动作 · 1 文件");
    expect(markup).toContain("runtime-events.jsonl");
    expect(markup).toContain("接口断言失败");
  });

  it("结果 API 编码任务 ID，附件 URL 编码两级标识", async () => {
    const fetchMock = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>(async () => new Response(JSON.stringify({ result }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(fetchTaskResult("task/one")).resolves.toMatchObject({ result: { runId: "run-one" } });
    expect(fetchMock).toHaveBeenCalledWith("/api/tasks/task%2Fone/result", expect.any(Object));
    await expect(fetchTaskResult("task/one", true)).resolves.toMatchObject({ result: { runId: "run-one" } });
    expect(fetchMock).toHaveBeenCalledWith("/api/tasks/task%2Fone/result?refresh=1", expect.any(Object));
    expect(taskArtifactUrl("task/one", "artifact/one")).toBe("/api/tasks/task%2Fone/artifacts/artifact%2Fone");
    vi.unstubAllGlobals();
  });

  it("重试 API 编码任务 ID 并提交失败用例范围", async () => {
    const fetchMock = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>(async () => new Response(JSON.stringify({ tasks: [] }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }));
    vi.stubGlobal("fetch", fetchMock);

    await retryTask("task/one", { caseRunIds: ["case-run-one"] });

    expect(fetchMock).toHaveBeenCalledWith("/api/tasks/task%2Fone/retry", expect.objectContaining({
      method: "POST",
      body: JSON.stringify({ caseRunIds: ["case-run-one"] }),
    }));
    vi.unstubAllGlobals();
  });

  it("手动刷新快照请求最新设备数据", async () => {
    const fetchMock = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>(async () => new Response(JSON.stringify({
      project: { id: "demo", name: "Demo", root: "/tmp" },
      devices: [],
      deviceErrors: {},
      tests: [],
      tasks: [],
      updatedAt: new Date().toISOString(),
    }), { status: 200, headers: { "Content-Type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);

    await fetchSnapshot(true);

    expect(fetchMock).toHaveBeenCalledWith("/api/snapshot?refresh=1", expect.any(Object));
    vi.unstubAllGlobals();
  });

  it("依据页面事件、参数提示和接口状态生成失败分类", () => {
    const run = result.runs[0];
    expect(diagnoseTaskResultRun(run).map(item => item.label)).toEqual(["参数问题", "页面打开失败"]);
    expect(isFailedApiCall({ result: "", status: 500 })).toBe(true);
    expect(isFailedApiCall({ result: "success", status: 200 })).toBe(false);
  });

  it("Suite 概览展示测试文件与测试点统计并隐藏页面专属信息", () => {
    const markup = renderToStaticMarkup(createElement(ResultPanel, {
      taskId: "task-suite",
      tab: "overview",
      state: { taskId: "task-suite", loading: false, result: suiteResult, error: "" },
      onRetryTask: vi.fn(),
      onCopy: vi.fn(),
    }));

    expect(markup).toContain("1 个套件 · 2 个测试点");
    expect(markup).toContain("config/graphql-endpoint · GraphQL 端点配置");
    expect(markup).toContain("tests/unit/config/graphql-endpoint.test.ts");
    expect(markup).toContain("2 个测试点 · 1 通过 · 1 失败 · 0 跳过 · 16ms");
    expect(markup).toContain("重新测试");
    expect(markup).not.toContain("? → ?");
    expect(markup).not.toContain("未记录设备");
    expect(markup).not.toContain("0 接口 · 0 截图 · 0 动作");
  });

  it("Suite 详情展示逐测试点状态、名称和耗时", () => {
    const markup = renderToStaticMarkup(createElement(ResultPanel, {
      taskId: "task-suite",
      tab: "overview",
      state: { taskId: "task-suite", loading: false, result: suiteResult, error: "" },
      initialSelectedRunKey: "run-suite:config/graphql-endpoint · GraphQL 端点配置",
      onRetryTask: vi.fn(),
      onCopy: vi.fn(),
    }));

    expect(markup).toContain("测试套件详情");
    expect(markup).toContain("接受 HTTPS 地址");
    expect(markup).toContain("拒绝非法协议");
    expect(markup).toContain("5ms");
    expect(markup).toContain("11ms");
    expect(markup).toContain("复制错误");
    expect(markup).not.toContain("页面打开");
    expect(markup).not.toContain("页面参数");
    expect(markup).not.toContain("查看接口");
  });

  it("Suite 统计与失败诊断使用单元测试语义", () => {
    expect(suiteTestSummary(suiteResult.runs[0])).toEqual({
      durationMs: 16,
      failed: 1,
      passed: 1,
      skipped: 0,
      tests: expect.any(Array),
      total: 2,
    });
    expect(diagnoseTaskResultRun(suiteResult.runs[0]).map(item => item.label)).toEqual([
      "单元测试失败",
    ]);
  });

  it("空结果保持通用结果统计语义", () => {
    const markup = renderToStaticMarkup(createElement(ResultPanel, {
      taskId: "task-empty",
      tab: "overview",
      state: {
        taskId: "task-empty",
        loading: false,
        result: { ...suiteResult, taskId: "task-empty", total: 0, caseRunCount: 0, passed: 0, failed: 0, runs: [] },
        error: "",
      },
      onRetryTask: vi.fn(),
      onCopy: vi.fn(),
    }));

    expect(markup).toContain("暂无分析结果");
    expect(markup).not.toContain("测试套件");
    expect(markup).not.toContain("测试点");
  });
});

function renderResult(tab: "overview" | "screenshots" | "api" | "evidence", initialSelectedRunKey = "", taskResult = result) {
  return renderToStaticMarkup(createElement(ResultPanel, {
    taskId: "task-one",
    tab,
    state: { taskId: "task-one", loading: false, result: taskResult, error: "" },
    initialSelectedRunKey,
    onTab: vi.fn(),
    onCopy: vi.fn(),
  }));
}

function findElement(
  node: ReactNode,
  predicate: (element: ReactElement<Record<string, unknown>>) => boolean,
): ReactElement<Record<string, unknown>> | undefined {
  if (Array.isArray(node)) {
    for (const child of node) {
      const match = findElement(child, predicate);
      if (match) return match;
    }
    return undefined;
  }
  if (!isValidElement<Record<string, unknown>>(node)) return undefined;
  if (predicate(node)) return node;
  return findElement(node.props.children as ReactNode, predicate);
}

const result: TaskResult = {
  schemaVersion: "mobile-test-console.task-result.v1",
  generatedAt: "2026-07-21T00:00:02.000Z",
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
    targetPage: "pageDemo",
    launchPage: "pageDemo",
    routeParams: { q: "牙膏" },
    parameterProfileId: "recorded-search",
    scenario: "render",
    fixture: "demo-v1",
    platform: "android",
    device: "Pixel 8",
    status: "failed",
    errorSummary: "路由参数校验后页面未就绪",
    requiredEvents: ["page_ready"],
    missingEvents: ["page_ready"],
    runtimeEventCount: 3,
    uiActionCount: 2,
    screenshots: [{
      id: "artifact-one",
      label: "screen.png",
      mimeType: "image/png",
      sizeBytes: 100,
    }],
    apiCalls: [{
      index: 1,
      ts: "2026-07-21T00:00:01.000Z",
      eventType: "api_call",
      page: "pageDemo",
      apiType: "graphql",
      method: "POST",
      url: "https://api.example.com/graphql",
      host: "api.example.com",
      path: "/graphql",
      endpoint: "member",
      operationName: "DemoQuery",
      status: 200,
      result: "success",
      durationMs: 20,
      request: { page: 1 },
      response: { ok: true },
      network: { dnsType: "system", dnsIps: "127.0.0.1", connectIp: "127.0.0.1", protocol: "h2" },
    }],
    evidenceFiles: ["case-one/runtime-events.jsonl"],
    failureLogExcerpt: "接口断言失败",
  }],
};

const suiteResult: TaskResult = {
  schemaVersion: "mobile-test-console.task-result.v1",
  generatedAt: "2026-08-24T06:00:00.000Z",
  taskId: "task-suite",
  runId: "run-suite",
  total: 1,
  caseRunCount: 1,
  passed: 0,
  failed: 1,
  warnings: [],
  runs: [{
    runId: "run-suite",
    caseRunId: "run-suite",
    caseRunCount: 1,
    caseId: "config/graphql-endpoint · GraphQL 端点配置",
    executionKind: "suite",
    targetPage: "tests/unit/config/graphql-endpoint.test.ts",
    launchPage: "",
    assertions: [
      {
        durationMs: 5,
        errorSummary: "",
        fullName: "GraphQL 端点配置 接受 HTTPS 地址",
        name: "接受 HTTPS 地址",
        status: "passed",
      },
      {
        durationMs: 11,
        errorSummary: "期望 https，实际 http",
        fullName: "GraphQL 端点配置 拒绝非法协议",
        name: "拒绝非法协议",
        status: "failed",
      },
    ],
    passBasis: [
      { kind: "unit", passed: true, description: "接受 HTTPS 地址" },
      { kind: "unit", passed: false, description: "拒绝非法协议" },
    ],
    scenario: "单元测试套件 · GraphQL 端点配置",
    fixture: "",
    platform: "wechat",
    device: "",
    status: "failed",
    errorSummary: "拒绝非法协议\n期望 https，实际 http",
    requiredEvents: [],
    missingEvents: [],
    runtimeEventCount: 0,
    uiActionCount: 0,
    apiCalls: [],
    screenshots: [],
    evidenceFiles: [],
    failureLogExcerpt: "",
  }],
};
