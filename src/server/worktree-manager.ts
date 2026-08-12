import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { CommandRunner } from "./command-runner.js";
import { ConsoleError } from "./errors.js";

export interface WorktreeInfo {
  baselineCommit: string;
  baselineTree: string;
  dirtyFingerprint: string;
  worktreePath: string;
  patchPath: string;
  baselinePatch: string;
  untrackedPaths: string[];
}

export type WorktreeBaseline = Pick<WorktreeInfo, "baselineCommit" | "dirtyFingerprint" | "baselinePatch" | "untrackedPaths">;

export class WorktreeManager {
  constructor(
    private readonly projectRoot: string,
    private readonly root: string,
    private readonly runner: CommandRunner,
    private readonly links: string[] = [],
  ) {}

  async inspectBaseline(): Promise<WorktreeBaseline> {
    const baselineCommit = await this.gitValue(["rev-parse", "HEAD"]);
    const [status, baselinePatch, untrackedRaw] = await Promise.all([
      this.gitValue(["status", "--porcelain=v1"]),
      this.gitRaw(["diff", "--binary", "HEAD"]),
      this.gitRaw(["ls-files", "--others", "--exclude-standard", "-z"]),
    ]);
    const untrackedPaths = untrackedRaw.split("\0").filter(Boolean);
    const dirtyFingerprint = crypto.createHash("sha256").update(`${status}\0${baselinePatch}\0${untrackedPaths.join("\0")}`).digest("hex");
    return { baselineCommit, dirtyFingerprint, baselinePatch, untrackedPaths };
  }

  async create(repairJobId: string, baseline?: WorktreeBaseline): Promise<WorktreeInfo> {
    const { baselineCommit, dirtyFingerprint, baselinePatch, untrackedPaths } = baseline ?? await this.inspectBaseline();
    const worktreePath = path.join(this.root, repairJobId);
    const patchPath = path.join(worktreePath, ".codex-repair", "repair.patch");
    await fs.mkdir(this.root, { recursive: true });
    const existing = await fs.stat(worktreePath).catch(() => null);
    if (!existing) {
      const result = await this.runner.capture("git", ["worktree", "add", "--detach", worktreePath, baselineCommit], 60_000, { cwd: this.projectRoot });
      if (result.code !== 0) {
        throw new ConsoleError("REPAIR_WORKTREE_FAILED", `创建修复 worktree 失败: ${result.stderr || result.stdout}`, 500);
      }
    }
    await fs.mkdir(path.dirname(patchPath), { recursive: true });
    await this.linkDependencies(worktreePath);
    if (baselinePatch.trim()) {
      const baselinePath = path.join(worktreePath, ".codex-repair", "baseline.patch");
      await fs.writeFile(baselinePath, baselinePatch);
      const applied = await this.runner.capture("git", ["apply", "--whitespace=nowarn", baselinePath], 60_000, { cwd: worktreePath });
      if (applied.code !== 0) {
        throw new ConsoleError("REPAIR_WORKTREE_FAILED", `应用基线改动失败: ${applied.stderr || applied.stdout}`, 500);
      }
    }
    await this.copyUntrackedFiles(worktreePath, untrackedPaths);
    const stage = await this.runner.capture("git", ["add", "-A", "--", ".", ":(exclude).codex-repair/**"], 60_000, { cwd: worktreePath });
    if (stage.code !== 0) throw new ConsoleError("REPAIR_WORKTREE_FAILED", `建立修复基线失败: ${stage.stderr || stage.stdout}`, 500);
    const baselineTree = await this.captureValue(["write-tree"], worktreePath);
    await fs.writeFile(path.join(worktreePath, ".codex-repair", "baseline-tree"), `${baselineTree}\n`);
    await this.runner.capture("git", ["reset", "--quiet"], 60_000, { cwd: worktreePath });
    return { baselineCommit, baselineTree, dirtyFingerprint, worktreePath, patchPath, baselinePatch, untrackedPaths };
  }

