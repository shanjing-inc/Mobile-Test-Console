import { spawn } from "node:child_process";
import type { LoadedProjectConfig, ResolvedCommand } from "./config.js";
import { resolveLifecycleCommand } from "./config.js";
import { ConsoleError } from "./errors.js";

export class ProjectLifecycle {
  private started = false;

  constructor(
    private readonly config: LoadedProjectConfig,
    private readonly processId = process.pid,
  ) {}

  async startup(): Promise<void> {
    await this.run("startup", "项目准备");
    this.started = true;
  }

  async shutdown(): Promise<void> {
    if (!this.started) return;
    await this.cleanup();
    this.started = false;
  }

  async cleanup(): Promise<void> {
    await this.run("shutdown", "项目清理");
  }

  private async run(phase: "startup" | "shutdown", label: string): Promise<void> {
    const command = resolveLifecycleCommand(this.config, phase, this.processId);
    if (!command) return;

    process.stdout.write(`[lifecycle] ${label}: ${formatCommand(command)}\n`);
    const result = await spawnAndWait(command);
    if (result.error) {
      throw new ConsoleError(
        `LIFECYCLE_${phase.toUpperCase()}_FAILED`,
        `${label}失败: ${result.error.message}`,
      );
    }
    if (result.code !== 0) {
      throw new ConsoleError(
        `LIFECYCLE_${phase.toUpperCase()}_FAILED`,
        `${label}执行失败，退出码: ${result.code ?? "unknown"}`,
      );
    }
  }
}

function spawnAndWait(command: ResolvedCommand): Promise<{ code: number | null; error: Error | null }> {
  return new Promise(resolve => {
    const child = spawn(command.executable, command.args, {
      cwd: command.cwd,
      env: { ...process.env, ...command.env },
      shell: false,
      stdio: "inherit",
    });
    let settled = false;
    const finish = (code: number | null, error: Error | null) => {
      if (settled) return;
      settled = true;
      resolve({ code, error });
    };
    child.once("error", error => finish(null, error));
    child.once("exit", (code, signal) => finish(
      code,
      signal ? new Error(`进程被信号 ${signal} 终止`) : null,
    ));
  });
}

function formatCommand(command: ResolvedCommand): string {
  return [command.executable, ...command.args]
    .map(value => /^[A-Za-z0-9_./:=@+-]+$/.test(value) ? value : JSON.stringify(value))
    .join(" ");
}
