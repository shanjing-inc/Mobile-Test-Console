import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AccountProfileStore } from "../src/server/account-profile-store.js";
import { AccountProfileService } from "../src/server/account-profiles.js";
import { PageParameterStore } from "../src/server/page-parameter-store.js";
import { PageParameterService } from "../src/server/page-parameters.js";
import { exportProjectData, importProjectData } from "../src/server/project-data-backup.js";
import type { LoadedProjectConfig } from "../src/server/config.js";
import type { AccountProfileExport, PageParameterExport, ProjectDataBackup } from "../src/shared/contracts.js";

const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true })));
});

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "mtc-project-backup-"));
  roots.push(root);
  const accountStore = new AccountProfileStore(path.join(root, "accounts"));
  const pageStore = new PageParameterStore(path.join(root, "pages"));
  const config = { project: { name: "备份测试", root }, stateDir: root } as LoadedProjectConfig;
  const accounts = new AccountProfileService(config, accountStore);
  const pages = new PageParameterService(config, pageStore);
  return { root, config, accountStore, pageStore, accounts, pages };
}

function accountData(): AccountProfileExport {
  return {
    schemaVersion: "mobile-test-console.account-profile-state.v1",
    profiles: [{ schemaVersion: "mobile-test-console.account-profile.v2", profileId: "account", accountLabel: "测试账号",
      platform: "android", environment: "qa", version: 2,
      providerEntries: [{ provider: "test", accountUid: "private-test-account", sourceDeviceKey: "android:test",
        capabilities: ["login"], recordedAt: "2026-09-08T01:00:00Z", validatedAt: "", expiresAt: "",
        captures: [{ captureId: "token", kind: "native", provider: "test", params: { token: "private-test-token" },
          result: { nested: { test: true } }, capturedAt: "2026-09-08T01:00:00Z" }] }] }],
    recordings: [{ recordingId: "account-recording", profileId: "account", accountLabel: "测试账号", provider: "test",
      deviceKey: "android:test", deviceId: "test", deviceType: "physical", platform: "android", environment: "qa",
      status: "stopped", startedAt: "2026-09-08T01:00:00Z", stoppedAt: "2026-09-08T01:01:00Z", error: "", captures: [] }],
  };
}

function pageData(): PageParameterExport {
  return {
    schemaVersion: "mobile-test-console.page-parameter-state.v1",
    profiles: [{ profileId: "page-profile", pageId: "detail", scenario: "场景", platform: "all", environment: "qa",
      isDefault: true, accountLabel: "测试账号", source: "recording", recordedAt: "2026-09-08T01:00:00Z",
      validatedAt: "", expiresAt: "", version: 1,
      values: { id: { strategy: "literal", value: " 001 " }, token: { strategy: "secretRef", value: "QA_TOKEN" } },
      navigation: { route: "demo://launch", params: { nested: '{"a":[1,true]}', empty: "", token: "private-page-token" } },
      actions: [{ type: "input", target: "query", value: "test", assertions: [{ type: "text", target: "result", value: "ok" }] }],
      assertions: [{ type: "runtimeEvent", event: "page_ready" }] }],
    recordings: [{ recordingId: "page-recording", deviceKey: "android:test", deviceId: "test", platform: "android",
      environment: "qa", status: "stopped", startedAt: "2026-09-08T01:00:00Z", stoppedAt: "2026-09-08T01:01:00Z", error: "",
      observations: [{ observationId: "open", pageId: "detail", bundle: "detail.bundle", previousPageId: "home",
        values: { id: " 001 " }, navigation: { route: "demo://launch", params: { launch: "captured-value" } },
        capturedAt: "2026-09-08T01:00:00Z", rawData: '{"raw":"recording"}' }] }],
  };
}

function backup(): ProjectDataBackup {
  return { schemaVersion: "mobile-test-console.project-data-backup.v1", exportedAt: "2026-09-08T01:00:00Z",
    project: { name: "源项目" }, accountProfiles: accountData(), pageParameters: pageData() };
}

