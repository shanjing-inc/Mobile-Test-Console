import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import {
  PLATFORMS,
  PROJECT_EXECUTION_PREREQUISITE_STEP_IDS,
  PROJECT_INTEGRATION_TYPES,
  PROJECT_ONBOARDING_STEP_IDS,
  projectFamilyOf,
  type Platform,
  type ApplyProjectInitializationRequest,
  type ApplyProjectSetupRequest,
  type ProjectCatalogEntry,
  type ProjectCatalogDetailResponse,
  type ProjectCatalogResponse,
  type ProjectActivationResponse,
  type ProjectCapabilityCheck,
  type ProjectConfigSelection,
  type ProjectOnboardingStep,
  type ProjectSetupAction,
  type ProjectSetupActionResult,
  type ProjectSetupApplyResponse,
  type ProjectSetupPlan,
  type ProjectTestEntryCheck,
  type ProjectTestingManifest,
  type ProjectToolCheck,
  type PreviewProjectInitializationRequest,
  type RegisterProjectRequest,
} from "../shared/contracts.js";
import { resolveDeviceExecutable, SystemCommandRunner, type CommandRunner } from "./command-runner.js";
import { loadProjectConfig, resolveTargetHealthCheckCommand, toPublicTests, type LoadedProjectConfig } from "./config.js";
import { DeviceDiscoveryService } from "./devices.js";
import { ConsoleError } from "./errors.js";
import { ResultBundleStore } from "./result-bundle-store.js";
import { loadRunnerRuntime } from "./runner-runtime.js";

const CATALOG_SCHEMA_VERSION = "mobile-test-console.project-catalog.v1" as const;
const onboardingStepSchema = z.object({
  id: z.enum(PROJECT_ONBOARDING_STEP_IDS),
  status: z.enum(["pending", "waiting", "blocked", "verified"]),
  summary: z.string(),
  issues: z.array(z.string()),
  checkedAt: z.string(),
  tools: z.array(z.object({
    id: z.string(),
    label: z.string(),
    executable: z.string(),
    status: z.enum(["ready", "blocked"]),
    path: z.string(),
    version: z.string(),
    detail: z.string(),
    guidance: z.array(z.string()),
  })).optional(),
  capabilities: z.array(z.object({
    id: z.string(),
    label: z.string(),
    status: z.enum(["ready", "missing"]),
    detail: z.string(),
    guidance: z.array(z.string()),
  })).optional(),
  testEntries: z.array(z.object({
    id: z.string(),
    label: z.string(),
    testType: z.string().default(""),
    description: z.string(),
    runnerId: z.string(),
    platforms: z.array(z.enum(PLATFORMS)),
    targetKeys: z.array(z.string()).optional(),
    parameterLabels: z.array(z.string()),
  })).optional(),
});

const catalogEntrySchema = z.object({
  id: z.string().regex(/^[a-z][a-z0-9-]*$/),
  name: z.string().min(1),
  root: z.string().min(1),
  configPath: z.string().min(1),
  integrationType: z.enum(PROJECT_INTEGRATION_TYPES),
  platforms: z.array(z.enum(PLATFORMS)),
  active: z.boolean(),
  createdAt: z.string(),
  updatedAt: z.string(),
  onboarding: z.array(onboardingStepSchema),
});

const storedCatalogSchema = z.object({
  schemaVersion: z.literal(CATALOG_SCHEMA_VERSION),
  activeProjectId: z.string(),
  projects: z.array(catalogEntrySchema),
});

interface StoredCatalog {
  schemaVersion: typeof CATALOG_SCHEMA_VERSION;
  activeProjectId: string;
  projects: ProjectCatalogEntry[];
}

interface InternalSetupAction extends ProjectSetupAction {
  content?: string;
  executable?: string;
  args?: string[];
}

interface BuiltSetupPlan {
  plan: ProjectSetupPlan;
  actions: InternalSetupAction[];
  projectId?: string;
}

export class ProjectCatalogStore {
  private writeQueue = Promise.resolve();

  constructor(private readonly catalogPath: string) {}

  async load(): Promise<StoredCatalog> {
    try {
      const parsed = storedCatalogSchema.safeParse(JSON.parse(await fs.readFile(this.catalogPath, "utf8")));
      if (!parsed.success) return emptyCatalog();
      return {
        schemaVersion: CATALOG_SCHEMA_VERSION,
        activeProjectId: parsed.data.activeProjectId,
        projects: parsed.data.projects.map(normalizeEntry),
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return emptyCatalog();
      throw error;
    }
  }

  async save(value: StoredCatalog): Promise<void> {
    const snapshot = structuredClone(value);
    this.writeQueue = this.writeQueue.then(async () => {
      await fs.mkdir(path.dirname(this.catalogPath), { recursive: true });
      const nextPath = `${this.catalogPath}.next`;
      await fs.writeFile(nextPath, `${JSON.stringify(snapshot, null, 2)}\n`);
      await fs.rename(nextPath, this.catalogPath);
    });
    await this.writeQueue;
  }
}

export class ProjectCatalogService {
  private readonly projects = new Map<string, ProjectCatalogEntry>();
  private activeProjectId = "";
  private operationQueue = Promise.resolve();

  constructor(
    private readonly store: ProjectCatalogStore,
    private readonly runner: CommandRunner = new SystemCommandRunner(),
  ) {}

  async initialize(activeConfig?: LoadedProjectConfig): Promise<void> {
    const stored = await this.store.load();
    this.projects.clear();
    for (const entry of stored.projects) this.projects.set(entry.id, normalizeEntry(entry));
    await this.runExclusive(async () => {
      if (!activeConfig) {
        this.activeProjectId = stored.activeProjectId;
        this.markActiveProject();
        return;
      }
      this.activeProjectId = activeConfig.project.id;
      const activeEntryWasRemoved = stored.activeProjectId === activeConfig.project.id
        && !this.projects.has(activeConfig.project.id);
      if (activeEntryWasRemoved) {
        this.markActiveProject();
        await this.persist();
        return;
      }
      const existing = this.projects.get(activeConfig.project.id);
      const now = new Date().toISOString();
      this.projects.set(activeConfig.project.id, normalizeEntry({
        id: activeConfig.project.id,
        name: activeConfig.project.name,
        root: activeConfig.project.root,
        configPath: activeConfig.configPath,
        integrationType: activeConfig.project.integrationType ?? "app",
        platforms: [...new Set(activeConfig.deviceProviders)],
        active: true,
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
        onboarding: existing?.onboarding ?? createOnboarding(activeConfig.project.id, activeConfig.project.name, now),
      }));
      this.markActiveProject();
      await this.persist();
    });
  }

