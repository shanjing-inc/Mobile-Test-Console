import {
  AlertCircle,
  CheckCircle2,
  ChevronDown,
  ClipboardCopy,
  ArrowUp,
  ArrowDown,
  Plus,
  FolderPlus,
  FolderOpen,
  FileText,
  HardDrive,
  Eye,
  Trash2,
  LoaderCircle,
  Power,
  RefreshCw,
  Smartphone,
  PanelsTopLeft,
  Terminal,
  Wrench,
  X,
} from "lucide-react";
import { useEffect, useState } from "react";
import type {
  Platform,
  ArtifactCleanupPlan,
  ArtifactRetentionSnapshot,
  ApplyProjectInitializationRequest,
  ApplyProjectSetupRequest,
  ProjectCapabilityCheck,
  ProjectCatalogEntry,
  ProjectCatalogDetailResponse,
  ProjectCatalogResponse,
  ProjectConfigSelection,
  ProjectFamily,
  ProjectIntegrationType,
  ProjectOnboardingStep,
  ProjectOnboardingStepStatus,
  ProjectTestEntryCheck,
  ProjectTestEntryEditorResponse,
  ProjectTestEntryInput,
  ProjectTestEntryPlan,
  TestParameterDefinition,
  ProjectToolCheck,
  ProjectSetupApplyResponse,
  ProjectSetupPlan,
  PreviewProjectInitializationRequest,
  RegisterProjectRequest,
} from "../shared/contracts";
import { PROJECT_EXECUTION_PREREQUISITE_STEP_IDS } from "../shared/contracts";
import { createUniqueTestEntryId, parseTestCommandLine, TestCommandLineError } from "../shared/test-command-line";
import { ApiError, applyArtifactCleanup, applyProjectTestEntry, fetchArtifactRetention, fetchProjectCatalogDetail, fetchProjectTestEntryEditor, inventoryArtifactCleanup, previewArtifactCleanup, previewProjectTestEntry } from "./api";

const platformLabels: Record<Platform, string> = {
  android: "Android",
  ios: "iOS",
  harmony: "HarmonyOS",
};

const integrationLabels: Record<ProjectIntegrationType, string> = {
  "lynx-app": "Lynx App",
  app: "通用 App",
  "mini-program": "小程序",
};

const stepLabels = {
  project: "确认项目位置",
  template: "准备测试配置",
  devices: "检查运行环境",
  capabilities: "配置项目能力",
} as const;

const stepDescriptions = {
  project: "让 MTC 记住项目目录，后续检测和测试都会在这里执行。",
  template: "创建项目的测试清单，告诉 MTC 要运行什么测试以及使用哪些环境。",
  devices: "确认本机已经具备运行测试所需的软件、设备或小程序开发工具。",
  capabilities: "接入后，MTC 可以在测试前自动完成构建、安装和账号准备，并在测试后整理结果。",
} as const;

const stepNextActions = {
  project: "选择包含项目代码的目录。",
  template: "生成基础配置，再按项目实际情况填写测试命令。",
  devices: "根据检查结果准备缺少的软件或连接测试设备，然后重新检查。",
  capabilities: "生成能力骨架，再逐项替换为项目自己的构建和测试逻辑。",
} as const;

const stepBenefits = {
  project: "完成后，MTC 可以读取这个项目的测试设置。",
  template: "完成后，可以开始检查运行环境。",
  devices: "完成后，MTC 可以调度测试运行。",
  capabilities: "完成后，可以自动处理更多项目准备工作。",
} as const;

const miniProgramHealthCheckConfig = `testing: {
  targets: [{
    // ...运行目标其他字段
    healthCheck: {
      executable: "node",
      args: [
        "qa/mtc/health-check.cjs",
        "--runtime", "{{target.runtime}}",
        "--app-id", "{{target.appId}}"
      ]
    }
  }]
}`;

const miniProgramHealthCheckScript = `const fs = require("node:fs");

const cli = process.env.MTC_MINI_PROGRAM_DEVTOOLS_PATH;
if (!cli || !fs.existsSync(cli)) {
  console.error("请配置可用的开发者工具 CLI 路径");
  process.exit(1);
}

console.log("小程序运行环境可用");
process.exit(0);`;

const statusLabels: Record<ProjectOnboardingStepStatus, string> = {
  pending: "待开始",
  waiting: "等待处理",
  blocked: "需处理",
  verified: "已验证",
};

type SetupContext = {
  kind: "initialization";
  projectDirectory: string;
  platforms: Platform[];
  family: ProjectFamily;
} | {
  kind: "setup";
  projectId: string;
  step: ApplyProjectSetupRequest["step"];
};