  async exportPatch(worktreePath: string, patchPath: string): Promise<{ diff: string; patchPath: string }> {
    const diff = await this.readDiff(worktreePath);
    await fs.mkdir(path.dirname(patchPath), { recursive: true });
    await fs.writeFile(patchPath, diff);
    return { diff, patchPath };
  }

  async readDiff(worktreePath: string): Promise<string> {
    const baselineTree = (await fs.readFile(path.join(worktreePath, ".codex-repair", "baseline-tree"), "utf8")).trim();
    await this.runner.capture("git", ["add", "-N", "--", ".", ":(exclude).codex-repair/**"], 60_000, { cwd: worktreePath });
    const result = await this.runner.capture("git", ["diff", "--binary", baselineTree], 60_000, { cwd: worktreePath });
    await this.runner.capture("git", ["reset", "--quiet"], 60_000, { cwd: worktreePath });
    if (result.code !== 0) {
      throw new ConsoleError("REPAIR_DIFF_FAILED", `读取修复 diff 失败: ${result.stderr || result.stdout}`, 500);
    }
    return result.stdout;
  }

  async cleanup(worktreePath: string): Promise<void> {
    const result = await this.runner.capture("git", ["worktree", "remove", "--force", worktreePath], 60_000, { cwd: this.projectRoot });
    if (result.code !== 0 && !/is not a working tree|missing/i.test(`${result.stderr}\n${result.stdout}`)) {
      throw new ConsoleError("REPAIR_WORKTREE_CLEANUP_FAILED", `回收修复 worktree 失败: ${result.stderr || result.stdout}`, 500);
    }
  }

  private async gitValue(args: string[]): Promise<string> {
    return this.captureValue(args, this.projectRoot);
  }

  private async linkDependencies(worktreePath: string): Promise<void> {
    for (const relativePath of this.links) {
      if (path.isAbsolute(relativePath) || relativePath.split(/[\\/]/).includes("..")) {
        throw new ConsoleError("REPAIR_WORKTREE_LINK_INVALID", `worktree 链接路径无效: ${relativePath}`, 500);
      }
      const source = path.join(this.projectRoot, relativePath);
      const target = path.join(worktreePath, relativePath);
      const [sourceStat, targetStat] = await Promise.all([
        fs.stat(source).catch(() => null),
        fs.lstat(target).catch(() => null),
      ]);
      if (!sourceStat || targetStat) continue;
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.symlink(source, target, sourceStat.isDirectory() ? "dir" : "file");
    }
  }

  private async copyUntrackedFiles(worktreePath: string, relativePaths: string[]): Promise<void> {
    for (const relativePath of relativePaths) {
      if (!relativePath || path.isAbsolute(relativePath) || relativePath.split(/[\\/]/).includes("..")) {
        throw new ConsoleError("REPAIR_WORKTREE_PATH_INVALID", `未跟踪文件路径无效: ${relativePath}`, 500);
      }
      const source = path.join(this.projectRoot, relativePath);
      const target = path.join(worktreePath, relativePath);
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.cp(source, target, { recursive: true, force: true, dereference: false });
    }
  }

  private async gitRaw(args: string[]): Promise<string> {
    const result = await this.runner.capture("git", args, 60_000, { cwd: this.projectRoot });
    if (result.code !== 0) throw new ConsoleError("REPAIR_GIT_FAILED", `读取 Git 状态失败: ${result.stderr || result.stdout}`, 500);
    return result.stdout;
  }

  private async captureValue(args: string[], cwd: string): Promise<string> {
    const result = await this.runner.capture("git", args, 60_000, { cwd });
    if (result.code !== 0) {
      throw new ConsoleError("REPAIR_GIT_FAILED", `读取 Git 状态失败: ${result.stderr || result.stdout}`, 500);
    }
    return result.stdout.trimEnd();
  }
}
