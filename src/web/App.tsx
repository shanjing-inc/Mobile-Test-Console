import {
  Activity,
  AlertCircle,
  BarChart3,
  CheckCircle2,
  ChevronRight,
  CircleDot,
  Clock3,
  Copy,
  Download,
  ExternalLink,
  Files,
  ImageIcon,
  LoaderCircle,
  List,
  MonitorSmartphone,
  Network,
  Play,
  Power,
  RefreshCw,
  Smartphone,
  Square,
  SlidersHorizontal,
  Clapperboard,
  UserRoundCheck,
  Terminal,
  Trash2,
  XCircle,
  Bot,
  RotateCcw,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  AccountProfileProvider,
  AccountProfileSummary,
  AccountProfilesResponse,
  ConsoleSnapshot,
  Device,
  DeviceConnectionState,
  Platform,
  TaskResult,
  TaskResultApiCall,
  TaskResultRun,
  TaskStatus,
  TestTask,
  RepairJob,
  RepairJobPreview,
} from "../shared/contracts";
import { ACTIVE_TASK_STATUSES, CURRENT_ACCOUNT_SESSION, TERMINAL_TASK_STATUSES } from "../shared/contracts";
import { supportsAccountProfileProvider } from "../shared/account-profile-compatibility";
import { ApiError, cancelRepairJob, createRepairJob, deleteTask, fetchAccountProfiles, fetchRepairJobPreview, fetchSnapshot, fetchTaskResult, installDevicePreparation, openRepairTask, retryRepairTest, selectRepairProjectDirectory, startDevice, startTasks, stopTask, taskArtifactUrl } from "./api";
import { PageParametersWorkspace } from "./PageParametersWorkspace";
import { AccountProfilesWorkspace } from "./AccountProfilesWorkspace";
import { BusinessScriptsWorkspace } from "./BusinessScriptsWorkspace";
import { diagnoseTaskResultRun, isFailedApiCall, taskResultRunKey } from "./result-analysis";

const ACTIVE_STATUSES = new Set(ACTIVE_TASK_STATUSES);
const TERMINAL_STATUSES = new Set(TERMINAL_TASK_STATUSES);

type DetailTab = "overview" | "screenshots" | "api" | "evidence" | "logs";

interface ResultState {
  taskId: string;
  loading: boolean;
  result: TaskResult | null;
  error: string;
}

const statusLabels: Record<TaskStatus, string> = {
  queued: "排队中",
  preparing: "准备中",
  running: "测试中",
  passed: "通过",
  failed: "失败",
  cancelled: "已取消",
  interrupted: "已中断",
};

const connectionLabels: Record<DeviceConnectionState, string> = {
  available: "已连接",
  offline: "离线",
  unauthorized: "待授权",
  unavailable: "不可用",
};

const platformLabels: Record<Platform, string> = {
  android: "Android",
  ios: "iOS",
  harmony: "HarmonyOS",
};

const accountProviderLabels: Record<AccountProfileProvider, string> = {
  wechat: "微信",
  qq: "QQ",
  taobao: "淘宝",
  huawei: "华为",
  "taobao-commerce": "淘宝授权",
};

// eslint-disable-next-line react-refresh/only-export-components
export function resolveAccountProfileOptions(
  profiles: AccountProfileSummary[],
  devices: Device[],
  selectedKeys: string[],
  capability: string,
  environment: string,
): Array<{ value: string; label: string; description: string }> {
  const selectedDevices = devices.filter(device => selectedKeys.includes(device.key));
  const selectedPlatforms = new Set(selectedDevices.map(device => device.platform));
  const targetPlatforms = [...selectedPlatforms];
  const targetPlatformLabel = targetPlatforms.map(platform => platform.toUpperCase()).join(" / ");
  const now = Date.now();
  const options = profiles
    .filter(profile => targetPlatforms.length > 0 && (!environment || profile.environment === environment))
    .flatMap(profile => profile.providerEntries
      .filter(entry => entry.capabilities.includes(capability)
        && selectedDevices.every(device => supportsAccountProfileProvider(entry.provider, device))
        && targetPlatforms.every(platform => profile.platform === platform || entry.capabilities.includes("login"))
        && Number.isFinite(Date.parse(entry.expiresAt))
        && Date.parse(entry.expiresAt) > now)
      .map(entry => ({
        value: `${profile.profileId}:${entry.provider}`,
        label: `${profile.accountLabel} · ${accountProviderLabels[entry.provider]}`,
        description: `录制于 ${profile.platform.toUpperCase()} · 回放到 ${targetPlatformLabel} · ${profile.environment} · UID ${entry.accountUidMasked || "待验证"}`,
      })));
  return [
    {
      value: CURRENT_ACCOUNT_SESSION,
      label: "使用设备当前登录态",
      description: selectedPlatforms.size > 1
        ? "每台设备独立验证当前登录态"
        : "会话有效时直接测试；会话失效时提示选择账号画像",
    },
    ...options,
  ];
}

