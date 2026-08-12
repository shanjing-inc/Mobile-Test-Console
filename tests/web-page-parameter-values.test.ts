import { describe, expect, it } from "vitest";
import type {
  PageParameterObservation,
  PageParameterPage,
  PageParameterProfile,
  PageScenarioTarget,
} from "../src/shared/contracts.js";
import {
  createPageActionDefaultAssertions,
  createPageParameterDraft,
  createObservationParameterDraft,
  isValidPageParameterKey,
  latestPageParameterProfile,
  hasUsablePageParameterValues,
  pageInteractionActions,
  pageInteractionTargets,
  pageParameterPresets,
  pageTargetActionPlatforms,
  pageTargetActions,
  resolvePageInteractionPlatform,
  resolveDefaultPageParameterProfile,
  resolveInitialPageParameterDraft,
  resolveDraftFields,
  replaceDraftFromProfile,
  shouldUseHistoricalPageParameterProfile,
  sortPageParameterProfiles,
  supplementDraftFromProfile,
} from "../src/web/page-parameter-values.js";

const page = {
  pageId: "loginIndexTelephone",
  label: "手机号登录",
  bundle: "loginIndexTelephone.bundle",
  source: "qa-manifest:login-multi-account-password",
  fields: [{
    key: "search_page_mode",
    required: true,
    sensitive: false,
    strategies: ["literal", "runtimeResolver"],
    description: "QA 清单字段",
  }],
  warnings: [],
  status: "recorded",
  profiles: [],
} as PageParameterPage;

