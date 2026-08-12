import { describe, expect, it } from "vitest";
import type { Device, PageParameterObservation, PageParameterPage } from "../src/shared/contracts.js";
import { latestPageObservations, resolveObservationPageId } from "../src/web/page-parameter-observations.js";
import {
  pageNeedsParameters,
  pageUsesDynamicParameters,
  resolveSelectedPageTestDevice,
} from "../src/web/page-parameter-values.js";

const pages = [{
  pageId: "pageSearchIndex",
  label: "搜索页",
  bundle: "pageSearchIndex.bundle",
  source: "qa-manifest",
  fields: [],
  warnings: [],
  status: "missing",
  profiles: [],
}] as PageParameterPage[];

describe("页面参数录制工作区", () => {
  it("通过页面 ID 或 bundle 将观察记录定位到参数页面", () => {
    expect(resolveObservationPageId(pages, observation("pageSearchIndex.bundle", "pageSearchIndex.bundle", "2026-07-30T01:00:00.000Z", {}))).toBe("pageSearchIndex");
    expect(resolveObservationPageId(pages, observation("https://example.com", "", "2026-07-30T01:00:00.000Z", {}))).toBe("");
  });

  it("每个页面保留最新一份待确认参数", () => {
    const latest = latestPageObservations(pages, [
      observation("pageSearchIndex", "pageSearchIndex.bundle", "2026-07-30T01:00:00.000Z", { q: "旧关键词" }),
      observation("pageSearchIndex", "pageSearchIndex.bundle", "2026-07-30T01:01:00.000Z", { q: "牙膏", mall_type: "tb" }),
    ]);
    expect(latest.get("pageSearchIndex")?.values).toEqual({ q: "牙膏", mall_type: "tb" });
  });

  it("区分普通页面、声明参数页面和动态参数页面", () => {
    const base = pages[0];
    expect(pageNeedsParameters(base)).toBe(false);
    expect(pageNeedsParameters({ ...base, fields: [{
      key: "q",
      required: false,
      sensitive: false,
      strategies: ["literal"],
      description: "搜索关键词",
    }] })).toBe(true);
    expect(pageNeedsParameters({ ...base, dynamicParameters: true })).toBe(true);
    expect(pageUsesDynamicParameters({ ...base, dynamicParameters: true })).toBe(true);
    expect(pageUsesDynamicParameters({ ...base, warnings: ["供用户阅读的告警文案"] })).toBe(false);
  });

  it("当前页测试只使用用户明确选择的可用设备", () => {
    const devices = [device("android:one", "available"), device("ios:two", "unavailable")];
    expect(resolveSelectedPageTestDevice(devices, "")).toBeUndefined();
    expect(resolveSelectedPageTestDevice(devices, "ios:two")).toBeUndefined();
    expect(resolveSelectedPageTestDevice(devices, "android:one")?.key).toBe("android:one");
  });
});

function device(key: string, connectionState: Device["connectionState"]): Device {
  return {
    key,
    id: key,
    name: key,
    platform: key.startsWith("ios:") ? "ios" : "android",
    type: key.startsWith("ios:") ? "simulator" : "physical",
    connectionState,
    osVersion: "test",
    detail: "",
    controlState: connectionState === "available" ? "ready" : "unavailable",
    controlReason: "",
  };
}

function observation(
  pageId: string,
  bundle: string,
  capturedAt: string,
  values: Record<string, string>,
): PageParameterObservation {
  return { observationId: capturedAt, pageId, bundle, previousPageId: "", values, capturedAt };
}
