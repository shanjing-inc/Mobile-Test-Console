import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import lockfile from "proper-lockfile";
import { isDeepStrictEqual } from "node:util";
import type { AccountProfile, AccountProfileProvider, AccountProfileProviderEntry, AccountProfileRecording, AccountProfileStorageInfo, ProjectAdapterManifest } from "../shared/contracts.js";
import { EMPTY_PROJECT_ADAPTER } from "../shared/project-adapter-defaults.js";
import { accountProfileCapabilities, isCompleteAccountProfileRecording } from "./project-adapter.js";
import { parseAccountProfileState } from "./account-profile-state-schema.js";
import { ConsoleError } from "./errors.js";

const PROFILE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const BACKUP_NAME = /^\d{13}-[a-f0-9-]{36}\.json$/;

export interface StoredAccountProfiles {
  schemaVersion: "mobile-test-console.account-profile-state.v1";
  profiles: AccountProfile[];
  recordings: AccountProfileRecording[];
  migratedPaths?: string[];
  notices?: string[];
}

export class AccountProfileStore {
  readonly statePath: string;
  private readonly backupDir: string;

  constructor(
    private readonly stateDir: string,
    private readonly adapter: ProjectAdapterManifest = EMPTY_PROJECT_ADAPTER,
    private readonly legacyDirectories: string[] = [],
    private readonly storageId?: string,
  ) {
    this.statePath = path.join(stateDir, "account-profiles.json");
    this.backupDir = path.join(stateDir, "backups");
  }

  private async locked<T>(operation: () => Promise<T>): Promise<T> {
    await fs.mkdir(this.stateDir, { recursive: true, mode: 0o700 });
    const release = await lockfile.lock(this.stateDir, {
      realpath: true,
      stale: 30_000,
      retries: { retries: 100, factor: 1, minTimeout: 100, maxTimeout: 100 },
    });
    try { return await operation(); } finally { await release(); }
  }

  async load(): Promise<StoredAccountProfiles> {
    return this.locked(() => this.loadUnlocked());
  }

  private decode(content: string): StoredAccountProfiles {
    let value: unknown;
    try { value = JSON.parse(content); } catch {
      throw new ConsoleError("ACCOUNT_PROFILE_STATE_INVALID", "账号画像文件包含无效 JSON", 409);
    }
    const payload = parseAccountProfileState(value);
    return { ...payload, profiles: payload.profiles.map(normalizeStoredProfile) };
  }

