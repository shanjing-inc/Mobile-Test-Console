import type {
  Device,
  PageParameterField,
  PageParameterObservation,
  PageParameterPage,
  PageParameterPlatform,
  PageParameterProfile,
  PageParameterValue,
  Platform,
  PageScenarioAction,
  PageScenarioActionType,
  PageScenarioAssertion,
  PageScenarioTarget,
} from "../shared/contracts";
import { PLATFORMS } from "../shared/contracts";

export type PageParameterValueOrigin = "captured" | "history" | "suggested" | "manual";

const IMAGE_DIALOG_PARAMETER_PRESETS: PageParameterField[] = [
  { key: "image_url", required: true, sensitive: false, strategies: ["literal", "runtimeResolver"], description: "图片地址" },
  { key: "image_width", required: false, sensitive: false, strategies: ["literal", "runtimeResolver"], description: "原图宽度" },
  { key: "image_height", required: false, sensitive: false, strategies: ["literal", "runtimeResolver"], description: "原图高度" },
  { key: "route", required: false, sensitive: false, strategies: ["literal", "runtimeResolver"], description: "点击图片后的目标路由" },
  { key: "clear_clipboard_data", required: false, sensitive: false, strategies: ["literal"], description: "关闭时是否清空剪贴板" },
  { key: "search_keyword", required: false, sensitive: false, strategies: ["literal", "runtimeResolver"], description: "搜索关键词" },
  { key: "dialog_style", required: false, sensitive: false, strategies: ["literal"], description: "动态更新消息的弹窗样式，使用 3" },
];

export function pageParameterPresets(page: PageParameterPage): PageParameterField[] {
  if (page.pageId === "imageDialog" || page.bundle.replace(/\.bundle$/i, "") === "imageDialog") {
    return IMAGE_DIALOG_PARAMETER_PRESETS.map(field => ({ ...field, strategies: [...field.strategies] }));
  }
  return [];
}

export function isValidPageParameterKey(value: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_.-]*$/.test(value.trim());
}

export interface PageParameterDraft {
  values: Record<string, PageParameterValue>;
  origins: Record<string, PageParameterValueOrigin>;
}

export function pageUsesDynamicParameters(page: PageParameterPage): boolean {
  return page.dynamicParameters === true;
}

export function pageNeedsParameters(page: PageParameterPage): boolean {
  return page.fields.length > 0 || pageUsesDynamicParameters(page);
}

export function resolveSelectedPageTestDevice(devices: Device[], deviceKey: string): Device | undefined {
  if (!deviceKey) return undefined;
  return devices.find(device => device.key === deviceKey && device.connectionState === "available");
}

export function resolvePageInteractionPlatform(
  profilePlatform: PageParameterPlatform,
  selectedDevicePlatform?: Platform,
): Platform | undefined {
  return profilePlatform === "all" ? selectedDevicePlatform : profilePlatform;
}

export function pageTargetActions(target: PageScenarioTarget, platform?: Platform): PageScenarioActionType[] {
  if (platform && target.platforms && !target.platforms.includes(platform)) return [];
  const actions = platform
    ? target.platformActions?.[platform] ?? target.actions
    : target.actions;
  return actions.filter(action => action !== "screenshot");
}

export function pageInteractionTargets(targets: PageScenarioTarget[] | undefined, platform?: Platform): PageScenarioTarget[] {
  return (targets ?? [])
    .map(target => ({ ...target, actions: pageTargetActions(target, platform) }))
    .filter(target => target.actions.length > 0);
}

export function pageTargetActionPlatforms(
  target: PageScenarioTarget,
  action: PageScenarioActionType,
): Platform[] {
  return PLATFORMS.filter(platform => pageTargetActions(target, platform).includes(action));
}

export function createPageActionDefaultAssertions(target: PageScenarioTarget): PageScenarioAssertion[] {
  if (target.defaultAssertions?.length) {
    return target.defaultAssertions.map(assertion => ({ ...assertion }));
  }
  return [];
}

export function pageInteractionActions(actions: PageScenarioAction[] | undefined): PageScenarioAction[] {
  return (actions ?? []).filter(action => action.type !== "screenshot");
}

export function sortPageParameterProfiles(profiles: PageParameterProfile[]): PageParameterProfile[] {
  return [...profiles].sort((left, right) => {
    const timestampOrder = profileTimestamp(right).localeCompare(profileTimestamp(left));
    return timestampOrder || left.profileId.localeCompare(right.profileId);
  });
}

export function latestPageParameterProfile(profiles: PageParameterProfile[]): PageParameterProfile | undefined {
  return sortPageParameterProfiles(profiles)[0];
}

