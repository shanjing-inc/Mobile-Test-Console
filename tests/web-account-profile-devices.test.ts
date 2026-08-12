import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AccountProfileProviderEntrySummary, AccountProfileRecordingSummary, AccountProfileSourceResponse, Device } from "../src/shared/contracts.js";
import { accountProfileIdentityForProvider, activeAccountProfileRecordings, resolveAccountProfileIdentityChange, resolveAccountProfileRecordingDevices, resolveAccountProfileReplayDevices, resolveDeviceKey, resolveReplayProvider } from "../src/web/account-profile-devices.js";
import { fetchAccountProfileSource, replayAccountProfile } from "../src/web/api.js";
import { AccountProfileDeleteConfirmation, AccountProfileSourcePanel } from "../src/web/AccountProfilesWorkspace.js";

afterEach(() => vi.unstubAllGlobals());

describe("账号画像设备选择", () => {
  it("为每个授权场景提供独立的默认画像标识和账号标签", () => {
    expect(accountProfileIdentityForProvider("wechat")).toEqual({ profileId: "qa-account-wechat", accountLabel: "QA 微信账号" });
    expect(accountProfileIdentityForProvider("taobao-commerce")).toEqual({ profileId: "qa-account-taobao-commerce", accountLabel: "QA 淘宝授权账号" });
  });

  it("仅在使用默认值时跟随场景切换，手动值保持不变", () => {
    expect(resolveAccountProfileIdentityChange("wechat", "taobao", "qa-account-wechat", "QA 微信账号")).toEqual({
      profileId: "qa-account-taobao",
      accountLabel: "QA 淘宝账号",
    });
    expect(resolveAccountProfileIdentityChange("wechat", "taobao", "fixed-member", "会员账号")).toEqual({
      profileId: "fixed-member",
      accountLabel: "会员账号",
    });
  });

  it("删除确认框展示画像标识及关联授权数据范围", () => {
    const markup = renderToStaticMarkup(createElement(AccountProfileDeleteConfirmation, {
      profile: { profileId: "qa-account-wechat", accountLabel: "QA 微信账号" },
      pending: false,
      onCancel: vi.fn(),
      onConfirm: vi.fn(),
    }));

    expect(markup).toContain('role="dialog"');
    expect(markup).toContain("QA 微信账号");
    expect(markup).toContain("qa-account-wechat");
    expect(markup).toContain("历史录制和授权数据");
    expect(markup).toContain(">取消<");
    expect(markup).toContain(">删除<");
  });

  it("录制选择与同平台回放选择可以独立解析", () => {
    const android = createDevice("android:1", "android");
    const ios = createDevice("ios:1", "ios");

    expect(resolveDeviceKey([android, ios], ios.key)).toBe(ios.key);
    expect(resolveDeviceKey([android], ios.key)).toBe(android.key);
    expect(resolveDeviceKey([ios], android.key)).toBe(ios.key);
  });

  it("login 分支提供三端设备，平台授权分支只提供录制平台设备", () => {
    const android = createDevice("android:1", "android");
    const ios = createDevice("ios:1", "ios");
    const harmony = createDevice("harmony:1", "harmony");

    expect(resolveAccountProfileReplayDevices([android, ios, harmony], "ios", providerEntry("wechat")))
      .toEqual([android, ios, harmony]);
    expect(resolveAccountProfileReplayDevices([android, ios, harmony], "ios", {
      ...providerEntry("taobao-commerce"),
      capabilities: ["taobao-commerce-auth"],
    })).toEqual([ios]);
  });

  it("华为录制设备只包含 Huawei Android 与 Harmony", () => {
    const redmi = { ...createDevice("android:redmi", "android"), name: "Redmi Note 13", manufacturer: "Xiaomi" };
    const huawei = { ...createDevice("android:huawei", "android"), name: "HUAWEI Mate 60", manufacturer: "Huawei" };
    const harmony = createDevice("harmony:1", "harmony");

    expect(resolveAccountProfileRecordingDevices([redmi, huawei, harmony], "huawei"))
      .toEqual([huawei, harmony]);
    expect(resolveAccountProfileRecordingDevices([redmi, huawei, harmony], "wechat"))
      .toEqual([redmi, huawei, harmony]);
  });

  it("华为回放设备过滤 Redmi 并保留 Huawei Android 与 Harmony", () => {
    const redmi = { ...createDevice("android:redmi", "android"), manufacturer: "Xiaomi" };
    const huawei = { ...createDevice("android:huawei", "android"), manufacturer: "HUAWEI" };
    const harmony = createDevice("harmony:1", "harmony");

    expect(resolveAccountProfileReplayDevices([redmi, huawei, harmony], "android", providerEntry("huawei")))
      .toEqual([huawei, harmony]);
  });

  it("保留全部启动中和录制中的会话", () => {
    const recordings = [
      createRecording("recording-1", "starting"),
      createRecording("recording-2", "recording"),
      createRecording("recording-3", "stopped"),
      createRecording("recording-4", "failed"),
    ];

    expect(activeAccountProfileRecordings(recordings).map(item => item.recordingId)).toEqual([
      "recording-1",
      "recording-2",
    ]);
  });

  it("回放 Provider 优先保留显式选择，其次使用当前录制选择和首个分支", () => {
    const entries = [providerEntry("wechat"), providerEntry("qq")];

    expect(resolveReplayProvider(entries, "qq", "wechat")).toBe("qq");
    expect(resolveReplayProvider(entries, "", "qq")).toBe("qq");
    expect(resolveReplayProvider(entries, "", "huawei")).toBe("wechat");
  });

  it("回放 API 显式发送画像、Provider 与设备", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ replay: { status: "passed" } }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }));
    vi.stubGlobal("fetch", fetchMock);

    await replayAccountProfile("fixed/account", "qq", "ios:device/1");

    expect(fetchMock).toHaveBeenCalledWith("/api/account-profiles/fixed%2Faccount/replay", expect.objectContaining({
      method: "POST",
      body: JSON.stringify({ deviceKey: "ios:device/1", provider: "qq" }),
    }));
  });

  it("源数据 API 按画像和 Provider 分支读取", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ schemaVersion: "mobile-test-console.account-profile-source.v1" }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }));
    vi.stubGlobal("fetch", fetchMock);

    await fetchAccountProfileSource("fixed/account", "huawei");

    expect(fetchMock).toHaveBeenCalledWith("/api/account-profiles/fixed%2Faccount/source?provider=huawei", expect.any(Object));
  });

  it("源数据面板展示完整录制 JSON 和复制操作", () => {
    const source: AccountProfileSourceResponse = {
      schemaVersion: "mobile-test-console.account-profile-source.v1",
      profileId: "fixed-huawei",
      accountLabel: "华为测试账号",
      platform: "harmony",
      environment: "qa",
      version: 2,
      providerEntry: {
        provider: "huawei",
        accountUid: "member-4027",
        sourceDeviceKey: "harmony:1",
        capabilities: ["login"],
        captures: [{
          captureId: "capture-1",
          kind: "native",
          provider: "huawei",
          module: "LynxLoginModule",
          method: "huaweiAuth",
          params: {},
          result: { data: { authCode: "source-auth-code" } },
          capturedAt: "2026-07-31T10:00:00.000Z",
        }],
        recordedAt: "2026-07-31T10:00:00.000Z",
        validatedAt: "",
        expiresAt: "2026-08-31T10:00:00.000Z",
      },
    };
    const markup = renderToStaticMarkup(createElement(AccountProfileSourcePanel, { source, onCopy: vi.fn() }));

    expect(markup).toContain("完整录制 JSON");
    expect(markup).toContain("member-4027");
    expect(markup).toContain("source-auth-code");
    expect(markup).toContain('aria-label="复制账号源数据"');
  });
});

