import {
  Activity,
  AlertCircle,
  CheckCircle2,
  CircleDot,
  Clock3,
  Copy,
  LoaderCircle,
  MonitorSmartphone,
  Play,
  RefreshCw,
  Smartphone,
  Square,
  Terminal,
  XCircle,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import type {
  ConsoleSnapshot,
  Device,
  DeviceConnectionState,
  Platform,
  TaskStatus,
  TestTask,
} from "../shared/contracts";
import { ACTIVE_TASK_STATUSES } from "../shared/contracts";
import { ApiError, fetchSnapshot, startTasks, stopTask } from "./api";

const ACTIVE_STATUSES = new Set(ACTIVE_TASK_STATUSES);

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

export default function App() {
  const [snapshot, setSnapshot] = useState<ConsoleSnapshot | null>(null);
  const [selectedKeys, setSelectedKeys] = useState<string[]>([]);
  const [selectedTestId, setSelectedTestId] = useState("");
  const [parameters, setParameters] = useState<Record<string, string>>({});
  const [focusedTaskId, setFocusedTaskId] = useState("");
  const [platformFilter, setPlatformFilter] = useState<"all" | Platform>("all");
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [actionPending, setActionPending] = useState(false);
  const [message, setMessage] = useState<{ kind: "error" | "info"; text: string } | null>(null);

  const load = useCallback(async (showSpinner = false) => {
    if (showSpinner) setRefreshing(true);
    try {
      const next = await fetchSnapshot();
      setSnapshot(next);
      setSelectedKeys(previous => previous.filter(key => next.devices.some(device => device.key === key && device.connectionState === "available")));
      setFocusedTaskId(previous => previous || next.tasks.find(task => ACTIVE_STATUSES.has(task.status))?.id || next.tasks[0]?.id || "");
      setMessage(null);
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
  const focusedTask = tasks.find(task => task.id === focusedTaskId) || tasks[0];

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
    if (device.connectionState !== "available" || taskByDevice.get(device.key) && ACTIVE_STATUSES.has(taskByDevice.get(device.key)!.status)) return;
    setSelectedKeys(previous => previous.includes(device.key)
      ? previous.filter(key => key !== device.key)
      : [...previous, device.key]);
  };

  const handleStart = async () => {
    if (!selectedTest || selectedKeys.length === 0) {
      setMessage({ kind: "error", text: "请选择测试和至少一台设备" });
      return;
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
        <button className="icon-button" type="button" onClick={() => void load(true)} disabled={refreshing} title="刷新设备和运行状态" aria-label="刷新设备和运行状态">
          <RefreshCw size={17} className={refreshing ? "spin" : ""} />
        </button>
      </header>

      <main className="content">
        <section className="metrics-strip" aria-label="运行概览">
          <Metric label="可用设备" value={connectedDevices.length} tone="teal" icon={<MonitorSmartphone size={17} />} />
          <Metric label="测试中" value={activeCount} tone="blue" icon={<LoaderCircle size={17} />} />
          <Metric label="最近通过" value={passedCount} tone="green" icon={<CheckCircle2 size={17} />} />
          <Metric label="需要关注" value={failedCount} tone="red" icon={<AlertCircle size={17} />} />
        </section>

        {message && <div className={`notice ${message.kind}`} role="status"><AlertCircle size={16} /> <span>{message.text}</span><button type="button" onClick={() => setMessage(null)} aria-label="关闭提示">×</button></div>}

        <div className="workspace-grid">
          <aside className="devices-column section-panel">
            <div className="section-heading">
              <div><p className="eyebrow">DEVICE POOL</p><h2>连接设备</h2></div>
              <span className="count-label">{visibleDevices.length} 台</span>
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
                {selectedTest?.parameters.map(parameter => <label className="field" key={parameter.id}><span>{parameter.label}</span><select value={parameters[parameter.id] || parameter.defaultValue} onChange={event => setParameters(previous => ({ ...previous, [parameter.id]: event.target.value }))}>{parameter.options.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}</select></label>)}
              </div>
              <div className="test-actions"><span className="action-hint"><Copy size={14} /> 每台设备独立记录运行结果</span><button className="primary-button" type="button" onClick={() => void handleStart()} disabled={actionPending || selectedKeys.length === 0 || !selectedTest}><Play size={16} fill="currentColor" />启动测试</button></div>
            </section>

            <section className="section-panel runs-panel">
              <div className="section-heading"><div><p className="eyebrow">RUN MONITOR</p><h2>运行状态</h2></div><span className="count-label">{tasks.length} 条记录</span></div>
              {tasks.length === 0 ? <EmptyState icon={<Clock3 size={21} />} text="还没有运行记录" /> : <div className="run-list">{tasks.map(task => <RunRow key={task.id} task={task} focused={task.id === focusedTask?.id} onFocus={() => setFocusedTaskId(task.id)} onStop={() => void handleStop(task)} pending={actionPending} />)}</div>}
            </section>

            {focusedTask && <section className="section-panel detail-panel">
              <div className="section-heading"><div><p className="eyebrow">RUN DETAIL</p><h2>{focusedTask.device.name}</h2></div><StatusBadge status={focusedTask.status} /></div>
              <div className="detail-meta"><span>{platformLabels[focusedTask.device.platform]}</span><span>{focusedTask.testLabel}</span><span>{focusedTask.phase}</span><span>{formatDuration(focusedTask.startedAt, focusedTask.finishedAt)}</span></div>
              <div className="log-window" role="log" aria-label={`${focusedTask.device.name} 测试日志`}><div className="log-toolbar"><span><Terminal size={14} /> 最近日志</span><span>{focusedTask.logs.length} 行</span></div>{focusedTask.logs.length > 0 ? <pre>{focusedTask.logs.join("\n")}</pre> : <div className="log-empty">等待测试输出</div>}</div>
              {focusedTask.error && <div className="error-detail"><XCircle size={15} /><span>{focusedTask.error}</span></div>}
            </section>}
          </div>
        </div>
      </main>
    </div>
  );
}

function Metric({ label, value, tone, icon }: { label: string; value: number; tone: string; icon: React.ReactNode }) {
  return <div className={`metric metric-${tone}`}><div className="metric-icon">{icon}</div><div><span>{label}</span><strong>{value}</strong></div></div>;
}

function EmptyState({ icon, text }: { icon: React.ReactNode; text: string }) {
  return <div className="empty-state">{icon}<span>{text}</span></div>;
}

function DeviceRow({ device, task, selected, onToggle }: { device: Device; task?: TestTask; selected: boolean; onToggle: () => void }) {
  const busy = Boolean(task && ACTIVE_STATUSES.has(task.status));
  const availabilityLabel = device.type === "physical"
    ? connectionLabels[device.connectionState]
    : device.detail || connectionLabels[device.connectionState];
  return <label className={`device-row ${selected ? "selected" : ""} ${device.connectionState !== "available" ? "disabled" : ""}`}>
    <input type="checkbox" checked={selected} onChange={onToggle} disabled={device.connectionState !== "available" || busy} />
    <span className={`device-status-dot ${device.connectionState}`} />
    <span className="device-main"><strong>{device.name}</strong><span>{platformLabels[device.platform]} · {device.type === "physical" ? "真机" : "模拟器"}</span></span>
    <span className="device-side"><span className={`connection-label ${device.connectionState}`}>{busy ? "测试中" : availabilityLabel}</span><small>{device.osVersion || device.id.slice(0, 12)}</small></span>
  </label>;
}

function RunRow({ task, focused, onFocus, onStop, pending }: { task: TestTask; focused: boolean; onFocus: () => void; onStop: () => void; pending: boolean }) {
  const active = ACTIVE_STATUSES.has(task.status);
  return <div className={`run-row ${focused ? "focused" : ""}`}>
    <button className="run-row-select" type="button" onClick={onFocus} aria-label={`查看 ${task.device.name} ${task.testLabel} 详情`}>
      <span className="run-row-status"><StatusIcon status={task.status} /><StatusBadge status={task.status} /></span>
      <span className="run-row-main"><strong>{task.device.name}</strong><span>{task.testLabel} · {task.phase}</span></span>
      <span className="run-row-time">{formatDuration(task.startedAt, task.finishedAt)}</span>
    </button>
    {active && <span className="run-row-action"><button type="button" className="stop-button" onClick={onStop} disabled={pending} title="停止此设备测试" aria-label={`停止 ${task.device.name} 测试`}><Square size={14} fill="currentColor" />停止</button></span>}
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
