import { execFile } from "node:child_process";

export interface CommandResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface CommandRunner {
  capture(executable: string, args: string[], timeoutMs?: number): Promise<CommandResult>;
}

export class SystemCommandRunner implements CommandRunner {
  capture(executable: string, args: string[], timeoutMs = 15_000): Promise<CommandResult> {
    return new Promise(resolve => {
      execFile(executable, args, {
        encoding: "utf8",
        timeout: timeoutMs,
        maxBuffer: 16 * 1024 * 1024,
      }, (error, stdout, stderr) => {
        const code = typeof (error as NodeJS.ErrnoException & { code?: number })?.code === "number"
          ? Number((error as NodeJS.ErrnoException & { code?: number }).code)
          : error ? 1 : 0;
        resolve({
          code,
          stdout: String(stdout || ""),
          stderr: String(stderr || error?.message || ""),
        });
      });
    });
  }
}