export default function App() {
  const [workspaceView, setWorkspaceView] = useState<"tests" | "parameters" | "scripts" | "accounts">("tests");
  const [snapshot, setSnapshot] = useState<ConsoleSnapshot | null>(null);
  const [accountProfiles, setAccountProfiles] = useState<AccountProfilesResponse | null>(null);
  const [selectedKeys, setSelectedKeys] = useState<string[]>([]);
  const [preparingDeviceKeys, setPreparingDeviceKeys] = useState<Set<string>>(new Set());
  const [selectedTestId, setSelectedTestId] = useState("");
  const [parameters, setParameters] = useState<Record<string, string>>({});
  const [focusedTaskId, setFocusedTaskId] = useState<string | null>(null);
  const [platformFilter, setPlatformFilter] = useState<"all" | Platform>("all");
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [actionPending, setActionPending] = useState(false);
  const [startingDeviceKeys, setStartingDeviceKeys] = useState<Set<string>>(() => new Set());
  const [message, setMessage] = useState<{ kind: "error" | "info"; text: string } | null>(null);
  const [deleteCandidate, setDeleteCandidate] = useState<TestTask | null>(null);
  const [repairPreview, setRepairPreview] = useState<{ task: TestTask; preview: RepairJobPreview } | null>(null);
  const [detailTab, setDetailTab] = useState<DetailTab>("logs");
  const [autoOpenRepairId, setAutoOpenRepairId] = useState("");
  const [resultState, setResultState] = useState<ResultState>({
    taskId: "",
    loading: false,
    result: null,
    error: "",
  });
  const deletedTaskIds = useRef(new Set<string>());

  const load = useCallback(async (showSpinner = false) => {
    if (showSpinner) setRefreshing(true);
    try {
      const [snapshotResponse, accountProfileResponse] = await Promise.all([
        fetchSnapshot(showSpinner),
        fetchAccountProfiles().catch(() => null),
      ]);
      const next = excludeDeletedTasks(snapshotResponse, deletedTaskIds.current);
      setSnapshot(next);
      if (accountProfileResponse) setAccountProfiles(accountProfileResponse);
      setSelectedKeys(previous => previous.filter(key => next.devices.some(device => device.key === key && device.connectionState === "available")));
      setFocusedTaskId(previous => reconcileFocusedTaskId(previous, next.tasks));
    } catch (error) {
      setMessage({ kind: "error", text: error instanceof ApiError ? error.message : "无法读取控制服务" });
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    void load();
    const timer = window.setInterval(() => void load(), 1_000);
    return () => window.clearInterval(timer);
  }, [load]);

  const tests = snapshot?.tests || [];
  const selectedTest = tests.find(test => test.id === selectedTestId) || tests[0];
  const tasks = useMemo(() => snapshot?.tasks ?? [], [snapshot]);
  const focusedTask = focusedTaskId ? tasks.find(task => task.id === focusedTaskId) : undefined;
  const focusedResultTaskId = focusedTask?.id || "";
  const focusedResultTaskStatus = focusedTask?.status || "";
  const repairJobs = useMemo(() => snapshot?.repairJobs ?? [], [snapshot]);
  const focusedRepairJobs = focusedTask ? repairJobs.filter(job => job.taskId === focusedTask.id) : [];

  const loadTaskResult = useCallback(async (taskId: string, refresh = false) => {
    setResultState({ taskId, loading: true, result: null, error: "" });
    try {
      const response = await fetchTaskResult(taskId, refresh);
      setResultState({ taskId, loading: false, result: response.result, error: "" });
    } catch (error) {
      setResultState({
        taskId,
        loading: false,
        result: null,
        error: error instanceof ApiError ? error.message : "无法读取测试分析结果",
      });
    }
  }, []);

  useEffect(() => {
    if (!focusedResultTaskId || !focusedResultTaskStatus) {
      setDetailTab("logs");
      setResultState({ taskId: "", loading: false, result: null, error: "" });
      return;
    }
    if (!TERMINAL_STATUSES.has(focusedResultTaskStatus as TaskStatus)) {
      setDetailTab("logs");
      setResultState({ taskId: focusedResultTaskId, loading: false, result: null, error: "" });
      return;
    }
    setDetailTab("overview");
    void loadTaskResult(focusedResultTaskId);
  }, [focusedResultTaskId, focusedResultTaskStatus, loadTaskResult]);

  useEffect(() => {
    if (!selectedTest) return;
    setSelectedTestId(previous => previous || selectedTest.id);
    setParameters(previous => {
      const next = { ...previous };
      for (const parameter of selectedTest.parameters) {
        if (!next[parameter.id]) next[parameter.id] = parameter.defaultValue;
      }
      return next;
    });
  }, [selectedTest]);

  useEffect(() => {
    if (!selectedTest) return;
    setParameters(previous => {
      let changed = false;
      const next = { ...previous };
      const environment = previous.environment || selectedTest.parameters.find(item => item.id === "environment")?.defaultValue || "";
      for (const parameter of selectedTest.parameters) {
        if (parameter.type !== "account-profile") continue;
        const options = resolveAccountProfileOptions(
          accountProfiles?.profiles ?? [],
          snapshot?.devices ?? [],
          selectedKeys,
          parameter.capability,
          environment,
        );
        const current = previous[parameter.id] || parameter.defaultValue;
        if (!options.some(option => option.value === current)) {
          next[parameter.id] = parameter.defaultValue;
          changed = true;
        }
      }
      return changed ? next : previous;
    });
  }, [accountProfiles?.profiles, selectedKeys, selectedTest, snapshot?.devices]);

  const taskByDevice = useMemo(() => {
    const map = new Map<string, TestTask>();
    for (const task of tasks) {
      const current = map.get(task.device.key);
      if (!current || task.createdAt > current.createdAt) map.set(task.device.key, task);
    }
    return map;
  }, [tasks]);

  const connectedDevices = (snapshot?.devices || []).filter(device => device.connectionState === "available");
  const visibleDevices = (snapshot?.devices || []).filter(device => platformFilter === "all" || device.platform === platformFilter);
  const activeCount = tasks.filter(task => ACTIVE_STATUSES.has(task.status)).length;
  const passedCount = tasks.filter(task => task.status === "passed").length;
  const failedCount = tasks.filter(task => ["failed", "interrupted"].includes(task.status)).length;

  const toggleDevice = (device: Device) => {
    if (device.connectionState !== "available"
      || device.preparations?.some(item => item.blocksTests && item.status !== "ready")
      || taskByDevice.get(device.key) && ACTIVE_STATUSES.has(taskByDevice.get(device.key)!.status)) return;
    setSelectedKeys(previous => previous.includes(device.key)
      ? previous.filter(key => key !== device.key)
      : [...previous, device.key]);
  };

  const handleStart = async () => {
    if (!selectedTest || selectedKeys.length === 0) {
      setMessage({ kind: "error", text: "请选择测试和至少一台设备" });
      return;
    }
    const accountParameter = selectedTest.parameters.find(parameter => parameter.type === "account-profile");
    if (accountParameter) {
      const selectedValue = parameters[accountParameter.id] || accountParameter.defaultValue;
      const environment = parameters.environment || selectedTest.parameters.find(item => item.id === "environment")?.defaultValue || "";
      const accountOptions = resolveAccountProfileOptions(
        accountProfiles?.profiles ?? [],
        snapshot?.devices ?? [],
        selectedKeys,
        accountParameter.capability,
        environment,
      );
      if (!accountOptions.some(option => option.value === selectedValue)) {
        setMessage({ kind: "error", text: "所选账号画像已过期或与当前设备、环境不匹配" });
        return;
      }
    }
    setActionPending(true);
    try {
      const result = await startTasks({ testId: selectedTest.id, deviceKeys: selectedKeys, parameters });
      setSelectedKeys([]);
      setFocusedTaskId(result.tasks[0]?.id || "");
      setMessage({ kind: "info", text: `已启动 ${result.tasks.length} 台设备` });
      await load();
    } catch (error) {
      setMessage({ kind: "error", text: error instanceof ApiError ? error.message : "启动测试失败" });
    } finally {
      setActionPending(false);
    }
  };

  const handleStartDevice = async (device: Device) => {
    setStartingDeviceKeys(previous => new Set(previous).add(device.key));
    try {
      await startDevice(device.key);
      setMessage({ kind: "info", text: `${device.name} 已启动` });
      await load(true);
    } catch (error) {
      setMessage({ kind: "error", text: error instanceof ApiError ? error.message : "启动模拟器失败" });
    } finally {
      setStartingDeviceKeys(previous => {
        const next = new Set(previous);
        next.delete(device.key);
        return next;
      });
    }
  };

  const handleInstallPreparation = async (device: Device, preparationId: string) => {
    setPreparingDeviceKeys(previous => new Set(previous).add(device.key));
    try {
      const response = await installDevicePreparation(device.key, preparationId);
      setMessage({ kind: "info", text: `${device.name} · ${response.preparation.label}已就绪` });
      await load(true);
    } catch (error) {
      setMessage({ kind: "error", text: error instanceof ApiError ? error.message : "设备准备失败" });
    } finally {
      setPreparingDeviceKeys(previous => {
        const next = new Set(previous);
        next.delete(device.key);
        return next;
      });
    }
  };

  const handleStop = async (task: TestTask) => {
    setActionPending(true);
    try {
      await stopTask(task.id);
      setMessage({ kind: "info", text: `已请求停止 ${task.device.name}` });
      await load();
    } catch (error) {
      setMessage({ kind: "error", text: error instanceof ApiError ? error.message : "停止测试失败" });
    } finally {
      setActionPending(false);
    }
  };

  const handleDelete = async () => {
    const task = deleteCandidate;
    if (!task) return;
    setActionPending(true);
    try {
      await deleteTask(task.id);
      deletedTaskIds.current.add(task.id);
      setSnapshot(previous => previous ? excludeDeletedTasks(previous, deletedTaskIds.current) : previous);
      setFocusedTaskId(previous => clearDeletedFocusedTaskId(previous, task.id));
      setDeleteCandidate(null);
      setMessage({ kind: "info", text: `已删除 ${task.device.name} 的运行记录` });
    } catch (error) {
      setMessage({ kind: "error", text: error instanceof ApiError ? error.message : "删除运行记录失败" });
    } finally {
      setActionPending(false);
    }
  };

  const handlePrepareRepair = async (task: TestTask, run: TaskResultRun) => {
    setActionPending(true);
    try {
      const response = await fetchRepairJobPreview(task.id, run.caseRunId);
      setRepairPreview({ task, preview: response.preview });
    } catch (error) {
      setMessage({ kind: "error", text: error instanceof ApiError ? error.message : "读取 Codex 修复信息失败" });
    } finally {
      setActionPending(false);
    }
  };

  const handleConfirmRepair = async () => {
    const candidate = repairPreview;
    if (!candidate) return;
    setActionPending(true);
    try {
      let response;
      try {
        response = await createRepairJob(candidate.task.id, candidate.preview.caseRunId);
      } catch (error) {
        if (!(error instanceof ApiError) || error.code !== "REPAIR_PROJECT_DIRECTORY_REQUIRED") throw error;
        const selection = await selectRepairProjectDirectory();
        response = await createRepairJob(candidate.task.id, candidate.preview.caseRunId, selection.projectDirectory);
      }
      setRepairPreview(null);
      setAutoOpenRepairId(response.job.repairJobId);
      setMessage({ kind: "info", text: `已交给 Codex 修复：${response.job.targetPage}` });
      await load();
    } catch (error) {
      setMessage({ kind: "error", text: error instanceof ApiError ? error.message : "创建 Codex 修复任务失败" });
    } finally {
      setActionPending(false);
    }
  };

  const handleCancelRepair = async (job: RepairJob) => {
    setActionPending(true);
    try {
      await cancelRepairJob(job.repairJobId);
      setMessage({ kind: "info", text: "已取消 Codex 修复" });
      await load();
    } catch (error) {
      setMessage({ kind: "error", text: error instanceof ApiError ? error.message : "取消 Codex 修复失败" });
    } finally {
      setActionPending(false);
    }
  };

  const handleRetryRepairTest = async (job: RepairJob) => {
    setActionPending(true);
    try {
      await retryRepairTest(job.repairJobId);
      setMessage({ kind: "info", text: "已重新执行原参数复测" });
      await load();
    } catch (error) {
      setMessage({ kind: "error", text: error instanceof ApiError ? error.message : "启动修复复测失败" });
    } finally {
      setActionPending(false);
    }
  };

  const handleOpenRepairTask = useCallback(async (job: RepairJob) => {
    setActionPending(true);
    try {
      await openRepairTask(job.repairJobId);
      setMessage({ kind: "info", text: "已打开 ChatGPT 修复任务" });
    } catch (error) {
      setMessage({ kind: "error", text: error instanceof ApiError ? error.message : "打开 ChatGPT 修复任务失败" });
    } finally {
      setActionPending(false);
    }
  }, []);

  useEffect(() => {
    if (!autoOpenRepairId) return;
    const job = repairJobs.find(item => item.repairJobId === autoOpenRepairId);
    if (!job?.codexThreadId) return;
    setAutoOpenRepairId("");
    void handleOpenRepairTask(job);
  }, [autoOpenRepairId, handleOpenRepairTask, repairJobs]);

  const copyJson = async (label: string, value: unknown) => {
    try {
      await navigator.clipboard.writeText(formatJson(value));
      setMessage({ kind: "info", text: `已复制${label}` });
    } catch {
      setMessage({ kind: "error", text: `${label}复制失败` });
    }
  };

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="brand-lockup">
          <div className="brand-icon"><Activity size={20} /></div>
          <div>
            <p className="eyebrow">LOCAL TEST CONTROL</p>
            <h1>Mobile Test Console</h1>
          </div>
        </div>
        <div className="project-context">
          <span className="context-label">项目</span>
          <strong>{snapshot?.project.name || "加载中"}</strong>
          <span className="local-badge"><CircleDot size={11} /> 本机</span>
        </div>
        <div className="workspace-switch" role="tablist" aria-label="工作区">
          <button type="button" role="tab" aria-selected={workspaceView === "tests"} className={workspaceView === "tests" ? "active" : ""} onClick={() => setWorkspaceView("tests")}><Activity size={14} />测试执行</button>
          <button type="button" role="tab" aria-selected={workspaceView === "parameters"} className={workspaceView === "parameters" ? "active" : ""} onClick={() => setWorkspaceView("parameters")}><SlidersHorizontal size={14} />页面列表</button>
          <button type="button" role="tab" aria-selected={workspaceView === "scripts"} className={workspaceView === "scripts" ? "active" : ""} onClick={() => setWorkspaceView("scripts")}><Clapperboard size={14} />业务脚本</button>
          <button type="button" role="tab" aria-selected={workspaceView === "accounts"} className={workspaceView === "accounts" ? "active" : ""} onClick={() => setWorkspaceView("accounts")}><UserRoundCheck size={14} />账号画像</button>
        </div>
        <button className="icon-button" type="button" onClick={() => void load(true)} disabled={refreshing} title="刷新设备和运行状态" aria-label="刷新设备和运行状态">
          <RefreshCw size={17} className={refreshing ? "spin" : ""} />
        </button>
      </header>

      <main className="content">
        {message && <div className={`notice ${message.kind}`} role="status"><AlertCircle size={16} /> <span>{message.text}</span><button type="button" onClick={() => setMessage(null)} aria-label="关闭提示">×</button></div>}

        {workspaceView === "tests" ? <>
        <section className="metrics-strip" aria-label="运行概览">
          <Metric label="可用设备" value={connectedDevices.length} tone="teal" icon={<MonitorSmartphone size={17} />} />
          <Metric label="测试中" value={activeCount} tone="blue" icon={<LoaderCircle size={17} />} />
          <Metric label="最近通过" value={passedCount} tone="green" icon={<CheckCircle2 size={17} />} />
          <Metric label="需要关注" value={failedCount} tone="red" icon={<AlertCircle size={17} />} />
        </section>

        <div className="workspace-grid">
          <aside className="devices-column section-panel">
            <div className="section-heading">
              <div><p className="eyebrow">DEVICE POOL</p><h2>连接设备</h2></div>
              <span className="count-label">
                {snapshot?.deviceDiscoveryPending ? <><LoaderCircle size={12} className="spin" />发现中</> : `${visibleDevices.length} 台`}
              </span>
            </div>
            <div className="platform-filter" aria-label="设备平台筛选">
              {(["all", "android", "ios", "harmony"] as const).map(platform => (
                <button
                  key={platform}
                  type="button"
                  className={platformFilter === platform ? "active" : ""}
                  aria-pressed={platformFilter === platform}
                  onClick={() => setPlatformFilter(platform)}
                >
                  {platform === "all" ? "全部" : platformLabels[platform]}
                </button>
              ))}
            </div>
            <div className="device-list">
              {loading && <EmptyState icon={<LoaderCircle className="spin" size={21} />} text="正在读取设备" />}
              {!loading && visibleDevices.length === 0 && <EmptyState icon={<Smartphone size={21} />} text="暂未发现设备" />}
              {visibleDevices.map(device => (
                <DeviceRow
                  key={device.key}
                  device={device}
                  task={taskByDevice.get(device.key)}
                  selected={selectedKeys.includes(device.key)}
                  onToggle={() => toggleDevice(device)}
                  starting={startingDeviceKeys.has(device.key)}
                  onStart={() => void handleStartDevice(device)}
                  preparing={preparingDeviceKeys.has(device.key)}
                  onInstallPreparation={preparationId => void handleInstallPreparation(device, preparationId)}
                />
              ))}
            </div>
            {Object.entries(snapshot?.deviceErrors || {}).map(([platform, error]) => <div className="provider-error" key={platform}><AlertCircle size={14} /><span>{platformLabels[platform as Platform]}：{error}</span></div>)}
          </aside>

          <div className="main-column">
            <section className="section-panel test-panel">
              <div className="section-heading"><div><p className="eyebrow">TEST PLAN</p><h2>启动测试</h2></div><span className="selection-label">已选 {selectedKeys.length} 台</span></div>
              <div className="form-grid">
                <label className="field"><span>测试入口</span><select value={selectedTest?.id || ""} onChange={event => { setSelectedTestId(event.target.value); setParameters({}); }} disabled={tests.length === 0}><option value="" disabled>选择测试入口</option>{tests.map(test => <option key={test.id} value={test.id}>{test.label}</option>)}</select></label>
                <div className="test-description">{selectedTest?.description || "选择已声明的测试入口和设备后启动。"}</div>
                {selectedTest?.parameters.map(parameter => {
                  if (parameter.type === "account-profile") {
                    const environment = parameters.environment || selectedTest.parameters.find(item => item.id === "environment")?.defaultValue || "";
                    const options = resolveAccountProfileOptions(
                      accountProfiles?.profiles ?? [],
                      snapshot?.devices ?? [],
                      selectedKeys,
                      parameter.capability,
                      environment,
                    );
                    const value = parameters[parameter.id] || parameter.defaultValue;
                    const description = options.find(option => option.value === value)?.description;
                    return <label className="field" key={parameter.id}>
                      <span>{parameter.label}</span>
                      <select value={value} onChange={event => setParameters(previous => ({ ...previous, [parameter.id]: event.target.value }))}>{options.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}</select>
                      {description ? <small className="field-description">{description}</small> : null}
                    </label>;
                  }
                  const value = parameters[parameter.id] || parameter.defaultValue;
                  const description = parameter.options.find(option => option.value === value)?.description;
                  return <label className="field" key={parameter.id}>
                    <span>{parameter.label}</span>
                    <select value={value} onChange={event => setParameters(previous => ({ ...previous, [parameter.id]: event.target.value }))}>{parameter.options.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}</select>
                    {description ? <small className="field-description">{description}</small> : null}
                  </label>;
                })}
              </div>
              <div className="test-actions"><span className="action-hint"><Copy size={14} /> 每台设备独立记录运行结果</span><button className="primary-button" type="button" onClick={() => void handleStart()} disabled={actionPending || selectedKeys.length === 0 || !selectedTest}><Play size={16} fill="currentColor" />启动测试</button></div>
            </section>

            <section className="section-panel runs-panel">
              <div className="section-heading"><div><p className="eyebrow">RUN MONITOR</p><h2>运行状态</h2></div><span className="count-label">{tasks.length} 条记录</span></div>
              {tasks.length === 0 ? <EmptyState icon={<Clock3 size={21} />} text="还没有运行记录" /> : <div className="run-list">{tasks.map(task => <RunRow key={task.id} task={task} focused={task.id === focusedTask?.id} onFocus={() => setFocusedTaskId(task.id)} onStop={() => void handleStop(task)} onDelete={() => setDeleteCandidate(task)} pending={actionPending} />)}</div>}
            </section>

            {focusedTask && <TaskDetail
              task={focusedTask}
              tab={detailTab}
              resultState={resultState.taskId === focusedTask.id ? resultState : { taskId: focusedTask.id, loading: true, result: null, error: "" }}
              repairJobs={focusedRepairJobs}
              codexRepairEnabled={snapshot?.codexRepairEnabled === true}
              repairPending={actionPending}
              onTab={setDetailTab}
              onReload={() => void loadTaskResult(focusedTask.id, true)}
              onCopy={(label, value) => void copyJson(label, value)}
              onCreateRepair={run => void handlePrepareRepair(focusedTask, run)}
              onCancelRepair={job => void handleCancelRepair(job)}
              onRetryRepair={job => void handleRetryRepairTest(job)}
              onOpenRepair={job => void handleOpenRepairTask(job)}
            />}
          </div>
        </div>
        </> : workspaceView === "parameters"
          ? <PageParametersWorkspace devices={snapshot?.devices ?? []} onMessage={setMessage} />
          : workspaceView === "scripts"
            ? <BusinessScriptsWorkspace devices={snapshot?.devices ?? []} onMessage={setMessage} />
            : <AccountProfilesWorkspace devices={snapshot?.devices ?? []} onMessage={setMessage} />}
      </main>
      {deleteCandidate && <DeleteConfirmation task={deleteCandidate} pending={actionPending} onCancel={() => setDeleteCandidate(null)} onConfirm={() => void handleDelete()} />}
      {repairPreview && <RepairPromptConfirmation preview={repairPreview.preview} pending={actionPending} onCancel={() => setRepairPreview(null)} onConfirm={() => void handleConfirmRepair()} />}
    </div>
  );
}