  snapshot(): ProjectCatalogResponse {
    return {
      schemaVersion: CATALOG_SCHEMA_VERSION,
      activeProjectId: this.activeProjectId,
      projects: [...this.projects.values()]
        .sort((left, right) => Number(right.active) - Number(left.active) || right.updatedAt.localeCompare(left.updatedAt))
        .map(entry => structuredClone(entry)),
    };
  }

  async detail(projectId: string): Promise<ProjectCatalogDetailResponse> {
    const entry = this.projects.get(projectId);
    if (!entry) throw new ConsoleError("PROJECT_UNKNOWN", `项目不存在: ${projectId}`, 404);

    let config: LoadedProjectConfig;
    try {
      config = await loadProjectConfig(entry.configPath);
    } catch (error) {
      throw new ConsoleError("PROJECT_CONFIG_INVALID", `项目配置无法加载: ${errorMessage(error)}`, 409);
    }
    if (config.project.id !== entry.id || config.project.root !== entry.root) {
      throw new ConsoleError("PROJECT_CONFIG_INVALID", "项目配置与登记信息不一致", 409);
    }
    return {
      project: structuredClone(entry),
      tests: toPublicTests(config.tests),
      executionReady: PROJECT_EXECUTION_PREREQUISITE_STEP_IDS.every(id => (
        entry.onboarding.find(step => step.id === id)?.status === "verified"
      )),
    };
  }

  async register(input: RegisterProjectRequest): Promise<ProjectCatalogResponse> {
    return this.runExclusive(async () => {
      const root = await requireDirectory(input.projectDirectory, "PROJECT_DIRECTORY_REQUIRED", "请选择有效的项目目录");
      const configPath = resolveConfigPath(root, input.configFile);
      if ([...this.projects.values()].some(entry => entry.configPath === configPath)) {
        throw new ConsoleError("PROJECT_CONFIG_ALREADY_REGISTERED", "该配置文件已经登记为项目", 409);
      }
      const configFile = await fs.stat(configPath).catch(() => null);
      if (!configFile?.isFile()) {
        throw new ConsoleError("PROJECT_CONFIG_REQUIRED", `项目配置不存在: ${configPath}`, 409);
      }
      let config: LoadedProjectConfig;
      try {
        config = await loadProjectConfig(configPath);
      } catch (error) {
        throw new ConsoleError("PROJECT_CONFIG_INVALID", `项目配置无法加载: ${errorMessage(error)}`, 409);
      }
      if (config.project.root !== root) {
        throw new ConsoleError("PROJECT_CONFIG_INVALID", "配置中的 project.root 必须指向所选项目目录", 409);
      }
      if (this.projects.has(config.project.id)) {
        throw new ConsoleError("PROJECT_EXISTS", `项目 ID 已登记: ${config.project.id}`, 409);
      }
      const now = new Date().toISOString();
      this.projects.set(config.project.id, {
        id: config.project.id,
        name: config.project.name,
        root,
        configPath,
        integrationType: config.project.integrationType ?? "app",
        platforms: [...new Set(config.deviceProviders)],
        active: config.project.id === this.activeProjectId,
        createdAt: now,
        updatedAt: now,
        onboarding: createOnboarding(config.project.id, config.project.name, now),
      });
      await this.persist();
      return this.snapshot();
    });
  }

  async previewInitialization(input: PreviewProjectInitializationRequest): Promise<ProjectSetupPlan> {
    return (await this.buildInitializationPlan(input)).plan;
  }

  async applyInitialization(input: ApplyProjectInitializationRequest): Promise<ProjectSetupApplyResponse> {
    const built = await this.buildInitializationPlan(input);
    requireCurrentSetupPlan(built.plan, input.planId);
    const results = await this.executeSetupActions(built.actions);
    if (!this.projects.has(built.projectId!)) {
      await this.register({ projectDirectory: built.plan.projectDirectory, configFile: CONFIG_FILE_NAME });
    }
    const catalog = await this.verify(built.projectId!);
    return { plan: built.plan, catalog, results };
  }

  async previewSetup(projectId: string, step: ApplyProjectSetupRequest["step"]): Promise<ProjectSetupPlan> {
    return (await this.buildProjectSetupPlan(projectId, step)).plan;
  }

  async applySetup(projectId: string, input: ApplyProjectSetupRequest): Promise<ProjectSetupApplyResponse> {
    const built = await this.buildProjectSetupPlan(projectId, input.step);
    requireCurrentSetupPlan(built.plan, input.planId);
    const results = await this.executeSetupActions(built.actions);
    const catalog = await this.verify(projectId);
    return { plan: built.plan, catalog, results };
  }

  async verify(projectId: string): Promise<ProjectCatalogResponse> {
    return this.runExclusive(async () => {
      const entry = this.projects.get(projectId);
      if (!entry) throw new ConsoleError("PROJECT_UNKNOWN", `项目不存在: ${projectId}`, 404);
      const checkedAt = new Date().toISOString();
      const next = structuredClone(entry);
      next.onboarding = createOnboarding(next.id, next.name, checkedAt);

      const root = await fs.stat(next.root).catch(() => null);
      if (!root?.isDirectory()) {
        updateStep(next, "project", "blocked", "项目目录不可访问", [`目录不存在或无权限: ${next.root}`], checkedAt);
        await this.saveEntry(next);
        return this.snapshot();
      }
      updateStep(next, "project", "verified", "项目目录已登记", [], checkedAt);

      const configExists = await fs.stat(next.configPath).catch(() => null);
      if (!configExists?.isFile()) {
        updateStep(next, "template", "waiting", "等待项目写入接入配置", [`缺少配置文件: ${next.configPath}`], checkedAt);
        updateStep(next, "devices", "pending", "配置加载后检测设备和工具链", [], checkedAt);
        updateStep(next, "capabilities", "pending", "配置加载后检测 Project Provider", [], checkedAt);
        await this.saveEntry(next);
        return this.snapshot();
      }

      let config: LoadedProjectConfig;
      try {
        config = await loadProjectConfig(next.configPath);
      } catch (error) {
        updateStep(next, "template", "blocked", "项目配置无法加载", [errorMessage(error)], checkedAt);
        await this.saveEntry(next);
        return this.snapshot();
      }
      if (config.project.id !== next.id || config.project.root !== next.root) {
        updateStep(next, "template", "blocked", "项目配置与登记信息不一致", [
          `配置项目: ${config.project.id}`,
          `配置目录: ${config.project.root}`,
        ], checkedAt);
        await this.saveEntry(next);
        return this.snapshot();
      }
      next.name = config.project.name;
      next.integrationType = config.project.integrationType ?? "app";
      next.platforms = [...new Set(config.deviceProviders)];
      updateStep(
        next,
        "template",
        "verified",
        `配置已加载，声明 ${config.tests.length} 个测试入口`,
        [],
        checkedAt,
        { testEntries: createTestEntryChecks(toPublicTests(config.tests)) },
      );

      await this.verifyDevices(next, config, checkedAt);
      await this.verifyCapabilities(next, config, checkedAt);
      await this.saveEntry(next);
      return this.snapshot();
    });
  }

