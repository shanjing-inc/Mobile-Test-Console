import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AccountProfileStore } from "../src/server/account-profile-store.js";
import { AccountProfileService } from "../src/server/account-profiles.js";
import type { LoadedProjectConfig } from "../src/server/config.js";
import type { AccountProfileCapture, AccountProfileProvider, AccountProfileRecording, Device } from "../src/shared/contracts.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true })));
});

describe("账号画像服务", () => {
  it("保存成功录制并只向公共快照返回脱敏摘要", async () => {
    const fixture = await createFixture();
    const started = await fixture.service.startRecording(fixture.device, {
      deviceKey: fixture.device.key,
      profileId: "fixed-wechat",
      accountLabel: "固定微信账号",
      provider: "wechat",
      environment: "qa",
    });
    expect(started.status).toBe("recording");

    const stopped = await fixture.service.stopRecording(started.recordingId);
    expect(stopped.profile?.profileId).toBe("fixed-wechat");
    expect(stopped.profile?.providerEntries[0].accountUid).toBe("member-12345678");
    expect(stopped.profile?.providerEntries[0].validatedAt).toBe("");

    const snapshot = await fixture.service.snapshot();
    const providerEntry = snapshot.profiles[0].providerEntries[0];
    expect(providerEntry.accountUidMasked).toBe("********5678");
    expect(providerEntry.captureSummaries).toHaveLength(2);
    expect(providerEntry.captureSummaries[1].resultKeys).toContain("data.oauthLogin.session_key");
    expect(providerEntry.captureSummaries[1].digest).toMatch(/^[a-f0-9]{12}$/);

    const publicPayload = JSON.stringify(snapshot);
    expect(publicPayload).not.toContain("native-secret-code");
    expect(publicPayload).not.toContain("session-secret-value");
    expect(publicPayload).not.toContain("access-token-secret");
    expect(publicPayload).not.toContain('"captures"');

    const statePath = path.join(fixture.stateDir, "account-profiles.json");
    const storedPayload = await fs.readFile(statePath, "utf8");
    expect(storedPayload).toContain("session-secret-value");
    expect((await fs.stat(statePath)).mode & 0o777).toBe(0o600);

    const source = await fixture.service.source("fixed-wechat", "wechat");
    expect(source.schemaVersion).toBe("mobile-test-console.account-profile-source.v1");
    expect(source.providerEntry.accountUid).toBe("member-12345678");
    expect(JSON.stringify(source.providerEntry.captures)).toContain("session-secret-value");
  });

  it("源数据读取校验画像与 Provider 分支", async () => {
    const fixture = await createFixture();
    const started = await fixture.service.startRecording(fixture.device, {
      deviceKey: fixture.device.key,
      profileId: "fixed-source",
      accountLabel: "源数据账号",
      provider: "wechat",
      environment: "qa",
    });
    await fixture.service.stopRecording(started.recordingId);

    await expect(fixture.service.source("missing", "wechat")).rejects.toMatchObject({ code: "ACCOUNT_PROFILE_UNKNOWN" });
    await expect(fixture.service.source("fixed-source", "qq")).rejects.toMatchObject({ code: "ACCOUNT_PROFILE_PROVIDER_UNKNOWN" });
  });

  it("回放只向 provider 传画像标识并在成功后更新验证时间", async () => {
    const fixture = await createFixture();
    const started = await fixture.service.startRecording(fixture.device, {
      deviceKey: fixture.device.key,
      profileId: "fixed-qq",
      accountLabel: "固定 QQ 账号",
      provider: "qq",
      environment: "qa",
    });
    await fixture.service.stopRecording(started.recordingId);
    const before = (await fixture.service.snapshot()).profiles[0].providerEntries[0].validatedAt;
    expect(before).toBe("");

    const replay = await fixture.service.replayProfile("fixed-qq", "qq", fixture.device);
    expect(replay.status).toBe("passed");
    expect(replay.output).toBe("账号画像回放完成");
    expect((await fixture.service.snapshot()).profiles[0].providerEntries[0].validatedAt).not.toBe("");

    const invocation = await fs.readFile(fixture.invocationPath, "utf8");
    expect(invocation).toContain("--profile-id\nfixed-qq");
    expect(invocation).toContain("--provider\nqq");
    expect(invocation).not.toContain("--profile-json");
    expect(invocation).not.toContain("session-secret-value");
  });

  it("login 画像允许跨平台回放并记录目标与来源平台", async () => {
    const fixture = await createFixture();
    const started = await fixture.service.startRecording(fixture.device, {
      deviceKey: fixture.device.key,
      profileId: "cross-platform-qq",
      accountLabel: "跨平台 QQ 账号",
      provider: "qq",
      environment: "qa",
    });
    await fixture.service.stopRecording(started.recordingId);
    const target: Device = { ...fixture.device, key: "harmony:1", id: "harmony-1", platform: "harmony" };

    await expect(fixture.service.replayProfile("cross-platform-qq", "qq", target)).resolves.toMatchObject({
      status: "passed",
      platform: "harmony",
      sourcePlatform: "android",
    });
    const invocation = await fs.readFile(fixture.invocationPath, "utf8");
    expect(invocation).toContain("--platform\nharmony");
  });

  it("华为录制在 Provider 调用前拒绝 Redmi", async () => {
    const fixture = await createFixture();
    const redmi: Device = { ...fixture.device, name: "Redmi Note 13", manufacturer: "Xiaomi" };

    await expect(fixture.service.startRecording(redmi, {
      deviceKey: redmi.key,
      profileId: "redmi-huawei",
      accountLabel: "Redmi 华为登录",
      provider: "huawei",
      environment: "qa",
    })).rejects.toMatchObject({ code: "ACCOUNT_PROFILE_DEVICE_MISMATCH", statusCode: 409 });
    await expect(fs.readFile(fixture.invocationPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    expect((await fixture.service.snapshot()).recordings).toEqual([]);
  });

  it("Huawei Android 与 Harmony 允许录制且 Provider 命令包含厂商", async () => {
    for (const platform of ["android", "harmony"] as const) {
      const fixture = await createFixture();
      const device: Device = {
        ...fixture.device,
        key: `${platform}:device-1`,
        id: `${platform}-device-1`,
        name: platform === "harmony" ? "Harmony Device" : "HUAWEI Mate 60",
        platform,
        manufacturer: "Huawei",
      };
      const started = await fixture.service.startRecording(device, {
        deviceKey: device.key,
        profileId: `huawei-${device.platform}`,
        accountLabel: `华为 ${device.platform}`,
        provider: "huawei",
        environment: "qa",
      });

      expect(started.status).toBe("recording");
      expect(await fs.readFile(fixture.invocationPath, "utf8")).toContain(`--device-manufacturer\nHuawei`);
    }
  });

  it("平台授权画像跨平台回放时保持严格门禁", async () => {
    const fixture = await createFixture();
    const started = await fixture.service.startRecording(fixture.device, {
      deviceKey: fixture.device.key,
      profileId: "android-commerce",
      accountLabel: "Android 淘宝授权",
      provider: "taobao-commerce",
      environment: "qa",
    });
    await fixture.service.stopRecording(started.recordingId);
    const target: Device = { ...fixture.device, key: "ios:1", id: "ios-1", platform: "ios" };

    await expect(fixture.service.replayProfile("android-commerce", "taobao-commerce", target)).rejects.toMatchObject({
      code: "ACCOUNT_PROFILE_PLATFORM_MISMATCH",
      statusCode: 409,
    });
  });

  it("同平台回放仍严格校验 Provider 对应能力", async () => {
    const fixture = await createFixture();
    const started = await fixture.service.startRecording(fixture.device, {
      deviceKey: fixture.device.key,
      profileId: "invalid-capability",
      accountLabel: "能力异常账号",
      provider: "wechat",
      environment: "qa",
    });
    await fixture.service.stopRecording(started.recordingId);
    const statePath = path.join(fixture.stateDir, "account-profiles.json");
    const state = JSON.parse(await fs.readFile(statePath, "utf8"));
    state.profiles[0].providerEntries[0].capabilities = ["taobao-commerce-auth"];
    await fs.writeFile(statePath, JSON.stringify(state));

    await expect(fixture.service.replayProfile("invalid-capability", "wechat", fixture.device)).rejects.toMatchObject({
      code: "ACCOUNT_PROFILE_CAPABILITY_MISMATCH",
      statusCode: 409,
    });
  });

  it("回放和任务启动都拒绝空或非法有效期", async () => {
    const fixture = await createFixture();
    const started = await fixture.service.startRecording(fixture.device, {
      deviceKey: fixture.device.key,
      profileId: "invalid-expiry",
      accountLabel: "有效期异常账号",
      provider: "wechat",
      environment: "qa",
    });
    await fixture.service.stopRecording(started.recordingId);
    const statePath = path.join(fixture.stateDir, "account-profiles.json");
    const state = JSON.parse(await fs.readFile(statePath, "utf8"));

    for (const expiresAt of ["", "invalid"]) {
      state.profiles[0].providerEntries[0].expiresAt = expiresAt;
      await fs.writeFile(statePath, JSON.stringify(state));
      await expect(fixture.service.replayProfile("invalid-expiry", "wechat", fixture.device)).rejects.toMatchObject({
        code: "ACCOUNT_PROFILE_EXPIRED",
        statusCode: 409,
      });
      await expect(fixture.service.validateTaskSelection(
        "invalid-expiry",
        "wechat",
        "login",
        "qa",
        [fixture.device],
      )).rejects.toMatchObject({
        code: "ACCOUNT_PROFILE_EXPIRED",
        statusCode: 409,
      });
    }
  });

  it("任务启动画像校验环境、所需能力和跨平台边界", async () => {
    const fixture = await createFixture();
    const started = await fixture.service.startRecording(fixture.device, {
      deviceKey: fixture.device.key,
      profileId: "task-selection",
      accountLabel: "任务选择账号",
      provider: "wechat",
      environment: "qa",
    });
    await fixture.service.stopRecording(started.recordingId);
    const harmony: Device = { ...fixture.device, key: "harmony:1", id: "harmony-1", platform: "harmony" };

    await expect(fixture.service.validateTaskSelection(
      "task-selection",
      "wechat",
      "login",
      "qa",
      [fixture.device, harmony],
    )).resolves.toBeUndefined();
    await expect(fixture.service.validateTaskSelection(
      "task-selection",
      "wechat",
      "login",
      "staging",
      [fixture.device],
    )).rejects.toMatchObject({ code: "ACCOUNT_PROFILE_SCOPE_MISMATCH", statusCode: 409 });
    await expect(fixture.service.validateTaskSelection(
      "task-selection",
      "wechat",
      "taobao-commerce-auth",
      "qa",
      [fixture.device],
    )).rejects.toMatchObject({ code: "ACCOUNT_PROFILE_CAPABILITY_MISMATCH", statusCode: 409 });
  });

  it("删除画像时同步清理关联历史录制和授权载荷", async () => {
    const fixture = await createFixture();
    const started = await fixture.service.startRecording(fixture.device, {
      deviceKey: fixture.device.key,
      profileId: "deletable-wechat",
      accountLabel: "待删除微信账号",
      provider: "wechat",
      environment: "qa",
    });
    await fixture.service.stopRecording(started.recordingId);

    await fixture.service.deleteProfile("deletable-wechat");

    const snapshot = await fixture.service.snapshot();
    expect(snapshot.profiles).toEqual([]);
    expect(snapshot.recordings).toEqual([]);
    const stored = JSON.parse(await fs.readFile(path.join(fixture.stateDir, "account-profiles.json"), "utf8"));
    expect(stored.profiles).toEqual([]);
    expect(stored.recordings).toEqual([]);
    expect(JSON.stringify(stored)).not.toContain("session-secret-value");
  });

  it("画像存在活动录制时拒绝删除并保留画像数据", async () => {
    const fixture = await createFixture();
    const initial = await fixture.service.startRecording(fixture.device, {
      deviceKey: fixture.device.key,
      profileId: "active-wechat",
      accountLabel: "活动微信账号",
      provider: "wechat",
      environment: "qa",
    });
    await fixture.service.stopRecording(initial.recordingId);
    await fixture.service.startRecording(fixture.device, {
      deviceKey: fixture.device.key,
      profileId: "active-wechat",
      accountLabel: "活动微信账号",
      provider: "wechat",
      environment: "qa",
    });

    await expect(fixture.service.deleteProfile("active-wechat")).rejects.toMatchObject({
      code: "ACCOUNT_PROFILE_RECORDING_ACTIVE",
      statusCode: 409,
    });
    expect((await fixture.service.snapshot()).profiles).toHaveLength(1);
  });

  it("同一画像聚合多个 Provider 并按 Provider 覆盖对应分支", async () => {
    const fixture = await createFixture();
    for (const provider of ["wechat", "qq", "wechat"] as const) {
      const started = await fixture.service.startRecording(fixture.device, {
        deviceKey: fixture.device.key,
        profileId: "fixed-multi",
        accountLabel: "聚合账号",
        provider,
        environment: "qa",
      });
      await fixture.service.stopRecording(started.recordingId);
    }

    const snapshot = await fixture.service.snapshot();
    expect(snapshot.profiles).toHaveLength(1);
    expect(snapshot.profiles[0].providerEntries.map(item => item.provider)).toEqual(["qq", "wechat"]);
    expect(snapshot.profiles[0].providerEntries.every(item => item.captureSummaries.every(capture => capture.provider === item.provider))).toBe(true);
  });

  it("拒绝把其他 Provider 捕获合并到当前分支", async () => {
    const fixture = await createFixture("provider-mismatch");
    const started = await fixture.service.startRecording(fixture.device, {
      deviceKey: fixture.device.key,
      profileId: "fixed-taobao",
      accountLabel: "固定淘宝账号",
      provider: "taobao",
      environment: "qa",
    });
    await expect(fixture.service.stopRecording(started.recordingId)).rejects.toMatchObject({
      code: "ACCOUNT_PROFILE_PROVIDER_INVALID",
    });
  });

  it.each([
    "invalid-status",
    "captures-not-array",
    "invalid-provider",
    "invalid-kind",
    "missing-location",
    "invalid-objects",
    "invalid-time",
  ])("畸形录制响应 %s 统一返回协议错误", async mode => {
    const fixture = await createFixture(mode);
    const started = await fixture.service.startRecording(fixture.device, {
      deviceKey: fixture.device.key,
      profileId: `invalid-${mode}`,
      accountLabel: "畸形响应账号",
      provider: "wechat",
      environment: "qa",
    });

    await expect(fixture.service.stopRecording(started.recordingId)).rejects.toMatchObject({
      code: "ACCOUNT_PROFILE_PROVIDER_INVALID",
    });
  });

  it("畸形回放响应统一返回协议错误", async () => {
    const fixture = await createFixture("replay-invalid");
    const started = await fixture.service.startRecording(fixture.device, {
      deviceKey: fixture.device.key,
      profileId: "invalid-replay",
      accountLabel: "畸形回放账号",
      provider: "wechat",
      environment: "qa",
    });
    await fixture.service.stopRecording(started.recordingId);

    await expect(fixture.service.replayProfile("invalid-replay", "wechat", fixture.device)).rejects.toMatchObject({
      code: "ACCOUNT_PROFILE_PROVIDER_INVALID",
    });
  });

  it("读取旧版单 Provider JSON 并按显式 Provider 回放", async () => {
    const fixture = await createFixture();
    await fs.mkdir(fixture.stateDir, { recursive: true });
    await fs.writeFile(path.join(fixture.stateDir, "account-profiles.json"), JSON.stringify({
      schemaVersion: "mobile-test-console.account-profile-state.v1",
      recordings: [],
      profiles: [{
        schemaVersion: "mobile-test-console.account-profile.v1",
        profileId: "legacy-wechat",
        accountLabel: "旧版微信账号",
        accountUid: "legacy-member-1234",
        provider: "wechat",
        platform: "android",
        environment: "qa",
        sourceDeviceKey: fixture.device.key,
        capabilities: ["login"],
        captures: [],
        recordedAt: "2026-07-30T10:00:00.000Z",
        validatedAt: "2026-07-30T10:00:00.000Z",
        expiresAt: "2099-08-30T10:00:00.000Z",
        version: 1,
      }],
    }));

    const snapshot = await fixture.service.snapshot();
    expect(snapshot.profiles[0].providerEntries).toHaveLength(1);
    expect(snapshot.profiles[0].providerEntries[0]).toMatchObject({ provider: "wechat", accountUidMasked: "********1234" });
    await expect(fixture.service.replayProfile("legacy-wechat", "wechat", fixture.device)).resolves.toMatchObject({ status: "passed" });
    const persisted = JSON.parse(await fs.readFile(path.join(fixture.stateDir, "account-profiles.json"), "utf8"));
    expect(persisted.profiles[0]).toMatchObject({ schemaVersion: "mobile-test-console.account-profile.v2", version: 2 });
    expect(persisted.profiles[0].providerEntries).toHaveLength(1);
    expect((await fs.stat(path.join(fixture.stateDir, "account-profiles.json"))).mode & 0o777).toBe(0o600);
  });

  it("从历史成功录制补齐缺失 Provider 分支并保持迁移幂等", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "mtc-account-profile-migration-"));
    tempDirs.push(root);
    const statePath = path.join(root, "account-profiles.json");
    const explicitTaobaoEntry = {
      provider: "taobao" as const,
      accountUid: "explicit-taobao-uid",
      sourceDeviceKey: "android:explicit-device",
      capabilities: ["login"],
      captures: createCompleteCaptures("taobao", "explicit-taobao"),
      recordedAt: "2026-07-30T09:00:00.000Z",
      validatedAt: "2026-07-30T09:30:00.000Z",
      expiresAt: "2099-08-30T09:00:00.000Z",
    };
    const recordings: AccountProfileRecording[] = [
      createHistoricalRecording("huawei", "huawei-older", "2026-07-30T10:00:00.000Z"),
      createHistoricalRecording("huawei", "huawei-newer", "2026-07-30T11:00:00.000Z", {
        deviceKey: "android:huawei-newer-device",
      }),
      createHistoricalRecording("huawei", "huawei-failed-latest", "2026-07-30T12:00:00.000Z", {
        status: "failed",
      }),
      createHistoricalRecording("qq", "qq-complete", "2026-07-30T10:30:00.000Z"),
      createHistoricalRecording("taobao-commerce", "taobao-commerce-complete", "2026-07-30T10:45:00.000Z"),
      createHistoricalRecording("taobao", "taobao-history-newer", "2026-07-30T12:30:00.000Z"),
      createHistoricalRecording("wechat", "wechat-empty", "2026-07-30T13:00:00.000Z", { captures: [] }),
      createHistoricalRecording("wechat", "wechat-incomplete", "2026-07-30T13:15:00.000Z", {
        captures: createCompleteCaptures("wechat", "wechat-incomplete").slice(0, 1),
      }),
      createHistoricalRecording("wechat", "wechat-mixed-provider", "2026-07-30T13:30:00.000Z", {
        captures: createCompleteCaptures("wechat", "wechat-mixed-provider").map((capture, index) => index === 0
          ? { ...capture, provider: "qq" }
          : capture),
      }),
      createHistoricalRecording("wechat", "wechat-cross-platform", "2026-07-30T14:00:00.000Z", { platform: "ios" }),
      createHistoricalRecording("wechat", "wechat-cross-environment", "2026-07-30T14:15:00.000Z", { environment: "staging" }),
      createHistoricalRecording("qq", "deleted-profile-recording", "2026-07-30T15:00:00.000Z", { profileId: "deleted-profile" }),
    ];
    await fs.writeFile(statePath, JSON.stringify({
      schemaVersion: "mobile-test-console.account-profile-state.v1",
      profiles: [{
        schemaVersion: "mobile-test-console.account-profile.v2",
        profileId: "qa-account",
        accountLabel: "QA 聚合账号",
        platform: "android",
        environment: "qa",
        providerEntries: [explicitTaobaoEntry],
        version: 2,
      }],
      recordings,
    }), { mode: 0o644 });
    await fs.chmod(statePath, 0o644);

    const store = new AccountProfileStore(root);
    const firstLoad = await store.load();
    const profile = firstLoad.profiles.find(item => item.profileId === "qa-account");
    expect(profile?.providerEntries.map(item => item.provider)).toEqual(["huawei", "qq", "taobao", "taobao-commerce"]);
    expect(profile?.providerEntries.find(item => item.provider === "taobao")).toEqual(explicitTaobaoEntry);
    expect(profile?.providerEntries.find(item => item.provider === "huawei")).toMatchObject({
      sourceDeviceKey: "android:huawei-newer-device",
      accountUid: "huawei-newer-uid",
      validatedAt: "",
    });
    expect(profile?.providerEntries.find(item => item.provider === "qq")).toMatchObject({
      accountUid: "qq-complete-uid",
      capabilities: ["login"],
    });
    expect(profile?.providerEntries.find(item => item.provider === "taobao-commerce")).toMatchObject({
      accountUid: "",
      capabilities: ["taobao-commerce-auth", "taobao-oauth2"],
    });
    expect(profile?.providerEntries.find(item => item.provider === "wechat")).toBeUndefined();
    expect(firstLoad.profiles.find(item => item.profileId === "deleted-profile")).toBeUndefined();

    const firstSerialized = await fs.readFile(statePath, "utf8");
    expect(JSON.parse(firstSerialized).profiles[0]).toMatchObject({
      schemaVersion: "mobile-test-console.account-profile.v2",
      version: 2,
    });
    expect((await fs.stat(statePath)).mode & 0o777).toBe(0o600);

    await store.load();
    expect(await fs.readFile(statePath, "utf8")).toBe(firstSerialized);
  });

  it("缺少成功 OAuth 结果时保留失败录制且不生成画像", async () => {
    const fixture = await createFixture("native-only");
    fixture.device.manufacturer = "Huawei";
    const started = await fixture.service.startRecording(fixture.device, {
      deviceKey: fixture.device.key,
      profileId: "incomplete",
      accountLabel: "未完成账号",
      provider: "huawei",
      environment: "qa",
    });
    const stopped = await fixture.service.stopRecording(started.recordingId);
    expect(stopped.profile).toBeUndefined();
    expect(stopped.recording.status).toBe("failed");
    expect(stopped.recording.error).toContain("OAuth 登录结果");
    expect((await fixture.service.snapshot()).profiles).toEqual([]);
  });

  it("快照展示全部活动会话且终止后释放对应设备", async () => {
    const fixture = await createFixture();
    const secondDevice: Device = {
      ...fixture.device,
      key: "android:device-2",
      id: "device-2",
      name: "Android Device 2",
    };
    const [first, second] = await Promise.all([
      fixture.service.startRecording(fixture.device, {
        deviceKey: fixture.device.key,
        profileId: "fixed-wechat-one",
        accountLabel: "微信账号一",
        provider: "wechat",
        environment: "qa",
      }),
      fixture.service.startRecording(secondDevice, {
        deviceKey: secondDevice.key,
        profileId: "fixed-wechat-two",
        accountLabel: "微信账号二",
        provider: "wechat",
        environment: "qa",
      }),
    ]);

    const activeIds = (await fixture.service.snapshot()).recordings
      .filter(item => ["starting", "recording"].includes(item.status))
      .map(item => item.recordingId);
    expect(activeIds).toEqual(expect.arrayContaining([first.recordingId, second.recordingId]));
    expect(activeIds).toHaveLength(2);

    const terminated = await fixture.service.terminateRecording(first.recordingId);
    expect(terminated.status).toBe("failed");
    expect(terminated.error).toBe("用户终止录制会话");
    expect(terminated.stoppedAt).not.toBe("");

    const restarted = await fixture.service.startRecording(fixture.device, {
      deviceKey: fixture.device.key,
      profileId: "fixed-wechat-three",
      accountLabel: "微信账号三",
      provider: "wechat",
      environment: "qa",
    });
    expect(restarted.status).toBe("recording");
  });

  it("Provider 延迟返回时保持用户终止状态", async () => {
    const fixture = await createFixture("complete", 250);
    const startPromise = fixture.service.startRecording(fixture.device, {
      deviceKey: fixture.device.key,
      profileId: "delayed-wechat",
      accountLabel: "延迟微信账号",
      provider: "wechat",
      environment: "qa",
    });
    const recording = await waitForRecording(fixture.service);

    await fixture.service.terminateRecording(recording.recordingId);
    expect((await startPromise).status).toBe("failed");
    const stored = (await fixture.service.snapshot()).recordings.find(item => item.recordingId === recording.recordingId);
    expect(stored).toMatchObject({ status: "failed", error: "用户终止录制会话" });
  });
});

