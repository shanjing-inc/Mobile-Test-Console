import { describe, expect, it } from "vitest";
import type { CommandResult, CommandRunner } from "../src/server/command-runner.js";
import { DirectoryPicker } from "../src/server/directory-picker.js";

describe("系统目录选择器", () => {
  it("在 macOS 打开系统文件夹选择器并返回路径", async () => {
    const runner = recordingRunner({ code: 0, stdout: "/workspace/demo\n", stderr: "" });
    const selected = await new DirectoryPicker(runner.command, "darwin").pickDirectory("选择项目目录");

    expect(selected).toBe("/workspace/demo");
    expect(runner.calls[0]).toMatchObject({ executable: "osascript", timeoutMs: 120_000 });
    expect(runner.calls[0]?.args.join(" ")).toContain("选择项目目录");
  });

  it("在 Windows 打开文件夹选择器并返回路径", async () => {
    const runner = recordingRunner({ code: 0, stdout: "C:\\workspace\\demo\r\n", stderr: "" });
    const selected = await new DirectoryPicker(runner.command, "win32").pickDirectory("选择项目目录");

    expect(selected).toBe("C:\\workspace\\demo");
    expect(runner.calls[0]?.executable).toBe("powershell");
    expect(runner.calls[0]?.args.join(" ")).toContain("选择项目目录");
  });

  it("在 macOS 打开配置文件选择器", async () => {
    const runner = recordingRunner({ code: 0, stdout: "/workspace/demo/mobile-test.config.cjs\n", stderr: "" });
    const selected = await new DirectoryPicker(runner.command, "darwin").pickFile("选择 mobile-test.config.cjs");

    expect(selected).toBe("/workspace/demo/mobile-test.config.cjs");
    expect(runner.calls[0]?.args.join(" ")).toContain("choose file");
  });

  it("在 Linux 缺少 zenity 时返回明确错误", async () => {
    const runner = recordingRunner({ code: 1, stdout: "", stderr: "spawn zenity ENOENT" });

    await expect(new DirectoryPicker(runner.command, "linux").pickDirectory("选择项目目录"))
      .rejects.toMatchObject({ code: "DIRECTORY_PICKER_UNAVAILABLE", statusCode: 500 });
  });

  it("用户取消选择时返回空路径", async () => {
    const runner = recordingRunner({ code: 1, stdout: "", stderr: "已取消" });

    await expect(new DirectoryPicker(runner.command, "darwin").pickDirectory("选择项目目录")).resolves.toBe("");
  });
});

function recordingRunner(result: CommandResult): {
  command: CommandRunner;
  calls: Array<{ executable: string; args: string[]; timeoutMs?: number }>;
} {
  const calls: Array<{ executable: string; args: string[]; timeoutMs?: number }> = [];
  return {
    calls,
    command: {
      async capture(executable, args, timeoutMs) {
        calls.push({ executable, args, timeoutMs });
        return result;
      },
    },
  };
}
