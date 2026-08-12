import {
  AlertCircle,
  CheckCircle2,
  ChevronDown,
  FolderPlus,
  FolderOpen,
  FileText,
  LoaderCircle,
  Power,
  RefreshCw,
  Smartphone,
  Terminal,
  Wrench,
  X,
} from "lucide-react";
import { useEffect, useState } from "react";
import type {
  Platform,
  ApplyProjectInitializationRequest,
  ApplyProjectSetupRequest,
  ProjectCapabilityCheck,
  ProjectCatalogEntry,
  ProjectCatalogDetailResponse,
  ProjectCatalogResponse,
  ProjectConfigSelection,
  ProjectIntegrationType,
  ProjectOnboardingStepStatus,
  ProjectTestEntryCheck,
  ProjectToolCheck,
  ProjectSetupApplyResponse,
  ProjectSetupPlan,
  PreviewProjectInitializationRequest,
  RegisterProjectRequest,
} from "../shared/contracts";
import { PROJECT_EXECUTION_PREREQUISITE_STEP_IDS } from "../shared/contracts";
import { ApiError, fetchProjectCatalogDetail } from "./api";

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
  project: "项目目录",
  template: "接入配置",
  devices: "设备环境",
  capabilities: "项目能力",
} as const;

const stepDescriptions = {
  project: "确认 MTC 能访问项目根目录，并把项目配置纳入登记目录。",
  template: "读取 mobile-test.config.cjs，确认项目 ID、目录、类型、平台和测试入口。",
  devices: "根据项目声明的平台检查 adb、Xcode、hdc 等本机工具链，并确认存在已连接、已授权的可测试设备。",
  capabilities: "检查项目 Provider 是否声明构建、安装、页面参数和结果分析等能力。",
} as const;

