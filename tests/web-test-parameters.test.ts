import { describe, expect, it } from "vitest";
import type { AccountProfileSummary, Device } from "../src/shared/contracts.js";
import { resolveAccountProfileOptions } from "../src/web/App.js";

describe("测试账号参数", () => {
  it("按目标设备、环境、能力和有效期筛选跨平台登录画像", () => {
    const options = resolveAccountProfileOptions(
      [
        profile("harmony-login", "harmony", "qa", ["login"], "2099-01-01T00:00:00.000Z"),
        profile("android-login", "android", "qa", ["login"], "2099-01-01T00:00:00.000Z"),
        profile("harmony-commerce", "harmony", "qa", ["taobao-commerce-auth"], "2099-01-01T00:00:00.000Z"),
        profile("harmony-expired", "harmony", "qa", ["login"], "2020-01-01T00:00:00.000Z"),
        profile("harmony-empty-expiry", "harmony", "qa", ["login"], ""),
        profile("harmony-invalid-expiry", "harmony", "qa", ["login"], "invalid"),
        profile("harmony-staging", "harmony", "staging", ["login"], "2099-01-01T00:00:00.000Z"),
      ],
      [device("harmony:1", "harmony"), device("android:1", "android")],
      ["harmony:1"],
      "login",
      "qa",
    );

    expect(options.map(option => option.value)).toEqual([
      "current-session",
      "harmony-login:wechat",
      "android-login:wechat",
    ]);
  });

  it("未选择设备时只提供当前登录态，多平台设备共享 login 画像", () => {
    const profiles = [
      profile("harmony-login", "harmony", "qa", ["login"], "2099-01-01T00:00:00.000Z"),
      profile("android-login", "android", "qa", ["login"], "2099-01-01T00:00:00.000Z"),
    ];
    const devices = [device("harmony:1", "harmony"), device("android:1", "android")];

    expect(resolveAccountProfileOptions(profiles, devices, [], "login", "qa").map(option => option.value))
      .toEqual(["current-session"]);
    expect(resolveAccountProfileOptions(profiles, devices, ["harmony:1", "android:1"], "login", "qa").map(option => option.value))
      .toEqual(["current-session", "harmony-login:wechat", "android-login:wechat"]);
  });

  it("华为登录画像按设备厂商筛选", () => {
    const profiles = [profile("huawei-login", "android", "qa", ["login"], "2099-01-01T00:00:00.000Z", "huawei")];
    const redmi = { ...device("android:redmi", "android"), manufacturer: "Xiaomi", name: "Redmi Note 13" };
    const huawei = { ...device("android:huawei", "android"), manufacturer: "Huawei" };
    const harmony = device("harmony:1", "harmony");

    expect(resolveAccountProfileOptions(profiles, [redmi], [redmi.key], "login", "qa").map(option => option.value))
      .toEqual(["current-session"]);
    expect(resolveAccountProfileOptions(profiles, [huawei], [huawei.key], "login", "qa").map(option => option.value))
      .toEqual(["current-session", "huawei-login:huawei"]);
    expect(resolveAccountProfileOptions(profiles, [harmony], [harmony.key], "login", "qa").map(option => option.value))
      .toEqual(["current-session", "huawei-login:huawei"]);
  });
});

function profile(
  profileId: string,
  platform: AccountProfileSummary["platform"],
  environment: string,
  capabilities: string[],
  expiresAt: string,
  provider: AccountProfileSummary["providerEntries"][number]["provider"] = "wechat",
): AccountProfileSummary {
  return {
    schemaVersion: "mobile-test-console.account-profile.v2",
    profileId,
    accountLabel: profileId,
    platform,
    environment,
    version: 2,
    providerEntries: [{
      provider,
      accountUidMasked: "**1000",
      sourceDeviceKey: `${platform}:source`,
      capabilities,
      captureSummaries: [],
      recordedAt: "2026-01-01T00:00:00.000Z",
      validatedAt: "2026-01-01T00:00:00.000Z",
      expiresAt,
    }],
  };
}

function device(key: string, platform: Device["platform"]): Device {
  return {
    key,
    id: key.split(":")[1],
    name: key,
    platform,
    type: "physical",
    connectionState: "available",
    osVersion: "",
    detail: "",
    controlState: "ready",
    controlReason: "",
  };
}
