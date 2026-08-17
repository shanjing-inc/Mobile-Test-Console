import { AlertCircle, Braces, CircleDot, Database, History, LoaderCircle, Play, Plus, Radio, Save, Search, Square, Star, Trash2, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  PLATFORMS,
  type PageParameterAdapterManifest,
  type Device,
  type PageParameterField,
  type PageParameterPage,
  type PageParameterPlatform,
  type PageParameterProfile,
  type PageParameterReplay,
  type PageParameterRecording,
  type PageParameterValue,
  type PageParameterValueStrategy,
  type PageParametersResponse,
  type PageScenarioAction,
  type PageScenarioAssertion,
  type MiniProgramRunTarget,
  type ProjectTestEnvironment,
  type SavePageParameterProfileRequest,
} from "../shared/contracts";
import {
  ApiError,
  deletePageParameterProfile,
  fetchPageParameterRecording,
  fetchPageParameters,
  replayPageParameterProfile,
  savePageParameterProfile,
  setDefaultPageParameterProfile,
  startPageParameterRecording,
  stopPageParameterRecording,
} from "./api";
import { latestPageObservations } from "./page-parameter-observations";
import {
  createPageActionDefaultAssertions,
  createObservationParameterDraft,
  pageInteractionActions,
  pageInteractionTargets,
  pageTargetActionPlatforms,
  pageTargetActions,
  isValidPageParameterKey,
  pageNeedsParameters,
  pageUsesDynamicParameters,
  pageParameterPresets,
  hasUsablePageParameterValues,
  shouldUseHistoricalPageParameterProfile,
  resolveInitialPageParameterDraft,
  resolvePageInteractionPlatform,
  resolveDefaultPageParameterProfile,
  resolveSelectedPageTestDevice,
  resolveDraftFields,
  replaceDraftFromProfile,
  sortPageParameterProfiles,
  type PageParameterDraft,
  type PageParameterValueOrigin,
} from "./page-parameter-values";

const statusLabels = { missing: "缺失", recorded: "已录制", expired: "已过期", failed: "验证失败" } as const;
const CURRENT_TEST_PROFILE = "__current__";
const originLabels: Record<PageParameterValueOrigin, string> = {
  captured: "本次捕获",
  history: "历史补全",
  suggested: "代码建议",
  manual: "手动编辑",
};