describe("统一项目数据备份", () => {
  it("真实服务和存储完整往返两类画像、启动参数与录制，剥离本地元数据", async () => {
    const source = await fixture();
    await source.accountStore.save({ ...accountData(), migratedPaths: ["/private/account-source"], notices: ["local account"] });
    await source.pageStore.save({ ...pageData(), migratedPaths: ["/private/page-source"], notices: ["local page"] });
    const exported = await exportProjectData(source.config, source.accounts, source.pages);
    expect(exported).toEqual({ ...backup(), exportedAt: expect.any(String), project: { name: "备份测试" } });
    expect(JSON.stringify(exported)).not.toContain(source.root);
    expect(exported.accountProfiles).not.toHaveProperty("notices");
    expect(exported.pageParameters).not.toHaveProperty("migratedPaths");
    const destination = await fixture();
    await destination.pageStore.save({ ...pageData(), profiles: [], recordings: [], migratedPaths: ["/destination/old"] });
    const incoming = { ...exported, project: { ...exported.project, storageId: "source-id", root: source.root },
      accountProfiles: { ...exported.accountProfiles, notices: ["source-notice"], migratedPaths: ["/source/account"] },
      pageParameters: { ...exported.pageParameters, notices: ["source-notice"], migratedPaths: ["/source/page"], storageId: "source-id" } };
    await importProjectData(incoming, destination.accounts, destination.pages);
    expect(await destination.accounts.exportData()).toEqual(accountData());
    expect(await destination.pages.exportData()).toEqual(pageData());
    expect(await destination.pageStore.load()).toMatchObject({ migratedPaths: ["/destination/old"] });
    expect(JSON.stringify(await destination.pageStore.load())).not.toContain("source-notice");
    expect(await fs.readdir(path.join(destination.root, "pages/page-parameter-backups"))).toHaveLength(2);
    for (const file of [destination.accountStore.statePath, destination.pageStore.statePath]) {
      expect((await fs.stat(file)).mode & 0o777).toBe(0o600);
    }
  });

  it("旧账号文件和 v1 画像兼容导入，页面数据保持完整", async () => {
    const target = await fixture();
    await target.pageStore.save(pageData());
    const before = await fs.readFile(target.pageStore.statePath);
    const current = accountData().profiles[0];
    const legacy = { ...accountData(), profiles: [{ ...current.providerEntries[0],
      schemaVersion: "mobile-test-console.account-profile.v1", version: 1, profileId: current.profileId,
      accountLabel: current.accountLabel, platform: current.platform, environment: current.environment }] };
    await importProjectData(legacy, target.accounts, target.pages);
    await importProjectData(accountData(), target.accounts, target.pages);
    expect(await target.accounts.exportData()).toEqual(accountData());
    expect(await fs.readFile(target.pageStore.statePath)).toEqual(before);
  });

  it.each(["page", "account", "envelope"])("%s 格式无效时整包拒绝且两个文件保持原字节", async section => {
    const target = await fixture();
    await target.accountStore.save(accountData());
    await target.pageStore.save(pageData());
    const accountBytes = await fs.readFile(target.accountStore.statePath);
    const pageBytes = await fs.readFile(target.pageStore.statePath);
    const incoming = backup();
    incoming.accountProfiles.profiles[0].accountLabel = "new-value";
    if (section === "page") Object.assign(incoming.pageParameters.profiles[0].navigation!.params, { token: { value: "never-print-this" } });
    if (section === "account") Object.assign(incoming.accountProfiles.profiles[0], { platform: "never-print-this" });
    if (section === "envelope") Object.assign(incoming, { schemaVersion: "never-print-this" });
    const accounts = vi.spyOn(target.accounts, "importData");
    const pages = vi.spyOn(target.pages, "importData");
    await expect(importProjectData(incoming, target.accounts, target.pages)).rejects.toMatchObject({
      code: "PROJECT_DATA_BACKUP_INVALID", statusCode: 400, message: expect.not.stringContaining("never-print-this"),
    });
    expect(accounts).not.toHaveBeenCalled();
    expect(pages).not.toHaveBeenCalled();
    expect(await fs.readFile(target.accountStore.statePath)).toEqual(accountBytes);
    expect(await fs.readFile(target.pageStore.statePath)).toEqual(pageBytes);
  });

  it("冲突保留完整副本，默认切换及 false/省略差异保持重复导入幂等", async () => {
    const target = await fixture();
    const original = backup();
    await importProjectData(original, target.accounts, target.pages);
    const incoming = backup();
    incoming.accountProfiles.profiles[0].providerEntries[0].accountUid = "other-test-account";
    incoming.pageParameters.profiles[0].navigation!.params.nested = "other-launch";
    incoming.pageParameters.recordings[0].observations[0].values.id = "other-id";
    await importProjectData(incoming, target.accounts, target.pages);
    const first = await target.pages.exportData();
    expect(first.profiles).toHaveLength(2);
    const copy = first.profiles[1];
    expect(copy).toEqual({ ...incoming.pageParameters.profiles[0], profileId: expect.stringContaining("-import-"), isDefault: false });
    expect(first.recordings).toHaveLength(2);
    expect(first.recordings[1]).toEqual({ ...incoming.pageParameters.recordings[0], recordingId: expect.stringContaining("-import-") });
    await target.pageStore.update(current => {
      current.profiles[0].isDefault = false;
      current.profiles[1].isDefault = true;
    });
    for (let index = 0; index < 3; index++) {
      await importProjectData(incoming, target.accounts, target.pages);
      await importProjectData(original, target.accounts, target.pages);
    }
    expect((await target.accounts.exportData()).profiles).toHaveLength(2);
    const after = await target.pages.exportData();
    expect(after.profiles.map(item => item.profileId)).toEqual(first.profiles.map(item => item.profileId));
    expect(after.profiles.map(item => item.isDefault)).toEqual([false, true]);
    expect(after.recordings).toEqual(first.recordings);
    delete original.pageParameters.profiles[0].isDefault;
    await importProjectData(original, target.accounts, target.pages);
    expect(await target.pages.exportData()).toEqual(after);
  });

  it.each(["starting", "recording"] as const)("导入 %s 会话确定性终结，保留目标的活动会话并支持重复导入", async status => {
    const target = await fixture();
    const incoming = backup();
    incoming.accountProfiles.recordings[0].status = status;
    incoming.accountProfiles.recordings[0].stoppedAt = "";
    incoming.pageParameters.recordings[0].status = status;
    incoming.pageParameters.recordings[0].stoppedAt = "";
    await target.pageStore.save(incoming.pageParameters);
    for (let index = 0; index < 3; index++) await importProjectData(incoming, target.accounts, target.pages);
    const accounts = await target.accounts.exportData();
    expect(accounts.recordings).toHaveLength(1);
    expect(accounts.recordings[0]).toMatchObject({ status: "failed", stoppedAt: incoming.accountProfiles.recordings[0].startedAt });
    const pages = await target.pages.exportData();
    expect(pages.recordings).toHaveLength(2);
    expect(pages.recordings[0]).toEqual(incoming.pageParameters.recordings[0]);
    expect(pages.recordings[1]).toEqual({ ...incoming.pageParameters.recordings[0],
      recordingId: expect.stringContaining("-import-"), status: "failed", stoppedAt: incoming.pageParameters.recordings[0].startedAt,
      error: "导入的录制会话已结束，请重新启动录制" });
  });

  it("页面发布失败准确报告部分成功，保留原字节和并发更新，重试完成合并", async () => {
    const target = await fixture();
    await target.pageStore.save(pageData());
    const before = await fs.readFile(target.pageStore.statePath);
    const incoming = backup();
    incoming.pageParameters.profiles[0].navigation!.params.token = "updated-test-value";
    const rename = fs.rename;
    const failure = vi.spyOn(fs, "rename").mockImplementation((from, to) => to === target.pageStore.statePath
      ? Promise.reject(Object.assign(new Error("never-print-this"), { code: "EIO" })) : rename(from, to));
    await expect(importProjectData(incoming, target.accounts, target.pages)).rejects.toMatchObject({
      code: "PROJECT_DATA_IMPORT_PARTIAL", statusCode: 500,
      message: "账号画像已导入，页面参数尚未完全导入。请排除存储故障后重试同一备份文件。",
    });
    expect(await target.accounts.exportData()).toEqual(accountData());
    expect(await fs.readFile(target.pageStore.statePath)).toEqual(before);
    failure.mockRestore();
    await target.accountStore.update(current => { current.profiles.push({ ...accountData().profiles[0], profileId: "concurrent" }); });
    await importProjectData(incoming, target.accounts, target.pages);
    expect((await target.accounts.exportData()).profiles.map(item => item.profileId)).toEqual(["account", "concurrent"]);
    expect((await target.pages.exportData()).profiles).toHaveLength(2);
    const completed = await target.pages.exportData();
    await importProjectData(incoming, target.accounts, target.pages);
    expect(await target.pages.exportData()).toEqual(completed);
  });

  it("账号阶段 I/O 失败透传并阻止页面导入", async () => {
    const target = await fixture();
    const error = Object.assign(new Error("模拟账号存储故障"), { code: "EIO" });
    vi.spyOn(fs, "rename").mockRejectedValueOnce(error);
    const pages = vi.spyOn(target.pages, "importData");
    await expect(importProjectData(backup(), target.accounts, target.pages)).rejects.toBe(error);
    expect(pages).not.toHaveBeenCalled();
    await expect(fs.stat(target.accountStore.statePath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.stat(target.pageStore.statePath)).rejects.toMatchObject({ code: "ENOENT" });
  });
});
