import os from "node:os";
import type { CommandRunner } from "./command-runner.js";
import { SystemCommandRunner } from "./command-runner.js";
import { ConsoleError } from "./errors.js";

export type DirectoryPickerPlatform = NodeJS.Platform;

export class DirectoryPicker {
  private readonly runner: CommandRunner;
  private readonly platform: DirectoryPickerPlatform;

  constructor(runner: CommandRunner = new SystemCommandRunner(), platform: DirectoryPickerPlatform = process.platform) {
    this.runner = runner;
    this.platform = platform;
  }

  async pickDirectory(title: string): Promise<string> {
    if (this.platform === "darwin") {
      const result = await this.runner.capture("osascript", [
        "-e",
        `POSIX path of (choose folder with prompt "${title}")`,
      ], 120_000);
      return result.code === 0 ? result.stdout.trim() : "";
    }
    if (this.platform === "win32") {
      const script = [
        "Add-Type -AssemblyName System.Windows.Forms",
        "$dialog = New-Object System.Windows.Forms.FolderBrowserDialog",
        `$dialog.Description = '${title.replaceAll("'", "''")}'`,
        "if ($dialog.ShowDialog() -eq 'OK') { $dialog.SelectedPath }",
      ].join("; ");
      const result = await this.runner.capture("powershell", ["-NoProfile", "-Command", script], 120_000);
      return result.code === 0 ? result.stdout.trim() : "";
    }
    const result = await this.runner.capture("zenity", ["--file-selection", "--directory", `--title=${title}`], 120_000);
    if (result.code !== 0 && /ENOENT|not found/i.test(result.stderr)) {
      throw new ConsoleError("DIRECTORY_PICKER_UNAVAILABLE", `当前系统缺少目录选择器，请安装 zenity。${os.platform()}`, 500);
    }
    return result.code === 0 ? result.stdout.trim() : "";
  }

  async pickFile(title: string): Promise<string> {
    if (this.platform === "darwin") {
      const result = await this.runner.capture("osascript", [
        "-e",
        `POSIX path of (choose file with prompt "${title}")`,
      ], 120_000);
      return result.code === 0 ? result.stdout.trim() : "";
    }
    if (this.platform === "win32") {
      const script = [
        "Add-Type -AssemblyName System.Windows.Forms",
        "$dialog = New-Object System.Windows.Forms.OpenFileDialog",
        `$dialog.Title = '${title.replaceAll("'", "''")}'`,
        "$dialog.Filter = 'Mobile Test Console config (*.cjs)|*.cjs|All files (*.*)|*.*'",
        "if ($dialog.ShowDialog() -eq 'OK') { $dialog.FileName }",
      ].join("; ");
      const result = await this.runner.capture("powershell", ["-NoProfile", "-Command", script], 120_000);
      return result.code === 0 ? result.stdout.trim() : "";
    }
    const result = await this.runner.capture("zenity", [
      "--file-selection",
      `--title=${title}`,
      "--file-filter=Mobile Test Console config | *.cjs",
    ], 120_000);
    if (result.code !== 0 && /ENOENT|not found/i.test(result.stderr)) {
      throw new ConsoleError("DIRECTORY_PICKER_UNAVAILABLE", `当前系统缺少文件选择器，请安装 zenity。${os.platform()}`, 500);
    }
    return result.code === 0 ? result.stdout.trim() : "";
  }
}