export function ProjectCatalogWorkspace({
  catalog,
  loading,
  onRegister,
  onSelectDirectory,
  onSelectConfig,
  onVerify,
  onActivate,
  onPreviewInitialization,
  onApplyInitialization,
  onPreviewSetup,
  onApplySetup,
  selectedProjectId: controlledSelectedProjectId,
  runtimeProjectId = "",
  family = "app",
  addingProject = false,
  onCloseAdd,
  onMessage,
  onOpenTests,
}: {
  catalog: ProjectCatalogResponse | null;
  loading: boolean;
  onRegister: (request: RegisterProjectRequest) => Promise<boolean>;
  onSelectDirectory: () => Promise<ProjectConfigSelection | null>;
  onSelectConfig: () => Promise<ProjectConfigSelection | null>;
  onVerify: (projectId: string) => Promise<void>;
  onActivate: (projectId: string) => Promise<void>;
  onPreviewInitialization: (request: PreviewProjectInitializationRequest) => Promise<ProjectSetupPlan | null>;
  onApplyInitialization: (request: ApplyProjectInitializationRequest) => Promise<ProjectSetupApplyResponse | null>;
  onPreviewSetup: (projectId: string, step: ApplyProjectSetupRequest["step"]) => Promise<ProjectSetupPlan | null>;
  onApplySetup: (projectId: string, request: ApplyProjectSetupRequest) => Promise<ProjectSetupApplyResponse | null>;
  selectedProjectId?: string;
  runtimeProjectId?: string;
  family?: ProjectFamily;
  addingProject?: boolean;
  onCloseAdd: (projectId?: string) => void;
  onMessage: (message: { kind: "error" | "info"; text: string }) => void;
  onOpenTests?: () => void;
}) {
  const [pendingProjectId, setPendingProjectId] = useState("");
  const [selectingSource, setSelectingSource] = useState<"directory" | "config" | "">("");
  const [form, setForm] = useState<RegisterProjectRequest>(emptyForm());
  const [initializationRequired, setInitializationRequired] = useState(false);
  const [initializationPlatforms, setInitializationPlatforms] = useState<Platform[]>(["android"]);
  const [setupPlan, setSetupPlan] = useState<ProjectSetupPlan | null>(null);
  const [setupContext, setSetupContext] = useState<SetupContext | null>(null);
  const [setupPending, setSetupPending] = useState(false);
  const [selectedProjectId, setSelectedProjectId] = useState(catalog?.activeProjectId || catalog?.projects[0]?.id || "");
  const [detail, setDetail] = useState<ProjectCatalogDetailResponse | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState("");
  const [retention, setRetention] = useState<ArtifactRetentionSnapshot | null>(null);
  const [storagePending, setStoragePending] = useState(false);
  const [cleanupConfirmation, setCleanupConfirmation] = useState<ArtifactCleanupPlan | null>(null);
  const [cleanupPickerOpen, setCleanupPickerOpen] = useState(false);
  const [cleanupRunIds, setCleanupRunIds] = useState<string[]>([]);
  const selectedProject = addingProject ? null : catalog?.projects.find(project => project.id === selectedProjectId) ?? null;
  const selectedProjectVersion = selectedProject?.updatedAt ?? "";

  useEffect(() => {
    const projects = catalog?.projects ?? [];
    setSelectedProjectId(current => {
      if (controlledSelectedProjectId && projects.some(project => project.id === controlledSelectedProjectId)) {
        return controlledSelectedProjectId;
      }
      if (projects.some(project => project.id === current)) return current;
      const activeProjectId = projects.some(project => project.id === catalog?.activeProjectId)
        ? catalog?.activeProjectId ?? ""
        : "";
      return activeProjectId || projects[0]?.id || "";
    });
  }, [catalog, controlledSelectedProjectId]);

  useEffect(() => {
    if (!addingProject) return;
    setForm(emptyForm());
    setInitializationRequired(false);
    setInitializationPlatforms(["android"]);
    setSetupPlan(null);
    setSetupContext(null);
  }, [addingProject]);

  useEffect(() => {
    if (addingProject || !selectedProjectId) {
      setDetail(null);
      setDetailError("");
      setDetailLoading(false);
      return;
    }
    let cancelled = false;
    setDetailLoading(true);
    setDetailError("");
    void fetchProjectCatalogDetail(selectedProjectId)
      .then(response => {
        if (!cancelled) setDetail(response);
      })
      .catch(error => {
        if (!cancelled) {
          setDetail(null);
          setDetailError(error instanceof ApiError ? error.message : "无法读取项目测试配置");
        }
      })
      .finally(() => {
        if (!cancelled) setDetailLoading(false);
      });
    return () => { cancelled = true; };
  }, [addingProject, selectedProjectId, selectedProjectVersion]);

  useEffect(() => {
    if (addingProject || !selectedProjectId || selectedProjectId !== runtimeProjectId) {
      setRetention(null);
      return;
    }
    let cancelled = false;
    setStoragePending(true);
    void fetchArtifactRetention()
      .then(response => { if (!cancelled) setRetention(response); })
      .catch(() => { if (!cancelled) setRetention(null); })
      .finally(() => { if (!cancelled) setStoragePending(false); });
    return () => { cancelled = true; };
  }, [addingProject, runtimeProjectId, selectedProjectId]);

  const submit = async () => {
    const registered = await onRegister({
      projectDirectory: form.projectDirectory.trim(),
      configFile: form.configFile.trim() || "mobile-test.config.cjs",
    });
    if (!registered) return;
    setForm(emptyForm());
    setInitializationRequired(false);
  };

  const applySelection = async (source: "directory" | "config") => {
    setSelectingSource(source);
    try {
      const selection = source === "directory" ? await onSelectDirectory() : await onSelectConfig();
      if (!selection) return;
      const existingProject = catalog?.projects.find(project => project.configPath === selection.configPath);
      if (existingProject) {
        onCloseAdd(existingProject.id);
        onMessage({ kind: "info", text: `该配置已登记为项目：${existingProject.name}` });
        return;
      }
      setForm(previous => ({
        ...previous,
        projectDirectory: selection.projectDirectory,
        configFile: selection.configFile,
      }));
      setInitializationRequired(!selection.configFound);
      onMessage({
        kind: "info",
        text: selection.configFound
          ? "已读取配置文件，项目目录和配置路径已自动填入"
          : "项目目录已填入，未扫描到 mobile-test.config.cjs，可预览并初始化接入文件",
      });
    } finally {
      setSelectingSource("");
    }
  };

  const verify = async (projectId: string) => {
    setPendingProjectId(projectId);
    try {
      await onVerify(projectId);
    } finally {
      setPendingProjectId("");
    }
  };

  const previewInitialization = async (projectDirectory = form.projectDirectory, platforms = family === "mini-program" ? [] : initializationPlatforms) => {
    setSetupPending(true);
    try {
      const plan = await onPreviewInitialization({ projectDirectory, platforms, family });
      if (!plan) return;
      setSetupPlan(plan);
      setSetupContext({ kind: "initialization", projectDirectory, platforms, family });
    } finally {
      setSetupPending(false);
    }
  };

  const previewSetup = async (projectId: string, step: ApplyProjectSetupRequest["step"]) => {
    setSetupPending(true);
    try {
      const plan = await onPreviewSetup(projectId, step);
      if (!plan) return;
      setSetupPlan(plan);
      setSetupContext({ kind: "setup", projectId, step });
    } finally {
      setSetupPending(false);
    }
  };

  const applySetupPlan = async () => {
    if (!setupPlan || !setupContext || !setupPlan.canApply) return;
    setSetupPending(true);
    try {
      const response = setupContext.kind === "initialization"
        ? await onApplyInitialization({
          projectDirectory: setupContext.projectDirectory,
          platforms: setupContext.platforms,
          family: setupContext.family,
          planId: setupPlan.planId,
        })
        : await onApplySetup(setupContext.projectId, {
          step: setupContext.step,
          planId: setupPlan.planId,
        });
      if (!response) return;
      setSetupPlan(null);
      setSetupContext(null);
      if (setupContext.kind === "initialization") {
        setForm(emptyForm());
        setInitializationRequired(false);
      }
    } finally {
      setSetupPending(false);
    }
  };

  const previewCleanup = async () => {
    setStoragePending(true);
    try {
      const plan = await previewArtifactCleanup();
      setRetention(previous => previous ? { ...previous, latestPlan: plan } : previous);
      onMessage({ kind: "info", text: plan.items.length > 0
        ? `清理预览已生成，预计释放 ${formatBytes(plan.estimatedBytes)}`
        : "当前没有符合策略的清理候选" });
    } catch (error) {
      onMessage({ kind: "error", text: error instanceof ApiError ? error.message : "生成清理预览失败" });
    } finally {
      setStoragePending(false);
    }
  };

  const prepareCleanup = async () => {
    setCleanupPickerOpen(true);
    setCleanupConfirmation(null);
    setCleanupRunIds([]);
    setStoragePending(true);
    try {
      const plan = await inventoryArtifactCleanup();
      setCleanupConfirmation(plan);
    } catch (error) {
      onMessage({ kind: "error", text: error instanceof ApiError ? error.message : "扫描测试产物失败" });
    } finally {
      setStoragePending(false);
    }
  };

  const confirmCleanup = async (runIds: string[]) => {
    setCleanupRunIds(runIds);
    setStoragePending(true);
    try {
      const result = await applyArtifactCleanup(runIds);
      setRetention(previous => previous ? { ...previous, latestCleanup: result, latestPlan: null } : previous);
      setCleanupConfirmation(null);
      setCleanupPickerOpen(false);
      onMessage({ kind: "info", text: `已清理 ${result.filesRemoved} 个文件，释放 ${formatBytes(result.bytesFreed)}` });
    } catch (error) {
      onMessage({ kind: "error", text: error instanceof ApiError ? error.message : "清理测试产物失败" });
    } finally {
      setStoragePending(false);
      setCleanupRunIds([]);
    }
  };

  return <div className="project-catalog-workspace">
    <section className="project-catalog-intro">
      <div>
        <p className="eyebrow">{addingProject ? "ADD PROJECT" : "PROJECT CATALOG"}</p>
        <h2>{addingProject ? "添加项目" : "项目接入中心"}</h2>
        <p>{addingProject ? "选择一个项目配置或目录完成登记。" : "查看当前项目的接入状态和可用能力。"}</p>
      </div>
      {addingProject && <button className="secondary-button" type="button" onClick={() => onCloseAdd()}><X size={14} />取消添加</button>}
    </section>

    {addingProject && <section className="section-panel project-register-panel">
        <div className="section-heading">
          <div><p className="eyebrow">REGISTER PROJECT</p><h2>登记新的项目目录</h2></div>
          <span className="count-label">选择配置</span>
        </div>
      <div className="project-register-source-actions">
        <button className="primary-button" type="button" onClick={() => void applySelection("config")} disabled={Boolean(selectingSource)}><FileText size={14} />{selectingSource === "config" ? "选择中..." : "选择配置文件"}</button>
        <button className="secondary-button" type="button" onClick={() => void applySelection("directory")} disabled={Boolean(selectingSource)}><FolderOpen size={14} />{selectingSource === "directory" ? "扫描中..." : "打开项目目录并扫描"}</button>
      </div>
      <div className="project-register-grid">
        <label className="field project-register-wide"><span>项目目录</span><input value={form.projectDirectory} placeholder="选择配置文件或打开项目目录" readOnly aria-readonly="true" /><small className="field-description">选择配置文件后，项目根目录按配置中的 project.root 自动填入。</small></label>
        <label className="field"><span>配置文件</span><input value={form.configFile} placeholder="选择 mobile-test.config.cjs" readOnly aria-readonly="true" /><small className="field-description">MTC 会从配置读取项目 ID、名称、类型和目标平台。</small></label>
      </div>
      {initializationRequired && family === "app" && <fieldset className="project-register-platforms">
        <legend>目标平台</legend>
        <div className="project-register-platform-options">
          {(["android", "ios", "harmony"] as const).map(platform => <label key={platform}>
            <input
              type="checkbox"
              checked={initializationPlatforms.includes(platform)}
              onChange={event => setInitializationPlatforms(current => event.target.checked
                ? [...new Set([...current, platform])]
                : current.filter(item => item !== platform))}
            />
            <span>{platformLabels[platform]}</span>
          </label>)}
        </div>
        <small>初始化配置会按这里选择的平台声明设备 Provider 和 Smoke 入口。</small>
      </fieldset>}
      <div className="project-register-actions">
        <span className="action-hint"><Wrench size={14} />{initializationRequired ? "预览计划后确认创建，取消不会写入文件" : "选择配置后自动解析并显示接入步骤"}</span>
        {initializationRequired
          ? <button className="primary-button" type="button" onClick={() => void previewInitialization()} disabled={setupPending || !form.projectDirectory.trim() || (family === "app" && initializationPlatforms.length === 0)}>
            <FileText size={15} />预览初始化计划
          </button>
          : <button className="primary-button" type="button" onClick={() => void submit()} disabled={Boolean(selectingSource) || !form.projectDirectory.trim() || !form.configFile.trim()}>
            <CheckCircle2 size={15} />读取并登记
          </button>}
      </div>
    </section>}

    {!addingProject && loading && !catalog && <section className="section-panel project-catalog-loading"><LoaderCircle className="spin" size={20} />正在读取项目目录</section>}
    {!addingProject && !loading && catalog?.projects.length === 0 && <section className="section-panel project-catalog-empty"><FolderPlus size={22} /><strong>还没有登记项目</strong><span>添加一个 Lynx App 或其他移动项目开始接入。</span></section>}
    {!addingProject && catalog && catalog.projects.length > 0 && <div className="project-catalog-detail">
        {selectedProject && <ProjectCatalogCard
          project={selectedProject}
          runtimeActive={selectedProject.id === runtimeProjectId}
          detail={detail}
          detailLoading={detailLoading}
          detailError={detailError}
          verifying={pendingProjectId === selectedProject.id}
          onVerify={() => void verify(selectedProject.id)}
          onActivate={() => void onActivate(selectedProject.id)}
          setupPending={setupPending}
          onPreviewInitialization={() => void previewInitialization(selectedProject.root, selectedProject.platforms)}
          onPreviewSetup={step => void previewSetup(selectedProject.id, step)}
          onMessage={onMessage}
          onOpenTests={onOpenTests}
        />}
        {selectedProject && <ProjectStoragePanel
          runtimeActive={selectedProject.id === runtimeProjectId}
          retention={retention}
          pending={storagePending}
          onPreview={() => void previewCleanup()}
          onCleanup={() => void prepareCleanup()}
        />}
    </div>}
    {setupPlan && <ProjectSetupPlanDialog
      plan={setupPlan}
      pending={setupPending}
      onCancel={() => {
        setSetupPlan(null);
        setSetupContext(null);
      }}
      onConfirm={() => void applySetupPlan()}
    />}
    {cleanupPickerOpen && <ArtifactCleanupConfirmation
      plan={cleanupConfirmation}
      pending={storagePending}
      activeRunIds={cleanupRunIds}
      onCancel={() => {
        setCleanupConfirmation(null);
        setCleanupPickerOpen(false);
      }}
      onConfirm={runIds => void confirmCleanup(runIds)}
    />}
  </div>;
}