function TaskDetail({
  task,
  tab,
  resultState,
  repairJobs,
  codexRepairEnabled,
  repairPending,
  onTab,
  onReload,
  onCopy,
  onCreateRepair,
  onCancelRepair,
  onRetryRepair,
  onOpenRepair,
}: {
  task: TestTask;
  tab: DetailTab;
  resultState: ResultState;
  repairJobs: RepairJob[];
  codexRepairEnabled: boolean;
  repairPending: boolean;
  onTab: (tab: DetailTab) => void;
  onReload: () => void;
  onCopy: (label: string, value: unknown) => void;
  onCreateRepair: (run: TaskResultRun) => void;
  onCancelRepair: (job: RepairJob) => void;
  onRetryRepair: (job: RepairJob) => void;
  onOpenRepair: (job: RepairJob) => void;
}) {
  const terminal = TERMINAL_STATUSES.has(task.status);
  const tabs: Array<{ id: DetailTab; label: string; icon: React.ReactNode }> = terminal ? [
    { id: "overview", label: "概览", icon: <BarChart3 size={14} /> },
    { id: "screenshots", label: "截图", icon: <ImageIcon size={14} /> },
    { id: "api", label: "接口", icon: <Network size={14} /> },
    { id: "evidence", label: "证据", icon: <Files size={14} /> },
    { id: "logs", label: "日志", icon: <Terminal size={14} /> },
  ] : [
    { id: "logs", label: "日志", icon: <Terminal size={14} /> },
  ];
  return <section className="section-panel detail-panel">
    <div className="section-heading"><div><p className="eyebrow">RUN DETAIL</p><h2>{task.device.name}</h2></div><StatusBadge status={task.status} /></div>
    <div className="detail-meta"><span>{platformLabels[task.device.platform]}</span><span>{task.testLabel}</span><span>{task.phase}</span><span>{formatDuration(task.startedAt, task.finishedAt)}</span></div>
    <div className="detail-tabs" role="tablist" aria-label="运行详情视图">
      {tabs.map(item => <button
        key={item.id}
        type="button"
        role="tab"
        aria-selected={tab === item.id}
        className={tab === item.id ? "active" : ""}
        onClick={() => onTab(item.id)}
      >{item.icon}{item.label}</button>)}
      {terminal && <button type="button" className="detail-refresh" onClick={onReload} title="重新读取分析结果" aria-label="重新读取分析结果"><RefreshCw size={14} /></button>}
    </div>
    {tab === "logs"
      ? <TaskLog task={task} />
      : <ResultPanel
          key={task.id}
          taskId={task.id}
          tab={tab}
          state={resultState}
          repairJobs={repairJobs}
          codexRepairEnabled={codexRepairEnabled}
          repairPending={repairPending}
          onCreateRepair={onCreateRepair}
          onCancelRepair={onCancelRepair}
          onRetryRepair={onRetryRepair}
          onOpenRepair={onOpenRepair}
          onTab={onTab}
          onCopy={onCopy}
        />}
    {task.error && <div className="error-detail"><XCircle size={15} /><span>{task.error}</span></div>}
  </section>;
}

