import fs from "node:fs/promises";
import path from "node:path";
import type { AccountProfile, AccountProfileProvider, AccountProfileProviderEntry, AccountProfileRecording } from "../shared/contracts.js";

const PROFILE_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export interface StoredAccountProfiles {
  schemaVersion: "mobile-test-console.account-profile-state.v1";
  profiles: AccountProfile[];
  recordings: AccountProfileRecording[];
}

export class AccountProfileStore {
  private readonly statePath: string;
  private writeQueue = Promise.resolve();
  private mutationQueue = Promise.resolve();

  constructor(stateDir: string) {
    this.statePath = path.join(stateDir, "account-profiles.json");
  }

  async load(): Promise<StoredAccountProfiles> {
    try {
      const payload = JSON.parse(await fs.readFile(this.statePath, "utf8")) as StoredAccountProfiles;
      if (payload.schemaVersion !== "mobile-test-console.account-profile-state.v1") return emptyState();
      await fs.chmod(this.statePath, 0o600);
      const storedProfiles = Array.isArray(payload.profiles) ? payload.profiles : [];
      const recordings = Array.isArray(payload.recordings) ? payload.recordings : [];
      const migration = recoverMissingProviderEntries(storedProfiles, recordings);
      const state: StoredAccountProfiles = {
        schemaVersion: payload.schemaVersion,
        profiles: migration.profiles,
        recordings,
      };
      if (migration.changed) await this.save(state);
      return state;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return emptyState();
      throw error;
    }
  }

  async save(state: StoredAccountProfiles): Promise<void> {
    const snapshot = structuredClone(state);
    this.writeQueue = this.writeQueue.then(async () => {
      await fs.mkdir(path.dirname(this.statePath), { recursive: true });
      const nextPath = `${this.statePath}.next`;
      await fs.writeFile(nextPath, `${JSON.stringify(snapshot, null, 2)}\n`, { mode: 0o600 });
      await fs.rename(nextPath, this.statePath);
      await fs.chmod(this.statePath, 0o600);
    });
    await this.writeQueue;
  }

  async update<T>(mutator: (state: StoredAccountProfiles) => T | Promise<T>): Promise<T> {
    const operation = this.mutationQueue.then(async () => {
      const state = await this.load();
      const result = await mutator(state);
      await this.save(state);
      return result;
    });
    this.mutationQueue = operation.then(() => undefined, () => undefined);
    return operation;
  }
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
): { profiles: AccountProfile[]; changed: boolean } {
  let changed = false;
  const profiles = storedProfiles.map(storedProfile => {
    const wasLegacy = !Array.isArray((storedProfile as AccountProfile).providerEntries);
    const profile = normalizeStoredProfile(storedProfile);
    if (wasLegacy) changed = true;

    const existingProviders = new Set(profile.providerEntries.map(item => item.provider));
    const latestByProvider = latestValidRecordings(profile, recordings);
    const recoveredEntries = [...latestByProvider.values()]
      .filter(recording => !existingProviders.has(recording.provider))
      .map(buildProviderEntryFromHistory);
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

function latestValidRecordings(profile: AccountProfile, recordings: AccountProfileRecording[]): Map<AccountProfileProvider, AccountProfileRecording> {
  const result = new Map<AccountProfileProvider, AccountProfileRecording>();
  recordings
    .filter(recording => recording.profileId === profile.profileId
      && recording.platform === profile.platform
      && recording.environment === profile.environment
      && recording.status === "stopped"
      && isCompleteRecording(recording))
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

function isCompleteRecording(recording: AccountProfileRecording): boolean {
  if (String(recording.error ?? "").trim() || !isValidTimestamp(recording.startedAt) || !isValidTimestamp(recording.stoppedAt)) return false;
  if (!Array.isArray(recording.captures) || recording.captures.length === 0 || recording.captures.some(item => !item || item.provider !== recording.provider)) return false;
  const nativeSuccess = recording.captures.some(item => item.kind === "native" && String(item.result?.result ?? "").trim().toLowerCase() === "success");
  if (!nativeSuccess) return false;
  return recording.provider === "taobao-commerce"
    || recording.captures.some(item => item.kind === "graphql" && findScalar(item.result, "uid") && findScalar(item.result, "session_key"));
}

function isValidTimestamp(value: string): boolean {
  return typeof value === "string" && value.length > 0 && Number.isFinite(Date.parse(value));
}

function buildProviderEntryFromHistory(recording: AccountProfileRecording): AccountProfileProviderEntry {
  const timestamp = recordingTimestamp(recording);
  const baseTime = Date.parse(timestamp);
  const capabilities = new Set<string>([recording.provider === "taobao-commerce" ? "taobao-commerce-auth" : "login"]);
  recording.captures.forEach(item => {
    if (item.module === "LynxAlibcLoginModule" && ["getSession", "login"].includes(String(item.method))) capabilities.add("taobao-session");
    if (item.module === "LynxAlibcLoginModule" && item.method === "oauth2") capabilities.add("taobao-oauth2");
  });
  return {
    provider: recording.provider,
    accountUid: recording.captures.map(item => findScalar(item.result, "uid")).find(Boolean) ?? "",
    sourceDeviceKey: recording.deviceKey,
    capabilities: [...capabilities].sort(),
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