  private async loadUnlocked(): Promise<StoredAccountProfiles> {
    let state: StoredAccountProfiles;
    let original: string | undefined;
    try {
      original = await fs.readFile(this.statePath, "utf8");
      state = this.decode(original);
      await fs.chmod(this.statePath, 0o600);
    } catch (error) {
      const missing = (error as NodeJS.ErrnoException).code === "ENOENT";
      if (!missing && !(error instanceof SyntaxError) && !(error instanceof ConsoleError)) throw error;
      // 新版格式保留给对应版本处理，避免用旧备份覆盖未来版本的数据。
      if (original) {
        let version: unknown;
        try { version = (JSON.parse(original) as { schemaVersion?: unknown }).schemaVersion; } catch { /* 损坏 JSON 进入备份恢复。 */ }
        if (version && version !== "mobile-test-console.account-profile-state.v1") throw error;
      }
      const backup = await this.latestValidBackup();
      if (!backup) {
        if (!missing) throw new ConsoleError("ACCOUNT_PROFILE_STATE_INVALID", "账号画像文件损坏，原文件已保留。请导入已导出的画像文件恢复。", 409);
        state = emptyState();
      } else {
        if (original !== undefined) await this.writeExclusive(path.join(this.stateDir, `${Date.now()}-${randomUUID()}.corrupt`), original);
        state = backup.state;
        state.notices = [...new Set([...(state.notices ?? []), `已从备份 ${backup.name} 恢复画像，请核对最近修改。`])];
        await this.writeUnlocked(state);
      }
    }
    const before = JSON.stringify(state);
    for (const directory of this.legacyDirectories) {
      const source = path.join(directory, "account-profiles.json");
      if (source === this.statePath || state.migratedPaths?.includes(source)) continue;
      try {
        const previous = this.decode(await fs.readFile(source, "utf8"));
        mergeStates(state, previous, false);
        state.notices = [...new Set([...(state.notices ?? []), `已迁移旧目录画像，原文件保留于 ${source}`])];
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
          throw new ConsoleError("ACCOUNT_PROFILE_MIGRATION_FAILED", `旧画像文件迁移失败，原文件已保留：${source}`, 409);
        }
      }
      state.migratedPaths = [...(state.migratedPaths ?? []), source];
    }
    const recovered = recoverMissingProviderEntries(state.profiles, state.recordings, this.adapter);
    state.profiles = recovered.profiles;
    const wasLegacy = original !== undefined && original.includes('"mobile-test-console.account-profile.v1"');
    if (wasLegacy || before !== JSON.stringify(state)) await this.writeUnlocked(state);
    if (original !== undefined && (await this.backupNames()).length === 0) await this.backup(original);
    return state;
  }

  async save(state: StoredAccountProfiles): Promise<void> {
    const snapshot = this.decode(JSON.stringify(state));
    await this.locked(() => this.writeUnlocked(snapshot));
  }

  async update<T>(mutator: (state: StoredAccountProfiles) => T | Promise<T>): Promise<T> {
    return this.locked(async () => {
      const state = await this.loadUnlocked();
      const result = await mutator(state);
      await this.writeUnlocked(state);
      return result;
    });
  }

  private async writeExclusive(filePath: string, content: string): Promise<void> {
    const handle = await fs.open(filePath, "wx", 0o600);
    try { await handle.writeFile(content); await handle.sync(); } finally { await handle.close(); }
  }

  private async writeUnlocked(state: StoredAccountProfiles): Promise<void> {
    parseAccountProfileState(state);
    const content = `${JSON.stringify(state, null, 2)}\n`;
    let previous: string | undefined;
    try { previous = await fs.readFile(this.statePath, "utf8"); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (previous === content) return;
    await this.backup(previous ?? content);
    const nextPath = `${this.statePath}.${randomUUID()}.next`;
    try {
      await this.writeExclusive(nextPath, content);
      await fs.rename(nextPath, this.statePath);
      if (process.platform !== "win32") {
        const directory = await fs.open(this.stateDir, "r");
        try { await directory.sync(); } finally { await directory.close(); }
      }
    } finally { await fs.rm(nextPath, { force: true }); }
  }

  private async backup(content: string): Promise<void> {
    await fs.mkdir(this.backupDir, { recursive: true, mode: 0o700 });
    const lastBackup = (await this.backupNames())[0];
    const timestamp = Math.max(Date.now(), lastBackup ? Number(lastBackup.slice(0, 13)) + 1 : 0);
    await this.writeExclusive(path.join(this.backupDir, `${timestamp}-${randomUUID()}.json`), content);
    if (process.platform !== "win32") {
      const directory = await fs.open(this.backupDir, "r");
      try { await directory.sync(); } finally { await directory.close(); }
    }
  }

  private async backupNames(): Promise<string[]> {
    try { return (await fs.readdir(this.backupDir)).filter(name => BACKUP_NAME.test(name)).sort().reverse(); } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
  }

  private async latestValidBackup(): Promise<{ name: string; state: StoredAccountProfiles } | undefined> {
    for (const name of await this.backupNames()) {
      try { return { name, state: this.decode(await fs.readFile(path.join(this.backupDir, name), "utf8")) }; } catch (error) {
        // 仅跳过损坏或已移除的备份；权限与磁盘故障必须阻止空库写入。
        if ((error as NodeJS.ErrnoException).code !== "ENOENT"
          && !(error instanceof ConsoleError && error.code === "ACCOUNT_PROFILE_STATE_INVALID")) throw error;
      }
    }
    return undefined;
  }

  async storageInfo(): Promise<AccountProfileStorageInfo> {
    return {
      id: this.storageId,
      directory: this.stateDir,
      backups: (await this.backupNames()).map(id => ({ id, createdAt: new Date(Number(id.slice(0, 13))).toISOString() })),
    };
  }

  async exportData() {
    const { profiles, recordings } = await this.load();
    return { schemaVersion: "mobile-test-console.account-profile-state.v1" as const, profiles, recordings };
  }

  async importData(value: unknown): Promise<void> {
    const incoming = this.decode(JSON.stringify(value));
    incoming.profiles = recoverMissingProviderEntries(incoming.profiles, incoming.recordings, this.adapter).profiles;
    await this.locked(async () => {
      let current: StoredAccountProfiles;
      try { current = await this.loadUnlocked(); } catch (error) {
        if (!(error instanceof ConsoleError) || error.code !== "ACCOUNT_PROFILE_STATE_INVALID") throw error;
        // 用户显式导入可恢复损坏主文件；writeUnlocked 会先完整备份原字节。
        current = emptyState();
      }
      mergeStates(current, incoming, true);
      await this.writeUnlocked(current);
    });
  }

  async restoreBackup(id: string): Promise<void> {
    if (!BACKUP_NAME.test(id)) throw new ConsoleError("ACCOUNT_PROFILE_BACKUP_INVALID", "备份标识无效", 400);
    let content: string;
    try { content = await fs.readFile(path.join(this.backupDir, id), "utf8"); } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new ConsoleError("ACCOUNT_PROFILE_BACKUP_UNKNOWN", "备份不存在", 404);
      throw error;
    }
    await this.importData(this.decode(content));
  }
}

