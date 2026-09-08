import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PageParameterStore, type StoredPageParameters } from "../src/server/page-parameter-store.js";
import { PageParameterService } from "../src/server/page-parameters.js";
import type { LoadedProjectConfig } from "../src/server/config.js";
import type { Device, PageParameterProfile, PageParameterRecording } from "../src/shared/contracts.js";

const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true })));
});
async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "mtc-page-durable-"));
  roots.push(root);
  return root;
}
function profile(id = "default", pageId = "detail"): PageParameterProfile {
  return {
    profileId: id, pageId, scenario: "detail", platform: "all", environment: "qa", accountLabel: "test",
    values: { id: { strategy: "literal", value: " 001 " }, token: { strategy: "secretRef", value: "QA_TOKEN" } },
    navigation: { route: "demo://launch", params: { bundle: "detail.bundle", launch: '{"nested":[1,true]}', empty: "" } },
    actions: [{ type: "tap", target: "buy", assertions: [{ type: "visible", target: "result" }] }],
    assertions: [{ type: "runtimeEvent", event: "page_ready" }], source: "recording",
    recordedAt: "2026-09-08T01:00:00Z", validatedAt: "", expiresAt: "", version: 1,
  };
}
function recording(id = "history"): PageParameterRecording {
  return {
    recordingId: id, deviceKey: "android:test", deviceId: "test", platform: "android", environment: "qa",
    status: "stopped", startedAt: "2026-09-08T01:00:00Z", stoppedAt: "2026-09-08T01:01:00Z", error: "",
    observations: [{ observationId: "first", pageId: "detail", bundle: "detail.bundle", previousPageId: "home",
      values: { id: " 001 " }, navigation: profile().navigation, capturedAt: "2026-09-08T01:01:00Z", rawData: '{"test":true}' }],
  };
}
function state(...profiles: PageParameterProfile[]): StoredPageParameters {
  return { schemaVersion: "mobile-test-console.page-parameter-state.v1", profiles, recordings: [recording()] };
}
async function writeLegacy(directory: string, value: StoredPageParameters) {
  await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(path.join(directory, "page-parameters.json"), JSON.stringify(value));
}
const device: Device = {
  key: "android:test", id: "test", name: "Test", platform: "android", type: "physical", connectionState: "available",
  osVersion: "", detail: "", controlState: "ready", controlReason: "",
};

function serviceFixture(root: string, store = new PageParameterStore(root)) {
  const service = new PageParameterService({ stateDir: root } as LoadedProjectConfig, store);
  const provider = vi.spyOn(service as unknown as { callProvider(action: string): Promise<unknown> }, "callProvider");
  return { service, provider, store };
}