export function ProjectTestEntryWizard({
  projectId,
  onClose,
  onApplied,
  onMessage,
}: {
  projectId: string;
  onClose: () => void;
  onApplied: (entryId: string) => Promise<void>;
  onMessage: (message: { kind: "error" | "info"; text: string }) => void;
}) {
  const [editor, setEditor] = useState<ProjectTestEntryEditorResponse | null>(null);
  const [draft, setDraft] = useState<ProjectTestEntryInput>(() => emptyTestEntryDraft(""));
  const [commandLine, setCommandLine] = useState("");
  const [envRows, setEnvRows] = useState<Array<{ key: string; value: string }>>([{ key: "", value: "" }]);
  const [plan, setPlan] = useState<ProjectTestEntryPlan | null>(null);
  const [retryContractConfirmed, setRetryContractConfirmed] = useState(false);
  const [pending, setPending] = useState(true);
  const [error, setError] = useState("");
  const [commandError, setCommandError] = useState("");

  useEffect(() => {
    let cancelled = false;
    setPending(true);
    void fetchProjectTestEntryEditor(projectId)
      .then(response => {
        if (cancelled) return;
        setEditor(response);
        setDraft(emptyTestEntryDraft(response.targets.map(target => target.key)));
      })
      .catch(reason => { if (!cancelled) setError(reason instanceof ApiError ? reason.message : "无法读取测试入口配置"); })
      .finally(() => { if (!cancelled) setPending(false); });
    return () => { cancelled = true; };
  }, [projectId]);

  const command = draft.commands.default ?? { executable: "", args: [], cwd: ".", env: {} };
  const updateDraft = (updater: (current: ProjectTestEntryInput) => ProjectTestEntryInput) => {
    setDraft(updater);
    setPlan(null);
  };
  const setCommand = (next: Partial<typeof command>) => {
    updateDraft(current => ({
      ...current,
      commands: {
        ...current.commands,
        default: { ...(current.commands.default ?? command), ...next },
      },
    }));
  };
  const save = async () => {
    if (!editor) return;
    setCommandError("");
    setError("");
    let parsed: ReturnType<typeof parseTestCommandLine>;
    try {
      parsed = parseTestCommandLine(commandLine);
    } catch (reason) {
      setCommandError(reason instanceof TestCommandLineError ? reason.message : "测试命令格式无效");
      return;
    }
    if (!draft.label.trim()) {
      setError("请填写显示名称");
      return;
    }
    if (draft.targetKeys.length === 0) {
      setError("请在高级设置中选择至少一个运行目标");
      return;
    }
    if (draft.kind === "page" && !retryContractConfirmed) {
      setError("请确认项目脚本已经接入页面重试范围");
      return;
    }
    const entryId = createUniqueTestEntryId(commandLine, [
      ...editor.mainConfigTests.map(test => test.id),
      ...editor.editableTests.map(test => test.id),
    ]);
    const nextDraft: ProjectTestEntryInput = {
      ...draft,
      id: entryId,
      label: draft.label.trim(),
      description: draft.description.trim(),
      testType: draft.testType.trim() || "自定义测试",
      commands: {
        ...draft.commands,
        default: {
          ...command,
          executable: parsed.executable,
          args: parsed.args,
          cwd: command.cwd?.trim() || ".",
          env: Object.fromEntries(envRows.map(row => [row.key.trim(), row.value]).filter(([key]) => Boolean(key))),
        },
      },
    };
    setDraft(nextDraft);
    setPlan(null);
    setPending(true);
    try {
      const response = await previewProjectTestEntry(projectId, {
        mode: "create",
        entry: nextDraft,
        commandLine: commandLine.trim(),
      });
      setPlan(response);
      if (!response.canApply) throw new ApiError("PROJECT_TEST_ENTRY_CANNOT_APPLY", "测试入口当前无法保存");
      await applyProjectTestEntry(projectId, { planId: response.planId });
      onMessage({ kind: "info", text: `测试入口 ${nextDraft.label} 已写入 mobile-test.entries.json` });
      await onApplied(nextDraft.id);
    } catch (reason) {
      setError(reason instanceof ApiError ? reason.message : "测试入口保存失败");
    } finally {
      setPending(false);
    }
  };
  const copyAiGuidance = () => {
    const guidance = plan?.aiGuidance ?? [
      "请帮助我检查这条 MTC 小程序测试命令。",
      `显示名称：${draft.label.trim() || "待填写"}`,
      `命令：${commandLine.trim() || "待填写"}`,
      `运行目标：${draft.targetKeys.join("、") || "待选择"}`,
      `测试类型：${draft.kind}`,
      `业务分类：${draft.testType || "自定义测试"}`,
      `环境变量名称：${envRows.map(row => row.key.trim()).filter(Boolean).join("、") || "无"}`,
      "请按 MTC 的 executable、args、cwd、env 结构检查命令，并说明需要修正的字段。",
    ].join("\n");
    void navigator.clipboard.writeText(guidance)
      .then(() => onMessage({ kind: "info", text: "已复制 AI 接入说明" }))
      .catch(() => onMessage({ kind: "error", text: "复制 AI 接入说明失败" }));
  };
  const canSave = Boolean(editor && draft.label.trim() && commandLine.trim() && draft.targetKeys.length > 0);

  return <div className="confirm-overlay" role="presentation">
    <section className="confirm-dialog project-test-entry-dialog" role="dialog" aria-modal="true" aria-labelledby="project-test-entry-title">
      <header className="project-test-entry-header">
        <div><p className="eyebrow">TEST ENTRY</p><h2 id="project-test-entry-title">添加自定义命令</h2></div>
        <button className="icon-button" type="button" onClick={onClose} disabled={pending} title="关闭" aria-label="关闭添加自定义命令"><X size={17} /></button>
      </header>
      <div className="project-test-entry-body">
        {pending && !editor && <div className="project-catalog-loading"><LoaderCircle className="spin" size={18} />正在读取项目配置</div>}
        {editor && <div className="project-test-entry-quick-form">
          <div className="project-test-entry-form two-columns">
            <label className="field"><span>显示名称</span><input autoFocus value={draft.label} placeholder="员工取件码排序验证" onChange={event => updateDraft(current => ({ ...current, label: event.currentTarget.value }))} /></label>
            <label className="field"><span>命令</span><input value={commandLine} placeholder="pnpm test:e2e:pickup-code-sort" aria-invalid={Boolean(commandError)} onChange={event => { setCommandLine(event.currentTarget.value); setCommandError(""); setPlan(null); }} /><small>支持空格、单引号和双引号参数。</small>{commandError && <small className="field-error">{commandError}</small>}</label>
            <label className="field project-test-entry-wide"><span>说明（可选）</span><textarea value={draft.description} placeholder="说明这条命令验证的功能" onChange={event => updateDraft(current => ({ ...current, description: event.currentTarget.value }))} /></label>
          </div>
          <details className="project-test-entry-advanced">
            <summary><span>高级设置</span><small>运行目标、类型、目录、环境变量、参数与重试</small><ChevronDown size={14} /></summary>
            <div className="project-test-entry-advanced-body">
              <section className="project-test-entry-advanced-section">
                <header><strong>运行目标</strong><small>默认选择项目声明的全部目标</small></header>
                <div className="project-test-entry-targets">
                  {editor.targets.map(target => <label key={target.key} className={draft.targetKeys.includes(target.key) ? "selected" : ""}>
                    <input type="checkbox" checked={draft.targetKeys.includes(target.key)} onChange={event => updateDraft(current => ({ ...current, targetKeys: event.currentTarget.checked ? [...new Set([...current.targetKeys, target.key])] : current.targetKeys.filter(key => key !== target.key) }))} />
                    <span><strong>{target.label}</strong><code>{target.key}</code><small>{target.platform} · {target.runtime} · {target.appId}</small></span>
                  </label>)}
                  {editor.targets.length === 0 && <div className="project-test-entry-empty"><AlertCircle size={18} />项目需要先在 mobile-test.config.cjs 声明 testing.targets。</div>}
                </div>
              </section>
              <div className="project-test-entry-form three-columns">
                <label className="field"><span>测试类型</span><select value={draft.kind} onChange={event => { updateDraft(current => ({ ...current, kind: event.currentTarget.value as ProjectTestEntryInput["kind"] })); setRetryContractConfirmed(false); }}><option value="general">通用测试</option><option value="page">页面测试</option><option value="flow">流程测试</option></select></label>
                <label className="field"><span>业务分类</span><input value={draft.testType} placeholder="自定义测试" onChange={event => updateDraft(current => ({ ...current, testType: event.currentTarget.value }))} /></label>
                <label className="field"><span>工作目录</span><input value={command.cwd ?? ""} placeholder="." onChange={event => setCommand({ cwd: event.currentTarget.value })} /><small>使用项目根目录内的相对路径。</small></label>
              </div>
              <EntryListEditor title="环境变量" addLabel="添加环境变量" rows={envRows} onChange={rows => { setEnvRows(rows); setPlan(null); }} placeholder="MTC_CUSTOM_OPTION" keyed />
              <section className="project-test-entry-parameters">
                <div className="project-test-entry-parameter-actions">
                  <button className="secondary-button" type="button" onClick={() => updateDraft(current => ({ ...current, parameters: [...current.parameters, createSelectParameter(current.parameters.length)] }))}><Plus size={14} />选择参数</button>
                  <button className="secondary-button" type="button" onClick={() => updateDraft(current => ({ ...current, parameters: [...current.parameters, createPageParameter(current.parameters.length)] }))}><Plus size={14} />页面参数</button>
                  <button className="secondary-button" type="button" onClick={() => updateDraft(current => ({ ...current, parameters: [...current.parameters, createAccountParameter(current.parameters.length)] }))}><Plus size={14} />账号参数</button>
                </div>
                {draft.parameters.map((parameter, index) => <TestParameterEditor key={`${parameter.type}-${index}`} parameter={parameter} onChange={next => updateDraft(current => ({ ...current, parameters: current.parameters.map((item, itemIndex) => itemIndex === index ? next : item) }))} onRemove={() => updateDraft(current => ({ ...current, parameters: current.parameters.filter((_item, itemIndex) => itemIndex !== index) }))} />)}
                <p className="project-test-entry-rule">参数通过 <code>{"{{params.<参数ID>}}"}</code> 传给命令，并在运行前由 MTC 校验。</p>
              </section>
              {draft.kind === "page" && <section className="project-test-entry-retry-guide">
                <strong>页面重试接入</strong>
                <p>项目脚本读取以下环境变量，将范围转换为已有命令的页面或用例筛选参数。</p>
                <code>MTC_RETRY_TARGET_PAGES</code><code>MTC_RETRY_CASE_IDS</code><code>MTC_RETRY_CASE_RUN_IDS</code>
                <pre>{`const pages = process.env.MTC_RETRY_TARGET_PAGES;
const args = pages ? ["--pages", pages] : [];`}</pre>
                <label className="project-test-entry-retry-confirm"><input type="checkbox" checked={retryContractConfirmed} onChange={event => setRetryContractConfirmed(event.currentTarget.checked)} /><span>我已确认项目脚本会读取重试范围，并将它传给原有测试命令。</span></label>
              </section>}
              <section className="project-test-entry-ai-guide"><div><strong>AI 操作引导</strong><small>复制当前表单摘要，让 AI 按 MTC 规则检查命令。</small></div><button className="secondary-button" type="button" onClick={copyAiGuidance}><ClipboardCopy size={14} />复制引导</button></section>
            </div>
          </details>
        </div>}
        {editor && plan && <details className="project-test-entry-save-details">
          <summary><span>保存详情</span><small>预览计划与写入内容</small><ChevronDown size={14} /></summary>
          <div className="project-test-entry-review">
          <div className="project-test-entry-review-meta"><span><strong>目标文件</strong><code>{plan.entriesPath}</code></span><span><strong>命令预览</strong><code>{[plan.commandPreview.executable, ...plan.commandPreview.args].join(" ")}</code></span><span><strong>执行目录</strong><code>{plan.commandPreview.cwd}</code></span></div>
          {plan.warnings.map(warning => <div className="project-test-entry-warning" key={warning}><AlertCircle size={15} />{warning}</div>)}
          <details><summary>完整 JSON<ChevronDown size={14} /></summary><pre>{plan.contentPreview}</pre></details>
          </div>
        </details>}
        {error && <div className="project-detail-error"><AlertCircle size={16} />{error}</div>}
      </div>
      <footer className="confirm-actions project-test-entry-footer">
        <button className="secondary-button" type="button" onClick={onClose} disabled={pending}>取消</button>
        <button className="primary-button" type="button" onClick={() => void save()} disabled={pending || !canSave}>{pending ? <LoaderCircle className="spin" size={14} /> : <CheckCircle2 size={14} />}{pending ? "保存中" : "保存命令"}</button>
      </footer>
    </section>
  </div>;
}