const stepNextActions = {
  project: "选择可访问的项目目录。",
  template: "在项目目录中准备 mobile-test.config.cjs，然后重新验证接入。",
  devices: "按检测结果安装工具或配置本机路径，再连接设备、完成授权并重新验证。",
  capabilities: "补齐项目 Provider 能力声明，并重新验证项目能力。",
} as const;

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
  addingProject = false,
  onCloseAdd,
  onMessage,
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
  addingProject?: boolean;
  onCloseAdd: (projectId?: string) => void;
  onMessage: (message: { kind: "error" | "info"; text: string }) => void;
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

  const previewInitialization = async (projectDirectory = form.projectDirectory, platforms = initializationPlatforms) => {
    setSetupPending(true);
    try {
      const plan = await onPreviewInitialization({ projectDirectory, platforms });
      if (!plan) return;
      setSetupPlan(plan);
      setSetupContext({ kind: "initialization", projectDirectory, platforms });
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
      {initializationRequired && <fieldset className="project-register-platforms">
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
          ? <button className="primary-button" type="button" onClick={() => void previewInitialization()} disabled={setupPending || !form.projectDirectory.trim() || initializationPlatforms.length === 0}>
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
  </div>;
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
}) {
  const executionPrerequisites = project.onboarding.filter(step => (
    PROJECT_EXECUTION_PREREQUISITE_STEP_IDS.some(id => id === step.id)
  ));
  const executionPrerequisiteVerifiedCount = executionPrerequisites.filter(step => step.status === "verified").length;
  return <section className={`section-panel project-card ${runtimeActive ? "active" : ""}`}>
    <div className="project-card-header">
      <div className="project-card-title">
        <span className="project-card-icon"><Smartphone size={17} /></span>
        <div><strong>{project.name}</strong><small>{project.id} · {integrationLabels[project.integrationType]}</small></div>
      </div>
      <div className="project-card-tools">
        {runtimeActive && <span className="project-active-label">当前运行项目</span>}
        {!runtimeActive && <button className="secondary-button" type="button" onClick={onActivate} disabled={verifying}><Power size={14} />切换运行项目</button>}
        <button className="secondary-button" type="button" onClick={onVerify} disabled={verifying}>
          <RefreshCw size={14} className={verifying ? "spin" : ""} />验证接入
        </button>
      </div>
    </div>
    <div className="project-card-meta"><span>{project.root}</span><span>{detail?.executionReady ? "运行前检查已通过" : `${executionPrerequisiteVerifiedCount}/${executionPrerequisites.length} 项运行前检查通过`}</span><span>{project.platforms.map(platform => platformLabels[platform]).join(" · ")}</span></div>
    {detailLoading && <div className="project-detail-loading"><LoaderCircle className="spin" size={17} />正在读取项目支持的测试</div>}
    {detailError && <div className="project-detail-error"><AlertCircle size={16} />{detailError}</div>}
    {!detailLoading && <section className="project-onboarding-section">
      <div className="project-onboarding-heading"><div><p className="eyebrow">ONBOARDING STATUS</p><h3>项目接入状态</h3></div><span className="count-label">{detail?.executionReady ? "可以执行测试" : `${executionPrerequisiteVerifiedCount}/${executionPrerequisites.length} 项运行前检查通过`}</span></div>
      {detail?.executionReady && <div className="project-execution-ready"><CheckCircle2 size={15} /><span>项目接入已完成，顶部项目工作区现已可用。</span></div>}
      <div className="project-step-list">
        {project.onboarding.map(step => <details className={`project-step ${step.status}`} key={step.id} open={step.status === "waiting" || step.status === "blocked"}>
          <summary className="project-step-summary">
            <span className="project-step-marker">{step.status === "verified" ? <CheckCircle2 size={15} /> : step.status === "blocked" ? <AlertCircle size={15} /> : <span />}</span>
            <span className="project-step-content"><strong>{stepLabels[step.id]}</strong><small>{step.summary}</small></span>
            <span className="project-step-status">{statusLabels[step.status]}<ChevronDown size={14} className="project-step-chevron" /></span>
          </summary>
          <div className="project-step-detail">
            <p>{stepDescriptions[step.id]}</p>
            <div><strong>完成后</strong><span>{step.id === "project" ? "项目目录状态变为已验证。" : "MTC 会自动复检该步骤，并根据最新项目状态开放对应工作区。"}</span></div>
            <div><strong>下一步</strong><span>{stepNextActions[step.id]}</span></div>
            {step.id === "template" && <ProjectTestEntryChecks testEntries={step.testEntries ?? []} />}
            {step.id === "devices" && <ProjectToolChecks tools={step.tools ?? []} />}
            {step.id === "capabilities" && <ProjectCapabilityChecks capabilities={step.capabilities ?? []} />}
            {step.issues.length > 0 && <div className="project-step-issues"><strong>需要处理</strong>{step.issues.map(issue => <code key={issue}>{issue}</code>)}</div>}
            {step.status !== "verified" && step.id === "template" && <button className="secondary-button project-step-action" type="button" onClick={onPreviewInitialization} disabled={setupPending}><FileText size={14} />预览初始化配置</button>}
            {step.status !== "verified" && step.id === "devices" && <button className="secondary-button project-step-action" type="button" onClick={() => onPreviewSetup("devices")} disabled={setupPending}><Terminal size={14} />修复设备环境</button>}
            {step.status !== "verified" && step.id === "capabilities" && <button className="secondary-button project-step-action" type="button" onClick={() => onPreviewSetup("capabilities")} disabled={setupPending}><Wrench size={14} />生成能力模板</button>}
          </div>
        </details>)}
      </div>
    </section>}
    {project.integrationType === "mini-program" && <p className="project-card-note">小程序目标已纳入项目协议，执行 Connector 将在后续阶段接入。</p>}
    <button className="text-button project-doc-hint" type="button" onClick={() => void navigator.clipboard.writeText("examples/lynx-app-starter").then(() => onMessage({ kind: "info", text: "已复制 Lynx App Starter 路径" })).catch(() => onMessage({ kind: "error", text: "复制 Starter 路径失败" }))}>
      参考 Lynx App Starter：examples/lynx-app-starter
    </button>
  </section>;
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
          <p>{test.description || "该测试入口暂未填写用途说明。"}</p>
          <div className="project-test-entry-check-meta">
            <span><strong>平台</strong>{test.platforms.map(platform => platformLabels[platform]).join(" · ")}</span>
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