describe("页面参数持久存储", () => {
  it("完整迁移页面参数和启动导航，保留源字节，删除后重启保持删除", async () => {
    const root = await fixture();
    const legacy = path.join(root, "legacy");
    const original = state(profile(), profile("default", "other-page"));
    await writeLegacy(legacy, original);
    const sourcePath = path.join(legacy, "page-parameters.json");
    const source = await fs.readFile(sourcePath);
    const directory = path.join(root, "durable");
    const store = new PageParameterStore(directory, [legacy]);
    const migrated = await store.load();
    expect(migrated.profiles).toEqual(original.profiles);
    expect(migrated.recordings).toEqual(original.recordings);
    expect(migrated.migratedPaths).toEqual([sourcePath]);
    const { service, provider } = serviceFixture(directory, store);
    provider.mockResolvedValue({ pages: [{ pageId: "detail", fields: [] }], warnings: ["provider notice"] });
    expect((await service.snapshot()).warnings).toEqual(["provider notice", ...migrated.notices!]);
    await service.deleteProfile("detail", "default");
    await new PageParameterStore(directory, [legacy]).load();
    expect((await store.load()).profiles).toEqual([original.profiles[1]]);
    expect(await fs.readFile(sourcePath)).toEqual(source);
  });

  it("迁移冲突保留确定性副本，页面复合键隔离且当前默认优先", async () => {
    const root = await fixture();
    const current = { ...profile(), isDefault: true };
    const old = { ...profile(), isDefault: true, navigation: { route: "demo://older", params: { old: "yes" } } };
    const legacyOne = path.join(root, "legacy-one");
    const legacyTwo = path.join(root, "legacy-two");
    const previous = state(old, { ...profile("extra"), isDefault: true }, profile("default", "other-page"));
    previous.recordings[0].observations[0].navigation = old.navigation;
    await writeLegacy(legacyOne, previous);
    await writeLegacy(legacyTwo, previous);
    const directory = path.join(root, "durable");
    await new PageParameterStore(directory).save(state(current));
    const store = new PageParameterStore(directory, [legacyOne, legacyTwo]);
    const migrated = await store.load();
    expect(migrated.profiles.filter(item => item.pageId === "detail")).toHaveLength(3);
    expect(migrated.profiles.find(item => item.pageId === "detail" && item.profileId === "default")).toEqual(current);
    const copy = migrated.profiles.find(item => item.profileId.startsWith("default-migrated-"))!;
    expect(copy).toEqual({ ...old, profileId: copy.profileId, isDefault: false });
    expect(migrated.profiles.filter(item => item.pageId === "detail" && item.isDefault)).toEqual([current]);
    expect(migrated.recordings).toHaveLength(2);
    expect(migrated.recordings[1]).toEqual({ ...previous.recordings[0], recordingId: migrated.recordings[1].recordingId });
    expect(await new PageParameterStore(directory, [legacyOne, legacyTwo]).load()).toEqual(migrated);
  });

  it("已有文件首次读取建立私有备份，变更前备份且重复写保持幂等", async () => {
    const root = await fixture();
    const original = state(profile("before"));
    await writeLegacy(root, original);
    const store = new PageParameterStore(root);
    await store.load();
    const backupDir = path.join(root, "page-parameter-backups");
    expect(await fs.readdir(backupDir)).toHaveLength(1);
    await store.save(state(profile("after")));
    await store.save(state(profile("after")));
    const backups = (await fs.readdir(backupDir)).sort();
    expect(backups).toHaveLength(2);
    expect(JSON.parse(await fs.readFile(path.join(backupDir, backups.at(-1)!), "utf8"))).toEqual(original);
    for (const file of [store.statePath, ...backups.map(name => path.join(backupDir, name))]) {
      expect((await fs.stat(file)).mode & 0o777).toBe(0o600);
    }
  });

  it("坏主文件和缺失主文件恢复有效备份，坏字节完整保留", async () => {
    const root = await fixture();
    const store = new PageParameterStore(root);
    const original = state(profile("saved"));
    await store.save(original);
    await store.save(state(profile("later")));
    const backupDir = path.join(root, "page-parameter-backups");
    const timestamp = Number((await fs.readdir(backupDir)).sort().at(-1)!.slice(0, 13));
    await fs.writeFile(path.join(backupDir, `${timestamp + 1}-${randomUUID()}.json`), "broken-backup");
    await fs.writeFile(store.statePath, "broken-primary");
    const restored = await store.load();
    expect(restored.profiles).toEqual(original.profiles);
    expect(restored.recordings).toEqual(original.recordings);
    expect(restored.notices?.join()).toContain("恢复");
    const corrupt = (await fs.readdir(root)).find(name => name.endsWith(".corrupt"))!;
    expect(await fs.readFile(path.join(root, corrupt), "utf8")).toBe("broken-primary");
    await fs.rm(store.statePath);
    expect((await store.load()).profiles).toEqual(original.profiles);
  });

  it("未来格式、损坏数据与重复复合键阻止写入并保留源文件", async () => {
    const root = await fixture();
    const store = new PageParameterStore(root);
    await store.save(state(profile()));
    const future = JSON.stringify({ schemaVersion: "mobile-test-console.page-parameter-state.v2" });
    await fs.writeFile(store.statePath, future);
    const mutator = vi.fn();
    await expect(store.update(mutator)).rejects.toMatchObject({ code: "PAGE_PARAMETER_STATE_INVALID" });
    expect(mutator).not.toHaveBeenCalled();
    expect(await fs.readFile(store.statePath, "utf8")).toBe(future);
    await expect(store.save(state(profile(), profile()))).rejects.toMatchObject({ code: "PAGE_PARAMETER_STATE_INVALID" });
    const broken = path.join(root, "broken");
    await fs.mkdir(broken);
    await fs.writeFile(path.join(broken, "page-parameters.json"), "broken");
    await expect(new PageParameterStore(broken).save(state())).rejects.toMatchObject({ code: "PAGE_PARAMETER_STATE_INVALID" });
    const invalid = state(profile());
    (invalid.profiles[0].navigation!.params as Record<string, unknown>).launch = { private: "private-test-value" };
    await expect(new PageParameterStore(path.join(root, "invalid")).save(invalid)).rejects.toThrow("navigation.params.launch");
  });

  it("损坏的旧文件阻止整个迁移，修复后可重试", async () => {
    const root = await fixture();
    const legacy = path.join(root, "legacy");
    const broken = path.join(root, "broken");
    await writeLegacy(legacy, state(profile("one")));
    await fs.mkdir(broken);
    const brokenPath = path.join(broken, "page-parameters.json");
    await fs.writeFile(brokenPath, "broken");
    const store = new PageParameterStore(path.join(root, "durable"), [legacy, broken]);
    await expect(store.load()).rejects.toMatchObject({ code: "PAGE_PARAMETER_MIGRATION_FAILED" });
    expect(await fs.readFile(brokenPath, "utf8")).toBe("broken");
    await expect(fs.stat(store.statePath)).rejects.toMatchObject({ code: "ENOENT" });
    await writeLegacy(broken, state(profile("two")));
    expect((await store.load()).profiles.map(item => item.profileId)).toEqual(["one", "two"]);
  });

  it.each(["EACCES", "EIO"])("主文件与备份读取 %s 均阻止更新", async code => {
    const root = await fixture();
    const store = new PageParameterStore(root);
    await store.save(state(profile()));
    const backupDir = path.join(root, "page-parameter-backups");
    const backup = path.join(backupDir, (await fs.readdir(backupDir))[0]);
    const readFile = fs.readFile;
    const failure = Object.assign(new Error("模拟读取故障"), { code });
    for (const filePath of [store.statePath, backup]) {
      if (filePath === backup) await fs.rm(store.statePath);
      const spy = vi.spyOn(fs, "readFile").mockImplementation((file, options) => file === filePath ? Promise.reject(failure) : readFile(file, options));
      const mutator = vi.fn();
      await expect(store.update(mutator)).rejects.toBe(failure);
      expect(mutator).not.toHaveBeenCalled();
      spy.mockRestore();
    }
    await expect(fs.stat(store.statePath)).rejects.toMatchObject({ code: "ENOENT" });
    expect((await store.load()).profiles).toEqual([profile()]);
  });

  it.each(["EACCES", "EIO"])("旧文件读取 %s 保留原件并阻止迁移标记写入", async code => {
    const root = await fixture();
    const legacy = path.join(root, "legacy");
    await writeLegacy(legacy, state(profile()));
    const source = path.join(legacy, "page-parameters.json");
    const original = await fs.readFile(source);
    const store = new PageParameterStore(path.join(root, "durable"), [legacy]);
    const readFile = fs.readFile;
    const failure = Object.assign(new Error("模拟旧文件读取故障"), { code });
    const spy = vi.spyOn(fs, "readFile").mockImplementation((file, options) => file === source ? Promise.reject(failure) : readFile(file, options));
    await expect(store.load()).rejects.toBe(failure);
    await expect(fs.stat(store.statePath)).rejects.toMatchObject({ code: "ENOENT" });
    spy.mockRestore();
    expect(await fs.readFile(source)).toEqual(original);
    expect((await store.load()).profiles).toEqual([profile()]);
  });

  it("发布失败保留主文件，锁释放后可继续更新", async () => {
    const root = await fixture();
    const store = new PageParameterStore(root);
    await store.save(state(profile("saved")));
    const bytes = await fs.readFile(store.statePath);
    vi.spyOn(fs, "rename").mockRejectedValueOnce(new Error("模拟发布失败"));
    await expect(store.update(current => { current.profiles.push(profile("lost")); })).rejects.toThrow("模拟发布失败");
    expect(await fs.readFile(store.statePath)).toEqual(bytes);
    expect((await fs.readdir(root)).filter(name => name.endsWith(".next"))).toEqual([]);
    await store.update(current => { current.profiles.push(profile("next")); });
    expect((await store.load()).profiles.map(item => item.profileId)).toEqual(["saved", "next"]);
  });

  it("并发实例与独立进程更新保留所有修改", async () => {
    const root = await fixture();
    const stores = Array.from({ length: 5 }, () => new PageParameterStore(root));
    await Promise.all(stores.map((store, index) => store.update(async current => {
      await new Promise(resolve => setTimeout(resolve, 5));
      current.profiles.push(profile(`local-${index}`));
    })));
    const script = `import { PageParameterStore } from './src/server/page-parameter-store.ts';
      await new PageParameterStore(process.argv[1]).update(async state => {
        await new Promise(resolve => setTimeout(resolve, 30));
        state.profiles.push(JSON.parse(process.argv[2]));
      });`;
    await Promise.all([0, 1, 2].map(index => promisify(execFile)(process.execPath,
      ["--import", "tsx", "--input-type=module", "-e", script, root, JSON.stringify(profile(`process-${index}`))])));
    expect((await stores[0].load()).profiles).toHaveLength(8);
  }, 15_000);
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

describe("页面参数服务并发", () => {
  it("Provider 后续观察省略导航时保留已经捕获的启动参数", async () => {
    const root = await fixture();
    const { store, service, provider } = serviceFixture(root);
    const initial = state();
    initial.recordings[0].status = "recording";
    initial.recordings[0].stoppedAt = "";
    await store.save(initial);
    const next = { ...initial.recordings[0].observations[0], observationId: "next" };
    delete next.navigation;
    provider.mockResolvedValue({ status: "recording", observations: [next] });
    const refreshed = await service.refreshRecording("history");
    expect(refreshed.observations).toEqual([{ ...next, navigation: initial.recordings[0].observations[0].navigation }]);
    expect((await store.load()).recordings[0].observations).toEqual(refreshed.observations);
  });

  it.each(["start", "refresh"])("延迟 %s 响应合并当前状态，保留同时删除和停止操作", async action => {
    const root = await fixture();
    const { store, service, provider } = serviceFixture(root);
    const initial = state(profile("delete-me"));
    initial.recordings = action === "refresh" ? [{ ...recording(), status: "recording", stoppedAt: "", observations: [] }] : [];
    await store.save(initial);
    const pending = deferred<unknown>();
    const entered = deferred<void>();
    provider.mockImplementation(async requested => {
      if (requested === `recording-${action === "refresh" ? "status" : "start"}`) {
        entered.resolve();
        return pending.promise;
      }
      return { status: "stopped", observations: [{ ...recording().observations[0], observationId: "stop", values: { id: "stop" } }] };
    });
    const running = action === "refresh" ? service.refreshRecording("history") : service.startRecording(device, "qa");
    await entered.promise;
    const recordingId = (await store.load()).recordings[0].recordingId;
    await service.deleteProfile("detail", "delete-me");
    const stopped = await service.stopRecording(recordingId);
    pending.resolve({ status: "recording", observations: recording().observations });
    const result = await running;
    expect(result.status).toBe("stopped");
    expect(result.stoppedAt).toBe(stopped.stoppedAt);
    expect(result.observations.map(item => item.observationId).sort()).toEqual(["first", "stop"]);
    expect((await store.load()).profiles).toEqual([]);
  });

  it("同一设备并发启动仅保留一个活动录制会话", async () => {
    const root = await fixture();
    const { store, service, provider } = serviceFixture(root);
    provider.mockResolvedValue({ status: "recording", observations: [] });
    const results = await Promise.allSettled([service.startRecording(device, "qa"), service.startRecording(device, "qa")]);
    expect(results.filter(item => item.status === "fulfilled")).toHaveLength(1);
    expect(results.find(item => item.status === "rejected")).toMatchObject({ reason: { code: "PAGE_PARAMETER_RECORDING_ACTIVE" } });
    expect((await store.load()).recordings).toHaveLength(1);
  });
});
