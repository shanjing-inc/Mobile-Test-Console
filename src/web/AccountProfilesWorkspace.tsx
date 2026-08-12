import { AlertCircle, CheckCircle2, Copy, Eye, EyeOff, Fingerprint, KeyRound, LoaderCircle, Play, Radio, Square, Trash2, XCircle } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  type AccountProfileProvider,
  type AccountProfileRecordingSummary,
  type AccountProfileReplay,
  type AccountProfileSourceResponse,
  type AccountProfileSummary,
  type AccountProfilesResponse,
  type Device,
} from "../shared/contracts";
import {
  ApiError,
  deleteAccountProfile,
  fetchAccountProfileSource,
  fetchAccountProfiles,
  replayAccountProfile,
  startAccountProfileRecording,
  stopAccountProfileRecording,
  terminateAccountProfileRecording,
} from "./api";
import { accountProfileIdentityForProvider, activeAccountProfileRecordings, resolveAccountProfileIdentityChange, resolveAccountProfileRecordingDevices, resolveAccountProfileReplayDevices, resolveDeviceKey, resolveReplayProvider } from "./account-profile-devices";
import { EMPTY_PROJECT_ADAPTER } from "../shared/project-adapter-defaults";

export function AccountProfilesWorkspace({ devices, onMessage }: {
  devices: Device[];
  onMessage: (message: { kind: "error" | "info"; text: string }) => void;
}) {
  const [data, setData] = useState<AccountProfilesResponse | null>(null);
  const [recordingDeviceSelection, setRecordingDeviceSelection] = useState("");
  const [replayDeviceSelection, setReplayDeviceSelection] = useState("");
  const [replayProviderSelection, setReplayProviderSelection] = useState<AccountProfileProvider | "">("");
  const [profileId, setProfileId] = useState("");
  const [accountLabel, setAccountLabel] = useState("");
  const [provider, setProvider] = useState<AccountProfileProvider>("");
  const [environment, setEnvironment] = useState("qa");
  const [selectedProfileId, setSelectedProfileId] = useState("");
  const [pending, setPending] = useState(false);
  const [recordingActionId, setRecordingActionId] = useState("");
  const [replay, setReplay] = useState<AccountProfileReplay | null>(null);
  const [source, setSource] = useState<{ key: string; value: AccountProfileSourceResponse } | null>(null);
  const [sourceLoadingKey, setSourceLoadingKey] = useState("");
  const [deleteCandidate, setDeleteCandidate] = useState<AccountProfileSummary | null>(null);
  const providers = data?.providers ?? EMPTY_PROJECT_ADAPTER.accountProfiles.providers;
  const providerIds = useMemo(() => Object.keys(providers) as AccountProfileProvider[], [providers]);
  const providerLabel = (item: AccountProfileProvider) => providers[item]?.recordingLabel ?? item;

  const load = useCallback(async () => {
    try {
      const next = await fetchAccountProfiles();
      setData(next);
      setSelectedProfileId(current => next.profiles.some(item => item.profileId === current)
        ? current
        : next.profiles[0]?.profileId ?? "");
    } catch (error) {
      onMessage({ kind: "error", text: messageOf(error, "无法读取账号画像") });
    }
  }, [onMessage]);

  const activeRecordings = useMemo(() => activeAccountProfileRecordings(data?.recordings ?? []), [data?.recordings]);
  const activeRecordingIds = activeRecordings.map(item => item.recordingId).join(",");

  useEffect(() => { void load(); }, [load]);

  useEffect(() => {
    if (provider && providers[provider]) return;
    const nextProvider = providerIds[0] ?? "";
    const nextIdentity = accountProfileIdentityForProvider(nextProvider, providers);
    setProvider(nextProvider);
    setProfileId(nextIdentity.profileId);
    setAccountLabel(nextIdentity.accountLabel);
  }, [provider, providerIds, providers]);

  useEffect(() => {
    if (!activeRecordingIds) return;
    let cancelled = false;
    let timer = 0;
    const poll = async () => {
      await load();
      if (!cancelled) timer = window.setTimeout(() => { void poll(); }, 1_500);
    };
    timer = window.setTimeout(() => { void poll(); }, 1_500);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [activeRecordingIds, load]);

  const availableDevices = useMemo(() => devices.filter(item => item.connectionState === "available"), [devices]);
  const recordingDevices = useMemo(
    () => resolveAccountProfileRecordingDevices(availableDevices, provider, providers),
    [availableDevices, provider, providers],
  );
  const selectedProfile = data?.profiles.find(item => item.profileId === selectedProfileId) ?? null;
  const recordingDeviceKey = resolveDeviceKey(recordingDevices, recordingDeviceSelection);
  const replayProvider = resolveReplayProvider(selectedProfile?.providerEntries ?? [], replayProviderSelection, provider);
  const replayEntry = selectedProfile?.providerEntries.find(item => item.provider === replayProvider) ?? null;
  const replayDevices = resolveAccountProfileReplayDevices(availableDevices, selectedProfile?.platform, replayEntry, providers);
  const replayDeviceKey = resolveDeviceKey(replayDevices, replayDeviceSelection);
  const selectedDeviceRecording = activeRecordings.find(item => item.deviceKey === recordingDeviceKey);

  const changeProvider = (nextProvider: AccountProfileProvider) => {
    const nextIdentity = resolveAccountProfileIdentityChange(provider, nextProvider, profileId, accountLabel, providers);
    setProfileId(nextIdentity.profileId);
    setAccountLabel(nextIdentity.accountLabel);
    setProvider(nextProvider);
  };

  const startRecording = async () => {
    if (!provider || !recordingDeviceKey || !profileId.trim() || !accountLabel.trim()) {
      onMessage({ kind: "error", text: "请填写画像标识、账号标签并选择设备" });
      return;
    }
    setPending(true);
    try {
      await startAccountProfileRecording({
        deviceKey: recordingDeviceKey,
        profileId: profileId.trim(),
        accountLabel: accountLabel.trim(),
        provider,
        environment: environment.trim() || "qa",
      });
      onMessage({ kind: "info", text: `已启动 ${providerLabel(provider)} 录制` });
      await load();
    } catch (error) {
      onMessage({ kind: "error", text: messageOf(error, "启动账号录制失败") });
      await load();
    } finally {
      setPending(false);
    }
  };

  const stopRecording = async (recording: AccountProfileRecordingSummary) => {
    setRecordingActionId(recording.recordingId);
    try {
      const response = await stopAccountProfileRecording(recording.recordingId);
      onMessage({
        kind: response.profile ? "info" : "error",
        text: response.profile ? `账号画像 ${response.profile.profileId} 已保存` : response.recording.error || "账号录制未形成可用画像",
      });
      await load();
    } catch (error) {
      onMessage({ kind: "error", text: messageOf(error, "停止账号录制失败") });
    } finally {
      setRecordingActionId("");
    }
  };

  const terminateRecording = async (recording: AccountProfileRecordingSummary) => {
    setRecordingActionId(recording.recordingId);
    try {
      await terminateAccountProfileRecording(recording.recordingId);
      onMessage({ kind: "info", text: `已终止 ${recording.accountLabel} 的录制会话` });
      await load();
    } catch (error) {
      onMessage({ kind: "error", text: messageOf(error, "终止账号录制会话失败") });
    } finally {
      setRecordingActionId("");
    }
  };

  const runReplay = async () => {
    if (!selectedProfile || !replayProvider || !replayDeviceKey) return;
    setPending(true);
    setReplay(null);
    try {
      const response = await replayAccountProfile(selectedProfile.profileId, replayProvider, replayDeviceKey);
      setReplay(response.replay);
      onMessage({ kind: response.replay.status === "passed" ? "info" : "error", text: response.replay.status === "passed" ? "账号画像回放通过" : response.replay.error || "账号画像回放失败" });
      await load();
    } catch (error) {
      onMessage({ kind: "error", text: messageOf(error, "账号画像回放失败") });
    } finally {
      setPending(false);
    }
  };

  const toggleSource = async (item: AccountProfileSummary, sourceProvider: AccountProfileProvider) => {
    const key = `${item.profileId}:${sourceProvider}`;
    if (source?.key === key) {
      setSource(null);
      return;
    }
    setSourceLoadingKey(key);
    try {
      const value = await fetchAccountProfileSource(item.profileId, sourceProvider);
      setSource({ key, value });
    } catch (error) {
      onMessage({ kind: "error", text: messageOf(error, "读取账号源数据失败") });
    } finally {
      setSourceLoadingKey("");
    }
  };

  const copySource = async (value: AccountProfileSourceResponse) => {
    try {
      await navigator.clipboard.writeText(formatSource(value));
      onMessage({ kind: "info", text: "账号源数据已复制" });
    } catch {
      onMessage({ kind: "error", text: "账号源数据复制失败" });
    }
  };

  const removeProfile = async (item: AccountProfileSummary) => {
    setPending(true);
    try {
      await deleteAccountProfile(item.profileId);
      setDeleteCandidate(null);
      setReplay(null);
      setSource(null);
      onMessage({ kind: "info", text: `已删除账号画像 ${item.profileId}` });
      await load();
    } catch (error) {
      onMessage({ kind: "error", text: messageOf(error, "删除账号画像失败") });
    } finally {
      setPending(false);
    }
  };

  return <div className="account-workspace">
    <section className="section-panel account-recording-panel">
      <div className="section-heading">
        <div><p className="eyebrow">ACCOUNT CAPTURE</p><h2>真机账号录制</h2></div>
        <span className={`recording-state ${activeRecordings.length > 0 ? "recording" : ""}`}>
          {activeRecordings.length > 0 ? <><Radio size={11} />{activeRecordings.length} 个录制中</> : "等待录制"}
        </span>
      </div>
      <div className="account-recording-grid">
        <label className="field"><span>画像标识</span><input value={profileId} onChange={event => setProfileId(event.target.value)} /></label>
        <label className="field"><span>账号标签</span><input value={accountLabel} onChange={event => setAccountLabel(event.target.value)} /></label>
        <label className="field"><span>授权场景</span><select value={provider} disabled={providerIds.length === 0} onChange={event => changeProvider(event.target.value as AccountProfileProvider)}><option value="" disabled>{providerIds.length > 0 ? "选择授权场景" : "项目未配置授权场景"}</option>{providerIds.map(item => <option key={item} value={item}>{providerLabel(item)}</option>)}</select></label>
        <label className="field"><span>环境</span><input value={environment} onChange={event => setEnvironment(event.target.value)} /></label>
        <label className="field"><span>录制设备</span><select value={recordingDeviceKey} onChange={event => setRecordingDeviceSelection(event.target.value)}><option value="" disabled>{recordingDevices.length > 0 ? "选择已连接设备" : "当前无兼容设备"}</option>{recordingDevices.map(item => <option key={item.key} value={item.key}>{item.name} · {item.platform}</option>)}</select></label>
        <button className="primary-button account-command" type="button" disabled={pending || !provider || !recordingDeviceKey || Boolean(selectedDeviceRecording)} onClick={() => void startRecording()}>{pending ? <LoaderCircle className="spin" size={15} /> : <Radio size={15} />}{selectedDeviceRecording ? "设备录制中" : "开始录制"}</button>
      </div>
      {activeRecordings.length > 0 && <div className="account-recording-sessions">
        <div className="account-recording-sessions-heading"><strong>进行中的录制会话</strong><span>{activeRecordings.length} 个</span></div>
        {activeRecordings.map(item => <div className="account-recording-session" key={item.recordingId}>
          <span className={`recording-state ${item.status}`}><Radio size={11} />{item.status === "starting" ? "启动中" : "录制中"}</span>
          <span className="account-recording-identity"><strong>{item.accountLabel}</strong><small>{item.profileId} · {providerLabel(item.provider)}</small></span>
          <span className="account-recording-meta"><small>设备</small><strong>{item.deviceId} · {item.platform}</strong></span>
          <span className="account-recording-meta"><small>开始时间</small><strong>{formatTime(item.startedAt)}</strong></span>
          <span className="account-recording-captures"><strong>{item.captureSummaries.length}</strong><small>条数据</small></span>
          <div className="account-recording-actions">
            <button className="secondary-button" type="button" disabled={Boolean(recordingActionId)} onClick={() => void stopRecording(item)}>{recordingActionId === item.recordingId ? <LoaderCircle className="spin" size={14} /> : <Square size={14} />}停止并保存</button>
            <button className="stop-button" type="button" disabled={Boolean(recordingActionId)} onClick={() => void terminateRecording(item)}><XCircle size={14} />终止会话</button>
          </div>
        </div>)}
      </div>}
    </section>

    <div className="account-profile-layout">
      <section className="section-panel account-profile-list">
        <div className="section-heading"><div><p className="eyebrow">PROFILE VAULT</p><h2>账号画像</h2></div><span className="count-label">{data?.profiles.length ?? 0} 个</span></div>
        {data?.warnings.map(item => <div className="provider-error" key={item}><AlertCircle size={14} /><span>{item}</span></div>)}
        {(data?.profiles.length ?? 0) === 0
          ? <div className="account-empty"><KeyRound size={20} /><span>暂无可回放账号画像</span></div>
          : <div className="account-profile-rows">{data?.profiles.map(item => <button type="button" className={item.profileId === selectedProfileId ? "active" : ""} key={item.profileId} onClick={() => { setSelectedProfileId(item.profileId); setReplayProviderSelection(""); setReplay(null); setSource(null); }}>
            <Fingerprint size={17} />
            <span><strong>{item.accountLabel}</strong><small>{item.profileId} · {item.providerEntries.map(entry => providerLabel(entry.provider)).join(" / ")}</small></span>
            <em>{item.providerEntries.length} 个分支</em>
          </button>)}</div>}
      </section>

      <section className="section-panel account-profile-detail">
        <div className="section-heading"><div><p className="eyebrow">PROFILE DETAIL</p><h2>{selectedProfile?.accountLabel || "画像详情"}</h2></div>{selectedProfile && <span className="account-valid"><CheckCircle2 size={13} />已录制</span>}</div>
        {selectedProfile ? <>
          <div className="account-meta-grid">
            <Meta label="Provider" value={selectedProfile.providerEntries.map(item => providerLabel(item.provider)).join(" / ")} />
            <Meta label="录制平台" value={selectedProfile.platform} />
            <Meta label="环境" value={selectedProfile.environment} />
            <Meta label="当前 UID" value={replayEntry?.accountUidMasked || "待识别"} />
            <Meta label="录制时间" value={formatTime(replayEntry?.recordedAt ?? "")} />
            <Meta label="最后验证" value={formatTime(replayEntry?.validatedAt ?? "")} />
          </div>
          <div className="account-provider-entries">{selectedProfile.providerEntries.map(entry => {
            const sourceKey = `${selectedProfile.profileId}:${entry.provider}`;
            const sourceOpen = source?.key === sourceKey;
            const sourceLoading = sourceLoadingKey === sourceKey;
            return <div className="account-provider-entry" key={entry.provider}>
            <div className="account-provider-entry-heading"><strong>{providerLabel(entry.provider)}</strong><div className="account-provider-entry-tools"><span>{entry.accountUidMasked || "UID 待识别"}</span><button type="button" className="account-source-toggle" disabled={sourceLoading} onClick={() => void toggleSource(selectedProfile, entry.provider)}>{sourceLoading ? <LoaderCircle className="spin" size={13} /> : sourceOpen ? <EyeOff size={13} /> : <Eye size={13} />}{sourceOpen ? "收起源数据" : "查看源数据"}</button></div></div>
            <div className="account-capabilities">{entry.capabilities.map(item => <span key={item}>{item}</span>)}</div>
            <div className="account-capture-list">{entry.captureSummaries.map(item => <div key={item.captureId}>
              <span className={`capture-kind ${item.kind}`}>{item.kind}</span>
              <span><strong>{item.module || item.operationName || "成功结果"}</strong><small>{item.method || item.operationName || item.provider}</small></span>
              <code>{item.resultKeys.join(", ") || "result"}</code>
              <em>{item.digest}</em>
            </div>)}</div>
            {sourceOpen && <AccountProfileSourcePanel source={source.value} onCopy={() => void copySource(source.value)} />}
          </div>;
          })}</div>
          <div className="account-actions">
            <label className="field"><span>回放 Provider</span><select value={replayProvider} onChange={event => setReplayProviderSelection(event.target.value as AccountProfileProvider)}>{selectedProfile.providerEntries.map(item => <option key={item.provider} value={item.provider}>{providerLabel(item.provider)}</option>)}</select></label>
            <label className="field"><span>回放设备</span><select value={replayDeviceKey} onChange={event => setReplayDeviceSelection(event.target.value)}><option value="" disabled>选择可用设备</option>{replayDevices.map(item => <option key={item.key} value={item.key}>{item.name}</option>)}</select></label>
            <button className="primary-button" type="button" disabled={pending || !replayProvider || !replayDeviceKey} onClick={() => void runReplay()}><Play size={15} />{replayProvider && providers[replayProvider]?.requiredCapability === "login" ? "回放登录" : "回放授权"}</button>
            <button className="icon-button account-delete" type="button" disabled={pending} onClick={() => setDeleteCandidate(selectedProfile)} title="删除账号画像" aria-label={`删除 ${selectedProfile.accountLabel}`}><Trash2 size={16} /></button>
          </div>
          {replay && <div className={`account-replay-result ${replay.status}`}><strong>{replay.status === "passed" ? "回放通过" : "回放失败"}</strong><span>{replay.output || replay.error}</span></div>}
        </> : <div className="account-empty"><Fingerprint size={20} /><span>选择一个账号画像查看摘要</span></div>}
      </section>
    </div>
    {deleteCandidate && <AccountProfileDeleteConfirmation
      profile={deleteCandidate}
      pending={pending}
      onCancel={() => setDeleteCandidate(null)}
      onConfirm={() => void removeProfile(deleteCandidate)}
    />}
  </div>;
}

export function AccountProfileDeleteConfirmation({ profile, pending, onCancel, onConfirm }: {
  profile: Pick<AccountProfileSummary, "profileId" | "accountLabel">;
  pending: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return <div className="confirm-overlay">
    <section className="confirm-dialog" role="dialog" aria-modal="true" aria-labelledby="account-profile-delete-confirm-title">
      <div className="confirm-icon"><Trash2 size={20} /></div>
      <div className="confirm-copy">
        <h2 id="account-profile-delete-confirm-title">删除账号画像</h2>
        <p>将删除 {profile.accountLabel}（{profile.profileId}）及关联的历史录制和授权数据。此操作无法撤销。</p>
      </div>
      <div className="confirm-actions">
        <button type="button" className="secondary-button" onClick={onCancel} disabled={pending}>取消</button>
        <button type="button" className="danger-button" onClick={onConfirm} disabled={pending}>
          {pending ? <LoaderCircle className="spin" size={15} /> : <Trash2 size={15} />}删除
        </button>
      </div>
    </section>
  </div>;
}

export function AccountProfileSourcePanel({ source, onCopy }: {
  source: AccountProfileSourceResponse;
  onCopy: () => void;
}) {
  return <div className="account-source-panel">
    <div className="account-source-heading"><span>完整录制 JSON</span><button type="button" onClick={onCopy} title="复制账号源数据" aria-label="复制账号源数据"><Copy size={13} /></button></div>
    <pre>{formatSource(source)}</pre>
  </div>;
}

function Meta({ label, value }: { label: string; value: string }) {
  return <span><small>{label}</small><strong>{value}</strong></span>;
}

function messageOf(error: unknown, fallback: string): string {
  return error instanceof ApiError ? error.message : fallback;
}

function formatTime(value: string): string {
  return value ? new Date(value).toLocaleString("zh-CN", { hour12: false }) : "尚未验证";
}

function formatSource(value: AccountProfileSourceResponse): string {
  return JSON.stringify(value, null, 2);
}
