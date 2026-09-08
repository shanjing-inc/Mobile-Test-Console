import path from "node:path";
import type { LoadedProjectConfig } from "./config.js";
import { resolveProjectDataStorage, type ProjectDataStorage, type ProjectDataStorageInput } from "./project-data-storage.js";

export type AccountProfileStorage = ProjectDataStorage;

export function resolveAccountProfileStorage(input: ProjectDataStorageInput): Promise<AccountProfileStorage> {
  return resolveProjectDataStorage(input, "account-profiles");
}

export function accountProfileStatePath(config: LoadedProjectConfig): string {
  return path.join(config.accountProfileStorage?.directory ?? config.stateDir, "account-profiles.json");
}