  async remove(projectId: string): Promise<ProjectCatalogResponse> {
    return this.runExclusive(async () => {
      if (!this.projects.has(projectId)) throw new ConsoleError("PROJECT_UNKNOWN", `项目不存在: ${projectId}`, 404);
      this.projects.delete(projectId);
      await this.persist();
      return this.snapshot();
    });
  }

  async activate(projectId: string, activeTaskCount: number): Promise<ProjectActivationResponse> {
    return this.runExclusive(async () => {
      const entry = this.projects.get(projectId);
      if (!entry) throw new ConsoleError("PROJECT_UNKNOWN", `项目不存在: ${projectId}`, 404);
      if (activeTaskCount > 0) {
        throw new ConsoleError("PROJECT_SWITCH_TASK_ACTIVE", `当前有 ${activeTaskCount} 个活动任务，请先停止任务`, 409);
      }

      const configExists = await fs.stat(entry.configPath).catch(() => null);
      if (!configExists?.isFile()) {
        throw new ConsoleError("PROJECT_SWITCH_CONFIG_REQUIRED", `项目配置不存在: ${entry.configPath}`, 409);
      }
      let config: LoadedProjectConfig;
      try {
        config = await loadProjectConfig(entry.configPath);
      } catch (error) {
        throw new ConsoleError(
          "PROJECT_SWITCH_CONFIG_INVALID",
          `项目配置无法加载: ${errorMessage(error)}`,
          409,
        );
      }
      if (config.project.id !== entry.id || config.project.root !== entry.root) {
        throw new ConsoleError("PROJECT_SWITCH_CONFIG_INVALID", "项目配置与登记信息不一致", 409);
      }
      return {
        catalog: this.snapshot(),
        projectId: entry.id,
        configPath: entry.configPath,
        restartRequired: true,
      };
    });
  }

  private async verifyDevices(entry: ProjectCatalogEntry, config: LoadedProjectConfig, checkedAt: string): Promise<void> {
    if (projectFamilyOf(config.project.integrationType ?? "app") === "mini-program") {
      await this.verifyRunTargets(entry, config, checkedAt);
      return;
    }
    const requestedPlatforms = entry.platforms.filter(platform => config.deviceProviders.includes(platform));
    if (requestedPlatforms.length === 0) {
      updateStep(entry, "devices", "blocked", "项目配置未声明登记的平台", [
        `登记平台: ${entry.platforms.map(platformLabel).join("、")}`,
        `配置平台: ${config.deviceProviders.map(platformLabel).join("、") || "无"}`,
      ], checkedAt);
      return;
    }
    const toolchain = await inspectDeviceTools(requestedPlatforms, this.runner);
    if (toolchain.issues.length > 0) {
      updateStep(entry, "devices", "blocked", "设备工具链需要处理", toolchain.issues, checkedAt, { tools: toolchain.tools });
      return;
    }
    const devices = new DeviceDiscoveryService(this.runner, config.deviceProviders, config.iosSimulator, config);
    const discovery = await devices.snapshot({ refresh: true });
    const errors = requestedPlatforms.flatMap(platform => discovery.errors[platform]
      ? [`${platformLabel(platform)}：${discovery.errors[platform]}`]
      : []);
    const unavailable = requestedPlatforms.filter(platform => !discovery.devices.some(device => (
      device.platform === platform
      && device.connectionState === "available"
      && device.controlState === "ready"
      && !device.preparations?.some(preparation => preparation.blocksTests && preparation.status !== "ready")
    )));
    if (errors.length > 0) {
      updateStep(entry, "devices", "blocked", "设备或工具链需要处理", errors, checkedAt, { tools: toolchain.tools });
      return;
    }
    if (unavailable.length > 0) {
      updateStep(
        entry,
        "devices",
        "waiting",
        `等待 ${unavailable.map(platformLabel).join("、")} 可测试设备`,
        unavailable.flatMap(platform => describeUnavailableDevices(platform, discovery.devices)),
        checkedAt,
        { tools: toolchain.tools },
      );
      return;
    }
    updateStep(
      entry,
      "devices",
      "verified",
      `${toolchain.ready.join("、")} 可用，已检测到 ${requestedPlatforms.length} 个目标平台的可测试设备`,
      [],
      checkedAt,
      { tools: toolchain.tools },
    );
  }

  private async verifyRunTargets(entry: ProjectCatalogEntry, config: LoadedProjectConfig, checkedAt: string): Promise<void> {
    const targets = config.testing?.targets ?? [];
    if (targets.length === 0) {
      updateStep(entry, "devices", "blocked", "项目尚未声明小程序运行环境", [
        "在 mobile-test.config.cjs 的 testing.targets 中声明运行目标。",
      ], checkedAt);
      return;
    }
    const tools = await Promise.all(targets.map(async target => {
      const command = resolveTargetHealthCheckCommand(config, target.key);
      if (!command) {
        return {
          id: target.key,
          label: target.label,
          executable: "",
          status: "blocked" as const,
          path: "",
          version: target.runtime,
          detail: "运行目标缺少 healthCheck",
          guidance: ["为 testing.targets[].healthCheck 配置可重复执行的环境检查命令。"],
        };
      }
      try {
        const result = await this.runner.capture(command.executable, command.args, 30_000, {
          cwd: command.cwd,
          env: command.env,
        });
        return {
          id: target.key,
          label: target.label,
          executable: command.executable,
          status: result.code === 0 ? "ready" as const : "blocked" as const,
          path: command.cwd,
          version: target.runtime,
          detail: result.code === 0
            ? String(result.stdout || "运行环境可用").trim()
            : String(result.stderr || result.stdout || `退出码 ${result.code}`).trim(),
          guidance: result.code === 0 ? [] : ["按项目运行环境检查输出完成配置后重新验证。"],
        };
      } catch (error) {
        return {
          id: target.key,
          label: target.label,
          executable: command.executable,
          status: "blocked" as const,
          path: command.cwd,
          version: target.runtime,
          detail: errorMessage(error),
          guidance: ["确认项目 Node、包管理器和小程序开发工具配置后重新验证。"],
        };
      }
    }));
    const blocked = tools.filter(tool => tool.status === "blocked");
    updateStep(
      entry,
      "devices",
      blocked.length === 0 ? "verified" : "blocked",
      blocked.length === 0 ? `已验证 ${tools.length} 个小程序运行环境` : `${blocked.length} 个运行环境需要处理`,
      blocked.map(tool => `${tool.label}：${tool.detail}`),
      checkedAt,
      { tools },
    );
  }

