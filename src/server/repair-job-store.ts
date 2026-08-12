import fs from "node:fs/promises";
import path from "node:path";
import type { RepairJob } from "../shared/contracts.js";

interface StoredRepairJobs {
  schemaVersion: "mobile-test-console.repair-job-state.v1";
  jobs: RepairJob[];
}

export class RepairJobStore {
  private readonly statePath: string;
  private writeQueue = Promise.resolve();

  constructor(stateDir: string) {
    this.statePath = path.join(stateDir, "repair-jobs.json");
  }

  async load(): Promise<RepairJob[]> {
    try {
      const payload = JSON.parse(await fs.readFile(this.statePath, "utf8")) as Partial<StoredRepairJobs>;
      if (payload.schemaVersion !== "mobile-test-console.repair-job-state.v1" || !Array.isArray(payload.jobs)) return [];
      const recoveredAt = new Date().toISOString();
      return payload.jobs.map(job => {
        if (!["queued", "investigating", "fixing", "verifying", "waiting_device"].includes(job.status)) return job;
        return {
          ...job,
          status: "blocked" as const,
          updatedAt: recoveredAt,
          error: job.error || "控制服务在修复任务执行期间退出，请重试",
          events: [...job.events, {
            at: recoveredAt,
            status: "blocked" as const,
            message: "服务重启，修复任务已暂停，可从控制台重试",
          }],
        };
      });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
  }

  async save(jobs: RepairJob[]): Promise<void> {
    const snapshot = structuredClone(jobs);
    this.writeQueue = this.writeQueue.then(async () => {
      await fs.mkdir(path.dirname(this.statePath), { recursive: true });
      const nextPath = `${this.statePath}.next`;
      await fs.writeFile(nextPath, `${JSON.stringify({
        schemaVersion: "mobile-test-console.repair-job-state.v1",
        jobs: snapshot,
      }, null, 2)}\n`, { mode: 0o600 });
      await fs.chmod(nextPath, 0o600);
      await fs.rename(nextPath, this.statePath);
    });
    await this.writeQueue;
  }
}
