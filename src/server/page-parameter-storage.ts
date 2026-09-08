import path from "node:path";
import type { LoadedProjectConfig } from "./config.js";
import { resolveProjectDataStorage, type ProjectDataStorage, type ProjectDataStorageInput } from "./project-data-storage.js";

export type PageParameterStorage = ProjectDataStorage;

export function resolvePageParameterStorage(input: ProjectDataStorageInput): Promise<PageParameterStorage> {
  return resolveProjectDataStorage(input, "page-parameters");
}

export function pageParameterStatePath(config: LoadedProjectConfig): string {
  return path.join(config.pageParameterStorage?.directory ?? config.stateDir, "page-parameters.json");
}
