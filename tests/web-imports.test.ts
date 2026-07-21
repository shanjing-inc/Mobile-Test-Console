import fs from "node:fs";
import path from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import viteConfig from "../vite.config";

const WEB_ROOT = path.resolve("src/web");

describe("Web 开发入口", () => {
  it("所有本地 import 都能解析到真实源码文件", () => {
    const sourceFiles = fs.readdirSync(WEB_ROOT)
      .filter(name => /\.(ts|tsx)$/.test(name))
      .map(name => path.join(WEB_ROOT, name));

    const missing: string[] = [];
    for (const sourcePath of sourceFiles) {
      const source = ts.createSourceFile(
        sourcePath,
        fs.readFileSync(sourcePath, "utf8"),
        ts.ScriptTarget.Latest,
        true,
      );
      for (const statement of source.statements) {
        if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
        const specifier = statement.moduleSpecifier.text;
        if (!specifier.startsWith(".")) continue;
        const target = path.resolve(path.dirname(sourcePath), specifier);
        const candidates = path.extname(target)
          ? [target]
          : [target, `${target}.ts`, `${target}.tsx`, `${target}.js`, `${target}.jsx`, `${target}.css`];
        if (!candidates.some(candidate => fs.existsSync(candidate))) {
          missing.push(`${path.relative(WEB_ROOT, sourcePath)} -> ${specifier}`);
        }
      }
    }

    expect(missing).toEqual([]);
  });

  it("API 代理保留源码 api.ts 的路径", () => {
    const proxy = viteConfig.server?.proxy;
    expect(proxy).toMatchObject({ "/api/": "http://127.0.0.1:4310" });
    expect(proxy).not.toHaveProperty("/api");
  });
});
