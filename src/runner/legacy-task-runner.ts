import { spawn, type ChildProcess } from "node:child_process";
import type { ResolvedCommand } from "../server/config.js";
import type { ConnectorCapabilityManifest, TestTask } from "../shared/contracts.js";
import {
  type DeviceConnector,
  createRunPlan,
  createRunnerEvent,
  type InProcessRunner,
  LEGACY_COMMAND_RUNNER_ID,
  type RunPlan,
  type RunnerCommand,
  type RunnerContext,
  type RunnerResult,
  validateCapabilityManifest,
  validateRunnerId,
} from "./sdk.js";

const MAX_LOG_LINE_LENGTH = 4_000;

/**
 * 将 mobile-test-console.config.v1 的 executable/args 命令包装成 Runner SDK。
 * 该 facade 保留旧命令 runner 的 stdout/stderr、退出码和取消语义，便于逐任务切换 sdk 模式。
 */
export class CommandTaskRunner implements InProcessRunner {
  readonly id: string;
  private readonly processes = new Map<string, ChildProcess>();
  private readonly cancelledRuns = new Set<string>();
  private readonly terminationTimers = new Map<string, NodeJS.Timeout>();

  constructor(id = LEGACY_COMMAND_RUNNER_ID) {
    validateRunnerId(id);
    this.id = id;
  }

  async run(plan: RunPlan, context: RunnerContext): Promise<RunnerResult> {
    if (!plan.command) {
      const error = this.id === LEGACY_COMMAND_RUNNER_ID
        ? "legacy runner 缺少执行命令"
        : "命令 Runner 缺少执行命令";
      context.emit(createRunnerEvent(plan.runId, "error", { source: "runner", level: "error", message: error }));
      return { runId: plan.runId, status: "failed", exitCode: null, error };
    }

    const command = plan.command;
    context.emit(createRunnerEvent(plan.runId, "status", {
      source: "runner",
      message: this.id === LEGACY_COMMAND_RUNNER_ID ? "准备 legacy 命令" : "准备执行命令",
      data: { executable: command.executable, args: command.args },
    }));
    if (context.signal.aborted) return this.cancelled(plan.runId, context);

    const child = spawn(command.executable, command.args, {
      cwd: command.cwd,
      env: { ...process.env, ...command.env },
      shell: false,
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
    });
    this.processes.set(plan.runId, child);
    const abort = () => this.cancel(plan.runId);
    context.signal.addEventListener("abort", abort, { once: true });
    context.emit(createRunnerEvent(plan.runId, "status", { source: "runner", message: "执行中" }));
    this.bindOutput(plan.runId, child, context, "stdout");
    this.bindOutput(plan.runId, child, context, "stderr");

    try {
      const result = await waitForProcess(child);
      const cancelled = context.signal.aborted || this.cancelledRuns.has(plan.runId);
      if (cancelled) return this.cancelled(plan.runId, context, result.code);
      if (result.error) {
        const message = result.error.message;
        context.emit(createRunnerEvent(plan.runId, "error", { source: "runner", level: "error", message }));
        return { runId: plan.runId, status: "failed", exitCode: result.code, error: message };
      }
      if (result.code === 0) {
        context.emit(createRunnerEvent(plan.runId, "result", {
          source: "runner",
          message: this.id === LEGACY_COMMAND_RUNNER_ID ? "legacy 命令完成" : "命令执行完成",
          data: { exitCode: 0 },
        }));
        return { runId: plan.runId, status: "passed", exitCode: 0 };
      }
      const error = `测试进程退出码: ${result.code ?? "unknown"}`;
      context.emit(createRunnerEvent(plan.runId, "error", { source: "runner", level: "error", message: error }));
      return { runId: plan.runId, status: "failed", exitCode: result.code, error };
    } finally {
      context.signal.removeEventListener("abort", abort);
      this.processes.delete(plan.runId);
      this.cancelledRuns.delete(plan.runId);
      const timer = this.terminationTimers.get(plan.runId);
      if (timer) clearTimeout(timer);
      this.terminationTimers.delete(plan.runId);
    }
  }

  cancel(runId: string): void {
    const child = this.processes.get(runId);
    if (child) {
      this.cancelledRuns.add(runId);
      this.killProcessTree(child.pid, "SIGTERM");
      if (this.terminationTimers.has(runId)) return;
      const timer = setTimeout(() => {
        if (this.processes.get(runId) === child) this.killProcessTree(child.pid, "SIGKILL");
        this.terminationTimers.delete(runId);
      }, 3_000);
      timer.unref();
      this.terminationTimers.set(runId, timer);
    }
  }

  async shutdown(): Promise<void> {
    for (const [runId] of this.processes) this.cancel(runId);
  }

  private bindOutput(runId: string, child: ChildProcess, context: RunnerContext, source: "stdout" | "stderr"): void {
    child[source]?.on("data", chunk => {
      const lines = String(chunk).replace(/\r/g, "").split("\n").filter(Boolean);
      for (const line of lines) {
        context.emit(createRunnerEvent(runId, "log", {
          source,
          level: source === "stderr" ? "warn" : "info",
          message: line.slice(0, MAX_LOG_LINE_LENGTH),
        }));
      }
    });
  }

  private cancelled(runId: string, context: RunnerContext, exitCode: number | null = null): RunnerResult {
    context.emit(createRunnerEvent(runId, "cancelled", { source: "runner", message: "任务已取消" }));
    return { runId, status: "cancelled", exitCode };
  }

  private killProcessTree(pid: number | undefined, signal: NodeJS.Signals): void {
    if (!pid) return;
    try {
      if (process.platform === "win32") {
        const killer = spawn("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore" });
        killer.unref();
      } else {
        process.kill(-pid, signal);
      }
    } catch {
      try { process.kill(pid, signal); } catch { /* 进程已结束 */ }
    }
  }
}

export class LegacyTaskRunner extends CommandTaskRunner {
  constructor() {
    super(LEGACY_COMMAND_RUNNER_ID);
  }
}

export function toRunnerCommand(command: ResolvedCommand | RunnerCommand): RunnerCommand {
  return {
    executable: command.executable,
    args: [...command.args],
    ...(command.cwd ? { cwd: command.cwd } : {}),
    ...(command.env ? { env: { ...command.env } } : {}),
  };
}

export function createLegacyRunPlan(task: TestTask, command: ResolvedCommand): RunPlan {
  return createRunPlan(task, toRunnerCommand(command));
}

/**
 * 将旧设备 provider 与命令 runner 组合成 connector，供 SDK registry 使用。
 * 设备发现仍由现有 provider 负责，执行和取消统一转发到 LegacyTaskRunner。
 */
export interface LegacyTaskRunnerConnector extends DeviceConnector {
  readonly runner: LegacyTaskRunner;
}

export function createLegacyTaskRunnerConnector(options: {
  id: string;
  manifest: ConnectorCapabilityManifest;
  discover: DeviceConnector["discover"];
  runner?: LegacyTaskRunner;
}): LegacyTaskRunnerConnector {
  const manifest = { ...structuredClone(options.manifest), connectorId: options.id };
  validateCapabilityManifest(manifest);
  const runner = options.runner ?? new LegacyTaskRunner();
  return {
    id: options.id,
    manifest,
    runner,
    discover: options.discover,
    healthCheck: async device => ({ ok: device.connectionState === "available", detail: device.detail }),
    cancel: runId => runner.cancel(runId),
  };
}

/** 旧名称保留给迁移期项目适配器。 */
export { LegacyTaskRunner as LegacyCommandRunner };

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
