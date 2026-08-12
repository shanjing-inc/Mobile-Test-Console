import type { AccountProfileAdapterManifest, AccountProfileProvider, AccountProfileProviderEntrySummary, AccountProfileRecordingSummary, Device } from "../shared/contracts";
import { supportsAccountProfileProvider } from "../shared/account-profile-compatibility";
import { EMPTY_PROJECT_ADAPTER } from "../shared/project-adapter-defaults";

export interface AccountProfileIdentityDefaults {
  profileId: string;
  accountLabel: string;
}

export function accountProfileIdentityForProvider(
  provider: AccountProfileProvider,
  providers: AccountProfileAdapterManifest["providers"] = EMPTY_PROJECT_ADAPTER.accountProfiles.providers,
): AccountProfileIdentityDefaults {
  if (!provider) return { profileId: "", accountLabel: "" };
  const definition = providers[provider];
  return {
    profileId: definition?.defaultProfileId ?? `qa-account-${provider}`,
    accountLabel: definition?.defaultAccountLabel ?? provider,
  };
}

export function resolveAccountProfileIdentityChange(
  currentProvider: AccountProfileProvider,
  nextProvider: AccountProfileProvider,
  profileId: string,
  accountLabel: string,
  providers?: AccountProfileAdapterManifest["providers"],
): AccountProfileIdentityDefaults {
  const currentDefaults = accountProfileIdentityForProvider(currentProvider, providers);
  if (profileId !== currentDefaults.profileId || accountLabel !== currentDefaults.accountLabel) {
    return { profileId, accountLabel };
  }
  return accountProfileIdentityForProvider(nextProvider, providers);
}

export function resolveDeviceKey(devices: Device[], selectedKey: string): string {
  return devices.some(item => item.key === selectedKey) ? selectedKey : devices[0]?.key ?? "";
}

export function resolveAccountProfileReplayDevices(
  devices: Device[],
  sourcePlatform: Device["platform"] | undefined,
  entry: Pick<AccountProfileProviderEntrySummary, "provider" | "capabilities"> | null,
  providers: AccountProfileAdapterManifest["providers"] = EMPTY_PROJECT_ADAPTER.accountProfiles.providers,
): Device[] {
  if (!sourcePlatform || !entry) return devices;
  if (entry.capabilities.includes("login")) {
    return devices.filter(device => supportsAccountProfileProvider(providers[entry.provider], device));
  }
  return devices.filter(item => item.platform === sourcePlatform);
}

export function resolveAccountProfileRecordingDevices(
  devices: Device[],
  provider: AccountProfileProvider,
  providers: AccountProfileAdapterManifest["providers"] = EMPTY_PROJECT_ADAPTER.accountProfiles.providers,
): Device[] {
  return devices.filter(device => supportsAccountProfileProvider(providers[provider], device));
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
