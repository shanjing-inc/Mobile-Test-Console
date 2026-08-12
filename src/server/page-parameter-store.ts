import fs from "node:fs/promises";
import path from "node:path";
import type { PageParameterProfile, PageParameterRecording } from "../shared/contracts.js";

interface StoredPageParameters {
  schemaVersion: "mobile-test-console.page-parameter-state.v1";
  profiles: PageParameterProfile[];
  recordings: PageParameterRecording[];
}

export class PageParameterStore {
  private readonly statePath: string;
  private writeQueue = Promise.resolve();

  constructor(stateDir: string) {
    this.statePath = path.join(stateDir, "page-parameters.json");
  }

  async load(): Promise<StoredPageParameters> {
    try {
      const payload = JSON.parse(await fs.readFile(this.statePath, "utf8")) as StoredPageParameters;
      if (payload.schemaVersion !== "mobile-test-console.page-parameter-state.v1") return emptyState();
      return {
        schemaVersion: payload.schemaVersion,
        profiles: Array.isArray(payload.profiles) ? payload.profiles : [],
        recordings: Array.isArray(payload.recordings) ? payload.recordings : [],
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return emptyState();
      throw error;
    }
  }

  async save(state: StoredPageParameters): Promise<void> {
    const snapshot = structuredClone(state);
    this.writeQueue = this.writeQueue.then(async () => {
      await fs.mkdir(path.dirname(this.statePath), { recursive: true });
      const nextPath = `${this.statePath}.next`;
      await fs.writeFile(nextPath, `${JSON.stringify(snapshot, null, 2)}\n`, { mode: 0o600 });
      await fs.rename(nextPath, this.statePath);
    });
    await this.writeQueue;
  }
}

function emptyState(): StoredPageParameters {
  return {
    schemaVersion: "mobile-test-console.page-parameter-state.v1",
    profiles: [],
    recordings: [],
  };
}