  private async verifyCapabilities(entry: ProjectCatalogEntry, config: LoadedProjectConfig, checkedAt: string): Promise<void> {
    try {
      const runtime = await loadRunnerRuntime(config, [], new ResultBundleStore(config.stateDir));
      const capabilities = new Set(runtime.providers.manifests()
        .flatMap(provider => provider.capabilities.map(capability => capability.id)));
      const declarations = config.testing?.capabilities ?? [];
      if (declarations.length === 0 && entry.integrationType !== "app") {
        updateStep(
          entry,
          "capabilities",
          "waiting",
          "项目尚未声明测试能力",
          ["在 mobile-test.config.cjs 的 testing.capabilities 中声明测试能力和 Provider。"],
          checkedAt,
          { capabilities: [] },
        );
        return;
      }
      const required = declarations.filter(capability => capability.required);
      const providerCapabilities = new Map(runtime.providers.manifests().map(provider => [
        provider.providerId,
        new Set(provider.capabilities.map(capability => capability.id)),
      ]));
      const missing = required.filter(capability => !providerCapabilities.get(capability.providerId)?.has(capability.id));
      const checks = createCapabilityChecks(declarations, providerCapabilities, capabilities);
      updateStep(
        entry,
        "capabilities",
        missing.length === 0 ? "verified" : "waiting",
        missing.length === 0
          ? (declarations.length === 0 ? "基础命令测试能力已就绪" : `已检测到 ${checks.length} 项项目能力`)
          : `等待 ${missing.length} 项项目能力（Project Provider）`,
        missing.map(capability => `${capability.label} (${capability.id})`),
        checkedAt,
        { capabilities: checks },
      );
    } catch (error) {
      updateStep(
        entry,
        "capabilities",
        "blocked",
        "Project Provider 或 Runner 无法加载",
        [errorMessage(error)],
        checkedAt,
        { capabilities: createCapabilityChecks(config.testing?.capabilities ?? [], new Map(), new Set()) },
      );
    }
  }

  private async buildInitializationPlan(input: PreviewProjectInitializationRequest): Promise<BuiltSetupPlan> {
    const root = await requireDirectory(input.projectDirectory, "PROJECT_DIRECTORY_REQUIRED", "请选择有效的项目目录");
    const platforms = [...new Set(input.platforms)].filter(platform => PLATFORMS.includes(platform));
    const existingEntry = [...this.projects.values()].find(entry => entry.root === root);
    const projectId = existingEntry?.id ?? inferProjectId(root);
    const projectName = existingEntry?.name ?? (path.basename(root) || "Lynx App");
    const configPath = existingEntry?.configPath ?? path.join(root, CONFIG_FILE_NAME);
    const configProjectRoot = path.relative(path.dirname(configPath), root).split(path.sep).join("/") || ".";
    const smokePath = path.join(root, "qa", "mtc", "lynx-smoke.cjs");
    const guidePath = path.join(root, "qa", "mtc", "README.md");
    const conflicts = await existingPaths([configPath, smokePath, guidePath]);
    const idConflict = [...this.projects.values()].some(entry => entry.id === projectId && entry.root !== root);
    const blockingReason = platforms.length === 0
      ? "至少选择一个目标平台"
      : idConflict
        ? `项目 ID 已登记: ${projectId}`
        : conflicts.length > 0
          ? `以下文件已存在：${conflicts.join("、")}`
          : "";
    const actions: InternalSetupAction[] = [
      fileAction("write-config", "创建 MTC 项目配置", configPath, buildInitialConfig(projectId, projectName, configProjectRoot, platforms)),
      fileAction("write-smoke", "创建 Smoke 命令骨架", smokePath, buildSmokeScript()),
      fileAction("write-guide", "创建接入说明", guidePath, buildSetupGuide()),
    ];
    return finalizeSetupPlan({
      step: "config",
      projectId,
      projectDirectory: root,
      summary: `初始化 ${projectName} 的 Lynx App 测试接入`,
      actions,
      canApply: blockingReason.length === 0,
      blockingReason,
    });
  }

  private async buildProjectSetupPlan(
    projectId: string,
    step: ApplyProjectSetupRequest["step"],
  ): Promise<BuiltSetupPlan> {
    const entry = this.projects.get(projectId);
    if (!entry) throw new ConsoleError("PROJECT_UNKNOWN", `项目不存在: ${projectId}`, 404);
    if (step === "devices") return buildDeviceSetupPlan(entry, this.runner);

    const config = await loadProjectConfig(entry.configPath);
    const capabilityIds = (config.testing?.capabilities ?? []).map(capability => capability.id);

    const providerPath = path.join(entry.root, "qa", "mtc", "project-provider.cjs");
    const runnerPath = path.join(entry.root, "qa", "mtc", "runner.cjs");
    const fragmentPath = path.join(entry.root, "qa", "mtc", "mobile-test.config.fragment.cjs");
    const candidates = [
      fileAction("write-provider", "创建 Project Provider 能力模板", providerPath, buildProviderTemplate(entry.id)),
      fileAction("write-runner", "创建 Runner 插件模板", runnerPath, buildRunnerTemplate()),
      fileAction("write-config-fragment", "创建配置接入片段", fragmentPath, buildConfigFragment()),
    ];
    const conflicts = await existingPaths(candidates.map(action => action.target!));
    const actions = candidates.filter(action => !conflicts.includes(action.target!));
    const manualAction: InternalSetupAction = {
      id: "complete-capabilities",
      kind: "manual",
      label: "实现并声明项目能力",
      detail: capabilityIds.length > 0
        ? `在 Provider 中实现 ${capabilityIds.join("、")}，并保持能力清单与 mobile-test.config.cjs 一致。`
        : "先在 mobile-test.config.cjs 的 testing.capabilities 中声明项目能力，再在 Provider 中实现。",
      target: entry.configPath,
    };
    actions.push(manualAction);
    const blockingReason = actions.every(action => action.kind === "manual")
      ? "能力模板已存在，请按模板完成实现并重新验证"
      : "";
    return finalizeSetupPlan({
      step: "capabilities",
      projectId: entry.id,
      projectDirectory: entry.root,
      summary: "生成 Lynx App Provider 与 Runner 能力骨架",
      actions,
      canApply: blockingReason.length === 0,
      blockingReason,
    });
  }

