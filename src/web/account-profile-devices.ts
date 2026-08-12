import type { AccountProfileProvider, AccountProfileProviderEntrySummary, AccountProfileRecordingSummary, Device } from "../shared/contracts";
import { supportsAccountProfileProvider } from "../shared/account-profile-compatibility";

export interface AccountProfileIdentityDefaults {
  profileId: string;
  accountLabel: string;
}

const ACCOUNT_PROFILE_PROVIDER_IDENTITY: Record<AccountProfileProvider, AccountProfileIdentityDefaults> = {
  wechat: { profileId: "qa-account-wechat", accountLabel: "QA 微信账号" },
  qq: { profileId: "qa-account-qq", accountLabel: "QA QQ 账号" },
  taobao: { profileId: "qa-account-taobao", accountLabel: "QA 淘宝账号" },
  huawei: { profileId: "qa-account-huawei", accountLabel: "QA 华为账号" },
  "taobao-commerce": { profileId: "qa-account-taobao-commerce", accountLabel: "QA 淘宝授权账号" },
};

export function accountProfileIdentityForProvider(provider: AccountProfileProvider): AccountProfileIdentityDefaults {
  return ACCOUNT_PROFILE_PROVIDER_IDENTITY[provider];
}

export function resolveAccountProfileIdentityChange(
  currentProvider: AccountProfileProvider,
  nextProvider: AccountProfileProvider,
  profileId: string,
  accountLabel: string,
): AccountProfileIdentityDefaults {
  const currentDefaults = accountProfileIdentityForProvider(currentProvider);
  if (profileId !== currentDefaults.profileId || accountLabel !== currentDefaults.accountLabel) {
    return { profileId, accountLabel };
  }
  return accountProfileIdentityForProvider(nextProvider);
}

export function resolveDeviceKey(devices: Device[], selectedKey: string): string {
  return devices.some(item => item.key === selectedKey) ? selectedKey : devices[0]?.key ?? "";
}

export function resolveAccountProfileReplayDevices(
  devices: Device[],
  sourcePlatform: Device["platform"] | undefined,
  entry: Pick<AccountProfileProviderEntrySummary, "provider" | "capabilities"> | null,
): Device[] {
  if (!sourcePlatform || !entry) return devices;
  if (entry.capabilities.includes("login")) {
    return devices.filter(device => supportsAccountProfileProvider(entry.provider, device));
  }
  return devices.filter(item => item.platform === sourcePlatform);
}

export function resolveAccountProfileRecordingDevices(
  devices: Device[],
  provider: AccountProfileProvider,
): Device[] {
  return devices.filter(device => supportsAccountProfileProvider(provider, device));
}

export function activeAccountProfileRecordings(recordings: AccountProfileRecordingSummary[]): AccountProfileRecordingSummary[] {
  return recordings.filter(item => ["starting", "recording"].includes(item.status));
}

export function resolveReplayProvider(
  entries: AccountProfileProviderEntrySummary[],
  selectedProvider: AccountProfileProvider | "",
  preferredProvider: AccountProfileProvider,
): AccountProfileProvider | "" {
  if (entries.some(item => item.provider === selectedProvider)) return selectedProvider;
  if (entries.some(item => item.provider === preferredProvider)) return preferredProvider;
  return entries[0]?.provider ?? "";
}