function EntryListEditor({ title, addLabel, rows, onChange, placeholder, keyed = false }: {
  title: string;
  addLabel: string;
  rows: Array<{ key: string; value: string }>;
  onChange: (rows: Array<{ key: string; value: string }>) => void;
  placeholder: string;
  keyed?: boolean;
}) {
  return <section className="project-test-entry-list-editor">
    <div><strong>{title}</strong><button className="secondary-button" type="button" onClick={() => onChange([...rows, { key: keyed ? "" : String(rows.length), value: "" }])}><Plus size={13} />{addLabel}</button></div>
    {rows.map((row, index) => <div className="project-test-entry-list-row" key={index}>
      {keyed && <input value={row.key} placeholder={placeholder} aria-label={`${title}名称 ${index + 1}`} onChange={event => onChange(rows.map((item, itemIndex) => itemIndex === index ? { ...item, key: event.currentTarget.value } : item))} />}
      <input value={row.value} placeholder={keyed ? "值" : placeholder} aria-label={`${title}值 ${index + 1}`} onChange={event => onChange(rows.map((item, itemIndex) => itemIndex === index ? { ...item, value: event.currentTarget.value } : item))} />
      {!keyed && <span className="project-test-entry-order-actions">
        <button className="icon-button" type="button" title="上移参数" aria-label={`上移${title}项 ${index + 1}`} disabled={index === 0} onClick={() => onChange(moveEntryRow(rows, index, index - 1))}><ArrowUp size={13} /></button>
        <button className="icon-button" type="button" title="下移参数" aria-label={`下移${title}项 ${index + 1}`} disabled={index === rows.length - 1} onClick={() => onChange(moveEntryRow(rows, index, index + 1))}><ArrowDown size={13} /></button>
      </span>}
      <button className="icon-button" type="button" title={`删除${title}项`} aria-label={`删除${title}项 ${index + 1}`} onClick={() => onChange(rows.filter((_item, itemIndex) => itemIndex !== index))}><Trash2 size={14} /></button>
    </div>)}
  </section>;
}