export function PageParametersWorkspace({ devices, targets = [], environments = [], projectFamily = "app", adapter: adapterProp, onMessage }: {
  devices: Device[];
  targets?: MiniProgramRunTarget[];
  environments?: ProjectTestEnvironment[];
  projectFamily?: "app" | "mini-program";
  adapter?: PageParameterAdapterManifest;
  onMessage: (message: { kind: "error" | "info"; text: string }) => void;
}) {
  const [data, setData] = useState<PageParametersResponse | null>(null);
  const [selectedPageId, setSelectedPageId] = useState("");
  const [pageQuery, setPageQuery] = useState("");
  const [pageFilter, setPageFilter] = useState<"all" | "parameters">("all");
  const [deviceKey, setDeviceKey] = useState("");
  const [targetKey, setTargetKey] = useState("");
  const [environment, setEnvironment] = useState("qa");
  const [activeRecording, setActiveRecording] = useState<PageParameterRecording | null>(null);
  const [selectedObservationId, setSelectedObservationId] = useState("");
  const [profileId, setProfileId] = useState("default");
  const [scenario, setScenario] = useState("default");
  const [profilePlatform, setProfilePlatform] = useState<PageParameterPlatform>("all");
  const [profileIsDefault, setProfileIsDefault] = useState(false);
  const [accountLabel, setAccountLabel] = useState("");
  const [testProfileChoice, setTestProfileChoice] = useState(CURRENT_TEST_PROFILE);
  const [values, setValues] = useState<Record<string, PageParameterValue>>({});
  const [valueOrigins, setValueOrigins] = useState<Record<string, PageParameterValueOrigin>>({});
  const [parameterView, setParameterView] = useState<"current" | "history">("current");
  const [manualParameterKey, setManualParameterKey] = useState("");
  const [actions, setActions] = useState<PageScenarioAction[]>([]);
  const [assertions, setAssertions] = useState<PageScenarioAssertion[]>([]);
  const [confirmedObservationIds, setConfirmedObservationIds] = useState<Set<string>>(new Set());
  const [pending, setPending] = useState(false);
  const [replayingProfileId, setReplayingProfileId] = useState("");
  const [replayResult, setReplayResult] = useState<PageParameterReplay | null>(null);
  const lastAutoSelectedObservationId = useRef("");
  const replayContextRef = useRef("");
  const replayRequestIdRef = useRef(0);
  const parameterDrafts = useRef<Record<string, PageParameterDraft>>({});
  const parameterProfileRefs = useRef<Record<string, { profileId: string; isDefault: boolean }>>({});
  const actionDrafts = useRef<Record<string, PageScenarioAction[]>>({});
  const adapter = data?.adapter ?? adapterProp;
  const pageReadyEvent = adapter?.pageReadyEvent ?? "";
  const actionSucceededEvent = adapter?.actionSucceededEvent ?? "";

  const load = useCallback(async () => {
    try {
      const next = await fetchPageParameters();
      setData(next);
      setSelectedPageId(previous => previous || next.pages[0]?.pageId || "");
      const active = next.recordings.find(item => ["starting", "recording"].includes(item.status));
      if (active) setActiveRecording(active);
    } catch (error) {
      onMessage({ kind: "error", text: messageOf(error, "无法读取页面参数目录") });
    }
  }, [onMessage]);

  useEffect(() => { void load(); }, [load]);

  useEffect(() => {
    const firstEnvironment = environments[0]?.id;
    if (firstEnvironment && !environments.some(item => item.id === environment)) setEnvironment(firstEnvironment);
  }, [environment, environments]);

  useEffect(() => {
    if (!activeRecording || !["starting", "recording"].includes(activeRecording.status)) return;
    let cancelled = false;
    let timer = 0;
    const poll = async () => {
      try {
        const response = await fetchPageParameterRecording(activeRecording.recordingId);
        if (cancelled) return;
        setActiveRecording(response.recording);
        if (response.recording.status === "failed") onMessage({ kind: "error", text: response.recording.error || "参数录制已中断" });
      } catch (error) {
        if (cancelled) return;
        onMessage({ kind: "error", text: messageOf(error, "读取录制状态失败") });
      } finally {
        if (!cancelled) timer = window.setTimeout(() => void poll(), 1_500);
      }
    };
    timer = window.setTimeout(() => void poll(), 1_500);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [activeRecording, onMessage]);

  const page = data?.pages.find(item => item.pageId === selectedPageId) || null;
  const historyProfiles = useMemo(() => sortPageParameterProfiles(page?.profiles ?? []), [page?.profiles]);
  const connectedDevices = useMemo(() => devices.filter(device => device.connectionState === "available"), [devices]);
  const availableTargets = useMemo(() => targets, [targets]);
  const selectedTestDevice = useMemo(() => resolveSelectedPageTestDevice(devices, deviceKey), [deviceKey, devices]);
  const selectedTarget = useMemo(() => availableTargets.find(target => target.key === targetKey), [availableTargets, targetKey]);
  const selectedExecutionKey = projectFamily === "mini-program" ? targetKey : deviceKey;
  const defaultHistoryProfile = useMemo(
    () => resolveDefaultPageParameterProfile(page?.profiles ?? [], selectedTestDevice?.platform, environment),
    [environment, page?.profiles, selectedTestDevice?.platform],
  );
  const interactionPlatform = useMemo(
    () => resolvePageInteractionPlatform(profilePlatform, selectedTestDevice?.platform),
    [profilePlatform, selectedTestDevice?.platform],
  );
  const actionTargets = useMemo(
    () => pageInteractionTargets(page?.targets, interactionPlatform),
    [interactionPlatform, page?.targets],
  );
  const visiblePages = useMemo(() => {
    const query = pageQuery.trim().toLowerCase();
    return (data?.pages ?? []).filter(item => {
      if (pageFilter === "parameters" && !pageNeedsParameters(item)) return false;
      return !query || item.label.toLowerCase().includes(query) || item.bundle.toLowerCase().includes(query);
    });
  }, [data?.pages, pageFilter, pageQuery]);
  const observations = useMemo(() => activeRecording?.observations ?? [], [activeRecording?.observations]);
  const latestObservations = useMemo(
    () => latestPageObservations(data?.pages ?? [], observations),
    [data?.pages, observations],
  );
  const selectedObservation = observations.find(item => item.observationId === selectedObservationId);
  const latestObservedPage = useMemo(
    () => [...latestObservations.entries()].sort((left, right) => left[1].capturedAt.localeCompare(right[1].capturedAt)).at(-1),
    [latestObservations],
  );
  const pendingObservations = useMemo(
    () => [...latestObservations.entries()].filter(([pageId, observation]) => {
      if (confirmedObservationIds.has(observation.observationId)) return false;
      const targetPage = data?.pages.find(item => item.pageId === pageId);
      return !targetPage?.profiles.some(profile => profile.source === "recording" && profile.recordedAt === observation.capturedAt);
    }),
    [confirmedObservationIds, data?.pages, latestObservations],
  );
  const editorFields = useMemo(() => page ? resolveDraftFields(page, values) : [], [page, values]);

  useEffect(() => {
    if (!latestObservedPage) return;
    const [pageId, observation] = latestObservedPage;
    if (lastAutoSelectedObservationId.current === observation.observationId) return;
    lastAutoSelectedObservationId.current = observation.observationId;
    setSelectedPageId(pageId);
    setSelectedObservationId(observation.observationId);
    const key = editorDraftKey(pageId, observation.observationId);
    setActions(pageInteractionActions(actionDrafts.current[key]));
    const draft = parameterDrafts.current[key];
    setValues(draft?.values ?? {});
    setValueOrigins(draft?.origins ?? {});
    setAssertions(defaultAssertions(pageReadyEvent));
    setProfileId("default");
    setProfileIsDefault(false);
    setScenario("default");
    setProfilePlatform("all");
    setTestProfileChoice(CURRENT_TEST_PROFILE);
    setAccountLabel("");
    setParameterView("current");
    setManualParameterKey("");
    setReplayResult(null);
    if (replayingProfileId) setPending(false);
    setReplayingProfileId("");
    replayRequestIdRef.current += 1;
    replayContextRef.current = pageId;
  }, [latestObservedPage, pageReadyEvent, replayingProfileId]);

  useEffect(() => {
    if (!page) return;
    const pageObservation = selectedObservation?.pageId === page.pageId ? selectedObservation : undefined;
    const key = editorDraftKey(page.pageId, pageObservation?.observationId ?? "");
    const existingDraft = parameterDrafts.current[key];
    let draft = existingDraft;
    let fallbackProfile: PageParameterProfile | undefined;
    if (!draft) {
      if (pageObservation) {
        draft = createObservationParameterDraft(page, pageObservation);
      } else {
        const initial = resolveInitialPageParameterDraft(page, undefined, selectedTestDevice?.platform, environment);
        draft = initial.draft;
        fallbackProfile = initial.profile;
      }
    } else if (!pageObservation) {
      const initial = resolveInitialPageParameterDraft(page, draft, selectedTestDevice?.platform, environment);
      draft = initial.draft;
      fallbackProfile = initial.profile;
    }
    if (draft !== existingDraft) {
      parameterDrafts.current[key] = draft;
    }
    if (!existingDraft || fallbackProfile) {
      setScenario("default");
      setProfilePlatform("all");
      setProfileId(pageObservation ? `recorded-${environment}` : fallbackProfile?.profileId ?? "default");
      setProfileIsDefault(fallbackProfile?.isDefault === true);
      setTestProfileChoice(fallbackProfile?.profileId ?? CURRENT_TEST_PROFILE);
      setAccountLabel("");
      setParameterView("current");
      if (fallbackProfile) {
        parameterProfileRefs.current[key] = { profileId: fallbackProfile.profileId, isDefault: fallbackProfile.isDefault === true };
        setScenario(fallbackProfile.scenario);
        setProfilePlatform(fallbackProfile.platform);
        setAccountLabel(fallbackProfile.accountLabel);
        const nextActions = pageInteractionActions(fallbackProfile.actions);
        actionDrafts.current[key] = nextActions;
        setActions(nextActions);
        setAssertions(fallbackProfile.assertions?.length
          ? fallbackProfile.assertions
          : defaultAssertions(pageReadyEvent));
      }
    } else if (!pageObservation) {
      const restoredProfile = page.profiles.find(profile => profile.profileId === parameterProfileRefs.current[key]?.profileId);
      if (restoredProfile) {
        setProfileId(restoredProfile.profileId);
        setProfileIsDefault(restoredProfile.isDefault === true);
        setScenario(restoredProfile.scenario);
        setProfilePlatform(restoredProfile.platform);
        setAccountLabel(restoredProfile.accountLabel);
      }
    }
    setValues(draft.values);
    setValueOrigins(draft.origins);
  }, [environment, page, pageReadyEvent, selectedObservation, selectedTestDevice?.platform]);

  const updateValue = (key: string, patch: Partial<PageParameterValue>) => {
    setValues(previous => {
      const next = { ...previous, [key]: { ...previous[key], ...patch } };
      const nextOrigins = { ...valueOrigins, [key]: "manual" as const };
      parameterDrafts.current[editorDraftKey(selectedPageId, selectedObservationId)] = {
        values: next,
        origins: nextOrigins,
      };
      setValueOrigins(nextOrigins);
      setTestProfileChoice(CURRENT_TEST_PROFILE);
      setProfileIsDefault(false);
      return next;
    });
  };

  const addSuggestedField = (field: PageParameterPage["fields"][number]) => {
    if (Object.prototype.hasOwnProperty.call(values, field.key)) {
      setParameterView("current");
      return;
    }
    const nextValues = {
      ...values,
      [field.key]: {
        strategy: field.sensitive ? "secretRef" as const : "literal" as const,
        value: "",
      },
    };
    const nextOrigins = { ...valueOrigins, [field.key]: "suggested" as const };
    saveParameterDraft(nextValues, nextOrigins);
    setTestProfileChoice(CURRENT_TEST_PROFILE);
    setProfileIsDefault(false);
    setParameterView("current");
  };

  const addManualField = (rawKey: string = manualParameterKey) => {
    const key = rawKey.trim();
    if (!key) {
      onMessage({ kind: "error", text: "请输入参数键" });
      return;
    }
    if (!isValidPageParameterKey(key)) {
      onMessage({ kind: "error", text: "参数键只支持字母、数字、下划线、点和连字符，且需以字母或下划线开头" });
      return;
    }
    if (Object.prototype.hasOwnProperty.call(values, key)) {
      setParameterView("current");
      onMessage({ kind: "info", text: `参数 ${key} 已在当前测试中` });
      return;
    }
    const nextValues = {
      ...values,
      [key]: { strategy: "literal" as const, value: "" },
    };
    const nextOrigins = { ...valueOrigins, [key]: "manual" as const };
    saveParameterDraft(nextValues, nextOrigins);
    setManualParameterKey("");
    setTestProfileChoice(CURRENT_TEST_PROFILE);
    setProfileIsDefault(false);
    setParameterView("current");
  };

  const removeValue = (key: string) => {
    const nextValues = { ...values };
    const nextOrigins = { ...valueOrigins };
    delete nextValues[key];
    delete nextOrigins[key];
    saveParameterDraft(nextValues, nextOrigins);
    setTestProfileChoice(CURRENT_TEST_PROFILE);
    setProfileIsDefault(false);
  };

  const applyHistoricalProfile = (profile: PageParameterProfile) => {
    const applied = replaceDraftFromProfile(profile);
    saveParameterDraft(applied.values, applied.origins);
    replaceActions(() => pageInteractionActions(profile.actions));
    setAssertions(profile.assertions?.length
      ? profile.assertions
      : defaultAssertions(pageReadyEvent));
    setProfileId(profile.profileId);
    setProfileIsDefault(profile.isDefault === true);
    parameterProfileRefs.current[editorDraftKey(selectedPageId, selectedObservationId)] = {
      profileId: profile.profileId,
      isDefault: profile.isDefault === true,
    };
    // 完整应用历史画像后直接回放该画像；后续手动修改会切回当前草稿。
    setTestProfileChoice(profile.profileId);
    setScenario(profile.scenario);
    setProfilePlatform(profile.platform);
    setAccountLabel(profile.accountLabel);
    setParameterView("current");
    onMessage({
      kind: "info",
      text: `已应用 ${profile.profileId} 的全部历史参数，可直接测试或继续编辑`,
    });
  };

  const selectTestProfile = (selection: string) => {
    setTestProfileChoice(selection);
  };

  const saveParameterDraft = (
    nextValues: Record<string, PageParameterValue>,
    nextOrigins: Record<string, PageParameterValueOrigin>,
  ) => {
    parameterDrafts.current[editorDraftKey(selectedPageId, selectedObservationId)] = {
      values: nextValues,
      origins: nextOrigins,
    };
    setValues(nextValues);
    setValueOrigins(nextOrigins);
  };

  const selectPage = (pageId: string, observationId = latestObservations.get(pageId)?.observationId ?? "") => {
    setSelectedPageId(pageId);
    setSelectedObservationId(observationId);
    const key = editorDraftKey(pageId, observationId);
    setActions(pageInteractionActions(actionDrafts.current[key]));
    const draft = parameterDrafts.current[key];
    setValues(draft?.values ?? {});
    setValueOrigins(draft?.origins ?? {});
    setAssertions(defaultAssertions(pageReadyEvent));
    setProfileId("default");
    setProfileIsDefault(false);
    setScenario("default");
    setProfilePlatform("all");
    setTestProfileChoice(CURRENT_TEST_PROFILE);
    setAccountLabel("");
    setParameterView("current");
    setManualParameterKey("");
    setReplayResult(null);
    if (replayingProfileId) setPending(false);
    setReplayingProfileId("");
    replayRequestIdRef.current += 1;
    replayContextRef.current = pageId;
  };

  const replaceActions = (update: (previous: PageScenarioAction[]) => PageScenarioAction[]) => {
    setActions(previous => {
      const next = update(previous);
      actionDrafts.current[editorDraftKey(selectedPageId, selectedObservationId)] = next;
      return next;
    });
    setTestProfileChoice(CURRENT_TEST_PROFILE);
    setProfileIsDefault(false);
  };

  const addAction = (targetId = actionTargets[0]?.id ?? "") => {
    const target = actionTargets.find(item => item.id === targetId);
    const catalogTarget = page?.targets?.find(item => item.id === targetId);
    if (!target || !catalogTarget) return;
    const actionType = target.actions[0] ?? "tap";
    const supportedPlatforms = pageTargetActionPlatforms(catalogTarget, actionType);
    if (profilePlatform === "all" && supportedPlatforms.length < PLATFORMS.length) {
      const preferredPlatform = selectedTestDevice && supportedPlatforms.includes(selectedTestDevice.platform)
        ? selectedTestDevice.platform
        : supportedPlatforms[0];
      if (preferredPlatform) setProfilePlatform(preferredPlatform);
    }
    replaceActions(previous => [...previous, {
      type: actionType,
      target: target.id,
      value: "",
      assertions: createPageActionDefaultAssertions(catalogTarget),
    }]);
  };

  const addWaitAction = () => {
    const target = page?.assertionTargets?.[0] ?? actionTargets[0]?.id ?? "";
    if (!target) return;
    replaceActions(previous => [...previous, {
      type: "waitFor",
      target,
      timeoutMs: 10_000,
      assertions: [{ type: "visible", target }],
    }]);
  };

  const updateAction = (index: number, patch: Partial<PageScenarioAction>) => {
    replaceActions(previous => previous.map((action, actionIndex) => actionIndex === index ? { ...action, ...patch } : action));
  };

  const addActionAssertion = (actionIndex: number) => {
    replaceActions(previous => previous.map((action, index) => index === actionIndex
      ? { ...action, assertions: [...(action.assertions ?? []), defaultAssertion(page?.assertionTargets, actionSucceededEvent)] }
      : action));
  };

  const updateActionAssertion = (actionIndex: number, assertionIndex: number, next: PageScenarioAssertion) => {
    replaceActions(previous => previous.map((action, index) => index === actionIndex
      ? { ...action, assertions: (action.assertions ?? []).map((assertion, currentIndex) => currentIndex === assertionIndex ? next : assertion) }
      : action));
  };

  const removeActionAssertion = (actionIndex: number, assertionIndex: number) => {
    replaceActions(previous => previous.map((action, index) => index === actionIndex
      ? { ...action, assertions: (action.assertions ?? []).filter((_, currentIndex) => currentIndex !== assertionIndex) }
      : action));
  };

  const replaceAssertions = (update: (previous: PageScenarioAssertion[]) => PageScenarioAssertion[]) => {
    setAssertions(previous => update(previous));
    setTestProfileChoice(CURRENT_TEST_PROFILE);
    setProfileIsDefault(false);
  };

  const addAssertion = () => {
    replaceAssertions(previous => [...previous, defaultAssertion(page?.assertionTargets, pageReadyEvent)]);
  };

  const handleStart = async () => {
    if (!selectedExecutionKey) return onMessage({ kind: "error", text: projectFamily === "mini-program" ? "请选择小程序运行目标" : "请选择录制设备" });
    setPending(true);
    try {
      const response = await startPageParameterRecording({
        environment,
        ...(projectFamily === "mini-program" ? { targetKey: selectedExecutionKey } : { deviceKey: selectedExecutionKey }),
      });
      setActiveRecording(response.recording);
      setSelectedObservationId("");
      setConfirmedObservationIds(new Set());
      lastAutoSelectedObservationId.current = "";
      parameterDrafts.current = {};
      actionDrafts.current = {};
      setActions([]);
      onMessage({ kind: "info", text: "页面参数录制已开始" });
      await load();
    } catch (error) {
      onMessage({ kind: "error", text: messageOf(error, "启动参数录制失败") });
    } finally {
      setPending(false);
    }
  };

  const handleStop = async () => {
    if (!activeRecording) return;
    setPending(true);
    try {
      const response = await stopPageParameterRecording(activeRecording.recordingId);
      setActiveRecording(response.recording);
      onMessage({ kind: "info", text: `录制已停止，共捕获 ${response.recording.observations.length} 个页面` });
      await load();
    } catch (error) {
      onMessage({ kind: "error", text: messageOf(error, "停止参数录制失败") });
    } finally {
      setPending(false);
    }
  };

  const currentProfileInput = (): SavePageParameterProfileRequest => ({
    scenario,
    platform: profilePlatform,
    ...(profileIsDefault ? { isDefault: true } : {}),
    environment,
    accountLabel,
    values,
    capturedKeys: selectedObservation ? Object.keys(selectedObservation.values) : undefined,
    navigation: selectedObservation?.navigation ?? page?.navigation ?? defaultNavigation(page?.bundle || page?.pageId || "", adapter),
    actions,
    assertions,
    source: selectedObservation ? "recording" : "manual",
    recordedAt: selectedObservation?.capturedAt,
  });

  const handleSave = async () => {
    if (!page) return;
    setPending(true);
    try {
      const response = await savePageParameterProfile(page.pageId, profileId, currentProfileInput());
      setProfileIsDefault(response.profile.isDefault === true);
      parameterProfileRefs.current[editorDraftKey(selectedPageId, selectedObservationId)] = {
        profileId: response.profile.profileId,
        isDefault: response.profile.isDefault === true,
      };
      if (selectedObservation) {
        setConfirmedObservationIds(previous => new Set(previous).add(selectedObservation.observationId));
      }
      onMessage({ kind: "info", text: `${page.label} 参数画像已保存` });
      await load();
    } catch (error) {
      onMessage({ kind: "error", text: messageOf(error, "保存参数画像失败") });
    } finally {
      setPending(false);
    }
  };

  const handleTestCurrentPage = async () => {
    if (!page) return;
    if (!selectedTestDevice && !selectedTarget) return onMessage({ kind: "error", text: projectFamily === "mini-program" ? "请选择一个运行目标测试页面" : "请选择一台可用设备测试页面" });
    const selectedProfile = testProfileChoice === CURRENT_TEST_PROFILE
      ? undefined
      : page.profiles.find(profile => profile.profileId === testProfileChoice);
    const fallbackProfile = !selectedProfile && shouldUseHistoricalPageParameterProfile({ values, origins: valueOrigins })
      ? defaultHistoryProfile
      : undefined;
    const effectiveProfile = selectedProfile ?? fallbackProfile;
    const effectivePlatform = effectiveProfile?.platform ?? profilePlatform;
    if (selectedTestDevice && effectivePlatform !== "all" && effectivePlatform !== selectedTestDevice.platform) {
      return onMessage({ kind: "error", text: `参数画像平台为 ${pagePlatformLabel(effectivePlatform)}，当前设备为 ${selectedTestDevice.platform}，请切换设备或画像平台` });
    }
    const testProfileId = effectiveProfile?.profileId ?? profileId;
    const replayContext = `${page.pageId}:${testProfileId}`;
    const requestId = replayRequestIdRef.current + 1;
    replayRequestIdRef.current = requestId;
    replayContextRef.current = replayContext;
    setPending(true);
    setReplayingProfileId(testProfileId);
    setReplayResult(null);
    try {
      if (!effectiveProfile) {
        const response = await savePageParameterProfile(page.pageId, profileId, currentProfileInput());
        setProfileIsDefault(response.profile.isDefault === true);
        parameterProfileRefs.current[editorDraftKey(selectedPageId, selectedObservationId)] = {
          profileId: response.profile.profileId,
          isDefault: response.profile.isDefault === true,
        };
      }
      if (fallbackProfile) {
        setTestProfileChoice(fallbackProfile.profileId);
        onMessage({ kind: "info", text: `当前路由参数为空，已使用${fallbackProfile.isDefault ? "默认" : "最近"}历史画像 ${fallbackProfile.profileId}` });
      }
      const response = await replayPageParameterProfile(page.pageId, testProfileId, projectFamily === "mini-program"
        ? { targetKey: selectedTarget!.key }
        : { deviceKey: selectedTestDevice!.key });
      if (requestId !== replayRequestIdRef.current || replayContextRef.current !== replayContext) return;
      setReplayResult(response.replay);
      onMessage({
        kind: response.replay.status === "passed" ? "info" : "error",
        text: response.replay.status === "passed" ? `${page.label} 页面测试通过` : `${page.label} 页面测试失败`,
      });
      await load();
    } catch (error) {
      if (requestId !== replayRequestIdRef.current || replayContextRef.current !== replayContext) return;
      onMessage({ kind: "error", text: messageOf(error, "页面测试失败") });
    } finally {
      if (requestId === replayRequestIdRef.current) {
        setPending(false);
        setReplayingProfileId("");
      }
    }
  };

  const handleDelete = async (targetPage: PageParameterPage, targetProfileId: string) => {
    setPending(true);
    try {
      await deletePageParameterProfile(targetPage.pageId, targetProfileId);
      if (targetPage.pageId === selectedPageId && targetProfileId === profileId) {
        setProfileId("default");
      }
      if (targetPage.pageId === selectedPageId && targetProfileId === testProfileChoice) {
        setTestProfileChoice(CURRENT_TEST_PROFILE);
      }
      onMessage({ kind: "info", text: "参数画像已删除" });
      await load();
    } catch (error) {
      onMessage({ kind: "error", text: messageOf(error, "删除参数画像失败") });
    } finally {
      setPending(false);
    }
  };

  const handleSetDefault = async (targetPage: PageParameterPage, targetProfileId: string) => {
    const targetProfile = targetPage.profiles.find(profile => profile.profileId === targetProfileId);
    if (!targetProfile) return;
    const nextIsDefault = targetProfile.isDefault !== true;
    setPending(true);
    try {
      await setDefaultPageParameterProfile(targetPage.pageId, targetProfileId, nextIsDefault);
      if (targetPage.pageId === selectedPageId && targetProfileId === profileId) {
        setProfileIsDefault(nextIsDefault);
        const key = editorDraftKey(selectedPageId, selectedObservationId);
        if (parameterProfileRefs.current[key]?.profileId === targetProfileId) {
          parameterProfileRefs.current[key] = { profileId: targetProfileId, isDefault: nextIsDefault };
        }
      }
      onMessage({ kind: "info", text: nextIsDefault ? "默认参数画像已更新" : "已取消默认参数画像" });
      await load();
    } catch (error) {
      onMessage({ kind: "error", text: messageOf(error, "设置默认参数失败") });
    } finally {
      setPending(false);
    }
  };

  const handleReplay = async (targetPage: PageParameterPage, profile: PageParameterProfile) => {
    const device = profile.platform === "all"
      ? connectedDevices.find(item => item.key === deviceKey) ?? connectedDevices[0]
      : connectedDevices.find(item => item.key === deviceKey && item.platform === profile.platform)
        ?? connectedDevices.find(item => item.platform === profile.platform);
    if (projectFamily === "mini-program" && selectedTarget) {
      const replayContext = `${targetPage.pageId}:${profile.profileId}:${selectedTarget.key}`;
      const requestId = replayRequestIdRef.current + 1;
      replayRequestIdRef.current = requestId;
      replayContextRef.current = replayContext;
      setReplayingProfileId(profile.profileId);
      setReplayResult(null);
      try {
        const response = await replayPageParameterProfile(targetPage.pageId, profile.profileId, { targetKey: selectedTarget.key });
        if (requestId !== replayRequestIdRef.current || replayContextRef.current !== replayContext) return;
        setReplayResult(response.replay);
        onMessage({
          kind: response.replay.status === "passed" ? "info" : "error",
          text: response.replay.status === "passed" ? `${targetPage.label} 单页面回放通过` : `${targetPage.label} 单页面回放失败`,
        });
      } catch (error) {
        if (requestId !== replayRequestIdRef.current || replayContextRef.current !== replayContext) return;
        onMessage({ kind: "error", text: messageOf(error, "单页面回放失败") });
      } finally {
        if (requestId === replayRequestIdRef.current) setReplayingProfileId("");
      }
      return;
    }
    if (!device) return onMessage({ kind: "error", text: profile.platform === "all" ? "请选择一台可用设备进行回放" : `请选择一台可用的 ${profile.platform} 设备进行回放` });
    const replayContext = `${targetPage.pageId}:${profile.profileId}`;
    const requestId = replayRequestIdRef.current + 1;
    replayRequestIdRef.current = requestId;
    replayContextRef.current = replayContext;
    setReplayingProfileId(profile.profileId);
    setReplayResult(null);
    try {
      const response = await replayPageParameterProfile(targetPage.pageId, profile.profileId, { deviceKey: device.key });
      if (requestId !== replayRequestIdRef.current || replayContextRef.current !== replayContext) return;
      setReplayResult(response.replay);
      onMessage({
        kind: response.replay.status === "passed" ? "info" : "error",
        text: response.replay.status === "passed" ? `${targetPage.label} 单页面回放通过` : `${targetPage.label} 单页面回放失败`,
      });
    } catch (error) {
      if (requestId !== replayRequestIdRef.current || replayContextRef.current !== replayContext) return;
      onMessage({ kind: "error", text: messageOf(error, "单页面回放失败") });
    } finally {
      if (requestId === replayRequestIdRef.current) setReplayingProfileId("");
    }
  };

  const counts = useMemo(() => ({
    total: data?.pages.length ?? 0,
    withParameters: data?.pages.filter(pageNeedsParameters).length ?? 0,
  }), [data]);
  const suggestedFields = (page?.fields ?? []).filter(field => !Object.prototype.hasOwnProperty.call(values, field.key));
  const parameterPresets = page ? pageParameterPresets(page).filter(field => !Object.prototype.hasOwnProperty.call(values, field.key)) : [];
  const requiredFieldCount = editorFields.filter(field => field.required).length;
  const actionAssertionCount = actions.reduce((total, action) => total + (action.assertions?.length ?? 0), 0);
  const activeTestProfileId = testProfileChoice === CURRENT_TEST_PROFILE ? profileId : testProfileChoice;

  return <div className="parameter-workspace">
    <section className="section-panel parameter-catalog">
      <div className="section-heading"><div><p className="eyebrow">PAGE CATALOG</p><h2>页面列表</h2></div><span className="count-label">{data?.pages.length ?? 0} 页</span></div>
      <div className="parameter-catalog-tools">
        <label className="parameter-page-search"><Search size={14} /><input aria-label="搜索页面" value={pageQuery} onChange={event => setPageQuery(event.target.value)} placeholder="搜索页面或 bundle" /></label>
        <div className="parameter-page-filter" aria-label="页面参数筛选">
          <button type="button" className={pageFilter === "all" ? "active" : ""} onClick={() => setPageFilter("all")}>全部 {counts.total}</button>
          <button type="button" className={pageFilter === "parameters" ? "active" : ""} onClick={() => setPageFilter("parameters")}>需参数 {counts.withParameters}</button>
        </div>
      </div>
      <div className="parameter-page-list">
        {!data && <div className="empty-state"><LoaderCircle className="spin" size={20} />正在加载</div>}
        {data && visiblePages.length === 0 && <div className="empty-state">未找到匹配页面</div>}
        {visiblePages.map(item => {
          const draft = latestObservations.get(item.pageId);
          const hasPendingDraft = pendingObservations.some(([pageId]) => pageId === item.pageId);
          const needsParameters = pageNeedsParameters(item);
          const dynamicParameters = pageUsesDynamicParameters(item);
          const requiredParameters = item.fields.filter(field => field.required).length;
          const actionCount = pageInteractionTargets(item.targets).length;
          const statusClass = hasPendingDraft ? "pending" : needsParameters ? item.status : "ready";
          return <button key={item.pageId} type="button" className={`parameter-page-row ${item.pageId === page?.pageId ? "active" : ""}`} onClick={() => selectPage(item.pageId)}>
          <span className={`parameter-status-dot ${statusClass}`} />
          <span><strong>{item.label}</strong><small>{item.bundle}</small><small className="parameter-required-label"><Braces size={11} />{requiredParameters > 0 ? `${requiredParameters} 必填 · ` : ""}{dynamicParameters ? "动态参数" : `${item.fields.length} 参数`} · {actionCount > 0 ? `${actionCount} 动作` : "交互待注入"}</small></span>
          <em className={`parameter-status ${statusClass}`}>{hasPendingDraft ? `${Object.keys(draft?.values ?? {}).length} 个待确认` : needsParameters ? statusLabels[item.status] : "可直接测试"}</em>
        </button>;
        })}
      </div>
      {(data?.warnings.length ?? 0) > 0 && <details className="parameter-warnings"><summary><AlertCircle size={14} /> {data!.warnings.length} 条扫描提示</summary><div>{data!.warnings.map(warning => <p key={warning}>{warning}</p>)}</div></details>}
    </section>

    <div className="parameter-main">
      <section className="section-panel recording-panel">
        <div className="section-heading"><div><p className="eyebrow">RECORD & TEST</p><h2>录制与测试</h2></div>{activeRecording && <span className={`recording-state ${activeRecording.status}`}><CircleDot size={11} />{activeRecording.status === "recording" ? "录制中" : activeRecording.status}</span>}</div>
        <div className="recording-controls">
          {projectFamily === "mini-program"
            ? <label className="field"><span>小程序目标</span><select value={targetKey} onChange={event => setTargetKey(event.target.value)} disabled={Boolean(activeRecording && activeRecording.status === "recording")}><option value="">选择运行目标</option>{availableTargets.map(target => <option key={target.key} value={target.key}>{target.label} · {target.platform} · {target.appId}</option>)}</select></label>
            : <label className="field"><span>设备</span><select value={deviceKey} onChange={event => setDeviceKey(event.target.value)} disabled={Boolean(activeRecording && activeRecording.status === "recording")}><option value="">选择设备</option>{connectedDevices.map(device => <option key={device.key} value={device.key}>{device.name} · {device.platform}</option>)}</select></label>}
          <label className="field"><span>环境</span><select value={environment} onChange={event => setEnvironment(event.target.value)} disabled={Boolean(activeRecording && activeRecording.status === "recording")}>{(environments.length > 0 ? environments : [{ id: "qa", label: "QA" }, { id: "staging", label: "Staging" }, { id: "production", label: "Production" }]).map(item => <option key={item.id} value={item.id}>{item.label}</option>)}</select></label>
          {activeRecording && ["starting", "recording"].includes(activeRecording.status)
            ? <button className="stop-button recording-command" type="button" onClick={() => void handleStop()} disabled={pending}><Square size={14} fill="currentColor" />停止</button>
            : <button className="primary-button recording-command" type="button" onClick={() => void handleStart()} disabled={pending || !selectedExecutionKey}><Radio size={15} />开始录制</button>}
          {page && <button className="primary-button recording-command page-test-command" type="button" onClick={() => void handleTestCurrentPage()} disabled={pending || Boolean(replayingProfileId) || (!selectedTestDevice && !selectedTarget) || !activeTestProfileId || !scenario}>{replayingProfileId === activeTestProfileId ? <LoaderCircle className="spin" size={15} /> : <Play size={15} />}{replayingProfileId === activeTestProfileId ? "测试中" : "测试当前页面"}</button>}
        </div>
        {page && <div className="page-test-block result-block">
          <div className="scenario-editor-heading"><div><strong>测试结果</strong><small>{page.label} · 参数画像在这里选择，{projectFamily === "mini-program" ? "运行目标" : "设备"}使用上方共享选择</small></div><span className="count-label">{actions.length} 动作 · {assertions.length + actionAssertionCount} 断言</span></div>
          <div className="page-test-controls">
        <label className="field"><span>测试参数</span><select aria-label="测试参数画像" value={testProfileChoice} onChange={event => selectTestProfile(event.target.value)}><option value={CURRENT_TEST_PROFILE}>当前编辑参数 · {profileId || "未命名"}{!hasUsablePageParameterValues(values) && defaultHistoryProfile ? `（空值时使用 ${defaultHistoryProfile.profileId}）` : ""}</option>{historyProfiles.map(profile => <option key={profile.profileId} value={profile.profileId}>{profile.profileId}{profile.isDefault ? " · 默认" : ""} · {profile.scenario} · {pagePlatformLabel(profile.platform)}</option>)}</select></label>
          </div>
          {replayResult
            ? <details className={`page-replay-result ${replayResult.status}`} open>
              <summary><strong>{replayResult.status === "passed" ? "页面测试通过" : "页面测试失败"}</strong><small>{replayResult.profileId} · {formatDateTime(replayResult.finishedAt)}</small></summary>
              {replayResult.summary && <div className="replay-summary-grid">
                <span><strong>{replayResult.summary.pageOpened ? "已打开" : "打开失败"}</strong><small>页面状态</small></span>
                <span><strong>{replayResult.summary.actionPassed}/{replayResult.summary.actionCount}</strong><small>动作通过</small></span>
                <span><strong>{replayResult.summary.assertionPassed}/{replayResult.summary.assertionCount}</strong><small>断言通过</small></span>
              </div>}
              {replayResult.summary?.missingEvents.length ? <p className="replay-summary-warning">缺少事件：{replayResult.summary.missingEvents.join("、")}</p> : null}
              {replayResult.summary?.steps.length ? <div className="replay-step-list">{replayResult.summary.steps.map(step => <div className={`replay-step ${step.status}`} key={`${step.kind}-${step.index}`}><span>{step.index}</span><strong>{step.type}</strong><small>{step.target || step.message || step.kind}</small><em>{step.status}</em></div>)}</div> : null}
              {replayResult.error && <pre className="page-replay-error">{replayResult.error}</pre>}
              {replayResult.output && <details className="replay-output"><summary>查看 runner 输出</summary><pre>{replayResult.output}</pre></details>}
            </details>
            : <div className="page-test-result-empty">运行后在这里查看页面打开、交互和断言结果</div>}
        </div>}
        <div className="recording-result" aria-live="polite">
          <div className="scenario-editor-heading">
            <div><strong>录制结果</strong><small>设备上报的页面路由参数捕获</small></div>
            <span className="count-label">{latestObservations.size} 页面</span>
          </div>
          {observations.length === 0
            ? <div className="recording-result-empty">等待设备打开页面并上报参数</div>
            : <div className="recording-result-summary">
              <span><strong>{latestObservations.size}</strong><small>已捕获页面</small></span>
              <span><strong>{pendingObservations.reduce((total, [, item]) => total + Object.keys(item.values).length, 0)}</strong><small>待确认参数</small></span>
            </div>}
        </div>
      </section>

      {page && <section className="section-panel profile-editor">
        <div className="section-heading"><div><p className="eyebrow">PAGE TEST</p><h2>{page.label}</h2></div><span className={`parameter-status ${pageNeedsParameters(page) ? page.status : "ready"}`}>{pageNeedsParameters(page) ? statusLabels[page.status] : "无需参数"}</span></div>
        <details className="profile-settings">
          <summary>测试配置 <span>{profileId} · {scenario}</span></summary>
          <div className="profile-meta-grid">
            <label className="field"><span>画像 ID</span><input value={profileId} onChange={event => { setProfileId(event.target.value.replace(/[^a-zA-Z0-9._-]/g, "")); setTestProfileChoice(CURRENT_TEST_PROFILE); }} /></label>
            <label className="field"><span>场景</span><input value={scenario} onChange={event => { setScenario(event.target.value); setTestProfileChoice(CURRENT_TEST_PROFILE); }} /></label>
            <label className="field"><span>适用平台</span><select value={profilePlatform} onChange={event => { setProfilePlatform(event.target.value as PageParameterPlatform); setTestProfileChoice(CURRENT_TEST_PROFILE); }}><option value="all">全部平台</option><option value="android">Android</option><option value="ios">iOS</option><option value="harmony">HarmonyOS</option></select></label>
            <label className="field"><span>账号标签</span><input value={accountLabel} onChange={event => { setAccountLabel(event.target.value); setTestProfileChoice(CURRENT_TEST_PROFILE); }} /></label>
          </div>
        </details>

        <div className="page-test-block page-open-block">
          <div className="scenario-editor-heading"><div><strong>1. 页面参数列表</strong><small>{page.navigation?.route ?? adapter?.defaultRoute ?? ""} · {page.bundle}</small></div><span className="count-label">{requiredFieldCount} 必填 · {editorFields.length} 已用</span></div>
        <div className="parameter-source-tabs compact" role="tablist" aria-label="路由参数视图">
          <button type="button" role="tab" aria-selected={parameterView === "current"} className={parameterView === "current" ? "active" : ""} onClick={() => setParameterView("current")}><Braces size={14} />当前路由参数 <span>{editorFields.length}</span></button>
          <button type="button" role="tab" aria-selected={parameterView === "history"} className={parameterView === "history" ? "active" : ""} onClick={() => setParameterView("history")}><History size={14} />历史数据 <span>{page.profiles.length}</span></button>
        </div>

        {parameterView === "current" && <div className="parameter-source-panel" role="tabpanel">
          {selectedObservation?.rawData && <details className="raw-observation-details">
            <summary>录制来源 · {formatDateTime(selectedObservation.capturedAt)}</summary>
            <pre>{formatRawData(selectedObservation.rawData)}</pre>
          </details>}
          {editorFields.length === 0 && <div className="parameter-source-empty">{pageUsesDynamicParameters(page) ? "当前页面参数为动态参数，请手动添加后编辑" : "当前页面代码未读取路由参数，可直接测试打开"}</div>}
          {editorFields.length > 0 && <div className="parameter-field-list">
              <div className="parameter-field-columns" aria-hidden="true"><span>参数</span><span>取值方式</span><span>参数值</span><span /></div>
              {editorFields.map(field => <div className="parameter-field-row" key={field.key}>
                <span className="parameter-field-name"><strong>{field.key}</strong><small>{originLabels[valueOrigins[field.key] ?? "suggested"]} · {fieldRequirementLabel(field)}{field.sensitive ? " · 敏感" : ""}</small></span>
                <select aria-label={`${field.key} 取值策略`} value={values[field.key]?.strategy || "literal"} onChange={event => updateValue(field.key, { strategy: event.target.value as PageParameterValueStrategy })}>{field.strategies.map(strategy => <option key={strategy} value={strategy}>{strategy}</option>)}</select>
                <input aria-label={`${field.key} 参数值`} value={values[field.key]?.value || ""} onChange={event => updateValue(field.key, { value: event.target.value })} placeholder={field.sensitive ? "密钥引用名" : field.required ? "必填参数值" : "参数值"} />
                <button type="button" className="parameter-remove-button" aria-label={`移除 ${field.key}`} title="从当前测试移除" onClick={() => removeValue(field.key)} disabled={field.required && (field.alternatives?.length ?? 0) < 2}><X size={14} /></button>
              </div>)}
            </div>}
          {pageUsesDynamicParameters(page) && <div className="manual-parameter-editor">
            <div className="manual-parameter-heading"><div><strong>手动添加动态参数</strong><small>输入参数 key 后加入当前测试</small></div></div>
            <div className="manual-parameter-controls">
              <input aria-label="新增参数键" value={manualParameterKey} onChange={event => setManualParameterKey(event.target.value)} onKeyDown={event => { if (event.key === "Enter") addManualField(); }} placeholder="参数键，例如 image_url" />
              <button type="button" className="contract-add-button" onClick={() => addManualField()}><Plus size={14} />加入测试</button>
            </div>
          </div>}
          {parameterPresets.length > 0 && <details className="parameter-suggestions" open>
            <summary>imageDialog 常用参数 <span>{parameterPresets.length}</span></summary>
            <div className="contract-field-list">
              {parameterPresets.map(field => <div className="contract-field-row" key={field.key}>
                <span className="parameter-field-name"><strong>{field.key}</strong><small>{field.required ? "必填" : "可选"}</small></span>
                <span className="contract-field-description">{field.description}</span>
                <button type="button" className="contract-add-button" onClick={() => addManualField(field.key)}><Plus size={14} />加入测试</button>
              </div>)}
            </div>
          </details>}
          {defaultHistoryProfile && <div className="latest-history-card">
            <div className="latest-history-heading"><div><strong>{defaultHistoryProfile.isDefault ? "默认历史参数" : "最近历史参数"}</strong><small>{defaultHistoryProfile.profileId} · {defaultHistoryProfile.scenario} · {pagePlatformLabel(defaultHistoryProfile.platform)} · {formatDateTime(defaultHistoryProfile.recordedAt)}</small></div><button type="button" className="history-apply-button" onClick={() => applyHistoricalProfile(defaultHistoryProfile)} disabled={pending}><History size={13} />使用这组参数</button></div>
            <div className="latest-history-values">
              {Object.entries(defaultHistoryProfile.values).slice(0, 4).map(([key, value]) => <span key={key}><code>{key}</code><code>{profileValueLabel(value)}</code></span>)}
              {Object.keys(defaultHistoryProfile.values).length > 4 && <small>还有 {Object.keys(defaultHistoryProfile.values).length - 4} 个参数，可在历史数据中查看</small>}
            </div>
          </div>}
          {suggestedFields.length > 0 && <details className="parameter-suggestions">
            <summary>代码读取到的其他参数 <span>{suggestedFields.length}</span></summary>
            <div className="contract-field-list">
              {suggestedFields.map(field => <div className="contract-field-row" key={field.key}>
                <span className="parameter-field-name"><strong>{field.key}</strong><small>{fieldRequirementLabel(field)}{field.sensitive ? " · 敏感" : ""}</small></span>
                <span className="contract-field-description">{field.description}</span>
                <button type="button" className="contract-add-button" onClick={() => addSuggestedField(field)}><Plus size={14} />加入测试</button>
              </div>)}
            </div>
          </details>}
        </div>}

        {parameterView === "history" && <div className="parameter-source-panel" role="tabpanel">
          <div className="parameter-field-heading"><div><strong>历史路由参数</strong><small>按页面、平台和环境保存</small></div><span className="count-label">{page.profiles.length} 份</span></div>
          {page.profiles.length === 0
            ? <div className="parameter-source-empty">当前页面暂无历史参数画像</div>
            : <div className="history-profile-list">
              {historyProfiles.map(profile => <div className="history-profile" key={profile.profileId}>
                <div className="history-profile-main">
                  <Database size={14} />
                  <span><strong>{profile.profileId}{profile.isDefault ? " · 默认" : ""}</strong><small>{profile.scenario} · {pagePlatformLabel(profile.platform)} · {profile.environment} · {formatDateTime(profile.recordedAt)}</small></span>
                  <button type="button" className="history-apply-button" onClick={() => applyHistoricalProfile(profile)} disabled={pending}><Plus size={13} />用于当前测试</button>
                  <button type="button" className="history-replay-button" onClick={() => void handleReplay(page, profile)} disabled={pending || Boolean(replayingProfileId)}><Play size={13} />{replayingProfileId === profile.profileId ? "测试中" : "直接测试"}</button>
                  <button type="button" className={`history-default-button${profile.isDefault ? " active" : ""}`} aria-label={`${profile.isDefault ? "取消默认" : "设为默认"} ${profile.profileId}`} title={profile.isDefault ? "取消默认参数" : "设为默认参数"} onClick={() => void handleSetDefault(page, profile.profileId)} disabled={pending}><Star size={14} fill={profile.isDefault ? "currentColor" : "none"} /></button>
                  <button type="button" className="history-delete-button" aria-label={`删除 ${profile.profileId}`} title="删除画像" onClick={() => void handleDelete(page, profile.profileId)} disabled={pending}><Trash2 size={14} /></button>
                </div>
                <div className="history-profile-values">
                  {Object.entries(profile.values).map(([key, value]) => <span key={key}><code>{key}</code><code>{profileValueLabel(value)}</code></span>)}
                </div>
              </div>)}
            </div>}
        </div>}

        <div className="scenario-editor-heading assertion-heading"><div><strong>打开验证</strong><small>页面加载完成后验证</small></div><button type="button" className="icon-command" title="添加打开断言" aria-label="添加打开断言" onClick={addAssertion}><Plus size={15} /></button></div>
        <div className="scenario-step-list">
          {assertions.map((assertion, index) => <AssertionEditor key={`${index}-${assertion.type}`} assertion={assertion} index={index} targets={page.assertionTargets ?? []} label="打开断言" onChange={next => replaceAssertions(previous => previous.map((item, assertionIndex) => assertionIndex === index ? next : item))} onRemove={() => replaceAssertions(previous => previous.filter((_, assertionIndex) => assertionIndex !== index))} />)}
        </div>
        </div>

        <div className="page-test-block interaction-block">
          <div className="scenario-editor-heading"><div><strong>2. 页面交互</strong><small>通过 QA 注入脚本与客户端协商，使用语义目标和响应断言执行</small></div><span className="count-label">{actionTargets.length} 目标 · {actions.length} 步</span></div>
          <div className="page-target-list">
            {actionTargets.map(target => <button type="button" key={target.id} onClick={() => addAction(target.id)}><Plus size={13} /><span><strong>{target.label}</strong><small>{target.id} · {target.kind ?? "control"} · {target.actions.join(" / ")}</small></span></button>)}
            {(page.assertionTargets?.length ?? 0) > 0 && <button type="button" onClick={addWaitAction}><Plus size={13} /><span><strong>等待目标出现</strong><small>{page.assertionTargets?.[0]} · waitFor</small></span></button>}
          </div>
          {actionTargets.length === 0 && (page.assertionTargets?.length ?? 0) === 0 && <div className="parameter-source-empty">当前页面待补充稳定 QA 语义目标，暂时没有可配置的交互步骤</div>}
          <div className="interaction-step-list">
            {actions.length === 0 && <span className="scenario-empty">选择上方按钮添加交互测试</span>}
            {actions.map((action, index) => {
              const target = page.targets?.find(item => item.id === action.target);
              const availableActions = target ? pageTargetActions(target, interactionPlatform) : [];
              return <div className="interaction-step" key={`${index}-${action.target}`}>
                <div className="scenario-step-row">
                <span className="scenario-step-index">{index + 1}</span>
                <select aria-label={`动作 ${index + 1} 目标`} value={action.target} onChange={event => {
                  const nextTarget = actionTargets.find(item => item.id === event.target.value);
                  updateAction(index, { target: event.target.value, type: nextTarget?.actions[0] ?? "tap" });
                }}>
                  {actionTargets.map(item => <option key={item.id} value={item.id}>{item.label}</option>)}
                  {target && !actionTargets.some(item => item.id === target.id) && <option value={target.id}>{target.label}（当前平台待适配）</option>}
                  {action.type === "waitFor" && page.assertionTargets?.filter(targetId => !actionTargets.some(item => item.id === targetId)).map(targetId => <option key={targetId} value={targetId}>{targetId}</option>)}
                </select>
                <select aria-label={`动作 ${index + 1} 类型`} value={action.type} onChange={event => updateAction(index, { type: event.target.value as PageScenarioAction["type"] })}>
                  {availableActions.map(type => <option key={type} value={type}>{type}</option>)}
                  {!availableActions.includes(action.type) && <option value={action.type}>{action.type}（当前平台待适配）</option>}
                  {action.type === "waitFor" && <option value="waitFor">waitFor</option>}
                </select>
                <input aria-label={`动作 ${index + 1} 值`} type={action.type === "waitFor" ? "number" : "text"} value={action.type === "waitFor" ? String(action.timeoutMs ?? 10_000) : action.value ?? ""} onChange={event => action.type === "waitFor" ? updateAction(index, { timeoutMs: Math.max(1, Number(event.target.value) || 1) }) : updateAction(index, { value: event.target.value })} placeholder={action.type === "input" ? "输入内容" : action.type === "waitFor" ? "等待毫秒数" : "可选值"} disabled={!["input", "select", "waitFor"].includes(action.type)} />
                <button type="button" title="删除动作" aria-label={`删除动作 ${index + 1}`} onClick={() => replaceActions(previous => previous.filter((_, actionIndex) => actionIndex !== index))}><X size={14} /></button>
                </div>
                <div className="interaction-assertions">
                  <div className="interaction-assertion-title"><span>响应断言 <small>{action.assertions?.length ?? 0} 项</small></span><button type="button" className="icon-command" title="添加响应断言" aria-label={`为动作 ${index + 1} 添加响应断言`} onClick={() => addActionAssertion(index)}><Plus size={14} /></button></div>
                  {(action.assertions?.length ?? 0) === 0 && <span className="scenario-empty">每个动作至少配置一项响应断言</span>}
                  {(action.assertions ?? []).map((assertion, assertionIndex) => <AssertionEditor key={`${assertionIndex}-${assertion.type}`} assertion={assertion} index={assertionIndex} targets={page.assertionTargets ?? []} label={`动作 ${index + 1} 响应断言`} defaultEvent={actionSucceededEvent} onChange={next => updateActionAssertion(index, assertionIndex, next)} onRemove={() => removeActionAssertion(index, assertionIndex)} />)}
                </div>
              </div>;
            })}
          </div>
        </div>

        <div className="profile-actions"><span>{selectedObservation ? `${Object.keys(selectedObservation.values).length} 个路由参数由设备捕获` : "当前参数来自代码分析或手动填写"}</span><div className="profile-action-buttons"><button className="secondary-button" type="button" onClick={() => void handleSave()} disabled={pending || !profileId || !scenario}><Save size={15} />保存页面测试</button></div></div>
      </section>}
    </div>
  </div>;
}

function AssertionEditor({ assertion, index, targets, label, defaultEvent, onChange, onRemove }: {
  assertion: PageScenarioAssertion;
  index: number;
  targets: string[];
  label: string;
  defaultEvent?: string;
  onChange: (next: PageScenarioAssertion) => void;
  onRemove: () => void;
}) {
  const changeType = (type: PageScenarioAssertion["type"]) => {
    if (type === "runtimeEvent") {
      onChange({ type, event: defaultEvent ?? "" });
      return;
    }
    onChange({ type, target: targets[0] });
  };
  return <div className="scenario-step-row assertion-row">
    <span className="scenario-step-index">{index + 1}</span>
    <select aria-label={`${label} ${index + 1} 类型`} value={assertion.type} onChange={event => changeType(event.target.value as PageScenarioAssertion["type"])}><option value="runtimeEvent">运行时事件</option><option value="visible" disabled={targets.length === 0}>目标可见</option><option value="text" disabled={targets.length === 0}>文本包含</option><option value="selected" disabled={targets.length === 0}>选中状态</option></select>
    {assertion.type === "runtimeEvent"
      ? <input aria-label={`${label} ${index + 1} 事件`} value={assertion.event ?? ""} onChange={event => onChange({ ...assertion, event: event.target.value })} placeholder="运行时事件名" />
      : <select aria-label={`${label} ${index + 1} 目标`} value={assertion.target ?? ""} onChange={event => onChange({ ...assertion, target: event.target.value })}>{targets.map(target => <option key={target} value={target}>{target}</option>)}</select>}
    <input aria-label={`${label} ${index + 1} 期望值`} value={assertion.value ?? ""} onChange={event => onChange({ ...assertion, value: event.target.value })} placeholder={assertion.type === "text" ? "期望文本" : "无需填写"} disabled={assertion.type !== "text"} />
    <button type="button" title="删除断言" aria-label={`删除${label} ${index + 1}`} onClick={onRemove}><X size={14} /></button>
  </div>;
}

function defaultAssertion(targets: string[] | undefined, event: string, preferredTarget = ""): PageScenarioAssertion {
  const target = preferredTarget && targets?.includes(preferredTarget) ? preferredTarget : targets?.[0];
  return target ? { type: "visible", target } : { type: "runtimeEvent", event };
}

function defaultAssertions(event: string): PageScenarioAssertion[] {
  return event ? [{ type: "runtimeEvent", event }] : [];
}

function defaultNavigation(bundle: string, adapter: PageParameterAdapterManifest | undefined): SavePageParameterProfileRequest["navigation"] {
  if (!adapter?.defaultRoute) return undefined;
  return { route: adapter.defaultRoute, params: { [adapter.templateParameter]: bundle } };
}

function fieldRequirementLabel(field: PageParameterField): string {
  const requirement = field.requirement ?? (field.required ? "required" : "optional");
  if ((field.alternatives?.length ?? 0) > 1 && requirement !== "optional") return `至少一个：${field.alternatives!.join(" / ")}`;
  if (requirement === "required") return "必填";
  if (requirement === "optional") return "可选";
  if (requirement === "conditional") return "条件参数";
  return "待确认";
}

function messageOf(error: unknown, fallback: string): string {
  return error instanceof ApiError ? error.message : fallback;
}

function editorDraftKey(pageId: string, observationId: string): string {
  return observationId ? `observation:${observationId}` : `page:${pageId}`;
}

function formatDateTime(value: string): string {
  const time = Date.parse(value);
  if (!Number.isFinite(time)) return value;
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(time);
}

function formatRawData(value: string): string {
  try {
    return JSON.stringify(JSON.parse(value), null, 2);
  } catch {
    return value;
  }
}

function profileValueLabel(value: PageParameterValue): string {
  if (value.strategy === "secretRef") return `引用 ${value.value || "未配置"}`;
  return value.value || "(空值)";
}

function pagePlatformLabel(platform: PageParameterProfile["platform"]): string {
  return platform === "all" ? "全部平台" : platform;
}