async function createFixture(mode = "complete", startDelayMs = 0) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "mtc-account-profile-"));
  tempDirs.push(root);
  const stateDir = path.join(root, "state");
  const providerPath = path.join(root, "provider.cjs");
  const invocationPath = path.join(root, "invocations.txt");
  await fs.writeFile(providerPath, `
const fs = require("node:fs");
const action = process.argv[2];
const providerIndex = process.argv.indexOf("--provider");
const provider = providerIndex >= 0 ? process.argv[providerIndex + 1] : "wechat";
fs.appendFileSync(${JSON.stringify(invocationPath)}, process.argv.slice(2).join("\\n") + "\\n---\\n");
const now = "2026-07-30T10:00:00.000Z";
const nativeCapture = {
  captureId: "native-" + provider, kind: "native", provider,
  module: "LynxWechatLoginModule", method: "sendAuthRequest", params: {},
  result: { result: "success", code: "native-secret-code", access_token: "access-token-secret" }, capturedAt: now,
};
const graphqlCapture = {
  captureId: "graphql-" + provider, kind: "graphql", provider, operationName: "OauthLogin",
  params: { code: "native-secret-code" },
  result: { data: { oauthLogin: { uid: "member-12345678", session_key: "session-secret-value" } } }, capturedAt: now,
};
let payload;
if (action === "recording-start") payload = { schemaVersion: "mobile-test-console.account-profile-provider.v1", status: "recording" };
else if (action === "recording-status") payload = { schemaVersion: "mobile-test-console.account-profile-provider.v1", status: "recording" };
else if (action === "recording-stop") {
  const mode = ${JSON.stringify(mode)};
  if (mode === "invalid-status") payload = { schemaVersion: "mobile-test-console.account-profile-provider.v1", status: "complete", captures: [] };
  else if (mode === "captures-not-array") payload = { schemaVersion: "mobile-test-console.account-profile-provider.v1", status: "stopped", captures: {} };
  else if (mode === "invalid-provider") payload = { schemaVersion: "mobile-test-console.account-profile-provider.v1", status: "stopped", captures: [{ ...nativeCapture, provider: "unknown-provider" }] };
  else if (mode === "provider-mismatch") payload = { schemaVersion: "mobile-test-console.account-profile-provider.v1", status: "stopped", captures: [{ ...nativeCapture, provider: "taobao-commerce" }] };
  else if (mode === "invalid-kind") payload = { schemaVersion: "mobile-test-console.account-profile-provider.v1", status: "stopped", captures: [{ ...nativeCapture, kind: "rest" }] };
  else if (mode === "missing-location") payload = { schemaVersion: "mobile-test-console.account-profile-provider.v1", status: "stopped", captures: [{ ...nativeCapture, module: undefined }] };
  else if (mode === "invalid-objects") payload = { schemaVersion: "mobile-test-console.account-profile-provider.v1", status: "stopped", captures: [{ ...nativeCapture, params: [], result: "success" }] };
  else if (mode === "invalid-time") payload = { schemaVersion: "mobile-test-console.account-profile-provider.v1", status: "stopped", captures: [{ ...nativeCapture, capturedAt: "yesterday" }] };
  else payload = { schemaVersion: "mobile-test-console.account-profile-provider.v1", status: "stopped", captures: mode === "native-only" ? [nativeCapture] : [nativeCapture, graphqlCapture] };
}
else payload = ${JSON.stringify(mode)} === "replay-invalid"
  ? { schemaVersion: "mobile-test-console.account-profile-provider.v1", status: "done", output: 123 }
  : { schemaVersion: "mobile-test-console.account-profile-provider.v1", status: "passed", output: "账号画像回放完成" };
const emit = () => process.stdout.write(JSON.stringify(payload));
if (action === "recording-start" && ${startDelayMs} > 0) setTimeout(emit, ${startDelayMs});
else emit();
`);

  const config: LoadedProjectConfig = {
    schemaVersion: "mobile-test-console.config.v1",
    configPath: path.join(root, "mobile-test.config.cjs"),
    project: { id: "demo", name: "Demo", root },
    stateDir,
    deviceProviders: ["android"],
    lifecycle: {},
    taskDeletion: {},
    accountProfiles: { provider: { executable: process.execPath, args: [providerPath] } },
    tests: [{ id: "smoke", label: "Smoke", description: "", platforms: ["android"], parameters: [], commands: { default: { executable: process.execPath, args: ["--version"] } } }],
  };
  const device: Device = {
    key: "android:device-1",
    id: "device-1",
    name: "Android Device",
    platform: "android",
    type: "physical",
    connectionState: "available",
    controlState: "ready",
    controlReason: "",
    osVersion: "15",
    detail: "",
  };
  return { stateDir, invocationPath, device, service: new AccountProfileService(config, new AccountProfileStore(stateDir)) };
}

