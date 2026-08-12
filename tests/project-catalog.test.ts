import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { CommandRunner } from "../src/server/command-runner.js";
import { loadProjectConfig } from "../src/server/config.js";
import { ProjectCatalogService, ProjectCatalogStore, resolveProjectConfigSelection, scanProjectDirectory } from "../src/server/project-catalog.js";
import { PROJECT_ONBOARDING_STEP_IDS } from "../src/shared/contracts.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true })));
});

describe("项目目录与接入验证", () => {
  it("兼容缺少接入明细数组的历史项目目录记录", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "mtc-project-catalog-legacy-"));
    tempDirs.push(root);
    const catalogPath = path.join(root, "catalog.json");
    const checkedAt = "2026-08-10T00:00:00.000Z";
    await fs.writeFile(catalogPath, JSON.stringify({
      schemaVersion: "mobile-test-console.project-catalog.v1",
      activeProjectId: "legacy-app",
      projects: [{
        id: "legacy-app",
        name: "Legacy App",
        root,
        configPath: path.join(root, "mobile-test.config.cjs"),
        integrationType: "app",
        platforms: ["android"],
        active: true,
        createdAt: checkedAt,
        updatedAt: checkedAt,
        onboarding: [
          { id: "project", status: "verified", summary: "项目目录已登记", issues: [], checkedAt },
          { id: "template", status: "verified", summary: "配置已加载，声明 1 个测试入口", issues: [], checkedAt },
          { id: "devices", status: "verified", summary: "设备可用", issues: [], checkedAt },
          { id: "capabilities", status: "verified", summary: "能力可用", issues: [], checkedAt },
        ],
      }],
    }));

    const loaded = await new ProjectCatalogStore(catalogPath).load();
    expect(loaded.projects[0].onboarding).toEqual(PROJECT_ONBOARDING_STEP_IDS.map(id => expect.objectContaining({
      id,
      tools: [],
      capabilities: [],
      testEntries: [],
    })));
  });

  it("登记项目后按配置、设备和 Provider 能力更新接入步骤", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "mtc-project-catalog-"));
    tempDirs.push(root);
    const activeRoot = path.join(root, "active");
    const candidateRoot = path.join(root, "candidate");
    await fs.mkdir(activeRoot);
    await fs.mkdir(candidateRoot);
    await writeConfig(activeRoot, "active-app", "Active App");
    await writeConfig(candidateRoot, "candidate-lynx", "Candidate Lynx", false, undefined, "lynx-app");

    const activeConfig = await loadProjectConfig(path.join(activeRoot, "mobile-test.config.cjs"));
    const service = new ProjectCatalogService(
      new ProjectCatalogStore(path.join(root, "catalog.json")),
      androidReadyRunner,
    );
    await service.initialize(activeConfig);

    const registered = await service.register({
      projectDirectory: candidateRoot,
      configFile: "mobile-test.config.cjs",
    });
    expect(registered.projects.find(project => project.id === "candidate-lynx")).toMatchObject({
      name: "Candidate Lynx",
      integrationType: "lynx-app",
      platforms: ["android"],
      active: false,
      onboarding: expect.arrayContaining([
        expect.objectContaining({ id: "project", status: "verified" }),
        expect.objectContaining({ id: "template", status: "pending" }),
      ]),
    });

    await writeConfig(candidateRoot, "candidate-lynx", "Candidate Lynx", true, undefined, "lynx-app");
    const verified = await service.verify("candidate-lynx");
    expect(step(verified, "candidate-lynx", "template")).toMatchObject({
      status: "verified",
      testEntries: [{
        id: "smoke",
        label: "Smoke",
        description: "",
        runnerId: "legacy-command-runner",
        platforms: ["android"],
        parameterLabels: [],
      }],
    });
    expect(step(verified, "candidate-lynx", "devices")).toMatchObject({ status: "verified" });
    expect(step(verified, "candidate-lynx", "capabilities")).toMatchObject({
      status: "waiting",
      summary: expect.stringContaining("Project Provider"),
      capabilities: [
        expect.objectContaining({ id: "qa.bundle.prepare", status: "missing" }),
        expect.objectContaining({ id: "app.build", status: "missing" }),
        expect.objectContaining({ id: "app.install", status: "missing" }),
        expect.objectContaining({ id: "account.preflight", status: "missing" }),
        expect.objectContaining({ id: "page-parameters.resolve", status: "missing" }),
        expect.objectContaining({ id: "result.analysis", status: "missing" }),
      ],
    });
    expect(verified.activeProjectId).toBe("active-app");

    const activation = await service.activate("candidate-lynx", 0);
    expect(activation).toMatchObject({
      projectId: "candidate-lynx",
      configPath: path.join(candidateRoot, "mobile-test.config.cjs"),
      restartRequired: true,
    });
    expect(activation.catalog.activeProjectId).toBe("active-app");
    await expect(service.activate("candidate-lynx", 1)).rejects.toMatchObject({ code: "PROJECT_SWITCH_TASK_ACTIVE" });

    await writeConfig(candidateRoot, "candidate-lynx", "Candidate Lynx v2", true, undefined, "lynx-app");
    const reverified = await service.verify("candidate-lynx");
    expect(reverified.projects.find(project => project.id === "candidate-lynx")?.name).toBe("Candidate Lynx v2");
  });

  it("四项接入检查通过后允许执行测试", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "mtc-project-execution-ready-"));
    tempDirs.push(root);
    await writeConfig(root, "ready-lynx", "Ready Lynx", false, 1, "lynx-app", ["android"], [
      "qa.bundle.prepare",
      "app.build",
      "app.install",
      "account.preflight",
      "page-parameters.resolve",
      "result.analysis",
    ]);
    const service = new ProjectCatalogService(new ProjectCatalogStore(path.join(root, "catalog.json")), androidReadyRunner);
    await service.initialize(await loadProjectConfig(path.join(root, "mobile-test.config.cjs")));

    await service.verify("ready-lynx");
    const detail = await service.detail("ready-lynx");

    expect(detail).toMatchObject({ executionReady: true });
    expect(detail.project.onboarding).toEqual([
      expect.objectContaining({ id: "project", status: "verified" }),
      expect.objectContaining({ id: "template", status: "verified" }),
      expect.objectContaining({ id: "devices", status: "verified" }),
      expect.objectContaining({ id: "capabilities", status: "verified" }),
    ]);
    expect(step({ projects: [detail.project] }, "ready-lynx", "capabilities")).toMatchObject({
      capabilities: [
        expect.objectContaining({ id: "qa.bundle.prepare", label: "QA 包准备", status: "ready" }),
        expect.objectContaining({ id: "app.build", label: "App 构建", status: "ready" }),
        expect.objectContaining({ id: "app.install", label: "App 安装", status: "ready" }),
        expect.objectContaining({ id: "account.preflight", label: "账号预检", status: "ready" }),
        expect.objectContaining({ id: "page-parameters.resolve", label: "页面参数解析", status: "ready" }),
        expect.objectContaining({ id: "result.analysis", label: "结果分析", status: "ready" }),
      ],
    });
  });

  it("平台壳从目录历史项目切换时仍校验目标配置", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "mtc-project-catalog-stale-active-"));
    tempDirs.push(root);
    await writeConfig(root, "stale-active", "Stale Active");
    const configPath = path.join(root, "mobile-test.config.cjs");
    const service = new ProjectCatalogService(new ProjectCatalogStore(path.join(root, "catalog.json")), androidReadyRunner);
    await service.initialize(await loadProjectConfig(configPath));
    await fs.rm(configPath);

    await expect(service.activate("stale-active", 0)).rejects.toMatchObject({
      code: "PROJECT_SWITCH_CONFIG_REQUIRED",
    });
  });

  it("设备检查区分未授权设备并给出处理原因", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "mtc-project-device-auth-"));
    tempDirs.push(root);
    await writeConfig(root, "device-auth-app", "Device Auth App");
    const unauthorizedRunner: CommandRunner = {
      async capture(executable) {
        if (executable === "adb") return { code: 0, stdout: "pixel-8 unauthorized model:Pixel_8\n", stderr: "" };
        return { code: 0, stdout: "", stderr: "" };
      },
    };
    const service = new ProjectCatalogService(new ProjectCatalogStore(path.join(root, "catalog.json")), unauthorizedRunner);
    await service.initialize(await loadProjectConfig(path.join(root, "mobile-test.config.cjs")));

    const verified = await service.verify("device-auth-app");
    expect(step(verified, "device-auth-app", "devices")).toMatchObject({
      status: "waiting",
      issues: [expect.stringContaining("等待设备授权")],
    });
  });

  it("设备检查在工具链缺失时阻止执行并给出本机配置引导", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "mtc-project-device-tool-"));
    tempDirs.push(root);
    await writeConfig(root, "device-tool-app", "Device Tool App");
    const missingAdbRunner: CommandRunner = {
      async capture(executable) {
        return executable === "adb"
          ? { code: 1, stdout: "", stderr: "spawn adb ENOENT" }
          : { code: 0, stdout: "", stderr: "" };
      },
    };
    const service = new ProjectCatalogService(new ProjectCatalogStore(path.join(root, "catalog.json")), missingAdbRunner);
    await service.initialize(await loadProjectConfig(path.join(root, "mobile-test.config.cjs")));

    const verified = await service.verify("device-tool-app");
    expect(step(verified, "device-tool-app", "devices")).toMatchObject({
      status: "blocked",
      summary: "设备工具链需要处理",
      issues: [expect.stringContaining("ANDROID_ADB_PATH")],
      tools: [expect.objectContaining({
        id: "android-adb",
        status: "blocked",
        executable: "adb",
        guidance: expect.arrayContaining([expect.stringContaining("ANDROID_ADB_PATH")]),
      })],
    });
    await expect(service.detail("device-tool-app")).resolves.toMatchObject({ executionReady: false });
  });

  it("通用 App 的基础命令测试无需 Project Provider 即可执行", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "mtc-command-app-ready-"));
    tempDirs.push(root);
    await writeConfig(root, "command-app", "Command App");
    const service = new ProjectCatalogService(new ProjectCatalogStore(path.join(root, "catalog.json")), androidReadyRunner);
    await service.initialize(await loadProjectConfig(path.join(root, "mobile-test.config.cjs")));

    const verified = await service.verify("command-app");
    expect(step(verified, "command-app", "capabilities")).toMatchObject({
      status: "verified",
      summary: "基础命令测试能力已就绪",
    });
    await expect(service.detail("command-app")).resolves.toMatchObject({
      executionReady: true,
    });
  });

  it("预览初始化计划不写文件，确认后创建配置并自动登记复检", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "mtc-project-initialize-"));
    tempDirs.push(root);
    const projectRoot = path.join(root, "new-lynx-app");
    await fs.mkdir(projectRoot);
    const service = new ProjectCatalogService(new ProjectCatalogStore(path.join(root, "catalog.json")), androidReadyRunner);

    const plan = await service.previewInitialization({ projectDirectory: projectRoot, platforms: ["android"] });
    expect(plan).toMatchObject({
      step: "config",
      projectId: "new-lynx-app",
      canApply: true,
      actions: [
        expect.objectContaining({ kind: "write-file", target: path.join(projectRoot, "mobile-test.config.cjs") }),
        expect.objectContaining({ kind: "write-file", target: path.join(projectRoot, "qa", "mtc", "lynx-smoke.cjs") }),
        expect.objectContaining({ kind: "write-file", target: path.join(projectRoot, "qa", "mtc", "README.md") }),
      ],
    });
    await expect(fs.stat(path.join(projectRoot, "mobile-test.config.cjs"))).rejects.toMatchObject({ code: "ENOENT" });

    const applied = await service.applyInitialization({
      projectDirectory: projectRoot,
      platforms: ["android"],
      planId: plan.planId,
    });
    expect(applied.results).toHaveLength(3);
    expect(applied.catalog.projects).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "new-lynx-app", integrationType: "lynx-app" }),
    ]));
    await expect(fs.readFile(path.join(projectRoot, "mobile-test.config.cjs"), "utf8"))
      .resolves.toContain('integrationType: "lynx-app"');
    expect(step(applied.catalog, "new-lynx-app", "template")).toMatchObject({ status: "verified" });
  });

  it("文件状态变化后拒绝旧初始化计划", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "mtc-project-stale-plan-"));
    tempDirs.push(root);
    const service = new ProjectCatalogService(new ProjectCatalogStore(path.join(root, "catalog.json")), androidReadyRunner);
    const plan = await service.previewInitialization({ projectDirectory: root, platforms: ["android"] });
    await fs.writeFile(path.join(root, "mobile-test.config.cjs"), "module.exports = {};\n");

    await expect(service.applyInitialization({
      projectDirectory: root,
      platforms: ["android"],
      planId: plan.planId,
    })).rejects.toMatchObject({ code: "PROJECT_SETUP_PLAN_STALE" });
  });

  it("生成能力模板时保留项目已有文件", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "mtc-project-capability-template-"));
    tempDirs.push(root);
    await writeConfig(root, "template-lynx", "Template Lynx", false, undefined, "lynx-app");
    const providerPath = path.join(root, "qa", "mtc", "project-provider.cjs");
    await fs.mkdir(path.dirname(providerPath), { recursive: true });
    await fs.writeFile(providerPath, "module.exports = { preserved: true };\n");
    const service = new ProjectCatalogService(new ProjectCatalogStore(path.join(root, "catalog.json")), androidReadyRunner);
    await service.initialize(await loadProjectConfig(path.join(root, "mobile-test.config.cjs")));

    const plan = await service.previewSetup("template-lynx", "capabilities");
    expect(plan.actions).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ target: providerPath }),
    ]));
    expect(plan.actions).toEqual(expect.arrayContaining([
      expect.objectContaining({ target: path.join(root, "qa", "mtc", "runner.cjs") }),
      expect.objectContaining({ kind: "manual" }),
    ]));
    await service.applySetup("template-lynx", { step: "capabilities", planId: plan.planId });
    await expect(fs.readFile(providerPath, "utf8")).resolves.toBe("module.exports = { preserved: true };\n");
  });

  it("拒绝项目目录外的配置路径和重复项目 ID", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "mtc-project-catalog-invalid-"));
    tempDirs.push(root);
    await writeConfig(root, "active-app", "Active App");
    const service = new ProjectCatalogService(new ProjectCatalogStore(path.join(root, "catalog.json")), androidReadyRunner);
    await service.initialize(await loadProjectConfig(path.join(root, "mobile-test.config.cjs")));

    await expect(service.register({
      projectDirectory: root,
      configFile: "../mobile-test.config.cjs",
    })).rejects.toMatchObject({ code: "PROJECT_CONFIG_PATH_INVALID" });

    await fs.copyFile(path.join(root, "mobile-test.config.cjs"), path.join(root, "other.config.cjs"));
    await expect(service.register({
      projectDirectory: root,
      configFile: "other.config.cjs",
    })).rejects.toMatchObject({ code: "PROJECT_EXISTS" });
  });

  it("从配置文件或项目目录扫描结果推导项目根目录", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "mtc-project-config-selection-"));
    tempDirs.push(root);
    const projectRoot = path.join(root, "sample-app");
    const qaRoot = path.join(projectRoot, "qa");
    await fs.mkdir(qaRoot, { recursive: true });
    const configPath = path.join(qaRoot, "mobile-test.config.cjs");
    await fs.writeFile(configPath, `module.exports = {
      schemaVersion: "mobile-test-console.config.v1",
      project: { id: "sample-app", name: "Sample App", root: "..", integrationType: "lynx-app" },
      deviceProviders: ["android"],
      tests: [{ id: "smoke", label: "Smoke", platforms: ["android"], commands: { default: { executable: "node", args: ["--version"] } } }],
    };\n`);

    await expect(resolveProjectConfigSelection(configPath)).resolves.toMatchObject({
      projectDirectory: projectRoot,
      configFile: "qa/mobile-test.config.cjs",
      configFound: true,
    });
    await expect(scanProjectDirectory(qaRoot)).resolves.toMatchObject({
      projectDirectory: projectRoot,
      configFile: "qa/mobile-test.config.cjs",
      configPath,
      configFound: true,
    });
  });

  it("拒绝缺失、无效和项目根目录不匹配的配置", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "mtc-project-catalog-config-errors-"));
    tempDirs.push(root);
    await writeConfig(root, "active-app", "Active App");
    const service = new ProjectCatalogService(new ProjectCatalogStore(path.join(root, "catalog.json")), androidReadyRunner);
    await service.initialize(await loadProjectConfig(path.join(root, "mobile-test.config.cjs")));

    const missingRoot = path.join(root, "missing");
    await fs.mkdir(missingRoot);
    await expect(service.register({ projectDirectory: missingRoot, configFile: "mobile-test.config.cjs" }))
      .rejects.toMatchObject({ code: "PROJECT_CONFIG_REQUIRED" });

    const invalidRoot = path.join(root, "invalid");
    await fs.mkdir(invalidRoot);
    await fs.writeFile(path.join(invalidRoot, "mobile-test.config.cjs"), "module.exports = { schemaVersion: 'invalid' };\n");
    await expect(service.register({ projectDirectory: invalidRoot, configFile: "mobile-test.config.cjs" }))
      .rejects.toMatchObject({ code: "PROJECT_CONFIG_INVALID" });

    const mismatchRoot = path.join(root, "mismatch");
    await fs.mkdir(mismatchRoot);
    await fs.writeFile(path.join(mismatchRoot, "mobile-test.config.cjs"), `module.exports = {
      schemaVersion: "mobile-test-console.config.v1",
      project: { id: "mismatch", name: "Mismatch", root: ".." },
      deviceProviders: ["android"],
      tests: [{ id: "smoke", label: "Smoke", platforms: ["android"], commands: { default: { executable: "node", args: ["--version"] } } }],
    };\n`);
    await expect(service.register({ projectDirectory: mismatchRoot, configFile: "mobile-test.config.cjs" }))
      .rejects.toMatchObject({ code: "PROJECT_CONFIG_INVALID" });
  });

  it("重新验证时同步配置中的项目元数据", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "mtc-project-catalog-config-metadata-"));
    tempDirs.push(root);
    const activeRoot = path.join(root, "active");
    const candidateRoot = path.join(root, "candidate");
    await fs.mkdir(activeRoot);
    await fs.mkdir(candidateRoot);
    await writeConfig(activeRoot, "active-app", "Active App");
    await writeConfig(candidateRoot, "candidate", "Candidate v1", false, undefined, "app", ["android"]);
    const service = new ProjectCatalogService(new ProjectCatalogStore(path.join(root, "catalog.json")), androidReadyRunner);
    await service.initialize(await loadProjectConfig(path.join(activeRoot, "mobile-test.config.cjs")));
    await service.register({ projectDirectory: candidateRoot, configFile: "mobile-test.config.cjs" });

    await writeConfig(candidateRoot, "candidate", "Candidate v2", false, undefined, "mini-program", ["ios", "harmony"]);
    const verified = await service.verify("candidate");
    expect(verified.projects.find(project => project.id === "candidate")).toMatchObject({
      name: "Candidate v2",
      integrationType: "mini-program",
      platforms: ["ios", "harmony"],
    });
  });

  it("删除任意项目登记并保留项目文件与当前运行配置", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "mtc-project-catalog-remove-"));
    tempDirs.push(root);
    const activeRoot = path.join(root, "active");
    const candidateRoot = path.join(root, "candidate");
    await fs.mkdir(activeRoot);
    await fs.mkdir(candidateRoot);
    await writeConfig(activeRoot, "active", "Active");
    await writeConfig(candidateRoot, "candidate", "Candidate");
    const store = new ProjectCatalogStore(path.join(root, "catalog.json"));
    const service = new ProjectCatalogService(store, androidReadyRunner);
    await service.initialize(await loadProjectConfig(path.join(activeRoot, "mobile-test.config.cjs")));
    await service.register({ projectDirectory: candidateRoot, configFile: "mobile-test.config.cjs" });

    const activeConfig = await loadProjectConfig(path.join(activeRoot, "mobile-test.config.cjs"));
    const activeRemoved = await service.remove("active");
    expect(activeRemoved).toMatchObject({
      activeProjectId: "active",
      projects: [expect.objectContaining({ id: "candidate", active: false })],
    });
    expect((await fs.stat(path.join(activeRoot, "mobile-test.config.cjs"))).isFile()).toBe(true);

    const restarted = new ProjectCatalogService(store, androidReadyRunner);
    await restarted.initialize(activeConfig);
    expect(restarted.snapshot()).toMatchObject({
      activeProjectId: "active",
      projects: [expect.objectContaining({ id: "candidate", active: false })],
    });

    const registeredAgain = await restarted.register({ projectDirectory: activeRoot, configFile: "mobile-test.config.cjs" });
    expect(registeredAgain.projects).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "active", active: true }),
      expect.objectContaining({ id: "candidate", active: false }),
    ]));

    const inactiveRemoved = await restarted.remove("candidate");
    expect(inactiveRemoved.projects.map(project => project.id)).toEqual(["active"]);
    expect((await fs.stat(path.join(candidateRoot, "mobile-test.config.cjs"))).isFile()).toBe(true);
  });
});

