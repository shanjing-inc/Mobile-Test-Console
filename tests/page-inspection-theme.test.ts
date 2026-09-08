import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  loadProjectConfig,
  resolveTargetCommand,
  toPublicTestsFromConfig,
  type TestDefinition,
} from "../src/server/config.js";
import {
  ensureConfigPageInspectionTheme,
  ensurePageInspectionTheme,
  PAGE_INSPECTION_THEME_PARAMETER,
} from "../src/server/page-inspection-theme.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true })));
});

function pageInspectionTest(overrides: Partial<TestDefinition> = {}): TestDefinition {
  return {
    id: "saas-page-matrix",
    label: "本地回放页面结构巡检",
    description: "验证页面巡检的外观参数与启动命令。",
    kind: "page",
    platforms: [],
    targetKeys: ["wechat-devtools"],
    parameters: [{
      id: "pages",
      label: "页面",
      type: "page-selection",
      defaultValue: "all",
      source: "page-parameters",
      presets: [{ value: "all", label: "全部页面", description: "", filter: {} }],
    }],
    commands: {
      default: {
        executable: "pnpm",
        args: ["test:e2e:pages"],
        env: { E2E_PAGE_SELECTION: "{{params.pages}}" },
      },
    },
    ...overrides,
  };
}

describe("页面巡检外观参数", () => {
  it("给带页面选择的 page 测试注入外观，并写入 E2E_THEME", () => {
    const test = pageInspectionTest();
    ensurePageInspectionTheme(test);
    expect(test.parameters).toEqual(expect.arrayContaining([
      expect.objectContaining(PAGE_INSPECTION_THEME_PARAMETER),
    ]));
    expect(test.commands.default?.env).toMatchObject({
      E2E_PAGE_SELECTION: "{{params.pages}}",
      E2E_THEME: "{{params.theme}}",
    });
  });

  it("项目已声明 theme 时不重复注入，并保留原 E2E_THEME 模板", () => {
    const test = pageInspectionTest({
      parameters: [
        {
          id: "pages",
          label: "页面",
          type: "page-selection",
          defaultValue: "all",
          source: "page-parameters",
          presets: [{ value: "all", label: "全部页面", description: "", filter: {} }],
        },
        {
          id: "theme",
          label: "外观",
          type: "select",
          defaultValue: "dark",
          options: [
            { value: "light", label: "浅色", description: "" },
            { value: "dark", label: "深色", description: "" },
          ],
        },
      ],
      commands: {
        default: {
          executable: "pnpm",
          args: ["test:e2e:pages"],
          env: { E2E_THEME: "custom-{{params.theme}}" },
        },
      },
    });
    ensurePageInspectionTheme(test);
    expect(test.parameters.filter(parameter => parameter.id === "theme")).toHaveLength(1);
    expect(test.parameters.find(parameter => parameter.id === "theme")).toMatchObject({ defaultValue: "dark" });
    expect(test.commands.default?.env?.E2E_THEME).toBe("custom-{{params.theme}}");
  });

  it("重复处理共享配置分区时保持参数和各平台环境值稳定", () => {
    const test = pageInspectionTest({
      commands: {
        default: { executable: "pnpm", args: [], env: { KEEP: "value" } },
        android: { executable: "pnpm", args: [] },
        ios: { executable: "pnpm", args: [], env: { E2E_THEME: "dark" } },
        harmony: { executable: "pnpm", args: [], env: { E2E_THEME: "" } },
      },
    });
    const config = { tests: [test], mainConfigTests: [test], sidecarTests: [test] };

    expect(ensureConfigPageInspectionTheme(config)).toBe(config);
    const firstPass = structuredClone(test);
    expect(ensurePageInspectionTheme(test)).toBe(test);
    ensureConfigPageInspectionTheme(config);

    expect(test).toEqual(firstPass);
    expect(test.parameters.filter(parameter => parameter.id === "theme")).toHaveLength(1);
    expect(test.commands.default?.env).toEqual({ KEEP: "value", E2E_THEME: "{{params.theme}}" });
    expect(test.commands.android?.env).toEqual({ E2E_THEME: "{{params.theme}}" });
    expect(test.commands.ios?.env).toEqual({ E2E_THEME: "dark" });
    expect(test.commands.harmony?.env).toEqual({ E2E_THEME: "" });
  });

  it("每个测试独立复制外观选项数组与选项对象", () => {
    const first = ensurePageInspectionTheme(pageInspectionTest());
    const second = ensurePageInspectionTheme(pageInspectionTest());
    const firstTheme = first.parameters.find(parameter => parameter.id === "theme");
    const secondTheme = second.parameters.find(parameter => parameter.id === "theme");
    if (firstTheme?.type !== "select" || secondTheme?.type !== "select") {
      throw new Error("缺少外观选项");
    }
    const originalOptions = structuredClone(PAGE_INSPECTION_THEME_PARAMETER.options);

    expect(firstTheme.options).not.toBe(secondTheme.options);
    expect(firstTheme.options).not.toBe(PAGE_INSPECTION_THEME_PARAMETER.options);
    expect(firstTheme.options[0]).not.toBe(secondTheme.options[0]);
    expect(firstTheme.options[0]).not.toBe(PAGE_INSPECTION_THEME_PARAMETER.options[0]);
    firstTheme.options[0].label = "项目自定义浅色";
    firstTheme.options.push({ value: "system", label: "跟随系统", description: "" });

    expect(secondTheme.options).toEqual(originalOptions);
    expect(PAGE_INSPECTION_THEME_PARAMETER.options).toEqual(originalOptions);
  });

  it("Smoke 和无页面选择的 page 测试不注入外观", () => {
    const smoke: TestDefinition = {
      id: "saas-smoke",
      label: "Smoke 测试",
      description: "验证普通测试保持原始参数。",
      kind: "general",
      platforms: [],
      parameters: [],
      commands: { default: { executable: "pnpm", args: ["test:e2e:smoke"] } },
    };
    const pageWithoutSelection = pageInspectionTest({
      parameters: [],
    });
    ensurePageInspectionTheme(smoke);
    ensurePageInspectionTheme(pageWithoutSelection);
    expect(smoke.parameters).toEqual([]);
    expect(pageWithoutSelection.parameters).toEqual([]);
    expect(smoke.commands.default?.env).toBeUndefined();
    expect(pageWithoutSelection.commands.default?.env).toEqual({ E2E_PAGE_SELECTION: "{{params.pages}}" });
  });

  it("加载配置后 snapshot 测试含外观，深色启动命令带 E2E_THEME=dark", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mtc-page-theme-"));
    tempDirs.push(dir);
    const configPath = path.join(dir, "mobile-test.config.cjs");
    await fs.writeFile(configPath, `module.exports = {
      schemaVersion: "mobile-test-console.config.v1",
      project: { name: "Theme Demo", root: ".", integrationType: "mini-program" },
      deviceProviders: [],
      testing: { targets: [{
        key: "wechat-devtools", label: "微信开发者工具", kind: "mini-program",
        platform: "wechat", runtime: "wechat-devtools", appId: "wx-demo",
        concurrencyKey: "theme-demo-wechat",
      }] },
      tests: [{
        id: "pages",
        label: "本地回放页面结构巡检",
        kind: "page",
        targetKeys: ["wechat-devtools"],
        commands: {
          default: {
            executable: "pnpm",
            args: ["test:e2e:pages"],
            env: { E2E_PAGE_SELECTION: "{{params.pages}}" },
          },
        },
        parameters: [{
          id: "pages",
          label: "页面",
          type: "page-selection",
          defaultValue: "all",
          source: "page-parameters",
          presets: [{ value: "all", label: "全部页面", filter: {} }],
        }],
      }, {
        id: "smoke",
        label: "Smoke 测试",
        targetKeys: ["wechat-devtools"],
        commands: { default: { executable: "pnpm", args: ["test:e2e:smoke"] } },
      }],
    };`);

    const config = await loadProjectConfig(configPath);
    ensureConfigPageInspectionTheme(config);
    const publicTests = toPublicTestsFromConfig(config);
    expect(publicTests.find(test => test.id === "pages")?.parameters).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "theme", label: "外观", defaultValue: "light" }),
    ]));
    expect(publicTests.find(test => test.id === "smoke")?.parameters).toEqual([]);

    const target = config.testing?.targets?.[0];
    if (!target) throw new Error("缺少运行目标");
    const command = resolveTargetCommand(config, config.tests[0], {
      key: target.key,
      kind: "mini-program",
      label: target.label,
      platform: target.platform,
      runtime: target.runtime,
      appId: target.appId,
      concurrencyKey: target.concurrencyKey,
    }, { id: "task-1", runId: "run-1" }, { pages: "all", theme: "dark" });
    expect(command?.env).toMatchObject({
      E2E_PAGE_SELECTION: "all",
      E2E_THEME: "dark",
    });
  });
});
