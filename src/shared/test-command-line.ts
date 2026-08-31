export interface ParsedTestCommandLine {
  executable: string;
  args: string[];
}

export class TestCommandLineError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TestCommandLineError";
  }
}

const UNSUPPORTED_SHELL_CHARACTERS = new Set(["|", ">", "<", ";", "&"]);

export function parseTestCommandLine(value: string): ParsedTestCommandLine {
  const tokens: string[] = [];
  let token = "";
  let tokenStarted = false;
  let quote: "'" | '"' | null = null;

  const pushToken = () => {
    if (!tokenStarted) return;
    tokens.push(token);
    token = "";
    tokenStarted = false;
  };

  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (quote) {
      if (character === quote) {
        quote = null;
        continue;
      }
      if (quote === '"' && character === "$") {
        throw new TestCommandLineError("命令暂不支持变量展开，请直接填写参数值");
      }
      token += character;
      tokenStarted = true;
      continue;
    }

    if (/\s/.test(character)) {
      pushToken();
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
      tokenStarted = true;
      continue;
    }
    if (UNSUPPORTED_SHELL_CHARACTERS.has(character) || character === "`") {
      throw new TestCommandLineError(`命令暂不支持 shell 操作符 ${character}，请填写一条可直接执行的测试命令`);
    }
    if (character === "$") {
      throw new TestCommandLineError("命令暂不支持变量展开，请直接填写参数值");
    }
    token += character;
    tokenStarted = true;
  }

  if (quote) throw new TestCommandLineError(`命令中的${quote === "'" ? "单引号" : "双引号"}缺少结束符`);
  pushToken();
  if (tokens.length === 0 || !tokens[0]) throw new TestCommandLineError("请填写测试命令");
  return { executable: tokens[0], args: tokens.slice(1) };
}

export function createUniqueTestEntryId(commandLine: string, existingIds: Iterable<string>): string {
  const parsed = parseTestCommandLine(commandLine);
  const normalized = [parsed.executable, ...parsed.args]
    .join("-")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  const base = (/^[a-z]/.test(normalized) ? normalized : normalized ? `test-${normalized}` : "custom-test")
    .slice(0, 64)
    .replace(/-+$/g, "");
  const used = new Set(existingIds);
  if (!used.has(base)) return base;
  for (let suffix = 2; suffix < Number.MAX_SAFE_INTEGER; suffix += 1) {
    const suffixText = `-${suffix}`;
    const candidate = `${base.slice(0, 64 - suffixText.length).replace(/-+$/g, "")}${suffixText}`;
    if (!used.has(candidate)) return candidate;
  }
  throw new Error("无法生成唯一测试 ID");
}