function moveEntryRow(rows: Array<{ key: string; value: string }>, from: number, to: number): Array<{ key: string; value: string }> {
  if (to < 0 || to >= rows.length) return rows;
  const next = [...rows];
  const [row] = next.splice(from, 1);
  next.splice(to, 0, row);
  return next;
}

function TestParameterEditor({ parameter, onChange, onRemove }: { parameter: TestParameterDefinition; onChange: (parameter: TestParameterDefinition) => void; onRemove: () => void }) {
  const updateCommon = (patch: { id?: string; label?: string; defaultValue?: string }) => onChange({ ...parameter, ...patch } as TestParameterDefinition);
  return <section className="project-test-entry-parameter">
    <header><strong>{parameter.type === "select" ? "选择参数" : parameter.type === "page-selection" ? "页面参数" : "账号参数"}</strong><button className="icon-button" type="button" onClick={onRemove} title="删除参数" aria-label="删除参数"><Trash2 size={14} /></button></header>
    <div className="project-test-entry-form three-columns">
      <label className="field"><span>参数 ID</span><input value={parameter.id} onChange={event => updateCommon({ id: event.currentTarget.value })} /></label>
      <label className="field"><span>名称</span><input value={parameter.label} onChange={event => updateCommon({ label: event.currentTarget.value })} /></label>
      <label className="field"><span>默认值</span><input value={parameter.defaultValue} readOnly={parameter.type === "account-profile"} onChange={event => updateCommon({ defaultValue: event.currentTarget.value })} /></label>
      {parameter.type === "select" && <label className="field project-test-entry-wide"><span>选项（每行 value|名称）</span><textarea value={parameter.options.map(option => `${option.value}|${option.label}`).join("\n")} onChange={event => onChange({ ...parameter, options: parseValueLabelLines(event.currentTarget.value) })} /></label>}
      {parameter.type === "page-selection" && <label className="field project-test-entry-wide"><span>页面预设（每行 value|名称）</span><textarea value={parameter.presets.map(preset => `${preset.value}|${preset.label}`).join("\n")} onChange={event => onChange({ ...parameter, presets: parseValueLabelLines(event.currentTarget.value).map(item => ({ ...item, filter: {} })) })} /></label>}
      {parameter.type === "account-profile" && <label className="field project-test-entry-wide"><span>能力 ID</span><input value={parameter.capability} onChange={event => onChange({ ...parameter, capability: event.currentTarget.value })} /></label>}
    </div>
  </section>;
}

function parseValueLabelLines(value: string): Array<{ value: string; label: string }> {
  return value.split("\n").map(line => line.trim()).filter(Boolean).map(line => {
    const [optionValue, ...labelParts] = line.split("|");
    return { value: optionValue.trim(), label: (labelParts.join("|").trim() || optionValue.trim()) };
  });
}

function createSelectParameter(index: number): TestParameterDefinition {
  return { id: `option-${index + 1}`, label: "测试选项", type: "select", defaultValue: "default", options: [{ value: "default", label: "默认" }] };
}

function createPageParameter(index: number): TestParameterDefinition {
  return { id: index === 0 ? "pages" : `pages-${index + 1}`, label: "测试页面", type: "page-selection", defaultValue: "all", source: "page-parameters", presets: [{ value: "all", label: "全部页面", filter: {} }] };
}

function createAccountParameter(index: number): TestParameterDefinition {
  return { id: index === 0 ? "account-profile" : `account-profile-${index + 1}`, label: "测试账号", type: "account-profile", defaultValue: "current-session", capability: "login" };
}

function emptyTestEntryDraft(targetKeys: string[] | string): ProjectTestEntryInput {
  return {
    id: "",
    label: "",
    testType: "自定义测试",
    description: "",
    kind: "general",
    runnerId: "legacy-command-runner",
    requiredCapabilities: [],
    platforms: [],
    targetKeys: typeof targetKeys === "string" ? (targetKeys ? [targetKeys] : []) : targetKeys,
    parameters: [],
    commands: { default: { executable: "", args: [], cwd: ".", env: {} } },
  };
}

function ProjectStoragePanel({
  runtimeActive,
  retention,
  pending,
  onPreview,
  onCleanup,
}: {
  runtimeActive: boolean;
  retention: ArtifactRetentionSnapshot | null;
  pending: boolean;
  onPreview: () => void;
  onCleanup: () => void;
}) {
  if (!runtimeActive) return <section className="section-panel project-storage-panel inactive">
    <div className="section-heading"><div><p className="eyebrow">TEST STORAGE</p><h2>测试存储</h2></div><HardDrive size={18} /></div>
    <p className="project-storage-placeholder">激活该项目后，可读取产物占用、磁盘状态和清理计划。</p>
  </section>;
  if (!retention) return <section className="section-panel project-storage-panel">
    <div className="section-heading"><div><p className="eyebrow">TEST STORAGE</p><h2>测试存储</h2></div><HardDrive size={18} /></div>
    <p className="project-storage-placeholder">{pending ? "正在统计测试存储..." : "当前项目尚未提供测试存储信息。"}</p>
  </section>;
  const plan = retention.latestPlan;
  return <section className="section-panel project-storage-panel">
    <div className="section-heading">
      <div><p className="eyebrow">TEST STORAGE</p><h2>测试存储</h2></div>
      <span className={`storage-health ${retention.storage.issue ? "warning" : "ready"}`}>{retention.storage.issue || "存储可用"}</span>
    </div>
    <div className="project-storage-metrics">
      <div><span>项目产物</span><strong>{formatBytes(retention.storage.usedBytes)}</strong></div>
      <div><span>剩余空间</span><strong>{formatBytes(retention.storage.freeBytes)}</strong></div>
      <div><span>空间软上限</span><strong>{formatBytes(retention.policy.maxBytes)}</strong></div>
      <div><span>保留运行</span><strong>{retention.retainedRunIds.length}</strong></div>
    </div>
    <div className="project-storage-location">
      <span><strong>产物目录</strong><code>{retention.storage.artifactRoot || "未声明"}</code></span>
      <span><strong>存储卷</strong><code>{[retention.storage.fileSystem, retention.storage.mountPoint].filter(Boolean).join(" · ") || "未识别"}</code></span>
      <span><strong>保留策略</strong><code>{retention.policy.maxAgeDays} 天 · 最近 {retention.policy.maxRuns} 次 · {retention.autoCleanup ? "自动清理" : "确认后清理"}</code></span>
    </div>
    {plan && <details className="artifact-cleanup-preview" open={plan.items.length > 0}>
      <summary><span>清理预览</span><strong>{plan.items.length} 个运行 · {formatBytes(plan.estimatedBytes)}</strong><ChevronDown size={14} /></summary>
      <div className="artifact-cleanup-list">
        {plan.items.length === 0 && <p>当前运行均处于保留范围。</p>}
        {plan.items.map(item => <div key={item.runId}><code>{item.runId}</code><span>{item.files} 个文件</span><strong>{formatBytes(item.bytes)}</strong></div>)}
        {plan.warnings.map(warning => <p className="artifact-cleanup-warning" key={warning}>{warning}</p>)}
      </div>
    </details>}
    <div className="project-storage-actions">
      <button className="secondary-button" type="button" onClick={onPreview} disabled={pending || !retention.enabled}><Eye size={14} />查看清理计划</button>
      <button className="danger-button" type="button" onClick={onCleanup} disabled={pending || !retention.enabled}><Trash2 size={14} />{pending ? "扫描中..." : "选择清理"}</button>
    </div>
  </section>;
}