const repairStatusLabels: Record<RepairJob["status"], string> = {
  queued: "排队中",
  investigating: "分析中",
  fixing: "修复中",
  verifying: "复测中",
  fixed: "修复完成",
  waiting_device: "等待设备",
  blocked: "待人工处理",
  failed: "修复失败",
  cancelled: "已取消",
};

export function RepairPanel({
  job,
  pending,
  onCreate,
  onCancel,
  onRetry,
  onOpen,
}: {
  job?: RepairJob;
  pending: boolean;
  onCreate: () => void;
  onCancel?: () => void;
  onRetry?: () => void;
  onOpen?: () => void;
}) {
  if (!job) {
    return <div className="repair-panel repair-panel-empty">
      <div><strong><Bot size={16} /> 页面修复</strong><span>使用失败页面的原设备、账号和参数交给 Codex 定位</span></div>
      <button type="button" className="secondary-button" onClick={onCreate} disabled={pending}><Bot size={14} />交给 Codex 修复</button>
    </div>;
  }
  const active = ["queued", "investigating", "fixing", "verifying", "waiting_device"].includes(job.status);
  const repairRetryable = ["blocked", "failed", "cancelled"].includes(job.status)
    && (job.verificationStatus === "pending" || job.verificationFailureKind === "assertion");
  const testRetryable = job.verificationStatus === "failed";
  return <div className="repair-panel">
    <div className="repair-panel-heading">
      <div><strong><Bot size={16} /> Codex 修复 · {repairStatusLabels[job.status]}</strong><span>第 {job.attempt}/{job.maxAttempts} 轮 · {job.targetPage} · {platformLabels[job.platform]}</span></div>
      <span className={`status-badge status-${job.status === "fixed" ? "passed" : job.status === "failed" ? "failed" : "running"}`}>{repairStatusLabels[job.status]}</span>
    </div>
    <div className="repair-panel-meta"><span>复测：{job.verificationStatus === "passed" ? "通过" : job.verificationStatus === "failed" ? "失败" : "等待"}</span></div>
    {job.error && <p className="repair-panel-error">{job.error}</p>}
    <div className="repair-panel-actions">
      {job.codexThreadId && onOpen && <button type="button" className="secondary-button" onClick={onOpen} disabled={pending}><ExternalLink size={14} />打开修复任务</button>}
      {active && onCancel && <button type="button" className="secondary-button" onClick={onCancel} disabled={pending}>取消修复</button>}
      {repairRetryable && <button type="button" className="primary-button" onClick={onCreate} disabled={pending}><Bot size={14} />重新修复</button>}
      {testRetryable && onRetry && <button type="button" className="primary-button" onClick={onRetry} disabled={pending}><RotateCcw size={14} />重新复测</button>}
    </div>
  </div>;
}

