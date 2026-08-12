import { Check, FileCheck2, ListPlus, LoaderCircle, Play, Plus, Radio, Save, Square, Trash2 } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import type { BusinessScenario, BusinessScriptAssertion, BusinessScriptDraft, BusinessScriptStep, BusinessScriptsResponse, Device, PublishedBusinessScript } from "../shared/contracts";
import {
  deletePublishedBusinessScriptVersion,
  fetchBusinessScriptRecording,
  fetchBusinessScripts,
  publishBusinessScriptDraft,
  replayBusinessScenario,
  replayBusinessSuite,
  saveBusinessScriptDraft,
  saveBusinessSuite,
  startBusinessScriptRecording,
  stopBusinessScriptRecording,
} from "./api";
import { sortPublishedBusinessScripts, updateBusinessScriptInputBinding, updateBusinessStepAction } from "./business-script-editor";

export function BusinessScriptsWorkspace({ devices, onMessage }: {
  devices: Device[];
  onMessage: (message: { kind: "error" | "info"; text: string }) => void;
}) {
  const [data, setData] = useState<BusinessScriptsResponse | null>(null);
  const [deviceKey, setDeviceKey] = useState("");
  const [environment, setEnvironment] = useState("qa");
  const [activeRecordingId, setActiveRecordingId] = useState("");
  const [draft, setDraft] = useState<BusinessScriptDraft | null>(null);
  const [pending, setPending] = useState(false);
  const [suiteId, setSuiteId] = useState("recorded-suite");
  const [selectedScenarioKeys, setSelectedScenarioKeys] = useState<string[]>([]);
  const [deleteCandidate, setDeleteCandidate] = useState<PublishedBusinessScript | null>(null);
  const harmonyDevices = useMemo(() => devices.filter(item => item.platform === "harmony" && item.connectionState === "available"), [devices]);
  const publishedScripts = useMemo(() => sortPublishedBusinessScripts(data?.scripts ?? []), [data]);
  const latestScripts = useMemo(() => [...publishedScripts]
    .filter((script, index, list) => list.findIndex(item => item.scriptId === script.scriptId) === index), [publishedScripts]);
  const publishedScenarios = useMemo(() => latestScripts.flatMap(script => script.scenarios.map(scenario => ({
    script,
    scenario,
    key: scenarioKey(script.scriptId, script.version, scenario.scenarioId),
  }))), [latestScripts]);

  const load = useCallback(async () => {
    try {
      const next = await fetchBusinessScripts();
      setData(next);
      setDeviceKey(previous => previous || harmonyDevices[0]?.key || "");
      const active = next.recordings.find(item => ["starting", "recording"].includes(item.status));
      if (active) setActiveRecordingId(active.recordingId);
      setDraft(previous => previous ?? next.drafts[0] ?? null);
    } catch (error) {
      onMessage({ kind: "error", text: messageOf(error, "读取业务脚本失败") });
    }
  }, [harmonyDevices, onMessage]);

  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    if (!activeRecordingId) return;
    let cancelled = false;
    let timer = 0;
    const poll = async () => {
      try {
        const response = await fetchBusinessScriptRecording(activeRecordingId);
        if (!cancelled && response.recording.status === "failed") {
          setActiveRecordingId("");
          onMessage({ kind: "error", text: response.recording.error || "业务录制已中断" });
        }
      } catch (error) {
        if (!cancelled) onMessage({ kind: "error", text: messageOf(error, "读取业务录制状态失败") });
      } finally {
        if (!cancelled) timer = window.setTimeout(() => void poll(), 1_500);
      }
    };
    timer = window.setTimeout(() => void poll(), 1_500);
    return () => { cancelled = true; window.clearTimeout(timer); };
  }, [activeRecordingId, onMessage]);

  const handleStart = async () => {
    if (!deviceKey) return onMessage({ kind: "error", text: "请选择 HarmonyOS 真机" });
    setPending(true);
    try {
      const response = await startBusinessScriptRecording(deviceKey, environment, "qa-installed");
      if (response.recording.status === "failed") throw new Error(response.recording.error);
      setActiveRecordingId(response.recording.recordingId);
      onMessage({ kind: "info", text: "业务录制已开始，请在真机完成操作" });
    } catch (error) { onMessage({ kind: "error", text: messageOf(error, "启动业务录制失败") }); }
    finally { setPending(false); }
  };

  const handleStop = async () => {
    if (!activeRecordingId) return;
    setPending(true);
    try {
      const response = await stopBusinessScriptRecording(activeRecordingId);
      setActiveRecordingId("");
      if (response.draft) {
        const nextDraft = response.draft.scenarios.length > 0 ? response.draft : withDefaultScenario(response.draft);
        setDraft(nextDraft);
        await saveBusinessScriptDraft(nextDraft.draftId, draftRequest(nextDraft));
      }
      await load();
      onMessage({ kind: "info", text: `业务录制已停止，共生成 ${response.draft?.steps.length ?? 0} 个步骤` });
    } catch (error) { onMessage({ kind: "error", text: messageOf(error, "停止业务录制失败") }); }
    finally { setPending(false); }
  };

  const updateStep = (index: number, patch: Partial<BusinessScriptStep>) => setDraft(previous => previous ? ({ ...previous, steps: previous.steps.map((item, current) => current === index ? { ...item, ...patch } : item) }) : previous);
  const removeStep = (stepId: string) => setDraft(previous => previous ? ({ ...previous, steps: previous.steps.filter(item => item.stepId !== stepId), scenarios: previous.scenarios.map(item => ({ ...item, stepIds: item.stepIds.filter(id => id !== stepId) })) }) : previous);
  const addAssertion = () => setDraft(previous => {
    if (!previous) return previous;
    const assertion = { assertionId: `assert-${Date.now()}`, type: "page" as const, page: previous.expectedFinalPage };
    return { ...previous, assertions: [...previous.assertions, assertion], scenarios: previous.scenarios.map(item => ({ ...item, assertionIds: [...item.assertionIds, assertion.assertionId] })) };
  });
  const addScenario = () => setDraft(previous => previous ? ({ ...previous, scenarios: [...previous.scenarios, { scenarioId: `scenario-${previous.scenarios.length + 1}`, name: `功能 ${previous.scenarios.length + 1}`, startPage: previous.startPage, expectedFinalPage: previous.expectedFinalPage, tags: [], stepIds: previous.steps.map(item => item.stepId), assertionIds: previous.assertions.map(item => item.assertionId) }] }) : previous);

  const handleSave = async () => {
    if (!draft) return;
    setPending(true);
    try { const response = await saveBusinessScriptDraft(draft.draftId, draftRequest(draft)); setDraft(response.draft); await load(); onMessage({ kind: "info", text: "业务脚本草稿已保存" }); }
    catch (error) { onMessage({ kind: "error", text: messageOf(error, "保存业务脚本失败") }); }
    finally { setPending(false); }
  };

  const handlePublish = async () => {
    if (!draft) return;
    setPending(true);
    try { await saveBusinessScriptDraft(draft.draftId, draftRequest(draft)); const response = await publishBusinessScriptDraft(draft.draftId); await load(); onMessage({ kind: "info", text: `已发布 ${response.script.scriptId}@${response.script.version}` }); }
    catch (error) { onMessage({ kind: "error", text: messageOf(error, "发布业务脚本失败") }); }
    finally { setPending(false); }
  };

  const handleReplay = async (scriptId: string, version: number, scenarioId: string) => {
    if (!deviceKey) return onMessage({ kind: "error", text: "请选择回放设备" });
    setPending(true);
    try { const response = await replayBusinessScenario(scriptId, version, scenarioId, deviceKey); onMessage({ kind: response.replay.status === "passed" ? "info" : "error", text: `${scenarioId} 回放${response.replay.status === "passed" ? "通过" : "失败"}${response.replay.error ? `：${response.replay.error}` : ""}` }); }
    catch (error) { onMessage({ kind: "error", text: messageOf(error, "回放业务场景失败") }); }
    finally { setPending(false); }
  };

  const handleDeletePublishedVersion = async () => {
    if (!deleteCandidate) return;
    setPending(true);
    try {
      const target = deleteCandidate;
      const response = await deletePublishedBusinessScriptVersion(target.scriptId, target.version);
      const prefix = `${target.scriptId}:${target.version}:`;
      setSelectedScenarioKeys(previous => previous.filter(key => !key.startsWith(prefix)));
      setDeleteCandidate(null);
      await load();
      const suiteMessage = response.removedSuiteReferenceCount > 0
        ? `，已清理 ${response.removedSuiteReferenceCount} 个套件引用`
        : "";
      onMessage({ kind: "info", text: `已删除 ${target.scriptId}@${target.version}${suiteMessage}` });
    } catch (error) {
      onMessage({ kind: "error", text: messageOf(error, "删除发布版本失败") });
    } finally {
      setPending(false);
    }
  };

  const handleSuite = async () => {
    const selected = new Set(selectedScenarioKeys);
    const refs = publishedScenarios
      .filter(item => selected.has(item.key))
      .map(item => ({ scriptId: item.script.scriptId, version: item.script.version, scenarioId: item.scenario.scenarioId }));
    if (!refs.length || !deviceKey) return onMessage({ kind: "error", text: "请选择至少一个已发布功能和设备" });
    setPending(true);
    try { await saveBusinessSuite(suiteId, { name: suiteId, scenarioRefs: refs, platformMatrix: ["harmony"] }); const response = await replayBusinessSuite(suiteId, deviceKey); await load(); onMessage({ kind: response.replays.every(item => item.status === "passed") ? "info" : "error", text: `${suiteId} 已执行 ${response.replays.length} 个功能` }); }
    catch (error) { onMessage({ kind: "error", text: messageOf(error, "运行业务套件失败") }); }
    finally { setPending(false); }
  };

  return <div className="business-workspace">
    <section className="section-panel business-recorder">
      <div className="section-heading"><div><p className="eyebrow">BUSINESS RECORDER</p><h2>业务脚本录制</h2></div><span className="count-label">{activeRecordingId ? "录制中" : "待录制"}</span></div>
      <div className="business-record-controls">
        <label className="field"><span>HarmonyOS 真机</span><select value={deviceKey} onChange={event => setDeviceKey(event.target.value)}><option value="">选择设备</option>{harmonyDevices.map(device => <option key={device.key} value={device.key}>{device.name}</option>)}</select></label>
        <label className="field"><span>环境</span><select value={environment} onChange={event => setEnvironment(event.target.value)}><option value="qa">QA</option><option value="staging">Staging</option></select></label>
        {activeRecordingId ? <button className="stop-button" type="button" onClick={() => void handleStop()} disabled={pending}><Square size={14} fill="currentColor" />结束录制</button> : <button className="primary-button" type="button" onClick={() => void handleStart()} disabled={pending || !deviceKey}>{pending ? <LoaderCircle className="spin" size={15} /> : <Radio size={15} />}开始录制</button>}
      </div>
    </section>

    <div className="business-layout">
      <section className="section-panel business-editor">
        <div className="section-heading"><div><p className="eyebrow">RECORDED DRAFT</p><h2>脚本草稿</h2></div><span className="count-label">{draft?.steps.length ?? 0} 步</span></div>
        {!draft ? <div className="empty-state"><Radio size={20} /><span>完成一次真机录制后生成草稿</span></div> : <>
          <div className="business-meta"><label className="field"><span>脚本名称</span><input value={draft.name} onChange={event => setDraft({ ...draft, name: event.target.value })} /></label><label className="field"><span>起始页面</span><input value={draft.startPage} onChange={event => setDraft({ ...draft, startPage: event.target.value })} /></label><label className="field"><span>预期终态</span><input value={draft.expectedFinalPage} onChange={event => setDraft({ ...draft, expectedFinalPage: event.target.value })} /></label></div>
          <div className="business-step-list">{draft.steps.map((step, index) => <div className={`business-step ${step.status}`} key={step.stepId}><span className="scenario-step-index">{index + 1}</span><select value={step.actionType} onChange={event => updateStep(index, updateBusinessStepAction(step, event.target.value as BusinessScriptStep["actionType"]))}>{["tap", "input", "swipe", "back", "waitFor", "screenshot", "pageTransition"].map(value => <option key={value}>{value}</option>)}</select><input value={step.name} onChange={event => updateStep(index, { name: event.target.value })} /><input value={step.semanticTarget?.value ?? step.pageId ?? ""} placeholder="语义 target / 页面" onChange={event => updateStep(index, { semanticTarget: { strategy: step.semanticTarget?.strategy ?? "accessibilityId", value: event.target.value, status: event.target.value ? "resolved" : "needs-review" }, status: event.target.value ? "resolved" : "needs-review" })} /><button type="button" title="删除步骤" onClick={() => removeStep(step.stepId)}><Trash2 size={14} /></button>{step.actionType === "input" && <BusinessScriptInputBindingEditor step={step} index={index} onChange={inputBinding => setDraft(previous => previous ? updateBusinessScriptInputBinding(previous, index, inputBinding) : previous)} />}</div>)}</div>
          <EditorSection label="断言" onAdd={addAssertion}>{draft.assertions.map((assertion, index) => <AssertionRow key={assertion.assertionId} assertion={assertion} onChange={patch => setDraft({ ...draft, assertions: draft.assertions.map((item, current) => current === index ? { ...item, ...patch } : item) })} />)}</EditorSection>
          <EditorSection label="功能场景" onAdd={addScenario}>{draft.scenarios.map((scenario, index) => <ScenarioRow key={scenario.scenarioId} scenario={scenario} onChange={patch => setDraft({ ...draft, scenarios: draft.scenarios.map((item, current) => current === index ? { ...item, ...patch } : item) })} />)}</EditorSection>
          <div className="profile-actions"><span>{draft.warnings.join(" · ")}</span><div className="profile-action-buttons"><button className="secondary-button" type="button" onClick={() => void handleSave()} disabled={pending}><Save size={14} />保存草稿</button><button className="primary-button" type="button" onClick={() => void handlePublish()} disabled={pending || draft.scenarios.length === 0}><FileCheck2 size={14} />发布版本</button></div></div>
        </>}
      </section>

      <aside className="section-panel business-library">
        <div className="section-heading"><div><p className="eyebrow">PUBLISHED</p><h2>已发布功能</h2></div><span className="count-label">{data?.scripts.length ?? 0} 版</span></div>
        <div className="business-published-list">{publishedScripts.map(script => <div className="business-published" key={`${script.scriptId}:${script.version}`}><div className="business-published-heading"><div><strong>{script.name}</strong><small>{script.scriptId}@{script.version}</small></div><button className="business-published-delete" type="button" title={`删除 ${script.scriptId}@${script.version}`} aria-label={`删除发布版本 ${script.scriptId}@${script.version}`} onClick={() => setDeleteCandidate(script)} disabled={pending}><Trash2 size={14} /></button></div>{script.scenarios.map(scenario => {
          const key = scenarioKey(script.scriptId, script.version, scenario.scenarioId);
          return <div className="business-scenario-command" key={scenario.scenarioId}><label><input type="checkbox" checked={selectedScenarioKeys.includes(key)} onChange={event => setSelectedScenarioKeys(previous => event.target.checked ? [...new Set([...previous, key])] : previous.filter(item => item !== key))} /><span>{scenario.name}</span></label><button type="button" title={`单独回放 ${scenario.name}`} onClick={() => void handleReplay(script.scriptId, script.version, scenario.scenarioId)} disabled={pending}><Play size={13} /></button></div>;
        })}</div>)}</div>
        <div className="business-suite"><label className="field"><span>组合套件 ID</span><input value={suiteId} onChange={event => setSuiteId(event.target.value)} /></label><button className="secondary-button" type="button" onClick={() => void handleSuite()} disabled={pending || !deviceKey || selectedScenarioKeys.length === 0}><ListPlus size={14} />回放所选功能（{selectedScenarioKeys.length}）</button></div>
      </aside>
    </div>
    {deleteCandidate && <BusinessScriptDeleteConfirmation script={deleteCandidate} pending={pending} onCancel={() => setDeleteCandidate(null)} onConfirm={() => void handleDeletePublishedVersion()} />}
  </div>;
}