export function ArtifactCleanupConfirmation({
  plan,
  pending,
  activeRunIds = [],
  onCancel,
  onConfirm,
}: {
  plan: ArtifactCleanupPlan | null;
  pending: boolean;
  activeRunIds?: string[];
  onCancel: () => void;
  onConfirm: (runIds: string[]) => void;
}) {
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const selectableItems = (plan?.items ?? []).filter(item => item.status === "planned");
  const [selectedRunIds, setSelectedRunIds] = useState<string[]>([]);
  const selected = new Set(selectedRunIds);
  const selectedItems = selectableItems.filter(item => selected.has(item.runId));
  const selectedBytes = selectedItems.reduce((total, item) => total + item.bytes, 0);
  const selectedFiles = selectedItems.reduce((total, item) => total + item.files, 0);
  const allSelected = selectableItems.length > 0 && selectedItems.length === selectableItems.length;
  const cleanupRunning = pending && activeRunIds.length > 0;
  const active = new Set(activeRunIds);
  const activeItems = selectableItems.filter(item => active.has(item.runId));
  const activeFiles = activeItems.reduce((total, item) => total + item.files, 0);
  const activeBytes = activeItems.reduce((total, item) => total + item.bytes, 0);
  useEffect(() => {
    if (!cleanupRunning) {
      setElapsedSeconds(0);
      return;
    }
    const startedAt = Date.now();
    const updateElapsed = () => setElapsedSeconds(Math.floor((Date.now() - startedAt) / 1_000));
    updateElapsed();
    const timer = window.setInterval(updateElapsed, 1_000);
    return () => window.clearInterval(timer);
  }, [cleanupRunning]);
  const toggleRun = (runId: string, checked: boolean) => {
    setSelectedRunIds(current => checked
      ? [...new Set([...current, runId])]
      : current.filter(item => item !== runId));
  };
  return <div className="confirm-overlay">
    <section className="confirm-dialog artifact-cleanup-dialog" role="dialog" aria-modal="true" aria-labelledby="artifact-cleanup-confirm-title">
      <div className="confirm-icon"><Trash2 size={20} /></div>
      <div className="confirm-copy">
        <h2 id="artifact-cleanup-confirm-title">选择要清理的测试产物</h2>
        <p>{plan ? `已扫描 ${plan.items.length} 个运行。活动任务、长期保留运行和活动修复任务受到保护。` : "正在读取产物目录并统计文件数量与占用空间。"}</p>
      </div>
      <div className="artifact-cleanup-selection">
        {cleanupRunning ? <div className="artifact-cleanup-running" aria-live="polite">
          <div className="artifact-cleanup-running-heading">
            <span><LoaderCircle className="spin" size={20} /></span>
            <div><strong>正在清理测试产物</strong><small>已用时 {formatDuration(elapsedSeconds)}</small></div>
          </div>
          <div className="artifact-cleanup-progress" role="progressbar" aria-label="测试产物清理进度" aria-valuetext={`正在处理，已用时 ${formatDuration(elapsedSeconds)}`}>
            <span />
          </div>
          <div className="artifact-cleanup-running-summary">
            <span><strong>{activeItems.length}</strong><small>个运行</small></span>
            <span><strong>{activeFiles.toLocaleString()}</strong><small>个文件</small></span>
            <span><strong>{formatBytes(activeBytes)}</strong><small>预计释放</small></span>
          </div>
          <p>{elapsedSeconds >= 15 ? "目录包含大量文件，系统仍在持续处理，请保持页面打开。" : "正在删除所选运行及关联证据，请保持页面打开。"}</p>
        </div> : !plan ? <div className="artifact-cleanup-selection-empty">
          <LoaderCircle className="spin" size={20} />
          <strong>正在扫描测试产物...</strong>
          <span>目录较大时需要一些时间，扫描过程只读取文件信息。</span>
        </div> : selectableItems.length > 0 ? <>
          <label className="artifact-cleanup-select-all">
            <input
              type="checkbox"
              checked={allSelected}
              onChange={event => setSelectedRunIds(event.currentTarget.checked ? selectableItems.map(item => item.runId) : [])}
            />
            <span>全选可清理运行</span>
            <strong>{selectableItems.length} 项</strong>
          </label>
          <div className="artifact-cleanup-selection-list">
            {selectableItems.map(item => <label key={item.runId}>
              <input
                type="checkbox"
                checked={selected.has(item.runId)}
                onChange={event => toggleRun(item.runId, event.currentTarget.checked)}
              />
              <span><code title={item.runId}>{item.runId}</code><small>{item.files.toLocaleString()} 个文件</small></span>
              <strong>{formatBytes(item.bytes)}</strong>
            </label>)}
          </div>
          <div className="artifact-cleanup-selection-summary">
            <span>已选择 {selectedItems.length} 个运行，共 {selectedFiles.toLocaleString()} 个文件</span>
            <strong>预计释放 {formatBytes(selectedBytes)}</strong>
          </div>
        </> : <div className="artifact-cleanup-selection-empty">
          <HardDrive size={20} />
          <strong>当前没有可清理的测试产物</strong>
          <span>产物目录为空，或现有运行全部处于保护范围。</span>
        </div>}
      </div>
      <div className="confirm-actions">
        <button type="button" className="secondary-button" onClick={onCancel} disabled={cleanupRunning}>{cleanupRunning ? "处理中" : plan && selectableItems.length > 0 ? "取消" : "关闭"}</button>
        {plan && selectableItems.length > 0 && <button type="button" className="danger-button" onClick={() => onConfirm(selectedRunIds)} disabled={pending || selectedRunIds.length === 0}>{cleanupRunning ? `清理中 ${formatDuration(elapsedSeconds)}` : "清理所选内容"}</button>}
      </div>
    </section>
  </div>;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.max(0, Math.round(bytes / 1024))} KiB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GiB`;
}

function formatDuration(totalSeconds: number): string {
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

function ProjectCatalogCard({
  project,
  runtimeActive,
  detail,
  detailLoading,
  detailError,
  verifying,
  onVerify,
  onActivate,
  setupPending,
  onPreviewInitialization,
  onPreviewSetup,
  onMessage,
  onOpenTests,
}: {
  project: ProjectCatalogEntry;
  runtimeActive: boolean;
  detail: ProjectCatalogDetailResponse | null;
  detailLoading: boolean;
  detailError: string;
  verifying: boolean;
  onVerify: () => void;
  onActivate: () => void;
  setupPending: boolean;
  onPreviewInitialization: () => void;
  onPreviewSetup: (step: ApplyProjectSetupRequest["step"]) => void;
  onMessage: (message: { kind: "error" | "info"; text: string }) => void;
  onOpenTests?: () => void;
}) {
  const executionPrerequisites = project.onboarding.filter(step => (
    PROJECT_EXECUTION_PREREQUISITE_STEP_IDS.some(id => id === step.id)
  ));
  const executionPrerequisiteVerifiedCount = executionPrerequisites.filter(step => step.status === "verified").length;
  const miniProgram = project.integrationType === "mini-program";
  const nextStep = executionPrerequisites.find(step => step.status !== "verified");
  const guidePath = miniProgram ? "README.md" : "docs/lynx-app-onboarding.md";
  const copyGuidePath = () => void navigator.clipboard.writeText(guidePath)
    .then(() => onMessage({ kind: "info", text: "已复制接入指南路径" }))
    .catch(() => onMessage({ kind: "error", text: "复制接入指南路径失败" }));
  return <section className={`section-panel project-card ${runtimeActive ? "active" : ""}`}>
    <div className="project-card-header">
      <div className="project-card-title">
        <span className="project-card-icon">{miniProgram ? <PanelsTopLeft size={17} /> : <Smartphone size={17} />}</span>
        <div><strong>{project.name}</strong><small>{project.id} · {integrationLabels[project.integrationType]}</small></div>
      </div>
      <div className="project-card-tools">
        {runtimeActive && <span className="project-active-label">当前运行项目</span>}
        {!runtimeActive && <button className="secondary-button" type="button" onClick={onActivate} disabled={verifying}><Power size={14} />切换运行项目</button>}
        <button className="secondary-button" type="button" onClick={onVerify} disabled={verifying}>
          <RefreshCw size={14} className={verifying ? "spin" : ""} />重新检查
        </button>
      </div>
    </div>
    <div className="project-card-meta"><span>{project.root}</span><span>{detail?.executionReady ? "已经可以运行测试" : `${executionPrerequisiteVerifiedCount}/${executionPrerequisites.length} 步已完成`}</span><span>{miniProgram ? "小程序运行环境" : project.platforms.map(platform => platformLabels[platform]).join(" · ")}</span></div>
    {detailLoading && <div className="project-detail-loading"><LoaderCircle className="spin" size={17} />正在读取项目支持的测试</div>}
    {detailError && <div className="project-detail-error"><AlertCircle size={16} />{detailError}</div>}
    {!detailLoading && <section className="project-onboarding-section">
      <div className="project-onboarding-heading"><div><p className="eyebrow">GET STARTED</p><h3>完成接入，运行第一条测试</h3></div><span className="count-label">{detail?.executionReady ? "已准备好测试" : `${executionPrerequisiteVerifiedCount}/${executionPrerequisites.length} 步已完成`}</span></div>
      {nextStep
        ? <ProjectOnboardingNextAction
            step={nextStep}
            miniProgram={miniProgram}
            setupPending={setupPending}
            onVerify={onVerify}
            onPreviewInitialization={onPreviewInitialization}
            onPreviewSetup={onPreviewSetup}
            onCopyGuide={copyGuidePath}
          />
        : <div className="project-execution-ready"><CheckCircle2 size={15} /><span>{runtimeActive ? "接入已完成。现在运行第一条测试，确认整个链路正常。" : "接入已完成。切换为当前运行项目后，即可运行第一条测试。"}</span>{runtimeActive && <button className="primary-button project-first-test-action" type="button" onClick={onOpenTests}><Terminal size={14} />运行第一条测试</button>}</div>}
      <div className="project-step-list">
        {project.onboarding.map(step => <details className={`project-step ${step.status}`} key={step.id} open={step.id === nextStep?.id}>
          <summary className="project-step-summary">
            <span className="project-step-marker">{step.status === "verified" ? <CheckCircle2 size={15} /> : step.status === "blocked" ? <AlertCircle size={15} /> : <span />}</span>
            <span className="project-step-content"><strong>{miniProgram && step.id === "devices" ? "运行环境" : stepLabels[step.id]}</strong><small>{step.summary}</small></span>
            <span className="project-step-status">{statusLabels[step.status]}<ChevronDown size={14} className="project-step-chevron" /></span>
          </summary>
          <div className="project-step-detail">
            <p>{miniProgram && step.id === "devices" ? "确认 Node、包管理器和小程序开发工具已准备好，让测试可以稳定运行。" : stepDescriptions[step.id]}</p>
            <div><strong>完成后</strong><span>{stepBenefits[step.id]}</span></div>
            <div><strong>下一步</strong><span>{miniProgram && step.id === "devices" ? "根据下方检查结果准备运行环境，再重新检查。" : stepNextActions[step.id]}</span></div>
            {step.id === "template" && <ProjectTestEntryChecks testEntries={step.testEntries ?? []} />}
            {miniProgram && step.id === "devices" && step.status !== "verified" && <MiniProgramHealthCheckGuide onMessage={onMessage} />}
            {step.id !== nextStep?.id && <ProjectStepAction step={step} miniProgram={miniProgram} setupPending={setupPending} onVerify={onVerify} onPreviewInitialization={onPreviewInitialization} onPreviewSetup={onPreviewSetup} />}
            <ProjectStepTechnicalDetails step={step} />
          </div>
        </details>)}
      </div>
    </section>}
    <button className="text-button project-doc-hint" type="button" onClick={copyGuidePath}>
      {miniProgram ? "复制小程序接入指南路径" : "复制 Lynx App 接入指南路径"}
    </button>
  </section>;
}

function MiniProgramHealthCheckGuide({ onMessage }: { onMessage: (message: { kind: "error" | "info"; text: string }) => void }) {
  const copyExample = () => void navigator.clipboard.writeText(`${miniProgramHealthCheckConfig}\n\n// qa/mtc/health-check.cjs\n${miniProgramHealthCheckScript}`)
    .then(() => onMessage({ kind: "info", text: "已复制 healthCheck 配置示例" }))
    .catch(() => onMessage({ kind: "error", text: "复制 healthCheck 配置示例失败" }));
  return <section className="project-health-check-guide">
    <div className="project-health-check-guide-heading">
      <div><strong>如何配置 healthCheck</strong><span>它是一条可重复执行的环境检查命令：退出码 0 表示可用，其他退出码表示需要处理。</span></div>
      <button className="icon-button" type="button" onClick={copyExample} title="复制 healthCheck 配置示例" aria-label="复制 healthCheck 配置示例"><ClipboardCopy size={14} /></button>
    </div>
    <ol>
      <li>在 <code>mobile-test.config.cjs</code> 的运行目标中加入以下配置。</li>
      <li>创建 <code>qa/mtc/health-check.cjs</code>，检查项目实际依赖的开发者工具。</li>
      <li>在项目概览点击“重新检查运行环境”，检查输出会显示在下方详情中。</li>
    </ol>
    <strong className="project-health-check-code-title">mobile-test.config.cjs</strong>
    <pre>{miniProgramHealthCheckConfig}</pre>
    <strong className="project-health-check-code-title">qa/mtc/health-check.cjs</strong>
    <pre>{miniProgramHealthCheckScript}</pre>
    <p>示例通过 <code>MTC_MINI_PROGRAM_DEVTOOLS_PATH</code> 读取 CLI 路径。项目也可以检查 Node、包管理器、端口、登录状态或其他运行条件。</p>
  </section>;
}