  private async executeSetupActions(actions: InternalSetupAction[]): Promise<ProjectSetupActionResult[]> {
    const createdFiles: string[] = [];
    const results: ProjectSetupActionResult[] = [];
    try {
      for (const action of actions) {
        if (action.kind === "manual") {
          results.push({ actionId: action.id, status: "manual", detail: action.detail });
          continue;
        }
        if (action.kind === "write-file") {
          await fs.mkdir(path.dirname(action.target!), { recursive: true });
          await fs.writeFile(action.target!, action.content!, { flag: "wx" });
          createdFiles.push(action.target!);
          results.push({ actionId: action.id, status: "completed", detail: `已创建 ${action.target}` });
          continue;
        }
        const result = await this.runner.capture(action.executable!, action.args!, 10 * 60_000, { cwd: action.cwd });
        if (result.code !== 0) {
          throw new ConsoleError(
            "PROJECT_SETUP_COMMAND_FAILED",
            `${action.label}失败: ${result.stderr.trim() || result.stdout.trim() || `退出码 ${result.code}`}`,
            500,
          );
        }
        results.push({ actionId: action.id, status: "completed", detail: result.stdout.trim() || `${action.label}已完成` });
      }
      return results;
    } catch (error) {
      await Promise.all(createdFiles.map(file => fs.rm(file, { force: true })));
      throw error;
    }
  }

  private async saveEntry(entry: ProjectCatalogEntry): Promise<void> {
    entry.updatedAt = new Date().toISOString();
    entry.active = entry.id === this.activeProjectId;
    this.projects.set(entry.id, normalizeEntry(entry));
    this.markActiveProject();
    await this.persist();
  }

  private markActiveProject(): void {
    for (const [projectId, entry] of this.projects) {
      entry.active = projectId === this.activeProjectId;
    }
  }

  private async persist(): Promise<void> {
    await this.store.save({
      schemaVersion: CATALOG_SCHEMA_VERSION,
      activeProjectId: this.activeProjectId,
      projects: [...this.projects.values()].map(entry => structuredClone(entry)),
    });
  }

