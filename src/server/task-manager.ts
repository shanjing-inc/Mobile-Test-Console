import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { ACTIVE_TASK_STATUSES, type Device, type StartTasksRequest, type TestTask } from "../shared/contracts.js";
import {
  resolveCommand,
  validateParameters,
  type LoadedProjectConfig,
  type TestDefinition,
} from "./config.js";
import { ConsoleError } from "./errors.js";
import { StateStore } from "./state-store.js";

const ACTIVE_STATUSES = new Set(ACTIVE_TASK_STATUSES);
const MAX_TASKS = 100;
const MAX_LOG_LINES = 500;
const MAX_LOG_LINE_LENGTH = 4_000;

export class TaskManager {
  private readonly tasks = new Map<string, TestTask>();
  private readonly processes = new Map<string, ChildProcess>();
  private readonly cancelRequests = new Set<string>();
  private persistTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly config: LoadedProjectConfig,
    private readonly store: StateStore,
  ) {}

  async initialize(): Promise<void> {
    for (const task of await this.store.load()) {
      this.tasks.set(task.id, task);
    }
    await this.persistNow();
  }

  list(): TestTask[] {
    return [...this.tasks.values()]
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
      .slice(0, MAX_TASKS)
      .map(task => structuredClone(task));
  }

  async start(request: StartTasksRequest, devices: Device[]): Promise<TestTask[]> {
    const test = this.config.tests.find(item => item.id === request.testId);
    if (!test) throw new ConsoleError("TEST_UNKNOWN", `测试不存在: ${request.testId}`, 404);
    const parameters = validateParameters(test, request.parameters ?? {});
    const uniqueKeys = [...new Set(request.deviceKeys)];
    if (uniqueKeys.length === 0) throw new ConsoleError("DEVICE_REQUIRED", "请至少选择一台设备");

    const selected = uniqueKeys.map(key => {
      const device = devices.find(item => item.key === key);
      if (!device) throw new ConsoleError("DEVICE_UNKNOWN", `设备当前未连接: ${key}`, 404);
      if (device.connectionState !== "available") {
        throw new ConsoleError("DEVICE_UNAVAILABLE", `设备当前不可用: ${device.name}`, 409);
      }
      if (!test.platforms.includes(device.platform)) {
        throw new ConsoleError("PLATFORM_UNSUPPORTED", `${test.label} 不支持 ${device.platform}`);
      }
      const active = this.list().find(task => task.device.key === key && ACTIVE_STATUSES.has(task.status));
      if (active) throw new ConsoleError("DEVICE_BUSY", `${device.name} 正在执行 ${active.testLabel}`, 409);
      return device;
    });

    const createdAt = new Date().toISOString();
    const tasks = selected.map(device => this.createTask(test, device, parameters, createdAt));
    for (const task of tasks) this.tasks.set(task.id, task);
    await this.persistNow();
    for (const task of tasks) queueMicrotask(() => void this.execute(task.id, test));
    return tasks.map(task => structuredClone(task));
  }

  async stop(taskId: string): Promise<TestTask> {
    const task = this.tasks.get(taskId);
    if (!task) throw new ConsoleError("TASK_UNKNOWN", `任务不存在: ${taskId}`, 404);
    if (!ACTIVE_STATUSES.has(task.status)) return structuredClone(task);

    this.cancelRequests.add(taskId);
    task.phase = "正在停止";
    this.appendLog(task, "[console] 收到停止请求");
    const child = this.processes.get(taskId);
    if (child?.pid) {
      this.killProcessTree(child.pid, "SIGTERM");
      const pid = child.pid;
      setTimeout(() => {
        if (this.processes.has(taskId)) this.killProcessTree(pid, "SIGKILL");
      }, 3_000).unref();
    }
    await this.persistNow();
    return structuredClone(task);
  }

  async shutdown(): Promise<void> {
    const activeIds = [...this.processes.keys()];
    await Promise.all(activeIds.map(taskId => this.stop(taskId)));
    const deadline = Date.now() + 3_500;
    while (this.processes.size > 0 && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    await this.persistNow();
  }

  private createTask(
    test: TestDefinition,
    device: Device,
    parameters: Record<string, string>,
    createdAt: string,
  ): TestTask {
    const id = randomUUID();
    const compactTime = createdAt.replace(/[-:.TZ]/g, "").slice(0, 14);
    return {
      id,
      runId: `${this.config.project.id}-${compactTime}-${id.slice(0, 8)}`,
      projectId: this.config.project.id,
      testId: test.id,
      testLabel: test.label,
      device,
      parameters: { ...parameters },
      status: "queued",
      phase: "等待执行",
      createdAt,
      startedAt: "",
      finishedAt: "",
      exitCode: null,
      error: "",
      logs: [],
    };
  }

  private async execute(taskId: string, test: TestDefinition): Promise<void> {
    const task = this.tasks.get(taskId);
    if (!task || this.cancelRequests.has(taskId)) {
      if (task) await this.finalize(task, "cancelled", null, "");
      return;
    }

    task.status = "preparing";
    task.phase = "准备命令";
    task.startedAt = new Date().toISOString();
    this.appendLog(task, `[console] 开始 ${task.testLabel} · ${task.device.name}`);
    this.schedulePersist();

    try {
      const command = resolveCommand(this.config, test, task.device, task, task.parameters);
      this.appendLog(task, `[console] cwd: ${command.cwd}`);
      this.appendLog(task, `[console] command: ${formatCommand(command.executable, command.args)}`);
      if (this.cancelRequests.has(taskId)) {
        await this.finalize(task, "cancelled", null, "");
        return;
      }

      const child = spawn(command.executable, command.args, {
        cwd: command.cwd,
        env: { ...process.env, ...command.env },
        shell: false,
        detached: process.platform !== "win32",
        stdio: ["ignore", "pipe", "pipe"],
      });
      const completion = waitForProcess(child);
      this.processes.set(taskId, child);
      task.status = "running";
      task.phase = "执行中";
      this.bindLogs(task, child);
      await this.persistNow();

      const result = await completion;
      this.processes.delete(taskId);
      if (this.cancelRequests.has(taskId)) {
        await this.finalize(task, "cancelled", result.code, "");
      } else if (result.error) {
        await this.finalize(task, "failed", result.code, result.error.message);
      } else if (result.code === 0) {
        await this.finalize(task, "passed", 0, "");
      } else {
        await this.finalize(task, "failed", result.code, `测试进程退出码: ${result.code ?? "unknown"}`);
      }
    } catch (error) {
      this.processes.delete(taskId);
      const message = error instanceof Error ? error.message : String(error);
      await this.finalize(task, this.cancelRequests.has(taskId) ? "cancelled" : "failed", null, message);
    }
  }

  private bindLogs(task: TestTask, child: ChildProcess): void {
    child.stdout?.on("data", chunk => this.appendChunk(task, String(chunk)));
    child.stderr?.on("data", chunk => this.appendChunk(task, String(chunk), "stderr"));
  }

  private appendChunk(task: TestTask, chunk: string, source = "stdout"): void {
    if (!ACTIVE_STATUSES.has(task.status)) return;
    const lines = chunk.replace(/\r/g, "").split("\n").filter(Boolean);
    for (const line of lines) this.appendLog(task, source === "stderr" ? `[stderr] ${line}` : line);
    this.schedulePersist();
  }

  private appendLog(task: TestTask, line: string): void {
    task.logs.push(String(line).slice(0, MAX_LOG_LINE_LENGTH));
    if (task.logs.length > MAX_LOG_LINES) task.logs.splice(0, task.logs.length - MAX_LOG_LINES);
  }

  private async finalize(
    task: TestTask,
    status: "passed" | "failed" | "cancelled",
    exitCode: number | null,
    error: string,
  ): Promise<void> {
    task.status = status;
    task.phase = status === "passed" ? "测试通过" : status === "cancelled" ? "已取消" : "测试失败";
    task.finishedAt = new Date().toISOString();
    task.exitCode = exitCode;
    task.error = error;
    if (error) this.appendLog(task, `[console] ${error}`);
    this.appendLog(task, `[console] 任务结束: ${status}`);
    this.cancelRequests.delete(task.id);
    await this.persistNow();
  }

  private schedulePersist(): void {
    if (this.persistTimer) return;
    this.persistTimer = setTimeout(() => {
      this.persistTimer = null;
      void this.persistNow();
    }, 100);
  }

  private async persistNow(): Promise<void> {
    if (this.persistTimer) {
      clearTimeout(this.persistTimer);
      this.persistTimer = null;
    }
    const tasks = this.list();
    await this.store.save(tasks);
  }

  private killProcessTree(pid: number, signal: NodeJS.Signals): void {
    try {
      if (process.platform === "win32") {
        const killer = spawn("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore" });
        killer.unref();
      } else {
        process.kill(-pid, signal);
      }
    } catch {
      try {
        process.kill(pid, signal);
      } catch {
        // 进程已经退出时无需继续处理。
      }
    }
  }
}

function waitForProcess(child: ChildProcess): Promise<{ code: number | null; error: Error | null }> {
  return new Promise(resolve => {
    let settled = false;
    const finish = (code: number | null, error: Error | null) => {
      if (settled) return;
      settled = true;
      resolve({ code, error });
    };
    child.once("error", error => finish(null, error));
    child.once("close", code => finish(code, null));
  });
}

function formatCommand(executable: string, args: string[]): string {
  return [executable, ...args].map(value => /^[A-Za-z0-9_./:@%+=,-]+$/.test(value) ? value : JSON.stringify(value)).join(" ");
}