function ProjectOnboardingNextAction({
  step,
  miniProgram,
  setupPending,
  onVerify,
  onPreviewInitialization,
  onPreviewSetup,
  onCopyGuide,
}: {
  step: ProjectOnboardingStep;
  miniProgram: boolean;
  setupPending: boolean;
  onVerify: () => void;
  onPreviewInitialization: () => void;
  onPreviewSetup: (step: ApplyProjectSetupRequest["step"]) => void;
  onCopyGuide: () => void;
}) {
  return <div className="project-onboarding-next-action">
    <span className="project-onboarding-next-number">{PROJECT_EXECUTION_PREREQUISITE_STEP_IDS.indexOf(step.id) + 1}</span>
    <div><span>当前要做</span><strong>{stepLabels[step.id]}</strong><p>{stepNextActions[step.id]}</p></div>
    <div className="project-onboarding-next-controls">
      <ProjectStepAction step={step} miniProgram={miniProgram} setupPending={setupPending} onVerify={onVerify} onPreviewInitialization={onPreviewInitialization} onPreviewSetup={onPreviewSetup} primary />
      <button className="text-button" type="button" onClick={onCopyGuide}><FileText size={13} />查看接入指南</button>
    </div>
  </div>;
}

function ProjectStepAction({
  step,
  miniProgram,
  setupPending,
  onVerify,
  onPreviewInitialization,
  onPreviewSetup,
  primary = false,
}: {
  step: ProjectOnboardingStep;
  miniProgram: boolean;
  setupPending: boolean;
  onVerify: () => void;
  onPreviewInitialization: () => void;
  onPreviewSetup: (step: ApplyProjectSetupRequest["step"]) => void;
  primary?: boolean;
}) {
  if (step.status === "verified") return null;
  const className = primary ? "primary-button" : "secondary-button project-step-action";
  if (step.id === "template") return <button className={className} type="button" onClick={onPreviewInitialization} disabled={setupPending}><FileText size={14} />生成基础配置</button>;
  if (step.id === "devices" && !miniProgram) return <button className={className} type="button" onClick={() => onPreviewSetup("devices")} disabled={setupPending}><Terminal size={14} />{primary ? "检查并修复环境" : "修复设备环境"}</button>;
  if (step.id === "devices") return <button className={className} type="button" onClick={onVerify} disabled={setupPending}><RefreshCw size={14} />重新检查运行环境</button>;
  if (step.id === "capabilities") return <button className={className} type="button" onClick={() => onPreviewSetup("capabilities")} disabled={setupPending}><Wrench size={14} />生成能力骨架</button>;
  return <button className={className} type="button" onClick={onVerify} disabled={setupPending}><RefreshCw size={14} />重新检查</button>;
}