async function waitForRecording(service: AccountProfileService) {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    const recording = (await service.snapshot()).recordings[0];
    if (recording) return recording;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error("等待账号录制会话超时");
}

function createHistoricalRecording(
  provider: AccountProfileProvider,
  recordingId: string,
  startedAt: string,
  overrides: Partial<AccountProfileRecording> = {},
): AccountProfileRecording {
  return {
    recordingId,
    profileId: "qa-account",
    accountLabel: "QA 聚合账号",
    provider,
    deviceKey: `android:${recordingId}-device`,
    deviceId: `${recordingId}-device`,
    deviceType: "physical",
    platform: "android",
    environment: "qa",
    status: "stopped",
    startedAt,
    stoppedAt: new Date(Date.parse(startedAt) + 60_000).toISOString(),
    error: "",
    captures: createCompleteCaptures(provider, recordingId),
    ...overrides,
  };
}

function createCompleteCaptures(provider: AccountProfileProvider, recordingId: string): AccountProfileCapture[] {
  const capturedAt = "2026-07-30T10:00:00.000Z";
  const nativeCapture: AccountProfileCapture = {
    captureId: `${recordingId}-native`,
    kind: "native",
    provider,
    module: provider === "taobao-commerce" ? "LynxAlibcLoginModule" : "LynxAccountLoginModule",
    method: provider === "taobao-commerce" ? "oauth2" : "authorize",
    params: {},
    result: { result: "success" },
    capturedAt,
  };
  if (provider === "taobao-commerce") return [nativeCapture];
  return [nativeCapture, {
    captureId: `${recordingId}-graphql`,
    kind: "graphql",
    provider,
    operationName: "OauthLogin",
    params: {},
    result: { data: { oauthLogin: { uid: `${recordingId}-uid`, session_key: `${recordingId}-session` } } },
    capturedAt,
  }];
}
