import { describe, expect, it } from "vitest";
import { createUniqueTestEntryId, parseTestCommandLine } from "../src/shared/test-command-line.js";

describe("自定义测试命令解析", () => {
  it("按顺序解析普通参数、单引号、双引号和空参数", () => {
    expect(parseTestCommandLine(`pnpm test:e2e --filter "pickup code" '--mode=full run' ""`)).toEqual({
      executable: "pnpm",
      args: ["test:e2e", "--filter", "pickup code", "--mode=full run", ""],
    });
  });

  it("保留 Windows 路径中的反斜杠", () => {
    expect(parseTestCommandLine(String.raw`node C:\tests\run.mjs`)).toEqual({
      executable: "node",
      args: [String.raw`C:\tests\run.mjs`],
    });
    expect(parseTestCommandLine(String.raw`node "C:\Program Files\tests\run.mjs"`)).toEqual({
      executable: "node",
      args: [String.raw`C:\Program Files\tests\run.mjs`],
    });
    expect(parseTestCommandLine(String.raw`node "\\server\share\run.mjs"`)).toEqual({
      executable: "node",
      args: [String.raw`\\server\share\run.mjs`],
    });
  });

  it.each([
    ["pnpm test:e2e | tee result.log", "shell 操作符 |"],
    ["pnpm test:e2e && pnpm report", "shell 操作符 &"],
    ["pnpm test:e2e > result.log", "shell 操作符 >"],
    ["pnpm $TEST_SCRIPT", "变量展开"],
    ["pnpm `resolve-script`", "shell 操作符 `"],
    [`pnpm "missing`, "双引号缺少结束符"],
  ])("拒绝复合 shell 命令 %s", (command, message) => {
    expect(() => parseTestCommandLine(command)).toThrow(message);
  });

  it("根据命令生成稳定 ID，并为冲突 ID 追加数字后缀", () => {
    expect(createUniqueTestEntryId("pnpm test:e2e:pickup-code-sort", [])).toBe("pnpm-test-e2e-pickup-code-sort");
    expect(createUniqueTestEntryId("pnpm test:e2e:pickup-code-sort", [
      "pnpm-test-e2e-pickup-code-sort",
      "pnpm-test-e2e-pickup-code-sort-2",
    ])).toBe("pnpm-test-e2e-pickup-code-sort-3");
  });

  it("为数字开头或无英文字符的命令生成符合配置约束的 ID", () => {
    expect(createUniqueTestEntryId("123-runner test", [])).toBe("test-123-runner-test");
    expect(createUniqueTestEntryId("测试工具", ["custom-test"])).toBe("custom-test-2");
  });
});
