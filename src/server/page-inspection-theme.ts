import type { SelectParameterDefinition } from "../shared/contracts.js";

export const PAGE_INSPECTION_THEME_PARAMETER: SelectParameterDefinition = {
  id: "theme",
  label: "外观",
  type: "select",
  defaultValue: "light",
  options: [
    { value: "light", label: "浅色" },
    { value: "dark", label: "深色" },
  ],
};

const THEME_ENV_TEMPLATE = "{{params.theme}}";

interface ThemeAwareCommand {
  env?: Record<string, string>;
}

interface ThemeAwareTest {
  kind?: string;
  parameters: Array<{ id: string; type: string }>;
  commands: {
    default?: ThemeAwareCommand;
    android?: ThemeAwareCommand;
    ios?: ThemeAwareCommand;
    harmony?: ThemeAwareCommand;
  };
}

interface ThemeAwareConfig {
  tests: ThemeAwareTest[];
  mainConfigTests?: ThemeAwareTest[];
  sidecarTests?: ThemeAwareTest[];
}

export function isPageInspectionTest(test: Pick<ThemeAwareTest, "kind" | "parameters">): boolean {
  return test.kind === "page" && test.parameters.some(parameter => parameter.type === "page-selection");
}

export function ensurePageInspectionTheme<T extends ThemeAwareTest>(test: T): T {
  if (!isPageInspectionTest(test)) return test;
  if (!test.parameters.some(parameter => parameter.id === "theme")) {
    const theme: SelectParameterDefinition = {
      ...PAGE_INSPECTION_THEME_PARAMETER,
      options: PAGE_INSPECTION_THEME_PARAMETER.options.map(option => ({ ...option })),
    };
    test.parameters.push(theme);
  }
  for (const command of Object.values(test.commands)) {
    if (!command) continue;
    command.env = {
      ...command.env,
      E2E_THEME: command.env?.E2E_THEME ?? THEME_ENV_TEMPLATE,
    };
  }
  return test;
}

export function ensureConfigPageInspectionTheme<T extends ThemeAwareConfig>(config: T): T {
  for (const test of config.tests) ensurePageInspectionTheme(test);
  for (const test of config.mainConfigTests ?? []) ensurePageInspectionTheme(test);
  for (const test of config.sidecarTests ?? []) ensurePageInspectionTheme(test);
  return config;
}