function mergeStates(target: StoredAccountProfiles, source: StoredAccountProfiles, imported: boolean): void {
  const profileIds = new Map<string, string>();
  for (const original of source.profiles) {
    const profile = structuredClone(original);
    const existing = target.profiles.find(item => item.profileId === profile.profileId);
    if (existing && !isDeepStrictEqual(existing, profile)) {
      const digest = createHash("sha256").update(stableJson(profile)).digest("hex").slice(0, 16);
      profile.profileId = `${original.profileId}-import-${digest}`;
      profile.accountLabel = `${profile.accountLabel}（导入副本）`;
      const candidateId = profile.profileId;
      let suffix = 1;
      while (target.profiles.some(item => item.profileId === profile.profileId && !isDeepStrictEqual(item, profile))) {
        profile.profileId = `${candidateId}-${suffix++}`;
      }
    }
    profileIds.set(original.profileId, profile.profileId);
    if (!target.profiles.some(item => item.profileId === profile.profileId)) target.profiles.push(profile);
  }
  for (const original of source.recordings) {
    const recording = structuredClone(original);
    recording.profileId = profileIds.get(recording.profileId) ?? recording.profileId;
    if (imported && (recording.status === "starting" || recording.status === "recording")) {
      recording.status = "failed";
      recording.error = "导入的录制会话已结束，请重新启动录制";
      recording.stoppedAt = recording.startedAt;
    }
    const existing = target.recordings.find(item => item.recordingId === recording.recordingId);
    if (existing && !isDeepStrictEqual(existing, recording)) {
      recording.recordingId = `${recording.recordingId}-import-${createHash("sha256").update(stableJson(recording)).digest("hex").slice(0, 16)}`;
    }
    const candidateId = recording.recordingId;
    let suffix = 1;
    while (target.recordings.some(item => item.recordingId === recording.recordingId && !isDeepStrictEqual(item, recording))) {
      recording.recordingId = `${candidateId}-${suffix++}`;
    }
    if (!target.recordings.some(item => item.recordingId === recording.recordingId)) target.recordings.push(recording);
  }
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`).join(",")}}`;
  return JSON.stringify(value);
}

function emptyState(): StoredAccountProfiles {
  return {
    schemaVersion: "mobile-test-console.account-profile-state.v1",
    profiles: [],
    recordings: [],
  };
}

function normalizeStoredProfile(profile: AccountProfile | Record<string, unknown>): AccountProfile {
  if (Array.isArray((profile as AccountProfile).providerEntries)) return profile as AccountProfile;
  const legacy = profile as Record<string, unknown>;
  return {
    schemaVersion: "mobile-test-console.account-profile.v2",
    profileId: String(legacy.profileId ?? ""),
    accountLabel: String(legacy.accountLabel ?? ""),
    platform: legacy.platform as AccountProfile["platform"],
    environment: String(legacy.environment ?? ""),
    providerEntries: [{
      provider: legacy.provider as AccountProfile["providerEntries"][number]["provider"],
      accountUid: String(legacy.accountUid ?? ""),
      sourceDeviceKey: String(legacy.sourceDeviceKey ?? ""),
      capabilities: Array.isArray(legacy.capabilities) ? legacy.capabilities.map(String) : [],
      captures: Array.isArray(legacy.captures) ? legacy.captures as AccountProfile["providerEntries"][number]["captures"] : [],
      recordedAt: String(legacy.recordedAt ?? ""),
      validatedAt: String(legacy.validatedAt ?? ""),
      expiresAt: String(legacy.expiresAt ?? ""),
    }],
    version: 2,
  };
}

