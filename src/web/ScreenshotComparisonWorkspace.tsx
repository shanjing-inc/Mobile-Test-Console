import { AlertCircle, Columns2, ImageIcon, LoaderCircle, SplitSquareHorizontal } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import type {
  ProjectCatalogResponse,
  ScreenshotComparison,
  ScreenshotComparisonCandidate,
  ScreenshotComparisonPair,
  ScreenshotComparisonRef,
  ScreenshotComparisonSide,
} from "../shared/contracts";
import { ApiError, createScreenshotComparison, fetchScreenshotComparisonCandidates } from "./api";

const STORAGE_KEY = "mtc.screenshot-comparison.v1";
const PRESENCE_LABELS = {
  both: "两侧都有",
  "left-only": "仅左侧存在",
  "right-only": "仅右侧存在",
} as const;

type CompareMode = "side-by-side" | "slider";

interface StoredComparisonSelection {
  left: ScreenshotComparisonRef | null;
  right: ScreenshotComparisonRef | null;
}

export function ScreenshotComparisonWorkspace({
  catalog,
  currentProjectId,
  initialLeft = null,
  initialRight = null,
  onMessage,
}: {
  catalog: ProjectCatalogResponse | null;
  currentProjectId: string;
  initialLeft?: ScreenshotComparisonRef | null;
  initialRight?: ScreenshotComparisonRef | null;
  onMessage: (message: { kind: "error" | "info"; text: string }) => void;
}) {
  const stored = useMemo(() => readStoredSelection(), []);
  const projects = catalog?.projects ?? [];
  const [leftProjectId, setLeftProjectId] = useState(initialLeft?.projectId || stored.left?.projectId || currentProjectId || projects[0]?.id || "");
  const [rightProjectId, setRightProjectId] = useState(initialRight?.projectId || stored.right?.projectId || currentProjectId || projects[0]?.id || "");
  const [leftTaskId, setLeftTaskId] = useState(initialLeft?.taskId || stored.left?.taskId || "");
  const [rightTaskId, setRightTaskId] = useState(initialRight?.taskId || stored.right?.taskId || "");
  const [leftCandidates, setLeftCandidates] = useState<ScreenshotComparisonCandidate[]>([]);
  const [rightCandidates, setRightCandidates] = useState<ScreenshotComparisonCandidate[]>([]);
  const [loadingLeft, setLoadingLeft] = useState(false);
  const [loadingRight, setLoadingRight] = useState(false);
  const [pending, setPending] = useState(false);
  const [comparison, setComparison] = useState<ScreenshotComparison | null>(null);
  const [selectedKey, setSelectedKey] = useState("");
  const [mode, setMode] = useState<CompareMode>("side-by-side");
  const [missingOnly, setMissingOnly] = useState(false);
  const [slider, setSlider] = useState(50);

  useEffect(() => {
    if (initialLeft) {
      setLeftProjectId(initialLeft.projectId);
      setLeftTaskId(initialLeft.taskId);
    }
    if (initialRight) {
      setRightProjectId(initialRight.projectId);
      setRightTaskId(initialRight.taskId);
    }
  }, [initialLeft, initialRight]);

  const loadCandidates = useCallback(async (projectId: string, side: "left" | "right") => {
    if (!projectId) return;
    const setLoading = side === "left" ? setLoadingLeft : setLoadingRight;
    const setCandidates = side === "left" ? setLeftCandidates : setRightCandidates;
    setLoading(true);
    try {
      const response = await fetchScreenshotComparisonCandidates(projectId);
      setCandidates(response.candidates);
    } catch (error) {
      setCandidates([]);
      onMessage({ kind: "error", text: error instanceof ApiError ? error.message : "无法读取历史结果" });
    } finally {
      setLoading(false);
    }
  }, [onMessage]);

  useEffect(() => { void loadCandidates(leftProjectId, "left"); }, [leftProjectId, loadCandidates]);
  useEffect(() => { void loadCandidates(rightProjectId, "right"); }, [rightProjectId, loadCandidates]);

  const visiblePairs = useMemo(() => {
    const pairs = comparison?.pairs ?? [];
    return missingOnly ? pairs.filter(pair => pair.presence !== "both") : pairs;
  }, [comparison, missingOnly]);

  const selectedPair = visiblePairs.find(pair => pair.key === selectedKey) ?? visiblePairs[0] ?? null;

  const compare = useCallback(async (left = { projectId: leftProjectId, taskId: leftTaskId }, right = { projectId: rightProjectId, taskId: rightTaskId }) => {
    if (!left.projectId || !left.taskId || !right.projectId || !right.taskId) {
      onMessage({ kind: "error", text: "请先选择两个历史结果" });
      return;
    }
    setPending(true);
    try {
      const next = await createScreenshotComparison({ left, right });
      setComparison(next);
      setSelectedKey(next.pairs[0]?.key ?? "");
      writeStoredSelection({ left, right });
    } catch (error) {
      setComparison(null);
      onMessage({ kind: "error", text: error instanceof ApiError ? error.message : "无法创建截图对比" });
    } finally {
      setPending(false);
    }
  }, [leftProjectId, leftTaskId, onMessage, rightProjectId, rightTaskId]);

  useEffect(() => {
    if (leftProjectId && leftTaskId && rightProjectId && rightTaskId) {
      void compare({ projectId: leftProjectId, taskId: leftTaskId }, { projectId: rightProjectId, taskId: rightTaskId });
    }
    // 仅在两侧任务都就绪时自动对比一次。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [leftTaskId, rightTaskId, leftProjectId, rightProjectId]);

  return <div className="screenshot-compare-workspace">
    <section className="section-panel">
      <div className="section-heading">
        <div><p className="eyebrow">SCREENSHOT COMPARE</p><h2>截图对比</h2></div>
        <span className="count-label">{comparison ? `${comparison.pairs.length} 页` : "选择两个历史结果"}</span>
      </div>
      <div className="screenshot-compare-pickers">
        <ComparisonSidePicker
          label="左侧"
          projectId={leftProjectId}
          taskId={leftTaskId}
          projects={projects}
          candidates={leftCandidates}
          loading={loadingLeft}
          onProject={setLeftProjectId}
          onTask={setLeftTaskId}
        />
        <ComparisonSidePicker
          label="右侧"
          projectId={rightProjectId}
          taskId={rightTaskId}
          projects={projects}
          candidates={rightCandidates}
          loading={loadingRight}
          onProject={setRightProjectId}
          onTask={setRightTaskId}
        />
      </div>
      <div className="screenshot-compare-actions">
        <button className="primary-button" type="button" onClick={() => void compare()} disabled={pending || !leftTaskId || !rightTaskId}>
          {pending ? <LoaderCircle className="spin" size={15} /> : <Columns2 size={15} />}
          {pending ? "正在配对" : "开始对比"}
        </button>
        <label className="screenshot-compare-filter">
          <input type="checkbox" checked={missingOnly} onChange={event => setMissingOnly(event.target.checked)} />
          只看缺失页
        </label>
      </div>
    </section>

    {comparison && <section className="section-panel screenshot-compare-result">
      <ComparisonSideMeta side={comparison.left} align="left" />
      <ComparisonSideMeta side={comparison.right} align="right" />
      <div className="screenshot-compare-layout">
        <aside className="screenshot-compare-list" aria-label="对比页面">
          {visiblePairs.length === 0
            ? <div className="result-empty"><ImageIcon size={18} /><strong>没有可对比页面</strong><span>{missingOnly ? "两侧截图都已配对，没有缺失页" : "这两个运行没有可配对的截图"}</span></div>
            : visiblePairs.map(pair => <button
                key={pair.key}
                type="button"
                className={`screenshot-compare-item ${pair.key === selectedPair?.key ? "selected" : ""} ${pair.presence}`}
                onClick={() => setSelectedKey(pair.key)}
              >
                <strong>{pair.title}</strong>
                <small>{PRESENCE_LABELS[pair.presence]}</small>
              </button>)}
        </aside>
        <div className="screenshot-compare-stage">
          <div className="screenshot-compare-toolbar" role="tablist" aria-label="对比模式">
            <button type="button" role="tab" aria-selected={mode === "side-by-side"} className={mode === "side-by-side" ? "active" : ""} onClick={() => setMode("side-by-side")}><Columns2 size={14} />并排</button>
            <button type="button" role="tab" aria-selected={mode === "slider"} className={mode === "slider" ? "active" : ""} onClick={() => setMode("slider")}><SplitSquareHorizontal size={14} />滑杆</button>
          </div>
          {selectedPair
            ? <ComparisonPairView pair={selectedPair} mode={mode} slider={slider} onSlider={setSlider} />
            : <div className="result-empty"><ImageIcon size={18} /><strong>选择一个页面</strong><span>从左侧列表打开配对结果</span></div>}
        </div>
      </div>
    </section>}
  </div>;
}

function ComparisonSidePicker({
  label,
  projectId,
  taskId,
  projects,
  candidates,
  loading,
  onProject,
  onTask,
}: {
  label: string;
  projectId: string;
  taskId: string;
  projects: NonNullable<ProjectCatalogResponse["projects"]>;
  candidates: ScreenshotComparisonCandidate[];
  loading: boolean;
  onProject: (projectId: string) => void;
  onTask: (taskId: string) => void;
}) {
  return <div className="screenshot-compare-picker">
    <strong>{label}</strong>
    <label className="field"><span>项目</span>
      <select aria-label={`${label}项目`} value={projectId} onChange={event => { onProject(event.target.value); onTask(""); }}>
        <option value="" disabled>选择项目</option>
        {projects.map(project => <option key={project.id} value={project.id}>{project.name} · {project.root.split(/[\\/]/).at(-1)}</option>)}
      </select>
    </label>
    <label className="field"><span>历史结果</span>
      <select aria-label={`${label}历史结果`} value={taskId} onChange={event => onTask(event.target.value)} disabled={loading || candidates.length === 0}>
        <option value="">{loading ? "正在读取运行记录" : candidates.length === 0 ? "没有终态运行" : "选择运行"}</option>
        {candidates.map(candidate => <option key={candidate.taskId} value={candidate.taskId}>
          {candidate.testLabel} · {formatClock(candidate.createdAt)} · {candidate.screenshotCount} 张截图
        </option>)}
      </select>
    </label>
  </div>;
}

function ComparisonSideMeta({ side, align }: { side: ScreenshotComparisonSide; align: "left" | "right" }) {
  return <div className={`screenshot-compare-meta ${align}`}>
    <strong>{side.projectName}</strong>
    <small title={side.projectRoot}>{side.directoryName} · {side.testLabel || "未选择运行"}</small>
    <small>{side.taskId ? `任务 ${side.taskId.slice(0, 8)}` : "无任务"}{side.createdAt ? ` · ${formatClock(side.createdAt)}` : ""}{side.sourceRevision ? ` · ${side.sourceRevision.slice(0, 8)}` : ""}</small>
    {side.error && <span className="screenshot-compare-side-error"><AlertCircle size={12} />{side.error}</span>}
  </div>;
}

export function ComparisonPairView({
  pair,
  mode,
  slider,
  onSlider,
}: {
  pair: ScreenshotComparisonPair;
  mode: CompareMode;
  slider: number;
  onSlider: (value: number) => void;
}) {
  if (mode === "slider" && pair.presence === "both" && pair.left?.available && pair.right?.available) {
    return <div className="screenshot-compare-slider-wrap">
      <ComparisonSlider left={pair.left.url} right={pair.right.url} label={pair.title} value={slider} onChange={onSlider} />
      <small>{pair.title} · 拖动滑杆查看左右差异</small>
    </div>;
  }
  return <div className="screenshot-compare-side-by-side">
    <ComparisonImagePane image={pair.left} fallback={pair.presence === "right-only" ? "仅右侧存在" : "源截图已清理"} caption="左侧" />
    <ComparisonImagePane image={pair.right} fallback={pair.presence === "left-only" ? "仅左侧存在" : "源截图已清理"} caption="右侧" />
  </div>;
}

export function ComparisonImagePane({
  image,
  fallback,
  caption,
}: {
  image: ScreenshotComparisonPair["left"];
  fallback: string;
  caption: string;
}) {
  const [failed, setFailed] = useState(false);
  useEffect(() => { setFailed(false); }, [image?.url]);
  const missing = !image || !image.available || failed;
  return <div className={`screenshot-compare-pane ${missing ? "missing" : ""}`}>
    <span>{caption}</span>
    {missing
      ? <div className="screenshot-compare-missing"><AlertCircle size={16} /><strong>{image?.missingReason || fallback}</strong></div>
      : <a href={image.url} target="_blank" rel="noreferrer"><img src={image.url} alt={`${caption} ${image.artifactId}`} onError={() => setFailed(true)} /></a>}
  </div>;
}

export function ComparisonSlider({
  left,
  right,
  label,
  value,
  onChange,
}: {
  left: string;
  right: string;
  label: string;
  value: number;
  onChange: (value: number) => void;
}) {
  return <div className="screenshot-compare-slider">
    <img src={right} alt={`${label} 右侧`} />
    <img src={left} alt={`${label} 左侧`} style={{ clipPath: `inset(0 ${100 - value}% 0 0)` }} />
    <input
      type="range"
      min={0}
      max={100}
      value={value}
      aria-label="对比滑杆"
      onChange={event => onChange(Number(event.target.value))}
    />
  </div>;
}

function formatClock(value: string): string {
  if (!value) return "未记录时间";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return `${date.getMonth() + 1}/${date.getDate()} ${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

function readStoredSelection(): StoredComparisonSelection {
  try {
    if (typeof sessionStorage === "undefined") return { left: null, right: null };
    const raw = sessionStorage.getItem(STORAGE_KEY);
    if (!raw) return { left: null, right: null };
    const parsed = JSON.parse(raw) as StoredComparisonSelection;
    return {
      left: parsed.left?.projectId && parsed.left.taskId ? parsed.left : null,
      right: parsed.right?.projectId && parsed.right.taskId ? parsed.right : null,
    };
  } catch {
    return { left: null, right: null };
  }
}

function writeStoredSelection(selection: StoredComparisonSelection): void {
  try {
    if (typeof sessionStorage === "undefined") return;
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify(selection));
  } catch {
    // 私密模式或存储配额不足时仍可完成本次对比。
  }
}
