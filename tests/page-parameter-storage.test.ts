import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import type { Device, PageParameterProfile, TestTask } from "../src/shared/contracts.js";
import { resolveAccountProfileStorage } from "../src/server/account-profile-storage.js";
import { pageParameterStatePath, resolvePageParameterStorage } from "../src/server/page-parameter-storage.js";
import { loadProjectConfig, resolveCommand, resolveLifecycleCommand, resolvePageParameterProviderCommand, resolveTargetCommand, resolveTaskResultCommand } from "../src/server/config.js";

const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true })));
});

it("页面和账号共用持久标识并隔离数据，移动目录或移除侧文件后仍沿用", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "mtc-page-identity-"));
  roots.push(root);
  const project = path.join(root, "project");
  await fs.mkdir(project);
  const input = { configPath: path.join(project, "mobile-test.config.cjs"), stateDir: path.join(root, "runtime"), userDataDir: path.join(root, "data") };
  const [pages, accounts] = await Promise.all([resolvePageParameterStorage(input), resolveAccountProfileStorage(input)]);
  expect(pages.id).toBe(accounts.id);
  expect(pages.directory).toBe(path.join(input.userDataDir, "page-parameters", pages.id));
  expect(accounts.directory).toBe(path.join(input.userDataDir, "account-profiles", pages.id));
  const moved = path.join(root, "moved");
  await fs.rename(project, moved);
  const next = { ...input, configPath: path.join(moved, "mobile-test.config.cjs") };
  expect(await resolvePageParameterStorage(next)).toEqual(pages);
  await fs.rm(path.join(moved, "mobile-test.identity.json"));
  expect(await resolvePageParameterStorage(next)).toEqual(pages);
});

it("仅启用页面功能的配置先迁移完整启动参数，所有命令使用同一持久文件", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "mtc-page-config-"));
  roots.push(root);
  vi.spyOn(os, "homedir").mockReturnValue(root);
  const project = path.join(root, "project");
  await fs.mkdir(project);
  const legacy = path.join(root, ".mobile-test-console", "previous-project");
  await fs.mkdir(legacy, { recursive: true });
  const profile: PageParameterProfile = {
    pageId: "detail", profileId: "saved", scenario: "detail", platform: "all", environment: "qa", accountLabel: "QA",
    values: { item: { strategy: "literal", value: "test-item" } },
    navigation: { route: "demo://open", params: { bundle: "detail", entry: "saved-source" } },
    actions: [], assertions: [], source: "manual", recordedAt: "2026-09-08T00:00:00Z", validatedAt: "", expiresAt: "", version: 1,
  };
  const original = JSON.stringify({ schemaVersion: "mobile-test-console.page-parameter-state.v1", profiles: [profile], recordings: [] });
  const legacyPath = path.join(legacy, "page-parameters.json");
  await fs.writeFile(legacyPath, original);
  const command = { executable: "node", args: ["--pages", "{{pageParameters.statePath}}"] };
  const configPath = path.join(project, "mobile-test.config.cjs");
  await fs.writeFile(configPath, `module.exports = ${JSON.stringify({
    schemaVersion: "mobile-test-console.config.v1", project: { id: "previous-project", name: "Pages", root: "." },
    deviceProviders: [], pageParameters: { provider: command }, lifecycle: { startup: command },
    taskResults: { artifactsRoot: "artifacts", provider: command },
    tests: [{ id: "smoke", label: "Smoke", platforms: ["android"], commands: { android: command, default: command } }],
  })};`);
  const config = await loadProjectConfig(configPath);
  expect(config.accountProfileStorage?.id).toBe(config.pageParameterStorage?.id);
  expect(config.pageParameterStorage).toBeDefined();
  const statePath = pageParameterStatePath(config);
  expect(JSON.parse(await fs.readFile(statePath, "utf8")).profiles).toEqual([profile]);
  expect(await fs.readFile(legacyPath, "utf8")).toBe(original);
  const device: Device = {
    key: "android:one", id: "one", name: "Android", platform: "android", type: "physical", connectionState: "available",
    osVersion: "", detail: "", controlState: "ready", controlReason: "",
  };
  const task: TestTask = {
    id: "task", runId: "run", projectId: config.project.id, testId: "smoke", testLabel: "Smoke", device,
    parameters: {}, status: "passed", phase: "", createdAt: "", startedAt: "", finishedAt: "", exitCode: 0, error: "", logs: [],
  };
  for (const resolved of [
    resolveCommand(config, config.tests[0], device, task, {}),
    resolvePageParameterProviderCommand(config, "replay"),
    resolveLifecycleCommand(config, "startup"),
    resolveTaskResultCommand(config, task),
    resolveTargetCommand(config, config.tests[0], { key: "mini", kind: "mini-program", label: "Mini", platform: "wechat", runtime: "devtools", appId: "test", concurrencyKey: "mini" }, task, {}),
  ]) expect(resolved?.args.slice(0, 2)).toEqual(["--pages", statePath]);
  const moved = path.join(root, "moved-project");
  await fs.rename(project, moved);
  const movedConfigPath = path.join(moved, "mobile-test.config.cjs");
  await fs.appendFile(movedConfigPath, `\nmodule.exports.accountProfiles = { provider: ${JSON.stringify(command)} };`);
  const reloaded = await loadProjectConfig(movedConfigPath);
  expect(reloaded.accountProfileStorage?.directory).toBe(config.accountProfileStorage?.directory);
  expect(reloaded.project.id).not.toBe(config.project.id);
  expect(pageParameterStatePath(reloaded)).toBe(statePath);
  expect(JSON.parse(await fs.readFile(statePath, "utf8")).profiles).toEqual([profile]);
});