/** 当前页面没有路由值时，优先取明确标记的画像，再回退到最近历史画像。 */
export function resolveDefaultPageParameterProfile(
  profiles: PageParameterProfile[],
  platform?: Platform,
  environment?: string,
): PageParameterProfile | undefined {
  const compatible = profiles.filter(profile =>
    (profile.platform === "all" || !platform || profile.platform === platform)
      && (!environment || profile.environment === environment),
  );
  const active = compatible.filter(profile => !profile.expiresAt || Date.parse(profile.expiresAt) > Date.now());
  if (active.length === 0) return undefined;

  // 设备平台确定时，精确平台画像优先于 all；每个范围内再按默认标记和录制时间选择。
  const platformCandidates = platform
    ? active.filter(profile => profile.platform === platform)
    : [];
  const candidates = platformCandidates.length > 0 ? platformCandidates : active;
  const sorted = sortPageParameterProfiles(candidates);
  return sorted.find(profile => profile.isDefault === true) ?? sorted[0];
}

export function hasUsablePageParameterValues(values: Record<string, PageParameterValue>): boolean {
  return Object.values(values).some(parameter => String(parameter.value ?? "").trim().length > 0);
}

/** 空草稿可以由页面历史画像初始化；捕获值、手动值和已有非空值均保留。 */
export function shouldUseHistoricalPageParameterProfile(draft: PageParameterDraft | undefined): boolean {
  if (!draft) return true;
  const entries = Object.entries(draft.values);
  if (entries.length === 0) return true;
  return entries.every(([key, parameter]) => {
    const origin = draft.origins[key];
    if (origin === "captured" || origin === "manual") return false;
    if (origin === "history") return true;
    return String(parameter.value ?? "").trim().length === 0;
  });
}

export interface InitialPageParameterDraft {
  draft: PageParameterDraft;
  profile?: PageParameterProfile;
}

/** 为页面切换和首次加载提供确定的历史回退选择。 */
export function resolveInitialPageParameterDraft(
  page: PageParameterPage,
  currentDraft?: PageParameterDraft,
  platform?: Platform,
  environment?: string,
): InitialPageParameterDraft {
  const draft = currentDraft ?? createPageParameterDraft(page);
  if (!shouldUseHistoricalPageParameterProfile(currentDraft)) return { draft };
  const profile = resolveDefaultPageParameterProfile(page.profiles, platform, environment);
  return profile ? { draft: replaceDraftFromProfile(profile), profile } : { draft };
}

export function replaceDraftFromProfile(profile: PageParameterProfile): PageParameterDraft {
  const values: Record<string, PageParameterValue> = {};
  const origins: Record<string, PageParameterValueOrigin> = {};
  for (const [key, value] of Object.entries(profile.values)) {
    values[key] = { ...value };
    origins[key] = "history";
  }
  return {
    values,
    origins,
  };
}

export function createObservationParameterDraft(
  page: PageParameterPage,
  observation: PageParameterObservation,
): PageParameterDraft {
  const fields = new Map(page.fields.map(field => [field.key, field]));
  const values: Record<string, PageParameterValue> = {};
  const origins: Record<string, PageParameterValueOrigin> = {};
  for (const [key, capturedValue] of Object.entries(observation.values)) {
    const field = fields.get(key);
    values[key] = {
      strategy: field?.sensitive ? "secretRef" : "literal",
      value: field?.sensitive ? "" : String(capturedValue),
    };
    origins[key] = "captured";
  }
  return { values, origins };
}

export function createPageParameterDraft(page: PageParameterPage): PageParameterDraft {
  const values: Record<string, PageParameterValue> = {};
  const origins: Record<string, PageParameterValueOrigin> = {};
  for (const field of page.fields.filter(field => field.required)) {
    values[field.key] = {
      strategy: field.sensitive ? "secretRef" : "literal",
      value: "",
    };
    origins[field.key] = "suggested";
  }
  return { values, origins };
}

export function resolveDraftFields(
  page: PageParameterPage,
  values: Record<string, PageParameterValue>,
): PageParameterField[] {
  const catalogFields = new Map([
    ...page.fields,
    ...pageParameterPresets(page),
  ].map(field => [field.key, field] as const));
  const keys = new Set([
    ...page.fields.filter(field => field.required).map(field => field.key),
    ...Object.keys(values),
  ]);
  return [...keys].map(key => catalogFields.get(key) ?? {
    key,
    required: false,
    sensitive: false,
    strategies: ["literal", "secretRef", "runtimeResolver"],
    description: "录制观察值",
  });
}

export function supplementDraftFromProfile(
  draft: PageParameterDraft,
  profile: PageParameterProfile,
): PageParameterDraft & { addedCount: number } {
  const values = { ...draft.values };
  const origins = { ...draft.origins };
  let addedCount = 0;
  for (const [key, value] of Object.entries(profile.values)) {
    if (Object.prototype.hasOwnProperty.call(values, key)) continue;
    values[key] = { ...value };
    origins[key] = "history";
    addedCount += 1;
  }
  return { values, origins, addedCount };
}

function profileTimestamp(profile: PageParameterProfile): string {
  return profile.recordedAt || profile.validatedAt || "";
}