function createRecording(recordingId: string, status: AccountProfileRecordingSummary["status"]): AccountProfileRecordingSummary {
  return {
    recordingId,
    profileId: `profile-${recordingId}`,
    accountLabel: recordingId,
    provider: "wechat",
    deviceKey: `android:${recordingId}`,
    deviceId: recordingId,
    deviceType: "physical",
    platform: "android",
    environment: "qa",
    status,
    startedAt: "2026-07-30T10:00:00.000Z",
    stoppedAt: "",
    error: "",
    captureSummaries: [],
  };
}

function providerEntry(provider: AccountProfileProviderEntrySummary["provider"]): AccountProfileProviderEntrySummary {
  return {
    provider,
    accountUidMasked: "****1234",
    sourceDeviceKey: "android:1",
    capabilities: ["login"],
    captureSummaries: [],
    recordedAt: "2026-07-30T10:00:00.000Z",
    validatedAt: "",
    expiresAt: "2026-08-30T10:00:00.000Z",
  };
}

function createDevice(key: string, platform: Device["platform"]): Device {
  return {
    key,
    id: key,
    name: key,
    platform,
    type: platform === "ios" ? "simulator" : "physical",
    connectionState: "available",
    osVersion: "1",
    detail: "可用",
    controlState: "ready",
    controlReason: "",
  };
}