function TaskLog({ task }: { task: TestTask }) {
  return <div className="log-window" role="log" aria-label={`${task.device.name} 测试日志`}>
    <div className="log-toolbar"><span><Terminal size={14} /> 最近日志</span><span>{task.logs.length} 行</span></div>
    {task.logs.length > 0 ? <pre>{task.logs.join("\n")}</pre> : <div className="log-empty">等待测试输出</div>}
  </div>;
}

export function ResultPanel({
  taskId,
  tab,
  state,
  onTab,
  onCopy,
  repairJobs = [],
  codexRepairEnabled = false,
  repairPending = false,
  onCreateRepair,
  onCancelRepair,
  onRetryRepair,
  onOpenRepair,
  initialSelectedRunKey = "",
}: {
  taskId: string;
  tab: Exclude<DetailTab, "logs">;
  state: ResultState;
  onTab?: (tab: DetailTab) => void;
  onCopy: (label: string, value: unknown) => void;
  repairJobs?: RepairJob[];
  codexRepairEnabled?: boolean;
  repairPending?: boolean;
  onCreateRepair?: (run: TaskResultRun) => void;
  onCancelRepair?: (job: RepairJob) => void;
  onRetryRepair?: (job: RepairJob) => void;
  onOpenRepair?: (job: RepairJob) => void;
  initialSelectedRunKey?: string;
}) {
  const [selectedRunKey, setSelectedRunKey] = useState(initialSelectedRunKey);
  useEffect(() => setSelectedRunKey(""), [taskId]);
  if (state.loading) return <EmptyState icon={<LoaderCircle className="spin" size={20} />} text="正在分析测试结果" />;
  if (state.error) return <div className="result-empty"><AlertCircle size={18} /><strong>分析结果暂不可用</strong><span>{state.error}</span></div>;
  const result = state.result;
  if (!result || result.runs.length === 0) {
    return <div className="result-empty"><Files size={18} /><strong>暂无分析结果</strong><span>{result?.warnings[0] || "当前运行没有生成可分析的 QA 产物"}</span></div>;
  }
  const selectedRun = result.runs.find(run => taskResultRunKey(run) === selectedRunKey);
  const scopedRuns = selectedRun ? [selectedRun] : result.runs;
  const clearSelection = () => setSelectedRunKey("");
  if (tab === "screenshots") return <>
    {selectedRun && <ResultScope run={selectedRun} onClear={clearSelection} />}
    <ScreenshotResult taskId={taskId} runs={scopedRuns} />
  </>;
  if (tab === "api") return <>
    {selectedRun && <ResultScope run={selectedRun} onClear={clearSelection} />}
    <ApiResult runs={scopedRuns} onCopy={onCopy} />
  </>;
  if (tab === "evidence") return <>
    {selectedRun && <ResultScope run={selectedRun} onClear={clearSelection} />}
    <EvidenceResult runs={scopedRuns} />
  </>;
  return <OverviewResult
    result={result}
    selectedRunKey={selectedRunKey}
    onSelectRun={setSelectedRunKey}
    onTab={onTab}
    onCopy={onCopy}
    repairJobs={repairJobs}
    codexRepairEnabled={codexRepairEnabled}
    repairPending={repairPending}
    onCreateRepair={onCreateRepair}
    onCancelRepair={onCancelRepair}
    onRetryRepair={onRetryRepair}
    onOpenRepair={onOpenRepair}
  />;
}