function recoverMissingProviderEntries(
  storedProfiles: Array<AccountProfile | Record<string, unknown>>,
  recordings: AccountProfileRecording[],
  adapter: ProjectAdapterManifest,
): { profiles: AccountProfile[]; changed: boolean } {
  let changed = false;
  const profiles = storedProfiles.map(storedProfile => {
    const wasLegacy = !Array.isArray((storedProfile as AccountProfile).providerEntries);
    const profile = normalizeStoredProfile(storedProfile);
    if (wasLegacy) changed = true;

    const existingProviders = new Set(profile.providerEntries.map(item => item.provider));
    const latestByProvider = latestValidRecordings(profile, recordings, adapter);
    const recoveredEntries = [...latestByProvider.values()]
      .filter(recording => !existingProviders.has(recording.provider))
      .map(recording => buildProviderEntryFromHistory(recording, adapter));
    if (recoveredEntries.length === 0) return profile;
    changed = true;
    return {
      ...profile,
      providerEntries: [...profile.providerEntries, ...recoveredEntries]
        .sort((left, right) => left.provider.localeCompare(right.provider)),
    };
  });
  return { profiles, changed };
}

function latestValidRecordings(profile: AccountProfile, recordings: AccountProfileRecording[], adapter: ProjectAdapterManifest): Map<AccountProfileProvider, AccountProfileRecording> {
  const result = new Map<AccountProfileProvider, AccountProfileRecording>();
  recordings
    .filter(recording => recording.profileId === profile.profileId
      && recording.platform === profile.platform
      && recording.environment === profile.environment
      && recording.status === "stopped"
      && isCompleteRecording(recording, adapter))
    .sort((left, right) => compareRecordingRecency(right, left))
    .forEach(recording => {
      if (!result.has(recording.provider)) result.set(recording.provider, recording);
    });
  return result;
}

function compareRecordingRecency(left: AccountProfileRecording, right: AccountProfileRecording): number {
  const timestampOrder = recordingTimestamp(left).localeCompare(recordingTimestamp(right));
  if (timestampOrder !== 0) return timestampOrder;
  const startedOrder = left.startedAt.localeCompare(right.startedAt);
  return startedOrder !== 0 ? startedOrder : left.recordingId.localeCompare(right.recordingId);
}

function recordingTimestamp(recording: AccountProfileRecording): string {
  return recording.stoppedAt || recording.startedAt;
}

function isCompleteRecording(recording: AccountProfileRecording, adapter: ProjectAdapterManifest): boolean {
  if (String(recording.error ?? "").trim() || !isValidTimestamp(recording.startedAt) || !isValidTimestamp(recording.stoppedAt)) return false;
  if (!Array.isArray(recording.captures) || recording.captures.length === 0 || recording.captures.some(item => !item || item.provider !== recording.provider)) return false;
  const nativeSuccess = recording.captures.some(item => item.kind === "native" && String(item.result?.result ?? "").trim().toLowerCase() === "success");
  if (!nativeSuccess) return false;
  return isCompleteAccountProfileRecording(adapter.accountProfiles.providers[recording.provider], recording.captures);
}

function isValidTimestamp(value: string): boolean {
  return typeof value === "string" && value.length > 0 && Number.isFinite(Date.parse(value));
}

function buildProviderEntryFromHistory(recording: AccountProfileRecording, adapter: ProjectAdapterManifest): AccountProfileProviderEntry {
  const timestamp = recordingTimestamp(recording);
  const baseTime = Date.parse(timestamp);
  const capabilities = accountProfileCapabilities(adapter.accountProfiles.providers[recording.provider], recording.captures);
  return {
    provider: recording.provider,
    accountUid: recording.captures.map(item => findScalar(item.result, "uid")).find(Boolean) ?? "",
    sourceDeviceKey: recording.deviceKey,
    capabilities,
    captures: recording.captures,
    recordedAt: recording.startedAt,
    validatedAt: "",
    expiresAt: new Date((Number.isFinite(baseTime) ? baseTime : Date.now()) + PROFILE_TTL_MS).toISOString(),
  };
}

function findScalar(value: unknown, key: string): string {
  if (!value || typeof value !== "object") return "";
  if (!Array.isArray(value) && key in value) return String((value as Record<string, unknown>)[key] ?? "").trim();
  for (const item of Object.values(value as Record<string, unknown>)) {
    const found = findScalar(item, key);
    if (found) return found;
  }
  return "";
}