const androidReadyRunner: CommandRunner = {
  async capture(executable) {
    if (executable === "adb") return { code: 0, stdout: "pixel-8 device model:Pixel_8\n", stderr: "" };
    return { code: 0, stdout: "", stderr: "" };
  },
};

function step(catalog: { projects: Array<{ id: string; onboarding: Array<{ id: string }> }> }, projectId: string, stepId: string) {
  const project = catalog.projects.find(item => item.id === projectId);
  const onboardingStep = project?.onboarding.find(item => item.id === stepId);
  if (!onboardingStep) throw new Error(`未找到接入步骤: ${projectId}/${stepId}`);
  return onboardingStep;
}

async function writeConfig(root: string, id: string, name: string, provider = false, providerVersion?: number, integrationType = "app", deviceProviders = ["android"], providerCapabilities?: string[]): Promise<void> {
  if (providerVersion !== undefined) await writeProvider(root, providerVersion, providerCapabilities);
  const providerConfig = providerVersion !== undefined ? `
      projectProviderPlugins: [{ module: "./provider.mjs" }],
      runnerPlugins: [],` : provider ? `
      projectProviderPlugins: [],
      runnerPlugins: [],` : "";
  const capabilityLabels: Record<string, string> = {
    "qa.bundle.prepare": "QA 包准备",
    "app.build": "App 构建",
    "app.install": "App 安装",
    "account.preflight": "账号预检",
    "page-parameters.resolve": "页面参数解析",
    "result.analysis": "结果分析",
  };
  const declaredCapabilities = integrationType === "lynx-app" ? [
    "qa.bundle.prepare",
    "app.build",
    "app.install",
    "account.preflight",
    "page-parameters.resolve",
    "result.analysis",
  ] : [];
  await fs.writeFile(path.join(root, "mobile-test.config.cjs"), `module.exports = {
    schemaVersion: "mobile-test-console.config.v1",
    project: { id: "${id}", name: "${name}", root: ".", integrationType: "${integrationType}" },
    deviceProviders: ${JSON.stringify(deviceProviders)},
    testing: { capabilities: ${JSON.stringify(declaredCapabilities.map(id => ({
      id,
      label: capabilityLabels[id],
      description: `${capabilityLabels[id]} 测试能力`,
      guidance: ["完成项目 Provider 接入"],
      providerId: "provider-app",
    })))} },${providerConfig}
    tests: [{
      id: "smoke",
      label: "Smoke",
      platforms: ["android"],
      commands: { default: { executable: "node", args: ["--version"] } },
    }],
  };\n`);
}

async function writeProvider(root: string, version: number, capabilities = ["result.analysis"]): Promise<void> {
  await fs.writeFile(path.join(root, "provider.mjs"), `export default {
    apiVersion: "mobile-test-console.project-provider-plugin.v1",
    createProviders() {
      return [{
        id: "provider-app",
        manifest: {
          schemaVersion: "mobile-test-console.project-provider.v1",
          providerId: "provider-app",
          scope: { targetKinds: ["app"], platforms: ["android"] },
          capabilities: ${JSON.stringify(capabilities.map(id => ({ id, version })))},
        },
        collectResult() { return { bundle: {} }; },
      }];
    },
  };\n`);
}