function OverviewResult({
  result,
  selectedRunKey,
  onSelectRun,
  onTab,
  onCopy,
  repairJobs,
  codexRepairEnabled,
  repairPending,
  onCreateRepair,
  onCancelRepair,
  onRetryRepair,
  onOpenRepair,
}: {
  result: TaskResult;
  selectedRunKey: string;
  onSelectRun: (runKey: string) => void;
  onTab?: (tab: DetailTab) => void;
  onCopy: (label: string, value: unknown) => void;
  repairJobs: RepairJob[];
  codexRepairEnabled: boolean;
  repairPending: boolean;
  onCreateRepair?: (run: TaskResultRun) => void;
  onCancelRepair?: (job: RepairJob) => void;
  onRetryRepair?: (job: RepairJob) => void;
  onOpenRepair?: (job: RepairJob) => void;
}) {
  const screenshots = result.runs.reduce((total, run) => total + run.screenshots.length, 0);
  const apiCalls = result.runs.reduce((total, run) => total + run.apiCalls.length, 0);
  return <div className="analysis-content">
    <div className="analysis-summary">
      <AnalysisMetric label="用例" value={result.total} />
      <AnalysisMetric label="通过" value={result.passed} tone="passed" />
      <AnalysisMetric label="失败" value={result.failed} tone="failed" />
      <AnalysisMetric label="截图" value={screenshots} />
      <AnalysisMetric label="接口" value={apiCalls} />
    </div>
    {(result.preconditions?.length ?? 0) > 0 && <div className="result-preconditions">
      {result.preconditions!.map(item => <div className={`result-precondition ${item.status}`} key={item.id}>
        {item.status === "passed" ? <CheckCircle2 size={15} /> : <XCircle size={15} />}
        <span><strong>{item.label}</strong><small>{item.detail}</small></span>
        <code>{item.action === "reused-session" ? "复用登录态" : item.action === "account-profile-replay" ? `账号画像 ${item.profileId || ""}` : "前置失败"}</code>
      </div>)}
    </div>}
    {result.warnings.length > 0 && <div className="result-warning"><AlertCircle size={14} /><span>{result.warnings.join("；")}</span></div>}
    <div className="analysis-run-list">
      {result.runs.map(run => {
        const runKey = taskResultRunKey(run);
        const selected = runKey === selectedRunKey;
        return <div className={`analysis-run-entry ${selected ? "selected" : ""}`} key={runKey}>
          <button
            type="button"
            className="analysis-run-row"
            aria-expanded={selected}
            aria-label={`查看 ${run.caseId || run.targetPage || run.runId} ${run.status === "passed" ? "通过" : "失败"}详情`}
            onClick={() => onSelectRun(selected ? "" : runKey)}
          >
            <span className={`analysis-status ${run.status}`}>{run.status === "passed" ? "通过" : "失败"}</span>
            <span><strong>{run.caseId || run.targetPage || run.runId}</strong><small>{run.executionKind || "scenario"} · {run.launchPage || "?"} → {run.actualFinalPage || "?"} / {run.expectedFinalPage || run.targetPage || "?"}</small></span>
            <span><strong>{run.platform || "-"}</strong><small>{run.device || "未记录设备"}</small></span>
            <span><strong>{run.apiCalls.length} 接口</strong><small>{run.screenshots.length} 截图 · {run.uiActionCount} 动作</small></span>
            <span className="analysis-result-text">{run.errorSummary || (run.missingEvents.length ? `缺少 ${run.missingEvents.join("、")}` : run.passBasis?.map(item => item.description).join("；") || "证据采集完成")}</span>
            <ChevronRight className="analysis-run-chevron" size={16} />
          </button>
          {selected && <RunDiagnosticDetail
            run={run}
            repairJob={repairJobs.find(job => job.caseRunId === run.caseRunId)}
            codexRepairEnabled={codexRepairEnabled}
            repairPending={repairPending}
            onCreateRepair={onCreateRepair}
            onCancelRepair={onCancelRepair}
            onRetryRepair={onRetryRepair}
            onOpenRepair={onOpenRepair}
            onTab={onTab}
            onCopy={onCopy}
          />}
        </div>;
      })}
    </div>
  </div>;
}

function RunDiagnosticDetail({
  run,
  onTab,
  onCopy,
}: {
  run: TaskResultRun;
  repairJob?: RepairJob;
  codexRepairEnabled: boolean;
  repairPending: boolean;
  onCreateRepair?: (run: TaskResultRun) => void;
  onCancelRepair?: (job: RepairJob) => void;
  onRetryRepair?: (job: RepairJob) => void;
  onOpenRepair?: (job: RepairJob) => void;
  onTab?: (tab: DetailTab) => void;
  onCopy: (label: string, value: unknown) => void;
}) {
  const diagnostics = diagnoseTaskResultRun(run);
  const failedApis = run.apiCalls.filter(isFailedApiCall);
  const failedInteractions = [
    ...(run.passBasis || [])
      .filter(item => !item.passed && /action|assert|动作|断言|交互/i.test(`${item.kind} ${item.description}`))
      .map(item => item.description),
    ...(run.assertions || [])
      .filter(item => item.passed === false || item.status === "failed")
      .map(item => String(item.description || [item.type, item.event, item.target, item.expected].filter(Boolean).join(" · ") || item.evidence || "断言失败")),
  ];
  const routeParams = run.routeParams || {};
  const routeParamsRecorded = run.routeParams !== undefined;
  const diagnosticContext = {
    caseId: run.caseId,
    runId: run.runId,
    status: run.status,
    errorSummary: run.errorSummary,
    failureLogExcerpt: run.failureLogExcerpt,
    launchPage: run.launchPage,
    targetPage: run.targetPage,
    actualFinalPage: run.actualFinalPage,
    routeParams,
    missingEvents: run.missingEvents,
    failedApis,
    failedInteractions,
    screenshots: run.screenshots,
  };
  return <section className="run-diagnostic" aria-label={`${run.caseId || run.runId} 测试详情`}>
    <div className="run-diagnostic-heading">
      <div><strong>用例诊断</strong><span>{run.errorSummary || (run.status === "passed" ? "测试通过" : "请依据下方证据定位失败环节")}</span></div>
      <div className="run-diagnostic-tags">{diagnostics.map(item => <span className={item.tone} key={item.label}>{item.label}</span>)}</div>
    </div>
    <div className="run-diagnostic-grid">
      <section>
        <span className="run-diagnostic-label">页面打开</span>
        <strong>{run.launchPage || "未记录"} → {run.actualFinalPage || "未识别"}</strong>
        <small>期望页面：{run.expectedFinalPage || run.targetPage || "未记录"}</small>
        <small className={run.missingEvents.length ? "failed" : ""}>{run.missingEvents.length ? `缺失事件：${run.missingEvents.join("、")}` : "页面事件完整"}</small>
      </section>
      <section>
        <span className="run-diagnostic-label">页面参数</span>
        <strong>{run.parameterProfileId ? `画像 ${run.parameterProfileId}` : routeParamsRecorded ? "直接参数" : "历史结果未记录"}</strong>
        <small>{routeParamsRecorded ? `${Object.keys(routeParams).length} 个路由参数` : "下次测试会记录实际传入值"}</small>
        {routeParamsRecorded && <>
          <pre>{formatJson(routeParams)}</pre>
          <button type="button" className="diagnostic-copy" onClick={() => onCopy("页面参数", routeParams)}><Copy size={12} />复制参数</button>
        </>}
      </section>
      <section>
        <span className="run-diagnostic-label">接口</span>
        <strong>{run.apiCalls.length} 个调用 · {failedApis.length} 个失败</strong>
        {failedApis.length > 0
          ? <div className="diagnostic-lines">{failedApis.slice(0, 5).map((call, index) => <small className="failed" key={`${call.index}:${index}`}>{apiCallName(call)} · {String(call.status || call.result || "失败")}</small>)}</div>
          : <small>已采集接口中无失败记录</small>}
      </section>
      <section>
        <span className="run-diagnostic-label">动作与断言</span>
        <strong>{run.uiActionCount} 个动作 · {run.assertions?.length || 0} 条断言</strong>
        {failedInteractions.length > 0
          ? <div className="diagnostic-lines">{failedInteractions.map((item, index) => <small className="failed" key={`${item}:${index}`}>{item}</small>)}</div>
          : <small>未记录动作或断言失败证据</small>}
      </section>
    </div>
    {run.failureLogExcerpt && <pre className="run-diagnostic-log">{run.failureLogExcerpt}</pre>}
    <div className="run-diagnostic-actions">
      {run.status === "failed" && <button type="button" className="secondary-button" onClick={() => onCopy("错误信息", diagnosticContext)}><Copy size={13} />复制错误</button>}
      <button type="button" className="secondary-button" onClick={() => onTab?.("api")}><Network size={13} />查看接口</button>
      <button type="button" className="secondary-button" onClick={() => onTab?.("evidence")}><Files size={13} />查看证据</button>
      {run.screenshots.length > 0 && <button type="button" className="secondary-button" onClick={() => onTab?.("screenshots")}><ImageIcon size={13} />查看截图</button>}
    </div>
  </section>;
}

