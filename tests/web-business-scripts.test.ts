import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import {
  BusinessScriptDeleteConfirmation,
  BusinessScriptInputBindingEditor,
} from "../src/web/BusinessScriptsWorkspace.js";
import { sortPublishedBusinessScripts, updateBusinessScriptInputBinding, updateBusinessStepAction } from "../src/web/business-script-editor.js";
import { deletePublishedBusinessScriptVersion } from "../src/web/api.js";

describe("发布业务脚本删除交互", () => {
  it("发布历史保留同一脚本的全部版本并按版本倒序排列", () => {
    const scripts = [1, 3, 2].map(version => ({ scriptId: "recorded-flow", version })) as Parameters<typeof sortPublishedBusinessScripts>[0];
    expect(sortPublishedBusinessScripts(scripts).map(script => script.version)).toEqual([3, 2, 1]);
  });

  it("确认框展示精确版本与套件引用清理范围", () => {
    const markup = renderToStaticMarkup(createElement(BusinessScriptDeleteConfirmation, {
      script: { scriptId: "recorded/flow", version: 3, name: "商品详情流程" },
      pending: false,
      onCancel: vi.fn(),
      onConfirm: vi.fn(),
    }));

    expect(markup).toContain('role="dialog"');
    expect(markup).toContain("recorded/flow@3");
    expect(markup).toContain("清理组合套件中的关联场景");
    expect(markup).toContain(">取消<");
    expect(markup).toContain(">删除<");
  });

  it("API 编码脚本 ID 并发送无请求体 DELETE", async () => {
    const response = {
      script: { scriptId: "recorded/flow", version: 3 },
      removedSuiteReferenceCount: 1,
      removedSuiteCount: 1,
    };
    const fetchMock = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>(async () => new Response(JSON.stringify(response), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(deletePublishedBusinessScriptVersion("recorded/flow", 3)).resolves.toMatchObject(response);
    expect(fetchMock).toHaveBeenCalledWith("/api/business-scripts/recorded%2Fflow/versions/3", expect.objectContaining({ method: "DELETE" }));
    const requestInit = fetchMock.mock.calls[0]?.[1];
    expect(requestInit?.body).toBeUndefined();
    expect(new Headers(requestInit?.headers).has("Content-Type")).toBe(false);
    vi.unstubAllGlobals();
  });
});

describe("业务脚本输入参数编辑", () => {
  const recordedTap = {
    stepId: "step-001",
    name: "搜索输入框",
    kind: "action" as const,
    actionType: "tap" as const,
    semanticTarget: { strategy: "point" as const, value: "", status: "resolved" as const },
    rawPoint: { x: 548, y: 191 },
    status: "resolved" as const,
  };

  it("录制点击改为输入步骤时创建可手工填写的固定值", () => {
    expect(updateBusinessStepAction(recordedTap, "input")).toEqual({
      actionType: "input",
      inputBinding: { strategy: "literal", value: "" },
    });
  });

  it("输入步骤展示策略与内容编辑器", () => {
    const markup = renderToStaticMarkup(createElement(BusinessScriptInputBindingEditor, {
      step: { ...recordedTap, actionType: "input", inputBinding: { strategy: "literal", value: "牙膏" } },
      index: 0,
      onChange: vi.fn(),
    }));

    expect(markup).toContain('aria-label="步骤 1 输入策略"');
    expect(markup).toContain('aria-label="步骤 1 输入内容"');
    expect(markup).toContain('value="牙膏"');
    expect(markup).toContain("填写回放时直接输入的内容");
  });

  it("敏感变量与运行时变量同步写入草稿声明", () => {
    const draft = {
      draftId: "draft-1",
      recordingId: "recording-1",
      name: "搜索",
      platformScope: ["harmony" as const],
      startPage: "pageSearchIndex",
      expectedFinalPage: "pageSearchIndex",
      variables: [],
      steps: [{ ...recordedTap, actionType: "input" as const, inputBinding: { strategy: "literal" as const, value: "" } }],
      assertions: [],
      scenarios: [],
      warnings: [],
      createdAt: "2026-07-31T00:00:00.000Z",
      updatedAt: "2026-07-31T00:00:00.000Z",
    };
    const secretDraft = updateBusinessScriptInputBinding(draft, 0, { strategy: "secretRef", value: "QA_SEARCH_TEXT" });
    expect(secretDraft.variables).toEqual([{ name: "QA_SEARCH_TEXT", strategy: "secretRef", sensitive: true }]);
    const runtimeDraft = updateBusinessScriptInputBinding(secretDraft, 0, { strategy: "runtimeResolver", value: "QA_SEARCH_TEXT" });
    expect(runtimeDraft.variables).toEqual([{ name: "QA_SEARCH_TEXT", strategy: "runtimeResolver", sensitive: false }]);
    expect(runtimeDraft.steps[0].inputBinding).toEqual({ strategy: "runtimeResolver", value: "QA_SEARCH_TEXT" });
  });

  it("变量名编辑与切回固定值时清理已失去引用的声明", () => {
    const draft = {
      draftId: "draft-1",
      recordingId: "recording-1",
      name: "搜索",
      platformScope: ["harmony" as const],
      startPage: "pageSearchIndex",
      expectedFinalPage: "pageSearchIndex",
      variables: [{ name: "QA", strategy: "secretRef" as const, sensitive: true }],
      steps: [{ ...recordedTap, actionType: "input" as const, inputBinding: { strategy: "secretRef" as const, value: "QA" } }],
      assertions: [],
      scenarios: [],
      warnings: [],
      createdAt: "2026-07-31T00:00:00.000Z",
      updatedAt: "2026-07-31T00:00:00.000Z",
    };
    const renamedDraft = updateBusinessScriptInputBinding(draft, 0, { strategy: "secretRef", value: "QA_SEARCH_TEXT" });
    expect(renamedDraft.variables).toEqual([{ name: "QA_SEARCH_TEXT", strategy: "secretRef", sensitive: true }]);
    const literalDraft = updateBusinessScriptInputBinding(renamedDraft, 0, { strategy: "literal", value: "牙膏" });
    expect(literalDraft.variables).toEqual([]);
  });

  it("保留仍被其他步骤引用的变量声明", () => {
    const sharedBinding = { strategy: "secretRef" as const, value: "QA_SEARCH_TEXT" };
    const draft = {
      draftId: "draft-1",
      recordingId: "recording-1",
      name: "搜索",
      platformScope: ["harmony" as const],
      startPage: "pageSearchIndex",
      expectedFinalPage: "pageSearchIndex",
      variables: [{ name: "QA_SEARCH_TEXT", strategy: "secretRef" as const, sensitive: true }],
      steps: [
        { ...recordedTap, actionType: "input" as const, inputBinding: sharedBinding },
        { ...recordedTap, stepId: "step-002", actionType: "input" as const, inputBinding: sharedBinding },
      ],
      assertions: [],
      scenarios: [],
      warnings: [],
      createdAt: "2026-07-31T00:00:00.000Z",
      updatedAt: "2026-07-31T00:00:00.000Z",
    };
    const literalDraft = updateBusinessScriptInputBinding(draft, 0, { strategy: "literal", value: "牙膏" });
    expect(literalDraft.variables).toEqual([{ name: "QA_SEARCH_TEXT", strategy: "secretRef", sensitive: true }]);
  });
});
