import fs from "node:fs/promises";
import path from "node:path";
import type {
  BusinessScriptDraft,
  BusinessScriptRecording,
  BusinessSuite,
  PublishedBusinessScript,
} from "../shared/contracts.js";

export interface StoredBusinessScripts {
  schemaVersion: "mobile-test-console.business-script-state.v1";
  recordings: BusinessScriptRecording[];
  drafts: BusinessScriptDraft[];
  scripts: PublishedBusinessScript[];
  suites: BusinessSuite[];
  versionCounters: Record<string, number>;
}

export class BusinessScriptStore {
  private readonly statePath: string;
  private writeQueue = Promise.resolve();
  private mutationQueue = Promise.resolve();

  constructor(stateDir: string) {
    this.statePath = path.join(stateDir, "business-scripts.json");
  }

  async load(): Promise<StoredBusinessScripts> {
    try {
      const payload = JSON.parse(await fs.readFile(this.statePath, "utf8")) as StoredBusinessScripts;
      if (payload.schemaVersion !== "mobile-test-console.business-script-state.v1") return emptyState();
      return {
        schemaVersion: payload.schemaVersion,
        recordings: Array.isArray(payload.recordings) ? payload.recordings : [],
        drafts: Array.isArray(payload.drafts) ? payload.drafts : [],
        scripts: Array.isArray(payload.scripts) ? payload.scripts : [],
        suites: Array.isArray(payload.suites) ? payload.suites : [],
        versionCounters: payload.versionCounters && typeof payload.versionCounters === "object"
          ? payload.versionCounters
          : {},
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return emptyState();
      throw error;
    }
  }

  async save(state: StoredBusinessScripts): Promise<void> {
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

  async update<T>(mutator: (state: StoredBusinessScripts) => T | Promise<T>): Promise<T> {
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

function emptyState(): StoredBusinessScripts {
  return {
    schemaVersion: "mobile-test-console.business-script-state.v1",
    recordings: [],
    drafts: [],
    scripts: [],
    suites: [],
    versionCounters: {},
  };
}