export function BusinessScriptInputBindingEditor({ step, index, onChange }: {
  step: BusinessScriptStep;
  index: number;
  onChange: (inputBinding: NonNullable<BusinessScriptStep["inputBinding"]>) => void;
}) {
  const binding = step.inputBinding ?? { strategy: "literal" as const, value: "" };
  return <div className="business-step-input-binding">
    <select aria-label={`步骤 ${index + 1} 输入策略`} value={binding.strategy} onChange={event => onChange({ strategy: event.target.value as typeof binding.strategy, value: "" })}>
      <option value="literal">固定值</option>
      <option value="secretRef">敏感变量</option>
      <option value="runtimeResolver">运行时变量</option>
    </select>
    <input aria-label={`步骤 ${index + 1} 输入内容`} value={binding.value} placeholder={binding.strategy === "literal" ? "填写回放时直接输入的内容" : "填写变量名称"} onChange={event => onChange({ ...binding, value: event.target.value })} />
  </div>;
}

export function BusinessScriptDeleteConfirmation({ script, pending, onCancel, onConfirm }: {
  script: Pick<PublishedBusinessScript, "scriptId" | "version" | "name">;
  pending: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return <div className="confirm-overlay">
    <section className="confirm-dialog" role="dialog" aria-modal="true" aria-labelledby="business-script-delete-confirm-title">
      <div className="confirm-icon"><Trash2 size={20} /></div>
      <div className="confirm-copy">
        <h2 id="business-script-delete-confirm-title">删除发布版本</h2>
        <p>将删除 {script.name}（{script.scriptId}@{script.version}），并清理组合套件中的关联场景。此操作无法撤销。</p>
      </div>
      <div className="confirm-actions">
        <button type="button" className="secondary-button" onClick={onCancel} disabled={pending}>取消</button>
        <button type="button" className="danger-button" onClick={onConfirm} disabled={pending}>{pending ? <LoaderCircle className="spin" size={15} /> : <Trash2 size={15} />}删除</button>
      </div>
    </section>
  </div>;
}

function EditorSection({ label, onAdd, children }: { label: string; onAdd: () => void; children: ReactNode }) {
  return <section className="business-subeditor"><div><strong>{label}</strong><button className="icon-command" type="button" onClick={onAdd} title={`添加${label}`}><Plus size={14} /></button></div>{children}</section>;
}

function AssertionRow({ assertion, onChange }: { assertion: BusinessScriptAssertion; onChange: (patch: Partial<BusinessScriptAssertion>) => void }) {
  return <div className="business-inline-row"><Check size={14} /><select value={assertion.type} onChange={event => onChange({ type: event.target.value as BusinessScriptAssertion["type"] })}>{["page", "visible", "text", "runtimeEvent"].map(value => <option key={value}>{value}</option>)}</select><input value={assertion.page ?? assertion.target ?? assertion.event ?? ""} onChange={event => assertion.type === "page" ? onChange({ page: event.target.value }) : assertion.type === "runtimeEvent" ? onChange({ event: event.target.value }) : onChange({ target: event.target.value })} /></div>;
}

function ScenarioRow({ scenario, onChange }: { scenario: BusinessScenario; onChange: (patch: Partial<BusinessScenario>) => void }) {
  return <div className="business-inline-row scenario-business-row"><Play size={14} /><input value={scenario.scenarioId} onChange={event => onChange({ scenarioId: event.target.value })} /><input value={scenario.name} onChange={event => onChange({ name: event.target.value })} /><input aria-label={`${scenario.name} 步骤 ID`} value={scenario.stepIds.join(",")} onChange={event => onChange({ stepIds: splitIds(event.target.value) })} placeholder="step-001,step-002" /><input aria-label={`${scenario.name} 断言 ID`} value={scenario.assertionIds.join(",")} onChange={event => onChange({ assertionIds: splitIds(event.target.value) })} placeholder="assert-final-page" /></div>;
}

function withDefaultScenario(draft: BusinessScriptDraft): BusinessScriptDraft {
  return { ...draft, scenarios: [{ scenarioId: "recorded-flow", name: "完整录制流程", startPage: draft.startPage, expectedFinalPage: draft.expectedFinalPage, tags: ["recorded"], stepIds: draft.steps.map(item => item.stepId), assertionIds: draft.assertions.map(item => item.assertionId) }] };
}

function draftRequest(draft: BusinessScriptDraft) {
  return { name: draft.name, startPage: draft.startPage, expectedFinalPage: draft.expectedFinalPage, variables: draft.variables, steps: draft.steps, assertions: draft.assertions, scenarios: draft.scenarios };
}

function messageOf(error: unknown, fallback: string) { return error instanceof Error && error.message ? error.message : fallback; }
function splitIds(value: string) { return value.split(",").map(item => item.trim()).filter(Boolean); }
function scenarioKey(scriptId: string, version: number, scenarioId: string) { return `${scriptId}:${version}:${scenarioId}`; }