function ProjectStepTechnicalDetails({ step }: { step: ProjectOnboardingStep }) {
  const hasTechnicalDetails = step.issues.length > 0 || (step.tools?.length ?? 0) > 0 || (step.capabilities?.length ?? 0) > 0;
  if (!hasTechnicalDetails) return null;
  return <details className="project-step-technical-details">
    <summary>查看检查详情<ChevronDown size={14} /></summary>
    <div>
      {step.id === "devices" && <ProjectToolChecks tools={step.tools ?? []} />}
      {step.id === "capabilities" && <ProjectCapabilityChecks capabilities={step.capabilities ?? []} />}
      {step.issues.length > 0 && <div className="project-step-issues"><strong>需要处理</strong>{step.issues.map(issue => <code key={issue}>{issue}</code>)}</div>}
    </div>
  </details>;
}

function ProjectTestEntryChecks({ testEntries }: { testEntries: ProjectTestEntryCheck[] }) {
  if (testEntries.length === 0) return null;
  return <div className="project-test-entry-checks">
    <strong className="project-test-entry-checks-heading">测试入口清单</strong>
    <div className="project-test-entry-check-list">
      {testEntries.map(test => <article className="project-test-entry-check" key={test.id}>
        <span className="project-test-entry-check-icon"><CheckCircle2 size={14} /></span>
        <div className="project-test-entry-check-main">
          <strong>{test.label}</strong>
          <code>{test.id}</code>
          {test.testType && <span className="project-test-entry-check-type">{test.testType}</span>}
          <p>{test.description || "该测试入口暂未填写用途说明。"}</p>
          <div className="project-test-entry-check-meta">
            <span><strong>{test.targetKeys?.length ? "运行目标" : "平台"}</strong>{test.targetKeys?.length ? test.targetKeys.join(" · ") : test.platforms.map(platform => platformLabels[platform]).join(" · ")}</span>
            <span><strong>Runner</strong><code>{test.runnerId}</code></span>
            <span><strong>参数</strong>{test.parameterLabels.length > 0 ? test.parameterLabels.join(" · ") : "无需参数"}</span>
          </div>
        </div>
        <span className="project-test-entry-check-status">已声明</span>
      </article>)}
    </div>
  </div>;
}

function ProjectToolChecks({ tools }: { tools: ProjectToolCheck[] }) {
  if (tools.length === 0) return null;
  return <div className="project-tool-checks">
    <strong className="project-tool-checks-heading">工具链检查</strong>
    <div className="project-tool-check-list">
      {tools.map(tool => <article className={`project-tool-check ${tool.status}`} key={tool.id}>
        <div className="project-tool-check-header">
          <span className="project-tool-check-title">
            {tool.status === "ready" ? <CheckCircle2 size={14} /> : <AlertCircle size={14} />}
            <strong>{tool.label}</strong>
          </span>
          <span className="project-tool-check-status">{tool.status === "ready" ? "可用" : "不可用"}</span>
        </div>
        <div className="project-tool-check-meta">
          <code>{tool.executable}</code>
          <span>{tool.version || "未检测到版本"}</span>
          <code>{tool.path || "未解析到路径"}</code>
        </div>
        <p>{tool.detail}</p>
        {tool.guidance.length > 0 && <div className="project-tool-check-guidance">
          <strong>配置引导</strong>
          {tool.guidance.map(item => <code key={item}>{item}</code>)}
        </div>}
      </article>)}
    </div>
  </div>;
}

function ProjectCapabilityChecks({ capabilities }: { capabilities: ProjectCapabilityCheck[] }) {
  if (capabilities.length === 0) return null;
  return <div className="project-capability-checks">
    <strong className="project-capability-checks-heading">能力清单</strong>
    <div className="project-capability-check-list">
      {capabilities.map(capability => <article className={`project-capability-check ${capability.status}`} key={capability.id}>
        <span className="project-capability-check-icon">
          {capability.status === "ready" ? <CheckCircle2 size={14} /> : <AlertCircle size={14} />}
        </span>
        <div className="project-capability-check-main">
          <strong>{capability.label}</strong>
          <code>{capability.id}</code>
          <p>{capability.detail}</p>
          {capability.guidance.map(item => <small key={item}>{item}</small>)}
        </div>
        <span className="project-capability-check-status">{capability.status === "ready" ? "已接入" : "待接入"}</span>
      </article>)}
    </div>
  </div>;
}

function ProjectSetupPlanDialog({
  plan,
  pending,
  onCancel,
  onConfirm,
}: {
  plan: ProjectSetupPlan;
  pending: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return <div className="confirm-overlay" role="presentation">
    <section className="confirm-dialog project-setup-dialog" role="dialog" aria-modal="true" aria-labelledby="project-setup-title">
      <header className="project-setup-dialog-header">
        <div><p className="eyebrow">SETUP PLAN</p><h2 id="project-setup-title">确认接入计划</h2></div>
        <button className="icon-button" type="button" onClick={onCancel} disabled={pending} title="关闭接入计划" aria-label="关闭接入计划"><X size={17} /></button>
      </header>
      <p className="project-setup-summary">{plan.summary}</p>
      <div className="project-setup-scope"><strong>项目目录</strong><code>{plan.projectDirectory}</code></div>
      <div className="project-setup-actions">
        {plan.actions.map((action, index) => <details key={action.id} open={index === 0}>
          <summary>
            <span className={`project-setup-kind ${action.kind}`}>{action.kind === "write-file" ? "文件" : action.kind === "command" ? "命令" : "人工"}</span>
            <strong>{action.label}</strong>
            <ChevronDown size={14} />
          </summary>
          <div>
            <p>{action.detail}</p>
            {action.target && <code>{action.target}</code>}
            {action.command && <pre>{action.command}</pre>}
            {action.cwd && <small>执行目录：{action.cwd}</small>}
            {action.contentPreview && <pre>{action.contentPreview}</pre>}
          </div>
        </details>)}
      </div>
      {!plan.canApply && <div className="project-setup-blocked"><AlertCircle size={16} /><span>{plan.blockingReason}</span></div>}
      <p className="project-setup-impact">确认后，MTC 将执行以上文件和命令操作，并自动重新验证项目接入状态。</p>
      <footer className="confirm-actions">
        <button className="secondary-button" type="button" onClick={onCancel} disabled={pending}>取消</button>
        <button className="primary-button" type="button" onClick={onConfirm} disabled={pending || !plan.canApply}>{pending ? "执行中..." : "确认执行"}</button>
      </footer>
    </section>
  </div>;
}

function emptyForm(): RegisterProjectRequest {
  return {
    projectDirectory: "",
    configFile: "",
  };
}