  private async runExclusive<T>(action: () => Promise<T>): Promise<T> {
    const result = this.operationQueue.then(action);
    this.operationQueue = result.then(() => undefined, () => undefined);
    return result;
  }
}

const CONFIG_FILE_NAME = "mobile-test.config.cjs";
const CONFIG_SCAN_IGNORED_DIRECTORIES = new Set([".git", "node_modules", "dist", "build", ".next", ".mtc-state"]);

export async function resolveProjectConfigSelection(configPath: string): Promise<ProjectConfigSelection> {
  const resolvedConfigPath = path.resolve(configPath);
  const configStat = await fs.stat(resolvedConfigPath).catch(() => null);
  if (!configStat?.isFile()) {
    throw new ConsoleError("PROJECT_CONFIG_REQUIRED", `项目配置不存在: ${resolvedConfigPath}`, 409);
  }
  let config: LoadedProjectConfig;
  try {
    config = await loadProjectConfig(resolvedConfigPath);
  } catch (error) {
    throw new ConsoleError("PROJECT_CONFIG_INVALID", `项目配置无法加载: ${errorMessage(error)}`, 409);
  }
  const relativeConfigPath = path.relative(config.project.root, resolvedConfigPath);
  if (!relativeConfigPath || relativeConfigPath.startsWith(`..${path.sep}`) || path.isAbsolute(relativeConfigPath)) {
    throw new ConsoleError("PROJECT_CONFIG_INVALID", "配置文件必须位于 project.root 目录内", 409);
  }
  return {
    projectDirectory: config.project.root,
    configFile: relativeConfigPath.split(path.sep).join("/"),
    configPath: resolvedConfigPath,
    configFound: true,
  };
}

export async function scanProjectDirectory(inputDirectory: string): Promise<ProjectConfigSelection> {
  const root = await requireDirectory(inputDirectory, "PROJECT_DIRECTORY_REQUIRED", "请选择有效的项目目录");
  const configPath = await findProjectConfig(root);
  if (!configPath) {
    return {
      projectDirectory: root,
      configFile: CONFIG_FILE_NAME,
      configPath: path.join(root, CONFIG_FILE_NAME),
      configFound: false,
    };
  }
  return resolveProjectConfigSelection(configPath);
}

async function findProjectConfig(root: string): Promise<string | null> {
  const queue: Array<{ directory: string; depth: number }> = [{ directory: root, depth: 0 }];
  while (queue.length > 0) {
    const current = queue.shift()!;
    const entries = await fs.readdir(current.directory, { withFileTypes: true }).catch(() => []);
    const config = entries
      .filter(entry => entry.isFile() && entry.name === CONFIG_FILE_NAME)
      .sort((left, right) => left.name.localeCompare(right.name))[0];
    if (config) return path.join(current.directory, config.name);
    if (current.depth >= 3) continue;
    for (const entry of entries
      .filter(item => item.isDirectory() && !CONFIG_SCAN_IGNORED_DIRECTORIES.has(item.name))
      .sort((left, right) => left.name.localeCompare(right.name))) {
      queue.push({ directory: path.join(current.directory, entry.name), depth: current.depth + 1 });
    }
  }
  return null;
}

function emptyCatalog(): StoredCatalog {
  return { schemaVersion: CATALOG_SCHEMA_VERSION, activeProjectId: "", projects: [] };
}

function normalizeEntry(entry: ProjectCatalogEntry): ProjectCatalogEntry {
  const checkedAt = entry.updatedAt || new Date().toISOString();
  const byId = new Map(entry.onboarding.map(step => [step.id, step]));
  return {
    ...entry,
    platforms: [...new Set(entry.platforms)],
    onboarding: PROJECT_ONBOARDING_STEP_IDS.map(id => ({
      id,
      status: byId.get(id)?.status ?? "pending",
      summary: byId.get(id)?.summary ?? stepDefaultSummary(id, entry.name),
      issues: [...(byId.get(id)?.issues ?? [])],
      checkedAt: byId.get(id)?.checkedAt ?? checkedAt,
      tools: structuredClone(byId.get(id)?.tools ?? []),
      capabilities: structuredClone(byId.get(id)?.capabilities ?? []),
      testEntries: structuredClone(byId.get(id)?.testEntries ?? []),
    })),
  };
}

function createOnboarding(projectId: string, projectName: string, checkedAt: string): ProjectOnboardingStep[] {
  return PROJECT_ONBOARDING_STEP_IDS.map(id => ({
    id,
    status: id === "project" ? "verified" : "pending",
    summary: id === "project" ? `已登记 ${projectName || projectId}` : stepDefaultSummary(id, projectName),
    issues: [],
    checkedAt,
    tools: [],
    capabilities: [],
    testEntries: [],
  }));
}

function updateStep(
  entry: ProjectCatalogEntry,
  id: ProjectOnboardingStep["id"],
  status: ProjectOnboardingStep["status"],
  summary: string,
  issues: string[],
  checkedAt: string,
  details: {
    tools?: ProjectToolCheck[];
    capabilities?: ProjectCapabilityCheck[];
    testEntries?: ProjectTestEntryCheck[];
  } = {},
): void {
  const step = entry.onboarding.find(item => item.id === id);
  if (!step) return;
  step.status = status;
  step.summary = summary;
  step.issues = issues;
  step.checkedAt = checkedAt;
  step.tools = structuredClone(details.tools ?? []);
  step.capabilities = structuredClone(details.capabilities ?? []);
  step.testEntries = structuredClone(details.testEntries ?? []);
}

function createTestEntryChecks(tests: ReturnType<typeof toPublicTests>): ProjectTestEntryCheck[] {
  return tests.map(test => ({
    id: test.id,
    label: test.label,
    testType: test.testType,
    description: test.description,
    runnerId: test.runnerId,
    platforms: [...test.platforms],
    targetKeys: [...(test.targetKeys ?? [])],
    parameterLabels: test.parameters.map(parameter => parameter.label),
  }));
}

function createCapabilityChecks(
  declarations: ProjectTestingManifest["capabilities"],
  providerCapabilities: Map<string, Set<string>>,
  available: Set<string>,
): ProjectCapabilityCheck[] {
  if (declarations.length > 0) {
    return declarations.map(capability => {
      const ready = providerCapabilities.get(capability.providerId)?.has(capability.id) === true;
      return {
        id: capability.id,
        label: capability.label,
        status: ready ? "ready" : "missing",
        detail: capability.description || `由 ${capability.providerId} 提供。`,
        guidance: ready ? [] : capability.guidance,
      };
    });
  }
  return [...available].sort().map(id => ({
    id,
    label: id,
    status: "ready",
    detail: "项目 Provider 已声明此能力。",
    guidance: [],
  }));
}

async function requireDirectory(input: string, code: string, message: string): Promise<string> {
  const root = path.resolve(input.trim());
  const stat = await fs.stat(root).catch(() => null);
  if (!stat?.isDirectory()) throw new ConsoleError(code, message, 409);
  return root;
}

function resolveConfigPath(root: string, configFile: string): string {
  const normalized = configFile.trim() || "mobile-test.config.cjs";
  if (path.isAbsolute(normalized)) {
    throw new ConsoleError("PROJECT_CONFIG_PATH_INVALID", "配置文件应使用项目目录内的相对路径");
  }
  const configPath = path.resolve(root, normalized);
  const relative = path.relative(root, configPath);
  if (!relative || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new ConsoleError("PROJECT_CONFIG_PATH_INVALID", "配置文件需要位于项目目录内");
  }
  return configPath;
}

function platformLabel(platform: Platform): string {
  return platform === "android" ? "Android" : platform === "ios" ? "iOS" : "HarmonyOS";
}

async function inspectDeviceTools(
  platforms: Platform[],
  runner: CommandRunner,
): Promise<{ ready: string[]; issues: string[]; tools: ProjectToolCheck[] }> {
  const checks = await Promise.all(platforms.map(async platform => {
    const requirement = deviceToolRequirement(platform);
    if (platform === "ios" && process.platform !== "darwin") {
      return createToolCheck(
        requirement,
        { code: 1, stdout: "", stderr: "当前系统不是 macOS" },
        "iOS 测试需要 macOS 与 Xcode Command Line Tools",
      );
    }
    try {
      return createToolCheck(requirement, await runner.capture(requirement.executable, requirement.args, 5_000));
    } catch (error) {
      return createToolCheck(requirement, { code: 1, stdout: "", stderr: errorMessage(error) });
    }
  }));
  return {
    ready: checks.filter(check => check.status === "ready").map(check => check.label),
    issues: checks.filter(check => check.status === "blocked")
      .map(check => `${check.label}：${check.detail}；${check.guidance.join("；")}`),
    tools: checks,
  };
}

interface DeviceToolRequirement {
  id: string;
  label: string;
  executable: string;
  args: string[];
  guidance: string[];
}

function deviceToolRequirement(platform: Platform): DeviceToolRequirement {
  if (platform === "android") {
    return {
      id: "android-adb",
      label: "Android Platform Tools",
      executable: "adb",
      args: ["version"],
      guidance: [
        "macOS 可执行：brew install android-platform-tools",
        "自定义 adb：export ANDROID_ADB_PATH=/绝对路径/platform-tools/adb",
        "Android SDK：export ANDROID_SDK_ROOT=/绝对路径/Android/sdk",
        "设置后重启 MTC，点击“验证接入”重新检测。",
      ],
    };
  }
  if (platform === "harmony") {
    return {
      id: "harmony-hdc",
      label: "HarmonyOS hdc",
      executable: "hdc",
      args: ["version"],
      guidance: [
        "安装 DevEco Studio，并确认 SDK 中存在 toolchains/hdc。",
        "自定义 hdc：export HARMONY_HDC_PATH=/绝对路径/toolchains/hdc",
        "也可设置 HARMONY_SDK_HOME 或 DEVECO_SDK_HOME。",
        "设置后重启 MTC，点击“验证接入”重新检测。",
      ],
    };
  }
  return {
    id: "ios-xcode",
    label: "Xcode Command Line Tools",
    executable: "xcode-select",
    args: ["-p"],
    guidance: [
      "安装 Xcode：从 Mac App Store 安装 Xcode。",
      "选择开发者目录：sudo xcode-select --switch /Applications/Xcode.app/Contents/Developer",
      "缺少命令行工具时执行：xcode-select --install",
      "设置后重启 MTC，点击“验证接入”重新检测。",
    ],
  };
}

function createToolCheck(
  requirement: DeviceToolRequirement,
  result: { code: number; stdout?: string; stderr?: string },
  detailOverride = "",
): ProjectToolCheck {
  const ready = result.code === 0;
  const output = String(result.stdout || "").trim();
  const error = String(result.stderr || "").trim();
  const pathValue = requirement.executable === "xcode-select"
    ? (ready ? output : "")
    : resolveDeviceExecutable(requirement.executable);
  return {
    id: requirement.id,
    label: requirement.label,
    executable: requirement.executable,
    status: ready ? "ready" : "blocked",
    path: pathValue === requirement.executable ? "" : pathValue,
    version: ready
      ? requirement.executable === "xcode-select"
        ? "已选择开发者目录"
        : output.split("\n")[0] || "可执行"
      : "",
    detail: ready ? "命令可执行，项目 Runner 将继承此工具环境。" : detailOverride || error || output || "命令执行失败",
    guidance: ready ? [] : requirement.guidance,
  };
}

function describeUnavailableDevices(platform: Platform, devices: Awaited<ReturnType<DeviceDiscoveryService["snapshot"]>>["devices"]): string[] {
  const label = platformLabel(platform);
  const candidates = devices.filter(device => device.platform === platform);
  if (candidates.length === 0) return [`${label}：未发现设备，请连接设备或启动模拟器`];
  const issues = candidates.flatMap(device => {
    if (device.connectionState === "unauthorized") return [`${label} · ${device.name}：等待设备授权`];
    if (device.connectionState === "offline") return [`${label} · ${device.name}：设备离线`];
    if (device.connectionState === "unavailable") return [`${label} · ${device.name}：${device.detail || "设备不可用"}`];
    if (device.controlState !== "ready") return [`${label} · ${device.name}：${device.controlReason || "设备尚未就绪"}`];
    return (device.preparations ?? [])
      .filter(preparation => preparation.blocksTests && preparation.status !== "ready")
      .map(preparation => `${label} · ${device.name}：${preparation.label} ${preparation.detail}`);
  });
  return [...new Set(issues)];
}

function stepDefaultSummary(id: ProjectOnboardingStep["id"], projectName: string): string {
  if (id === "template") return "选择接入模板并写入项目配置";
  if (id === "devices") return "检测目标平台的工具链和设备";
  if (id === "capabilities") return "声明项目构建、安装和页面能力";
  return `已登记 ${projectName}`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function requireCurrentSetupPlan(plan: ProjectSetupPlan, planId: string): void {
  if (plan.planId !== planId) {
    throw new ConsoleError("PROJECT_SETUP_PLAN_STALE", "接入计划已变化，请重新预览后确认", 409);
  }
  if (!plan.canApply) {
    throw new ConsoleError("PROJECT_SETUP_BLOCKED", plan.blockingReason || "当前接入计划无法执行", 409);
  }
}

function inferProjectId(root: string): string {
  const candidate = path.basename(root)
    .toLowerCase()
    .replace(/[_\s]+/g, "-")
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  if (/^[a-z][a-z0-9-]*$/.test(candidate)) return candidate;
  return `lynx-app-${digest(root).slice(0, 8)}`;
}

async function existingPaths(paths: string[]): Promise<string[]> {
  const checks = await Promise.all(paths.map(async target => (
    await fs.stat(target).then(() => true, () => false) ? target : ""
  )));
  return checks.filter(Boolean);
}

function fileAction(id: string, label: string, target: string, content: string): InternalSetupAction {
  return {
    id,
    kind: "write-file",
    label,
    detail: `创建 ${target}`,
    target,
    content,
  };
}

function finalizeSetupPlan(input: Omit<BuiltSetupPlan, "plan"> & {
  step: ProjectSetupPlan["step"];
  projectDirectory: string;
  summary: string;
  canApply: boolean;
  blockingReason: string;
}): BuiltSetupPlan {
  const actions = input.actions.map(action => ({
    id: action.id,
    kind: action.kind,
    label: action.label,
    detail: action.detail,
    ...(action.target ? { target: action.target } : {}),
    ...(action.kind === "command" ? {
      command: [action.executable, ...(action.args ?? [])].filter(Boolean).join(" "),
      ...(action.cwd ? { cwd: action.cwd } : {}),
    } : {}),
    ...(action.content ? { contentPreview: previewContent(action.content) } : {}),
  }));
  const fingerprint = {
    schemaVersion: "mobile-test-console.project-setup.v1",
    step: input.step,
    projectId: input.projectId,
    projectDirectory: input.projectDirectory,
    summary: input.summary,
    actions: input.actions.map(action => ({
      ...action,
      contentDigest: action.content ? digest(action.content) : "",
      content: undefined,
    })),
    canApply: input.canApply,
    blockingReason: input.blockingReason,
  };
  return {
    projectId: input.projectId,
    actions: input.actions,
    plan: {
      schemaVersion: "mobile-test-console.project-setup.v1",
      planId: digest(JSON.stringify(fingerprint)),
      step: input.step,
      ...(input.projectId ? { projectId: input.projectId } : {}),
      projectDirectory: input.projectDirectory,
      summary: input.summary,
      actions,
      canApply: input.canApply,
      blockingReason: input.blockingReason,
    },
  };
}

async function buildDeviceSetupPlan(
  entry: ProjectCatalogEntry,
  runner: CommandRunner,
): Promise<BuiltSetupPlan> {
  const actions: InternalSetupAction[] = [];
  if (entry.platforms.includes("android")) {
    const adb = await runner.capture("adb", ["version"], 5_000);
    if (adb.code !== 0 && process.platform === "darwin") {
      actions.push({
        id: "install-android-platform-tools",
        kind: "command",
        label: "安装 Android Platform Tools",
        detail: "通过 Homebrew 安装 adb，用于发现和控制 Android 设备。",
        executable: "brew",
        args: ["install", "android-platform-tools"],
        cwd: entry.root,
      });
    } else if (adb.code !== 0) {
      actions.push({
        id: "install-adb-manually",
        kind: "manual",
        label: "安装 Android Platform Tools",
        detail: "安装 adb 并加入 PATH，然后重新验证设备环境。",
      });
    }
    actions.push({
      id: "connect-android-device",
      kind: "manual",
      label: "连接并授权 Android 设备",
      detail: "启用 USB 调试，连接设备并确认调试授权。",
    });
  }
  if (entry.platforms.includes("ios")) {
    const xcode = process.platform === "darwin"
      ? await runner.capture("xcode-select", ["-p"], 5_000)
      : { code: 1 };
    if (xcode.code !== 0 && process.platform === "darwin") {
      actions.push({
        id: "install-xcode-command-line-tools",
        kind: "command",
        label: "安装 Xcode Command Line Tools",
        detail: "启动 Apple 开发工具安装器，安装完成后重新验证。",
        executable: "xcode-select",
        args: ["--install"],
        cwd: entry.root,
      });
    } else if (process.platform !== "darwin") {
      actions.push({
        id: "prepare-ios-macos",
        kind: "manual",
        label: "准备 macOS 与 Xcode",
        detail: "iOS 测试需要在安装 Xcode 的 macOS 设备上运行 MTC。",
      });
    }
    actions.push({
      id: "connect-ios-device",
      kind: "manual",
      label: "连接 iOS 设备或启动模拟器",
      detail: "完成设备信任、开发者模式和签名配置，或启动配置中声明的模拟器。",
    });
  }
  if (entry.platforms.includes("harmony")) {
    actions.push({
      id: "prepare-harmony-toolchain",
      kind: "manual",
      label: "安装 DevEco Studio 与 hdc",
      detail: "安装 DevEco Studio，将 hdc 加入 PATH，并完成 HarmonyOS 设备授权。",
    });
  }
  const executableCount = actions.filter(action => action.kind !== "manual").length;
  return finalizeSetupPlan({
    step: "devices",
    projectId: entry.id,
    projectDirectory: entry.root,
    summary: "修复项目声明平台的设备工具链",
    actions,
    canApply: executableCount > 0,
    blockingReason: executableCount > 0 ? "" : "工具链已可调用，请完成设备连接与授权后重新验证",
  });
}

function buildInitialConfig(projectId: string, projectName: string, projectRoot: string, platforms: Platform[]): string {
  return `module.exports = {
  schemaVersion: "mobile-test-console.config.v1",
  project: {
    id: ${JSON.stringify(projectId)},
    name: ${JSON.stringify(projectName)},
    root: ${JSON.stringify(projectRoot)},
    integrationType: "lynx-app",
  },
  stateDir: "./.mtc-state",
  adapter: { workspaces: [] },
  deviceProviders: ${JSON.stringify(platforms)},
  tests: [{
    id: "lynx-smoke",
    label: "Lynx Smoke",
    description: "验证 Lynx App 基础启动链路。",
    platforms: ${JSON.stringify(platforms)},
    commands: {
      default: {
        executable: "node",
        args: ["qa/mtc/lynx-smoke.cjs", "--platform", "{{device.platform}}", "--device", "{{device.id}}", "--run-id", "{{task.runId}}"],
      },
    },
  }],
};
`;
}

function buildSmokeScript(): string {
  return `const args = process.argv.slice(2);

console.log("[MTC] Lynx Smoke 骨架已执行", args.join(" "));
console.log("请在 qa/mtc/lynx-smoke.cjs 中接入项目的构建、安装和页面验证命令。");
`;
}

function buildSetupGuide(): string {
  return `# Mobile Test Console 接入

1. 在 \`mobile-test.config.cjs\` 中确认项目 ID、目标平台和 Smoke 命令。
2. 在 MTC 项目概览中执行“验证接入”，确认本机 adb、Xcode 或 hdc 工具链可用。
3. 工具位于自定义目录时，设置 ANDROID_ADB_PATH、ANDROID_SDK_ROOT、ANDROID_HOME、HARMONY_HDC_PATH、HARMONY_SDK_HOME 或 DEVECO_SDK_HOME。
4. 连接目标设备，完成调试授权后重新验证设备环境。
5. 通过“生成能力模板”创建 Project Provider 与 Runner 骨架。
6. 实现构建、安装、账号前置、页面参数解析和结果分析能力。
7. 在配置中声明项目工作区，完成验证后进入“执行测试”。
`;
}

function buildProviderTemplate(projectId: string): string {
  return `const PROVIDER_ID = ${JSON.stringify(`${projectId}-provider`)};

module.exports = {
  apiVersion: "mobile-test-console.project-provider-plugin.v1",
  createProviders() {
    return [{
      id: PROVIDER_ID,
      manifest: {
        schemaVersion: "mobile-test-console.project-provider.v1",
        providerId: PROVIDER_ID,
        scope: { targetKinds: ["app"], runtimes: ["lynx"] },
        capabilities: [{ id: "integration.todo", version: 1 }],
      },
    }];
  },
};

module.exports.PROVIDER_ID = PROVIDER_ID;
`;
}

function buildRunnerTemplate(): string {
  return `const provider = require("./project-provider.cjs");

module.exports = {
  apiVersion: "mobile-test-console.runner-plugin.v1",
  createRunners(context) {
    context.services.requireProjectProvider(provider.PROVIDER_ID, []);
    return [context.services.createProviderCommandRunner(
      "lynx-project-runner",
      provider.PROVIDER_ID,
      [],
    )];
  },
};
`;
}

function buildConfigFragment(): string {
  return `// 将以下字段合入项目根目录的 mobile-test.config.cjs。
projectProviderPlugins: [{ module: "./qa/mtc/project-provider.cjs" }],
runnerPlugins: [{ module: "./qa/mtc/runner.cjs" }],
adapter: {
  workspaces: ["page-parameters", "business-scripts", "account-profiles"],
},
`;
}

function previewContent(content: string): string {
  const maximumLength = 1_200;
  return content.length <= maximumLength ? content : `${content.slice(0, maximumLength)}\n...`;
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
