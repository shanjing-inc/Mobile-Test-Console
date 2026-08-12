import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import type { ZodTypeAny } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import { configSchema } from "../src/server/config.js";
import { resultBundleSchema } from "../src/shared/result-bundle.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const checkOnly = process.argv.includes("--check");

const definitions = [
  {
    file: "mobile-test.config.v1.schema.json",
    id: "https://mobile-test-console.dev/schemas/mobile-test.config.v1.schema.json",
    title: "Mobile Test Console project configuration v1",
    schema: configSchema,
  },
  {
    file: "test-analysis.run.v1.schema.json",
    id: "https://mobile-test-console.dev/schemas/test-analysis.run.v1.schema.json",
    title: "Mobile Test Console Result Bundle v1",
    schema: resultBundleSchema,
  },
] satisfies Array<{ file: string; id: string; title: string; schema: ZodTypeAny }>;

let changed = false;
for (const definition of definitions) {
  const generated = zodToJsonSchema(definition.schema, {
    target: "jsonSchema7",
    $refStrategy: "none",
  });
  const content = `${JSON.stringify({
    ...generated,
    $schema: "http://json-schema.org/draft-07/schema#",
    $id: definition.id,
    title: definition.title,
  }, null, 2)}\n`;
  const target = path.join(root, "schemas", definition.file);
  const current = await fs.readFile(target, "utf8").catch(() => "");
  if (current === content) continue;
  changed = true;
  if (!checkOnly) {
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, content);
  }
}

if (checkOnly && changed) {
  console.error("JSON Schema 与当前 Zod 契约不一致，请运行 pnpm schema:generate");
  process.exitCode = 1;
} else {
  console.log(checkOnly ? "JSON Schema 已同步" : "JSON Schema 已生成");
}
