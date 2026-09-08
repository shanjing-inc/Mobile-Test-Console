import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AccountProfileStore, type StoredAccountProfiles } from "../src/server/account-profile-store.js";
import { accountProfileStatePath, resolveAccountProfileStorage } from "../src/server/account-profile-storage.js";
import type { AccountProfile } from "../src/shared/contracts.js";
import { TEST_PROJECT_ADAPTER } from "./fixtures/project-adapter.js";

const roots: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true }))); });
async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "mtc-durable-"));
  roots.push(root);
  return root;
}
function profile(id: string, uid = "private-test-uid"): AccountProfile {
  return {
    schemaVersion: "mobile-test-console.account-profile.v2", profileId: id, accountLabel: id,
    platform: "android", environment: "qa", version: 2,
    providerEntries: [{ provider: "wechat", accountUid: uid, sourceDeviceKey: "android:test", capabilities: ["login"],
      captures: [], recordedAt: "2026-09-08T01:00:00Z", validatedAt: "", expiresAt: "2099-01-01T00:00:00Z" }],
  };
}
function state(...profiles: AccountProfile[]): StoredAccountProfiles {
  return { schemaVersion: "mobile-test-console.account-profile-state.v1", profiles, recordings: [] };
}

describe("账号画像持久存储", () => {
  it("生成独立标识，项目目录移动后沿用数据，不同项目隔离", async () => {
    const root = await fixture();
    const project = path.join(root, "old-project");
    await fs.mkdir(project);
    const input = { configPath: path.join(project, "mobile-test.config.cjs"), stateDir: path.join(root, "runtime-one"), userDataDir: path.join(root, "user-data") };
    const [first, concurrent] = await Promise.all([resolveAccountProfileStorage(input), resolveAccountProfileStorage(input)]);
    expect(first.id).toBe(concurrent.id);
    await new AccountProfileStore(first.directory).save(state(profile("saved")));
    const moved = path.join(root, "moved-project");
    await fs.rename(project, moved);
    const second = await resolveAccountProfileStorage({ ...input, configPath: path.join(moved, "mobile-test.config.cjs"), stateDir: path.join(root, "runtime-two") });
    expect(second.directory).toBe(first.directory);
    expect((await new AccountProfileStore(second.directory).load()).profiles).toHaveLength(1);
    await fs.rm(path.join(moved, "mobile-test.identity.json"));
    expect((await resolveAccountProfileStorage({ ...input, configPath: path.join(moved, "mobile-test.config.cjs") })).id).toBe(first.id);
    const different = path.join(root, "different-project");
    await fs.mkdir(different);
    expect((await resolveAccountProfileStorage({ ...input, configPath: path.join(different, "mobile-test.config.cjs") })).id).not.toBe(first.id);
    expect(accountProfileStatePath({ stateDir: input.stateDir, accountProfileStorage: second } as Parameters<typeof accountProfileStatePath>[0])).toBe(path.join(second.directory, "account-profiles.json"));
  });

  it("显式标识支持只读配置，并拒绝损坏标识文件", async () => {
    const root = await fixture();
    const configPath = path.join(root, "mobile-test.config.cjs");
    const input = { configPath, stateDir: path.join(root, "runtime"), userDataDir: root };
    const id = randomUUID();
    expect((await resolveAccountProfileStorage({ ...input, storageId: id })).id).toBe(id);
    await expect(fs.stat(path.join(root, "mobile-test.identity.json"))).rejects.toMatchObject({ code: "ENOENT" });
    await fs.writeFile(path.join(root, "mobile-test.identity.json"), "broken");
    await expect(resolveAccountProfileStorage(input)).rejects.toMatchObject({ code: "ACCOUNT_STORAGE_IDENTITY_INVALID" });
    await expect(resolveAccountProfileStorage({ ...input, storageId: "../escape" })).rejects.toThrow();
  });

  it("合并两个旧目录且保留原件，重启后不会复活已删除画像", async () => {
    const root = await fixture();
    const legacy = path.join(root, "legacy");
    const hashed = path.join(root, "hashed");
    await new AccountProfileStore(legacy).save(state(profile("same"), profile("old-only")));
    await new AccountProfileStore(hashed).save(state(profile("same"), profile("new-only")));
    const original = await fs.readFile(path.join(legacy, "account-profiles.json"));
    const directory = path.join(root, "durable");
    const store = new AccountProfileStore(directory, TEST_PROJECT_ADAPTER, [hashed, legacy]);
    expect((await store.load()).profiles.map(item => item.profileId).sort()).toEqual(["new-only", "old-only", "same"]);
    await store.update(current => { current.profiles = current.profiles.filter(item => item.profileId !== "old-only"); });
    const restart = new AccountProfileStore(directory, TEST_PROJECT_ADAPTER, [hashed, legacy]);
    expect((await restart.load()).profiles).toHaveLength(2);
    expect(await fs.readFile(path.join(legacy, "account-profiles.json"))).toEqual(original);
  });

  it("冲突导入保留两份，重复导入幂等，导出可在新存储恢复", async () => {
    const root = await fixture();
    const store = new AccountProfileStore(root);
    await store.save(state(profile("same", "first")));
    const incoming = state(profile("same", "second"));
    await store.importData(incoming);
    await store.importData(incoming);
    expect((await store.load()).profiles.map(item => item.providerEntries[0].accountUid).sort()).toEqual(["first", "second"]);
    const exported = await store.exportData();
    expect(Object.keys(exported).sort()).toEqual(["profiles", "recordings", "schemaVersion"]);
    const other = new AccountProfileStore(path.join(root, "other"));
    await other.importData(exported);
    expect((await other.load()).profiles).toEqual(exported.profiles);
  });

  it.each([false, true])("历史录制补齐 Provider 后重复导入保持幂等（已有冲突画像：%s）", async hasConflict => {
    const root = await fixture();
    const store = new AccountProfileStore(root, TEST_PROJECT_ADAPTER);
    const existing = profile("same", "existing-uid");
    if (hasConflict) await store.save(state(existing));
    const incoming = state({ ...profile("same"), providerEntries: [] });
    incoming.recordings.push({
      recordingId: "historical", profileId: "same", accountLabel: "same", provider: "taobao-commerce",
      deviceKey: "android:test", deviceId: "test", deviceType: "physical", platform: "android", environment: "qa",
      status: "stopped", startedAt: "2026-09-08T01:00:00Z", stoppedAt: "2026-09-08T01:01:00Z", error: "",
      captures: [{
        captureId: "historical-native", kind: "native", provider: "taobao-commerce", module: "DemoCommerceLoginModule",
        method: "oauth2", params: {}, result: { result: "success", uid: "imported-uid" }, capturedAt: "2026-09-08T01:01:00Z",
      }],
    });
    let firstImport: StoredAccountProfiles | undefined;
    for (let index = 0; index < 3; index++) {
      await store.importData(incoming);
      const current = await store.load();
      expect(current.profiles).toHaveLength(hasConflict ? 2 : 1);
      expect(current.recordings).toHaveLength(1);
      const imported = current.profiles.find(item => item.providerEntries[0]?.provider === "taobao-commerce")!;
      expect(imported.providerEntries[0]).toMatchObject({ accountUid: "imported-uid", captures: incoming.recordings[0].captures });
      expect(current.recordings[0]).toEqual({ ...incoming.recordings[0], profileId: imported.profileId });
      if (hasConflict) {
        expect(current.profiles.find(item => item.profileId === "same")).toEqual(existing);
        expect(imported.profileId).toMatch(/^same-import-/);
      }
      if (firstImport) expect(current).toEqual(firstImport);
      else firstImport = current;
    }
    expect(incoming.profiles[0].providerEntries).toEqual([]);
  });

  it("每次变更备份，主文件与备份权限受限，重复保存不产生备份", async () => {
    const root = await fixture();
    const store = new AccountProfileStore(root);
    await store.save(state(profile("first")));
    await store.save(state(profile("second")));
    await store.save(state(profile("second")));
    const info = await store.storageInfo();
    expect(info.backups).toHaveLength(2);
    const backup = path.join(root, "backups", info.backups[0].id);
    expect(JSON.parse(await fs.readFile(backup, "utf8")).profiles[0].profileId).toBe("first");
    for (const file of [backup, store.statePath]) expect((await fs.stat(file)).mode & 0o777).toBe(0o600);
    await store.restoreBackup(info.backups[0].id);
    expect((await store.load()).profiles.map(item => item.profileId)).toEqual(["second", "first"]);
    await expect(store.restoreBackup("../../secret")).rejects.toMatchObject({ code: "ACCOUNT_PROFILE_BACKUP_INVALID" });
  });

  it("主文件损坏时保留字节并从有效备份恢复，缺失时也恢复", async () => {
    const root = await fixture();
    const store = new AccountProfileStore(root);
    await store.save(state(profile("saved")));
    await store.save(state(profile("later")));
    await fs.writeFile(store.statePath, "corrupt-test-bytes");
    const restored = await store.load();
    expect(restored.profiles[0].profileId).toBe("saved");
    expect(restored.notices?.[0]).toContain("恢复");
    const corrupt = (await fs.readdir(root)).find(name => name.endsWith(".corrupt"))!;
    expect(await fs.readFile(path.join(root, corrupt), "utf8")).toBe("corrupt-test-bytes");
    await fs.rm(store.statePath);
    expect((await store.load()).profiles[0].profileId).toBe("saved");
  });

  it("格式错误和未来版本停止写入，显式导入可恢复且保留损坏原件", async () => {
    const root = await fixture();
    const store = new AccountProfileStore(root);
    await fs.writeFile(store.statePath, "broken");
    await expect(store.update(current => { current.profiles = []; })).rejects.toMatchObject({ code: "ACCOUNT_PROFILE_STATE_INVALID" });
    expect(await fs.readFile(store.statePath, "utf8")).toBe("broken");
    await expect(store.importData({ ...state(), profiles: [{ token: "secret-must-not-leak" }] })).rejects.toThrow();
    await store.importData(state(profile("imported")));
    expect((await store.load()).profiles).toHaveLength(1);
    await fs.writeFile(store.statePath, JSON.stringify({ schemaVersion: "future" }));
    await expect(store.load()).rejects.toMatchObject({ code: "ACCOUNT_PROFILE_STATE_INVALID" });
    expect(JSON.parse(await fs.readFile(store.statePath, "utf8")).schemaVersion).toBe("future");
  });

  it.each(["EACCES", "EIO"])("主文件缺失且备份读取出现 %s 时阻止空库写入", async code => {
    const root = await fixture();
    const store = new AccountProfileStore(root);
    await store.save(state(profile("saved")));
    const backupId = (await store.storageInfo()).backups[0].id;
    const backupPath = path.join(root, "backups", backupId);
    const originalBackup = await fs.readFile(backupPath);
    await fs.rm(store.statePath);
    const readFile = fs.readFile;
    const failure = Object.assign(new Error("模拟备份读取失败"), { code });
    const readSpy = vi.spyOn(fs, "readFile").mockImplementation((file, options) => {
      if (file === backupPath) return Promise.reject(failure);
      return readFile(file, options);
    });
    await expect(store.load()).rejects.toBe(failure);
    const mutator = vi.fn();
    await expect(store.update(mutator)).rejects.toBe(failure);
    expect(mutator).not.toHaveBeenCalled();
    await expect(fs.stat(store.statePath)).rejects.toMatchObject({ code: "ENOENT" });
    readSpy.mockRestore();
    expect(await fs.readFile(backupPath)).toEqual(originalBackup);
    expect((await store.storageInfo()).backups.map(item => item.id)).toEqual([backupId]);
  });

  it("跳过格式损坏和未来版本备份并恢复较旧的有效备份", async () => {
    const root = await fixture();
    const store = new AccountProfileStore(root);
    await store.save(state(profile("saved")));
    const firstId = (await store.storageInfo()).backups[0].id;
    for (const [offset, content] of [[1, "broken"], [2, JSON.stringify({ schemaVersion: "future" })]] as const) {
      const id = `${Number(firstId.slice(0, 13)) + offset}-${randomUUID()}.json`;
      await fs.writeFile(path.join(root, "backups", id), content);
    }
    await fs.rm(store.statePath);
    expect((await store.load()).profiles.map(item => item.profileId)).toEqual(["saved"]);
  });

  it("失败写入保留主文件，后续更新仍然成功", async () => {
    const root = await fixture();
    const store = new AccountProfileStore(root);
    await store.save(state(profile("saved")));
    vi.spyOn(fs, "rename").mockRejectedValueOnce(new Error("模拟磁盘失败"));
    await expect(store.update(current => { current.profiles.push(profile("lost")); })).rejects.toThrow("模拟磁盘失败");
    await store.update(current => { current.profiles.push(profile("next")); });
    expect((await store.load()).profiles.map(item => item.profileId)).toEqual(["saved", "next"]);
  });

  it("并发实例及独立进程更新不丢失画像", async () => {
    const root = await fixture();
    const stores = Array.from({ length: 8 }, () => new AccountProfileStore(root));
    await Promise.all(stores.map((store, i) => store.update(async current => {
      await new Promise(resolve => setTimeout(resolve, 5));
      current.profiles.push(profile(`local-${i}`));
    })));
    const script = `import { AccountProfileStore } from './src/server/account-profile-store.ts';
      const store = new AccountProfileStore(process.argv[1]);
      await store.update(async state => {
        await new Promise(resolve => setTimeout(resolve, 30));
        state.profiles.push(JSON.parse(process.argv[2]));
      });`;
    await Promise.all([0, 1, 2].map(i => promisify(execFile)(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script, root, JSON.stringify(profile(`process-${i}`))])));
    expect((await stores[0].load()).profiles).toHaveLength(11);
  }, 15_000);
});
