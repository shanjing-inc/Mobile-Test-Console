import fs from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveCodexExecutable } from "../src/server/repair-job-manager.js";

const chatGptCodex = "/Applications/ChatGPT.app/Contents/Resources/codex";
const desktopCodex = "/Applications/Codex.app/Contents/Resources/codex";
const configuredCodex = "/tmp/configured-codex";

describe("Codex CLI 路径解析", () => {
  beforeEach(() => {
    vi.stubEnv("CODEX_CLI_PATH", undefined);
    vi.spyOn(fs, "existsSync").mockReturnValue(false);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it("显式配置路径优先于环境变量和内置 CLI", () => {
    vi.stubEnv("CODEX_CLI_PATH", configuredCodex);
    vi.mocked(fs.existsSync).mockReturnValue(true);

    expect(resolveCodexExecutable("/tmp/custom-codex")).toBe("/tmp/custom-codex");
    expect(fs.existsSync).not.toHaveBeenCalled();
  });

  it("环境变量指向的 CLI 存在时优先使用该路径", () => {
    vi.stubEnv("CODEX_CLI_PATH", configuredCodex);
    vi.mocked(fs.existsSync).mockReturnValue(true);

    expect(resolveCodexExecutable("codex")).toBe(configuredCodex);
  });

  it.each([
    { label: "仅 ChatGPT", existing: [chatGptCodex], expected: chatGptCodex },
    { label: "仅 Codex", existing: [desktopCodex], expected: desktopCodex },
    { label: "ChatGPT 和 Codex", existing: [chatGptCodex, desktopCodex], expected: chatGptCodex },
  ])("$label 内置 CLI 存在时按候选顺序选择", ({ existing, expected }) => {
    vi.mocked(fs.existsSync).mockImplementation(candidate => existing.includes(String(candidate)));

    expect(resolveCodexExecutable("codex")).toBe(expected);
  });

  it("环境变量和内置 CLI 均缺省时使用裸 codex", () => {
    expect(resolveCodexExecutable("codex")).toBe("codex");
  });

  it.each([
    { label: "内置 CLI", existing: [desktopCodex], expected: desktopCodex },
    { label: "裸 codex", existing: [], expected: "codex" },
  ])("环境变量路径不存在时回退到 $label", ({ existing, expected }) => {
    vi.stubEnv("CODEX_CLI_PATH", configuredCodex);
    vi.mocked(fs.existsSync).mockImplementation(candidate => existing.includes(String(candidate)));

    expect(resolveCodexExecutable("codex")).toBe(expected);
  });
});