function ResultScope({ run, onClear }: { run: TaskResultRun; onClear: () => void }) {
  return <div className="result-scope"><span>当前用例：<strong>{run.caseId || run.targetPage || run.runId}</strong></span><button type="button" onClick={onClear}><List size={13} />查看全部用例</button></div>;
}

function AnalysisMetric({ label, value, tone = "" }: { label: string; value: number; tone?: string }) {
  return <div className={`analysis-metric ${tone}`}><span>{label}</span><strong>{value}</strong></div>;
}

function ScreenshotResult({ taskId, runs }: { taskId: string; runs: TaskResultRun[] }) {
  const screenshots = runs.flatMap(run => run.screenshots.map(artifact => ({ artifact, run })));
  if (screenshots.length === 0) return <div className="result-empty"><ImageIcon size={18} /><strong>没有截图</strong><span>当前运行未生成 PNG、JPEG 或 WebP 图片</span></div>;
  return <div className="screenshot-gallery">
    {screenshots.map(({ artifact, run }) => <a
      key={`${run.runId}:${artifact.id}`}
      className="screenshot-item"
      href={taskArtifactUrl(taskId, artifact.id)}
      target="_blank"
      rel="noreferrer"
    >
      <img src={taskArtifactUrl(taskId, artifact.id)} alt={`${run.caseId} ${artifact.label}`} loading="lazy" />
      <span><strong>{artifact.label}</strong><small>{run.caseId || run.targetPage || run.runId}</small></span>
    </a>)}
  </div>;
}

function ApiResult({ runs, onCopy }: { runs: TaskResultRun[]; onCopy: (label: string, value: unknown) => void }) {
  const calls = runs.flatMap(run => run.apiCalls.map(call => ({ call, run })));
  if (calls.length === 0) return <div className="result-empty"><Network size={18} /><strong>没有接口记录</strong><span>当前运行未采集到 API runtime event</span></div>;
  return <div className="api-result-list">
    {calls.map(({ call, run }, index) => <ApiCallItem key={`${run.runId}:${call.index}:${index}`} call={call} run={run} onCopy={onCopy} />)}
  </div>;
}

function ApiCallItem({ call, run, onCopy }: { call: TaskResultApiCall; run: TaskResultRun; onCopy: (label: string, value: unknown) => void }) {
  const url = call.url === "undefinedundefined" ? "" : call.url;
  const name = call.operationName || call.path || call.endpoint || url || "未命名接口";
  return <details className="api-call-item">
    <summary>
      <span className="api-method">{call.method || "API"}</span>
      <span className="api-name"><strong>{name}</strong><small>{url || call.host || run.caseId}</small></span>
      <span className={`api-outcome ${call.result === "success" ? "success" : "failed"}`}>{String(call.status || call.result || "-")}</span>
      <span className="api-duration">{call.durationMs == null ? "-" : `${call.durationMs}ms`}</span>
    </summary>
    <div className="api-context"><span>{run.caseId || run.runId}</span><span>{call.page || run.targetPage || "-"}</span><span>{[call.network.dnsType, call.network.connectIp, call.network.protocol].filter(Boolean).join(" · ") || "未记录网络详情"}</span></div>
    <div className="json-grid">
      <JsonBlock label="请求参数" value={call.request} onCopy={() => onCopy("请求参数", call.request)} />
      <JsonBlock label="响应结果" value={call.response} onCopy={() => onCopy("响应结果", call.response)} />
    </div>
  </details>;
}

function JsonBlock({ label, value, onCopy }: { label: string; value: unknown; onCopy: () => void }) {
  return <div className="json-block">
    <div className="json-heading"><span>{label}</span><button type="button" onClick={onCopy} title={`复制${label}`} aria-label={`复制${label}`}><Copy size={13} /></button></div>
    <pre>{formatJson(value)}</pre>
  </div>;
}

function EvidenceResult({ runs }: { runs: TaskResultRun[] }) {
  return <div className="evidence-result-list">
    {runs.map(run => <section className="evidence-run" key={`${run.runId}:${run.caseId}`}>
      <div className="evidence-heading"><strong>{run.caseId || run.runId}</strong><span>{run.runtimeEventCount} 事件 · {run.uiActionCount} 动作 · {run.evidenceFiles.length} 文件</span></div>
      {run.requiredEvents.length > 0 && <div className="evidence-line"><span>要求事件</span><code>{run.requiredEvents.join(" · ")}</code></div>}
      {run.missingEvents.length > 0 && <div className="evidence-line missing"><span>缺失事件</span><code>{run.missingEvents.join(" · ")}</code></div>}
      {(run.pageSequence?.length ?? 0) > 0 && <div className="evidence-line"><span>页面序列</span><code>{run.pageSequence!.map(item => item.page).join(" → ")}</code></div>}
      {(run.passBasis?.length ?? 0) > 0 && run.passBasis!.map((item, index) => <div className={`evidence-line ${item.passed ? "" : "missing"}`} key={`${item.kind}:${index}`}><span>{item.passed ? "通过依据" : "失败依据"}</span><code>{item.description}</code></div>)}
      {run.evidenceFiles.length > 0 && <div className="evidence-files">{run.evidenceFiles.map(file => <span key={file}>{file}</span>)}</div>}
      {run.failureLogExcerpt && <pre className="evidence-log">{run.failureLogExcerpt}</pre>}
    </section>)}
  </div>;
}

function apiCallName(call: TaskResultApiCall): string {
  return call.operationName || call.path || call.endpoint || call.url || "未命名接口";
}

function formatJson(value: unknown): string {
  try {
    return JSON.stringify(value ?? {}, null, 2);
  } catch {
    return String(value ?? "");
  }
}

function Metric({ label, value, tone, icon }: { label: string; value: number; tone: string; icon: React.ReactNode }) {
  return <div className={`metric metric-${tone}`}><div className="metric-icon">{icon}</div><div><span>{label}</span><strong>{value}</strong></div></div>;
}

function EmptyState({ icon, text }: { icon: React.ReactNode; text: string }) {
  return <div className="empty-state">{icon}<span>{text}</span></div>;
}

