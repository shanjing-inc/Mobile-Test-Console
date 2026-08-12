import fs from "node:fs/promises";
import path from "node:path";
import { appRunTargetOf, type TestTask } from "../shared/contracts.js";

interface StoredState {
  schemaVersion: "mobile-test-console.state.v1";
  tasks: TestTask[];
}

export class StateStore {
  private readonly statePath: string;
  private writeQueue = Promise.resolve();

  constructor(stateDir: string) {
    this.statePath = path.join(stateDir, "state.json");
  }

  async load(): Promise<TestTask[]> {
    try {
      const payload = JSON.parse(await fs.readFile(this.statePath, "utf8")) as StoredState;
      if (payload.schemaVersion !== "mobile-test-console.state.v1" || !Array.isArray(payload.tasks)) {
        return [];
      }
      const recoveredAt = new Date().toISOString();
      return payload.tasks.map(task => {
        const migrated = task.target ? task : { ...task, target: appRunTargetOf(task.device) };
        return ["queued", "preparing", "running"].includes(task.status)
          ? {
              ...migrated,
              status: "interrupted" as const,
              phase: "服务重启，任务已中断",
              finishedAt: recoveredAt,
              error: task.error || "控制服务在任务执行期间退出",
            }
          : migrated;
      });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
  }

  async save(tasks: TestTask[]): Promise<void> {
    const snapshot = structuredClone(tasks);
    this.writeQueue = this.writeQueue.then(async () => {
      await fs.mkdir(path.dirname(this.statePath), { recursive: true });
      const nextPath = `${this.statePath}.next`;
      await fs.writeFile(nextPath, `${JSON.stringify({
        schemaVersion: "mobile-test-console.state.v1",
        tasks: snapshot,
      }, null, 2)}\n`);
      await fs.rename(nextPath, this.statePath);
    });
    await this.writeQueue;
  }
}