describe("页面参数值来源", () => {
  it("动态参数键校验接受路由常用命名并拒绝空格或非法起始字符", () => {
    expect(isValidPageParameterKey("image_url")).toBe(true);
    expect(isValidPageParameterKey("route.params-1")).toBe(true);
    expect(isValidPageParameterKey(" image_url ")).toBe(true);
    expect(isValidPageParameterKey("image url")).toBe(false);
    expect(isValidPageParameterKey("1image")).toBe(false);
    expect(isValidPageParameterKey("")).toBe(false);
  });

  it("imageDialog 提供动态参数快捷预置，其他页面保持空预置", () => {
    const imageDialog = {
      ...page,
      pageId: "imageDialog",
      bundle: "imageDialog.bundle",
      dynamicParameters: true,
    } as PageParameterPage;
    expect(pageParameterPresets(imageDialog).map(field => field.key)).toEqual([
      "image_url",
      "image_width",
      "image_height",
      "route",
      "clear_clipboard_data",
      "search_keyword",
      "dialog_style",
    ]);
    expect(pageParameterPresets(page)).toEqual([]);
  });

  it("imageDialog 手动加入预置键后保留参数要求和取值策略", () => {
    const imageDialog = {
      ...page,
      pageId: "imageDialog",
      bundle: "imageDialog.bundle",
      dynamicParameters: true,
      fields: [],
    } as PageParameterPage;
    expect(resolveDraftFields(imageDialog, {
      image_url: { strategy: "literal", value: "https://example.com/image.png" },
    })).toContainEqual(expect.objectContaining({
      key: "image_url",
      required: true,
      strategies: ["literal", "runtimeResolver"],
    }));
  });

  it("页面初始草稿创建必填路由参数并标记代码建议来源", () => {
    const draft = createPageParameterDraft(page);

    expect(draft.values).toEqual({
      search_page_mode: { strategy: "literal", value: "" },
    });
    expect(draft.origins).toEqual({ search_page_mode: "suggested" });
  });

  it("本次捕获只包含 observation 实际上报的路由键", () => {
    const draft = createObservationParameterDraft(page, observation({ from: "mainTabs", previousTab: "" }));

    expect(draft.values).toEqual({
      from: { strategy: "literal", value: "mainTabs" },
      previousTab: { strategy: "literal", value: "" },
    });
    expect(draft.origins).toEqual({ from: "captured", previousTab: "captured" });
    expect(draft.values).not.toHaveProperty("search_page_mode");
  });

  it("历史画像只补充本次捕获缺少的键", () => {
    const draft = createObservationParameterDraft(page, observation({ from: "", previousTab: "home" }));
    const result = supplementDraftFromProfile(draft, profile({
      from: { strategy: "literal", value: "history" },
      search_page_mode: { strategy: "literal", value: "js" },
    }));

    expect(result.addedCount).toBe(1);
    expect(result.values.from.value).toBe("");
    expect(result.values.search_page_mode.value).toBe("js");
    expect(result.origins).toEqual({
      from: "captured",
      previousTab: "captured",
      search_page_mode: "history",
    });
  });

  it("草稿字段保留代码分析元数据并兼容动态捕获字段", () => {
    const fields = resolveDraftFields(page, {
      search_page_mode: { strategy: "literal", value: "js" },
      from: { strategy: "literal", value: "mainTabs" },
    });

    expect(fields[0]).toMatchObject({ key: "search_page_mode", required: true });
    expect(fields[1]).toMatchObject({
      key: "from",
      required: false,
      description: "录制观察值",
      strategies: ["literal", "secretRef", "runtimeResolver"],
    });
  });

  it("页面交互只保留 QA 语义动作并过滤截图步骤", () => {
    expect(pageInteractionTargets([
      { id: "search.submit", label: "搜索", actions: ["submit", "screenshot"] },
      { id: "page.screenshot", label: "截图", actions: ["screenshot"] },
    ])).toEqual([{ id: "search.submit", label: "搜索", actions: ["submit"] }]);
    expect(pageInteractionActions([
      { type: "screenshot", target: "", value: "before-submit" },
      { type: "submit", target: "search.submit" },
    ])).toEqual([{ type: "submit", target: "search.submit" }]);
  });

  it("页面交互按设备平台解析目标能力", () => {
    const targets: PageScenarioTarget[] = [{
      id: "search.submit",
      label: "搜索",
      actions: ["tap", "submit"],
      platforms: ["android", "harmony"],
      platformActions: { harmony: ["tap"] },
    }];

    expect(pageInteractionTargets(targets, "ios")).toEqual([]);
    expect(pageTargetActions(targets[0], "android")).toEqual(["tap", "submit"]);
    expect(pageTargetActions(targets[0], "harmony")).toEqual(["tap"]);
  });

  it("画像平台优先决定交互能力，全部平台草稿由测试设备辅助发现", () => {
    expect(resolvePageInteractionPlatform("ios", "harmony")).toBe("ios");
    expect(resolvePageInteractionPlatform("all", "harmony")).toBe("harmony");
    expect(resolvePageInteractionPlatform("all")).toBeUndefined();
  });

  it("动作平台矩阵始终依据原始目标能力计算", () => {
    const target: PageScenarioTarget = {
      id: "search.submit",
      label: "搜索",
      actions: ["tap"],
      platformActions: { harmony: ["submit"] },
    };

    expect(pageTargetActionPlatforms(target, "tap")).toEqual(["android", "ios"]);
    expect(pageTargetActionPlatforms(target, "submit")).toEqual(["harmony"]);
  });

  it("动作默认断言透传项目结果，未知业务结果保持待配置", () => {
    const navigationTarget: PageScenarioTarget = {
      id: "login.phone.entry",
      label: "手机号登录",
      kind: "navigation-card",
      actions: ["tap"],
      defaultAssertions: [{ type: "visible", target: "login-phone.input" }],
    };
    const environmentDependentTarget: PageScenarioTarget = {
      id: "login.third-party.wechat",
      label: "微信登录",
      actions: ["tap"],
    };

    expect(createPageActionDefaultAssertions(navigationTarget)).toEqual([
      { type: "visible", target: "login-phone.input" },
    ]);
    expect(createPageActionDefaultAssertions(environmentDependentTarget)).toEqual([]);
  });

  it("历史参数画像按录制时间倒序并取最近一组", () => {
    const older = profile({ q: { strategy: "literal", value: "old" } });
    const newer = {
      ...profile({ q: { strategy: "literal", value: "new" } }),
      profileId: "newer",
      recordedAt: "2026-07-30T01:00:00.000Z",
    };

    expect(sortPageParameterProfiles([older, newer]).map(item => item.profileId)).toEqual(["newer", "history"]);
    expect(latestPageParameterProfile([older, newer])?.profileId).toBe("newer");
  });

  it("当前参数为空时优先使用明确默认画像，否则使用最近历史画像", () => {
    const latest = {
      ...profile({ q: { strategy: "literal", value: "latest" } }),
      profileId: "latest",
      recordedAt: "2026-07-30T01:00:00.000Z",
    };
    const explicitDefault = {
      ...profile({ q: { strategy: "literal", value: "default" } }),
      profileId: "default-profile",
      isDefault: true,
      recordedAt: "2026-07-29T01:00:00.000Z",
    };

    expect(resolveDefaultPageParameterProfile([latest, explicitDefault])?.profileId).toBe("default-profile");
    expect(resolveDefaultPageParameterProfile([latest])?.profileId).toBe("latest");
    expect(hasUsablePageParameterValues({ q: { strategy: "literal", value: "" } })).toBe(false);
    expect(hasUsablePageParameterValues({ q: { strategy: "literal", value: "query" } })).toBe(true);
  });

  it("设备平台确定时精确平台画像优先于 all 画像", () => {
    const allDefault = {
      ...profile({ q: { strategy: "literal", value: "all-default" } }),
      profileId: "all-default",
      platform: "all" as const,
      isDefault: true,
      recordedAt: "2026-07-30T01:00:00.000Z",
    };
    const exactPlatform = {
      ...profile({ q: { strategy: "literal", value: "ios-specific" } }),
      profileId: "ios-specific",
      platform: "ios" as const,
      recordedAt: "2026-07-29T01:00:00.000Z",
    };

    expect(resolveDefaultPageParameterProfile([allDefault, exactPlatform], "ios")?.profileId).toBe("ios-specific");
    expect(resolveDefaultPageParameterProfile([allDefault, exactPlatform], "android")?.profileId).toBe("all-default");
  });

  it("页面切换按目标页面重新选择历史画像，无历史时保留空草稿", () => {
    const pageWithDefault = {
      ...page,
      profiles: [{
        ...profile({ search_page_mode: { strategy: "literal", value: "default-mode" } }),
        pageId: page.pageId,
        isDefault: true,
      }],
    } as PageParameterPage;
    const otherPage = {
      ...page,
      pageId: "other-page",
      profiles: [{
        ...profile({ search_page_mode: { strategy: "literal", value: "other-mode" } }),
        pageId: "other-page",
        profileId: "other-latest",
      }],
    } as PageParameterPage;

    expect(resolveInitialPageParameterDraft(pageWithDefault).profile?.pageId).toBe(page.pageId);
    expect(resolveInitialPageParameterDraft(otherPage).draft.values.search_page_mode.value).toBe("other-mode");
    expect(resolveInitialPageParameterDraft({ ...page, profiles: [] } as PageParameterPage).draft.values.search_page_mode.value).toBe("");
  });

  it("已有手动或捕获参数时不触发历史覆盖", () => {
    const manual = {
      values: { search_page_mode: { strategy: "literal" as const, value: "manual-mode" } },
      origins: { search_page_mode: "manual" as const },
    };
    const capturedEmpty = {
      values: { search_page_mode: { strategy: "literal" as const, value: "" } },
      origins: { search_page_mode: "captured" as const },
    };

    expect(shouldUseHistoricalPageParameterProfile(manual)).toBe(false);
    expect(shouldUseHistoricalPageParameterProfile(capturedEmpty)).toBe(false);
    expect(shouldUseHistoricalPageParameterProfile({
      values: { search_page_mode: { strategy: "literal", value: "history-mode" } },
      origins: { search_page_mode: "history" },
    })).toBe(true);
    expect(resolveInitialPageParameterDraft({ ...page, profiles: [profile({ search_page_mode: { strategy: "literal", value: "history" } })] } as PageParameterPage, manual).draft).toBe(manual);
  });

  it("显式应用历史画像时完整替换当前参数并标记来源", () => {
    const draft = replaceDraftFromProfile(profile({ q: { strategy: "literal", value: "history" } }));

    expect(draft.values).toEqual({ q: { strategy: "literal", value: "history" } });
    expect(draft.origins).toEqual({ q: "history" });
  });
});

function observation(values: Record<string, string>): PageParameterObservation {
  return {
    observationId: "observation-1",
    pageId: "loginIndexTelephone",
    bundle: "loginIndexTelephone.bundle",
    previousPageId: "home",
    values,
    capturedAt: "2026-07-30T01:00:00.000Z",
  };
}

function profile(values: PageParameterProfile["values"]): PageParameterProfile {
  return {
    profileId: "history",
    pageId: "loginIndexTelephone",
    scenario: "default",
    platform: "ios",
    environment: "qa",
    accountLabel: "",
    values,
    source: "recording",
    recordedAt: "2026-07-29T01:00:00.000Z",
    validatedAt: "2026-07-29T01:00:00.000Z",
    expiresAt: "",
    version: 1,
  };
}