export function DeviceRow({ device, task, selected, onToggle, starting, onStart, preparing = false, onInstallPreparation = () => undefined }: { device: Device; task?: TestTask; selected: boolean; onToggle: () => void; starting: boolean; onStart: () => void; preparing?: boolean; onInstallPreparation?: (preparationId: string) => void }) {
  const busy = Boolean(task && ACTIVE_STATUSES.has(task.status));
  const missingPreparation = device.preparations?.find(item => item.status !== "ready");
  const blockingPreparation = device.preparations?.find(item => item.blocksTests && item.status !== "ready");
  const selectable = device.controlState === "ready" && device.connectionState === "available" && !busy && !blockingPreparation;
  const startable = device.controlState === "startable";
  const availabilityLabel = device.type === "physical"
    ? connectionLabels[device.connectionState]
    : device.controlReason || device.detail || connectionLabels[device.connectionState];
  return <div className={`device-row ${selected ? "selected" : ""} ${selectable ? "" : "disabled"}`}>
    <input type="checkbox" checked={selected} onChange={onToggle} disabled={!selectable} aria-label={`选择 ${device.name}`} />
    <span className={`device-status-dot ${device.connectionState}`} />
    <span className="device-main"><strong>{device.name}</strong><span>{platformLabels[device.platform]} · {device.type === "physical" ? "真机" : "模拟器"}</span></span>
    <span className="device-side">
      {missingPreparation?.installable
        ? <button className="device-prepare-button" type="button" onClick={() => onInstallPreparation(missingPreparation.id)} disabled={preparing} title={missingPreparation.detail}>
          {preparing ? <LoaderCircle className="spin" size={13} /> : <Download size={13} />}
          {preparing ? "安装中" : "安装驱动"}
        </button>
        : startable
        ? <button className="device-start-button" type="button" onClick={onStart} disabled={starting}>
          {starting ? <LoaderCircle className="spin" size={13} /> : <Power size={13} />}
          {starting ? "启动中" : "启动"}
        </button>
        : <span className={`connection-label ${device.connectionState}`}>{busy ? "测试中" : missingPreparation?.detail || availabilityLabel}</span>}
      <small>{missingPreparation?.label || device.osVersion || device.id.slice(0, 12)}</small>
    </span>
  </div>;
}

export function RunRow({ task, focused, onFocus, onStop, onDelete, pending }: { task: TestTask; focused: boolean; onFocus: () => void; onStop: () => void; onDelete: () => void; pending: boolean }) {
  const active = ACTIVE_STATUSES.has(task.status);
  const deletable = TERMINAL_STATUSES.has(task.status);
  return <div className={`run-row ${focused ? "focused" : ""}`}>
    <button className="run-row-select" type="button" onClick={onFocus} aria-label={`查看 ${task.device.name} ${task.testLabel} 详情`}>
      <span className="run-row-status"><StatusIcon status={task.status} /><StatusBadge status={task.status} /></span>
      <span className="run-row-main"><strong>{task.device.name}</strong><span>{task.testLabel} · {task.phase}</span></span>
      <span className="run-row-time">{formatDuration(task.startedAt, task.finishedAt)}</span>
    </button>
    {active && <span className="run-row-action"><button type="button" className="stop-button" onClick={onStop} disabled={pending} title="停止此设备测试" aria-label={`停止 ${task.device.name} 测试`}><Square size={14} fill="currentColor" />停止</button></span>}
    {deletable && <span className="run-row-action"><button type="button" className="delete-button" onClick={onDelete} disabled={pending} title="删除此运行记录" aria-label={`删除 ${task.device.name} 的运行记录`}><Trash2 size={15} /></button></span>}
  </div>;
}

// 测试复用该状态归并函数，覆盖删除详情焦点后的轮询行为。
// eslint-disable-next-line react-refresh/only-export-components
export function reconcileFocusedTaskId(previous: string | null, tasks: TestTask[]): string {
  if (previous === null) {
    return tasks.find(task => ACTIVE_STATUSES.has(task.status))?.id || tasks[0]?.id || "";
  }
  return previous && tasks.some(task => task.id === previous) ? previous : "";
}

// 删除请求成功后立即关闭对应详情，后续快照刷新失败时也不会保留失效记录。
// eslint-disable-next-line react-refresh/only-export-components
export function clearDeletedFocusedTaskId(previous: string | null, deletedTaskId: string): string | null {
  return previous === deletedTaskId ? "" : previous;
}

// 已确认删除的记录立即从页面移除，并拦截并发轮询返回的旧快照。
// eslint-disable-next-line react-refresh/only-export-components
export function excludeDeletedTasks(snapshot: ConsoleSnapshot, deletedTaskIds: ReadonlySet<string>): ConsoleSnapshot {
  const tasks = snapshot.tasks.filter(task => !deletedTaskIds.has(task.id));
  return tasks.length === snapshot.tasks.length ? snapshot : { ...snapshot, tasks };
}

export function DeleteConfirmation({ task, pending, onCancel, onConfirm }: { task: Pick<TestTask, "testLabel" | "device">; pending: boolean; onCancel: () => void; onConfirm: () => void }) {
  return <div className="confirm-overlay">
    <section className="confirm-dialog" role="dialog" aria-modal="true" aria-labelledby="delete-confirm-title">
      <div className="confirm-icon"><Trash2 size={20} /></div>
      <div className="confirm-copy">
        <h2 id="delete-confirm-title">删除运行记录</h2>
        <p>将删除 {task.device.name} 的 {task.testLabel} 记录及本地测试文件。此操作无法撤销。</p>
      </div>
      <div className="confirm-actions">
        <button type="button" className="secondary-button" onClick={onCancel} disabled={pending}>取消</button>
        <button type="button" className="danger-button" onClick={onConfirm} disabled={pending}><Trash2 size={15} />删除</button>
      </div>
    </section>
  </div>;
}

export function RepairPromptConfirmation({
  preview,
  pending,
  onCancel,
  onConfirm,
}: {
  preview: RepairJobPreview;
  pending: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return <div className="confirm-overlay">
    <section className="confirm-dialog repair-confirm-dialog" role="dialog" aria-modal="true" aria-labelledby="repair-confirm-title">
      <div className="confirm-icon repair-confirm-icon"><Bot size={20} /></div>
      <div className="confirm-copy">
        <h2 id="repair-confirm-title">确认创建 Codex 修复任务</h2>
        <p>以下诊断内容将传递给 Codex。确认后会分配隔离工作目录并替换正文中的占位说明。</p>
      </div>
      <div className="repair-preview-meta">
        <span><strong>页面</strong>{preview.launchPage || "未记录"} → {preview.targetPage}</span>
        <span><strong>平台</strong>{preview.platform.toUpperCase()} · {preview.device.name}</span>
        <span><strong>参数</strong><code>{formatJson(preview.parameters)}</code></span>
      </div>
      <pre className="repair-preview-prompt">{preview.prompt}</pre>
      <div className="confirm-actions">
        <button type="button" className="secondary-button" onClick={onCancel} disabled={pending}>取消</button>
        <button type="button" className="primary-button" onClick={onConfirm} disabled={pending}><Bot size={15} />确认并创建</button>
      </div>
    </section>
  </div>;
}

function StatusBadge({ status }: { status: TaskStatus }) {
  return <span className={`status-badge status-${status}`}>{statusLabels[status]}</span>;
}

function StatusIcon({ status }: { status: TaskStatus }) {
  if (status === "passed") return <CheckCircle2 size={17} />;
  if (["failed", "interrupted"].includes(status)) return <XCircle size={17} />;
  if (status === "cancelled") return <Square size={15} />;
  return <LoaderCircle size={17} className="spin" />;
}

function formatDuration(start: string, finish: string): string {
  if (!start) return "等待";
  const startTime = Date.parse(start);
  const endTime = finish ? Date.parse(finish) : Date.now();
  if (!Number.isFinite(startTime) || !Number.isFinite(endTime)) return "-";
  const seconds = Math.max(0, Math.floor((endTime - startTime) / 1_000));
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}
