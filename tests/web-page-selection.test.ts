import { describe, expect, it } from "vitest";
import type { PageParameterPage, PageSelectionParameterDefinition } from "../src/shared/contracts.js";
import { matchesPagePreset, resolveSelectedPageIds } from "../src/web/PageSelectionField.js";

const parameter: PageSelectionParameterDefinition = {
  id: "pages",
  label: "页面范围",
  type: "page-selection",
  source: "page-parameters",
  defaultValue: "smoke",
  presets: [
    { value: "smoke", label: "Smoke", filter: { tags: ["smoke"] } },
    { value: "p0", label: "P0", filter: { priorities: ["P0"] } },
    { value: "all-pages", label: "全部", filter: { testScopes: ["user-facing"] } },
  ],
};

const pages: PageParameterPage[] = [
  createPage("pageHome", { priority: "P0", tags: ["smoke"], testScope: "user-facing" }),
  createPage("pageOrders", { priority: "P1", tags: [], testScope: "user-facing" }),
  createPage("internalDebug", { priority: "P0", tags: [], testScope: "internal" }),
];

describe("页面测试选择", () => {
  it("显式选择值只包含目录中当前可用的页面 ID", () => {
    expect([...resolveSelectedPageIds(parameter, "pageOrders,pageHome", pages)]).toEqual(["pageOrders", "pageHome"]);
    expect([...resolveSelectedPageIds(parameter, "", pages)]).toEqual([]);
  });

  it("根据项目提供的页面元数据应用预设", () => {
    expect([...resolveSelectedPageIds(parameter, "smoke", pages)]).toEqual(["pageHome"]);
    expect([...resolveSelectedPageIds(parameter, "p0", pages)]).toEqual(["pageHome", "internalDebug"]);
    expect([...resolveSelectedPageIds(parameter, "all-pages", pages)]).toEqual(["pageHome", "pageOrders"]);
  });

  it("保留目录中存在的显式页面选择", () => {
    expect([...resolveSelectedPageIds(parameter, "pageOrders,unknown,pageHome", pages)])
      .toEqual(["pageOrders", "pageHome"]);
    expect(matchesPagePreset(pages[0], { priorities: ["P0"], tags: ["smoke"] })).toBe(true);
    expect(matchesPagePreset(pages[1], { priorities: ["P0"] })).toBe(false);
  });
});

function createPage(
  pageId: string,
  metadata: Pick<PageParameterPage, "priority" | "tags" | "testScope">,
): PageParameterPage {
  return {
    pageId,
    label: pageId,
    bundle: `${pageId}.bundle`,
    source: "fixture",
    fields: [],
    warnings: [],
    status: "missing",
    profiles: [],
    ...metadata,
  };
}
