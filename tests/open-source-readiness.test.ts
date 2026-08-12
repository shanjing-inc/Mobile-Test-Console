import fs from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Ajv, { type AnySchema } from "ajv";
import { describe, expect, it } from "vitest";
import {
  PROJECT_PROVIDER_MANIFEST_SCHEMA_VERSION,
  PROJECT_PROVIDER_PLUGIN_API_VERSION,
  RESULT_BUNDLE_SCHEMA_VERSION,
  RUNNER_PLUGIN_API_VERSION,
} from "../src/sdk/index.js";
import { loadProjectConfig } from "../src/server/config.js";
import { loadRunnerRuntime } from "../src/server/runner-runtime.js";

const root = fileURLToPath(new URL("..", import.meta.url));
const require = createRequire(import.meta.url);
const fixtures = [
  {
    configPath: path.join(root, "examples/lynx-app-starter/mobile-test.config.cjs"),
    projectId: "lynx-app-starter",
    runnerId: "lynx-app-starter-runner",
    providerId: "lynx-app-starter",
  },
  {
    configPath: path.join(root, "examples/com.shanjing.example/mobile-test.config.cjs"),
    projectId: "shanjing-example",
    runnerId: "shanjing-example-runner",
    providerId: "shanjing-example",
  },
];

describe("开源发布契约", () => {
  it("公开 SDK 统一导出版本化 Runner、Provider 与 Result Bundle 契约", () => {
    expect(RUNNER_PLUGIN_API_VERSION).toBe("mobile-test-console.runner-plugin.v1");
    expect(PROJECT_PROVIDER_PLUGIN_API_VERSION).toBe("mobile-test-console.project-provider-plugin.v1");
    expect(PROJECT_PROVIDER_MANIFEST_SCHEMA_VERSION).toBe("mobile-test-console.project-provider.v1");
    expect(RESULT_BUNDLE_SCHEMA_VERSION).toBe("test-analysis.run.v1");
  });

  it("JSON Schema 校验两个独立 Lynx 项目与 Result Bundle 示例", async () => {
    const [configSchema, resultSchema, resultExample] = await Promise.all([
      readJson<AnySchema>("schemas/mobile-test.config.v1.schema.json"),
      readJson<AnySchema>("schemas/test-analysis.run.v1.schema.json"),
      readJson("examples/result-bundle.mini-program.json"),
    ]);
    const ajv = new Ajv({ allErrors: true, strict: false });
    const validateConfig = ajv.compile(configSchema);
    const validateResult = ajv.compile(resultSchema);

    for (const fixture of fixtures) {
      delete require.cache[require.resolve(fixture.configPath)];
      const raw = require(fixture.configPath);
      expect(validateConfig(raw), JSON.stringify(validateConfig.errors)).toBe(true);
    }
    expect(validateResult(resultExample), JSON.stringify(validateResult.errors)).toBe(true);
  });

  it("两个 Lynx 项目都通过配置边界注册自己的 Provider 与 Runner", async () => {
    for (const fixture of fixtures) {
      const config = await loadProjectConfig(fixture.configPath);
      const runtime = await loadRunnerRuntime(config);
      expect(config.project.id).toBe(fixture.projectId);
      expect(runtime.providers.manifests().map(item => item.providerId)).toContain(fixture.providerId);
      expect(runtime.resolver.resolve({
        runId: `${fixture.projectId}-contract`,
        projectId: fixture.projectId,
        testId: "lynx-smoke",
        runnerId: fixture.runnerId,
        device: {
          key: "android:contract",
          id: "contract",
          name: "Contract device",
          platform: "android",
          type: "physical",
          connectionState: "available",
          controlState: "ready",
          controlReason: "",
          osVersion: "15",
          detail: "",
        },
      }).id).toBe(fixture.runnerId);
    }
  });

  it("npm 包声明公开 SDK、Schema、许可证和 Beta 版本", async () => {
    const packageJson = await readJson<Record<string, unknown>>("package.json");
    const exports = packageJson.exports as Record<string, unknown>;
    expect(packageJson.private).not.toBe(true);
    expect(packageJson.license).toBe("MIT");
    expect(packageJson.version).toMatch(/^0\.1\.0-beta\./);
    expect(exports["./sdk"]).toBeTruthy();
    expect(exports["./schemas/mobile-test.config.v1.json"]).toBeTruthy();
    expect(exports["./schemas/test-analysis.run.v1.json"]).toBeTruthy();
  });
});

async function readJson<T = unknown>(relativePath: string): Promise<T> {
  return JSON.parse(await fs.readFile(path.join(root, relativePath), "utf8"));
}
