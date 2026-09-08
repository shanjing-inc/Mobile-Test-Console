import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import lockfile from "proper-lockfile";
import type { PageParameterExport, PageParameterProfile, PageParameterRecording } from "../shared/contracts.js";
import { parsePageParameterState } from "./page-parameter-state-schema.js";
import { ConsoleError } from "./errors.js";

const BACKUP_NAME = /^\d{13}-[a-f0-9-]{36}\.json$/;

export interface StoredPageParameters {
  schemaVersion: "mobile-test-console.page-parameter-state.v1";
  profiles: PageParameterProfile[];
  recordings: PageParameterRecording[];
  migratedPaths?: string[];
  notices?: string[];
}

export class PageParameterStore {
  readonly statePath: string;
  private readonly backupDir: string;

  constructor(private readonly stateDir: string, private readonly legacyDirectories: string[] = []) {
    this.statePath = path.resolve(stateDir, "page-parameters.json");
    this.backupDir = path.join(stateDir, "page-parameter-backups");
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

  async load(): Promise<StoredPageParameters> {
    return this.locked(() => this.loadUnlocked());
  }

  async exportData(): Promise<PageParameterExport> {
    const { schemaVersion, profiles, recordings } = await this.load();
    return { schemaVersion, profiles, recordings };
  }

  async importData(value: unknown): Promise<void> {
    const incoming = parsePageParameterState(value);
    await this.update(current => { mergeStates(current, incoming, true); });
  }

  private decode(content: string): StoredPageParameters {
    let value: unknown;
    try { value = JSON.parse(content); } catch {
      throw new ConsoleError("PAGE_PARAMETER_STATE_INVALID", "页面参数文件包含无效 JSON", 409);
    }
    const payload = parsePageParameterState(value);
    return payload;
  }

  private async loadUnlocked(): Promise<StoredPageParameters> {
    let state: StoredPageParameters;
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
        if (version !== undefined && version !== "mobile-test-console.page-parameter-state.v1") throw error;
      }
      const backup = await this.latestValidBackup();
      if (!backup) {
        if (!missing) throw new ConsoleError("PAGE_PARAMETER_STATE_INVALID", "页面参数文件损坏，原文件已保留。请检查备份后恢复。", 409);
        state = emptyState();
      } else {
        if (original !== undefined) await this.writeExclusive(path.join(this.stateDir, `${Date.now()}-${randomUUID()}.corrupt`), original);
        state = backup.state;
        state.notices = [...new Set([...(state.notices ?? []), `已从备份 ${backup.name} 恢复页面参数，请核对最近修改。`])];
        await this.writeUnlocked(state);
      }
    }
    const before = JSON.stringify(state);
    for (const directory of this.legacyDirectories) {
      const source = path.resolve(directory, "page-parameters.json");
      if (source === this.statePath || state.migratedPaths?.includes(source)) continue;
      try {
        const previous = this.decode(await fs.readFile(source, "utf8"));
        mergeStates(state, previous);
        state.notices = [...new Set([...(state.notices ?? []), `已迁移旧目录页面参数，原文件保留于 ${source}`])];
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
          if (!(error instanceof ConsoleError && error.code === "PAGE_PARAMETER_STATE_INVALID")) throw error;
          throw new ConsoleError("PAGE_PARAMETER_MIGRATION_FAILED", `旧页面参数文件迁移失败，原文件已保留：${source}`, 409);
        }
      }
      state.migratedPaths = [...(state.migratedPaths ?? []), source];
    }
    if (before !== JSON.stringify(state)) await this.writeUnlocked(state);
    if (original !== undefined && (await this.backupNames()).length === 0) await this.backup(original);
    return state;
  }

  async save(state: StoredPageParameters): Promise<void> {
    const snapshot = this.decode(JSON.stringify(state));
    await this.locked(async () => {
      const current = await this.loadUnlocked();
      snapshot.migratedPaths = [...new Set([...(current.migratedPaths ?? []), ...(snapshot.migratedPaths ?? [])])];
      snapshot.notices = [...new Set([...(current.notices ?? []), ...(snapshot.notices ?? [])])];
      await this.writeUnlocked(snapshot);
    });
  }

  async update<T>(mutator: (state: StoredPageParameters) => T | Promise<T>): Promise<T> {
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

  private async writeUnlocked(state: StoredPageParameters): Promise<void> {
    parsePageParameterState(state);
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

  private async latestValidBackup(): Promise<{ name: string; state: StoredPageParameters } | undefined> {
    for (const name of await this.backupNames()) {
      try { return { name, state: this.decode(await fs.readFile(path.join(this.backupDir, name), "utf8")) }; } catch (error) {
        // 仅跳过损坏或已移除的备份；权限与磁盘故障必须阻止空库写入。
        if ((error as NodeJS.ErrnoException).code !== "ENOENT"
          && !(error instanceof ConsoleError && error.code === "PAGE_PARAMETER_STATE_INVALID")) throw error;
      }
    }
    return undefined;
  }
}

function mergeStates(target: StoredPageParameters, source: StoredPageParameters, imported = false): void {
  for (const original of source.profiles) {
    const profile = structuredClone(original);
    const existing = target.profiles.find(item => item.pageId === profile.pageId && item.profileId === profile.profileId);
    if (existing && sameProfile(existing, profile)) continue;
    if (profile.isDefault && target.profiles.some(item => item.pageId === profile.pageId && item.isDefault)) profile.isDefault = false;
    if (existing) {
      const candidateId = `${original.profileId}-${imported ? "import" : "migrated"}-${digest({ ...original, isDefault: false })}`;
      profile.profileId = candidateId;
      let suffix = 1;
      while (target.profiles.some(item => item.pageId === profile.pageId && item.profileId === profile.profileId && !sameProfile(item, profile))) {
        profile.profileId = `${candidateId}-${suffix++}`;
      }
    }
    if (!target.profiles.some(item => item.pageId === profile.pageId && item.profileId === profile.profileId)) target.profiles.push(profile);
  }
  for (const original of source.recordings) {
    const recording = structuredClone(original);
    if (imported && (recording.status === "starting" || recording.status === "recording")) {
      recording.status = "failed";
      recording.error = "导入的录制会话已结束，请重新启动录制";
      recording.stoppedAt = recording.startedAt;
    }
    const existing = target.recordings.find(item => item.recordingId === recording.recordingId);
    if (existing && !isDeepStrictEqual(existing, recording)) {
      const candidateId = `${original.recordingId}-${imported ? "import" : "migrated"}-${digest(recording)}`;
      recording.recordingId = candidateId;
      let suffix = 1;
      while (target.recordings.some(item => item.recordingId === recording.recordingId && !isDeepStrictEqual(item, recording))) {
        recording.recordingId = `${candidateId}-${suffix++}`;
      }
    }
    if (!target.recordings.some(item => item.recordingId === recording.recordingId)) target.recordings.push(recording);
  }
}

function sameProfile(left: PageParameterProfile, right: PageParameterProfile): boolean {
  // 默认选择属于目标项目偏好；相同内容保留当前选择，避免产生重复副本。
  return isDeepStrictEqual({ ...left, isDefault: false }, { ...right, isDefault: false });
}

function digest(value: unknown): string {
  return createHash("sha256").update(stableJson(value)).digest("hex").slice(0, 16);
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`).join(",")}}`;
  return JSON.stringify(value);
}

function emptyState(): StoredPageParameters {
  return { schemaVersion: "mobile-test-console.page-parameter-state.v1", profiles: [], recordings: [] };
}
