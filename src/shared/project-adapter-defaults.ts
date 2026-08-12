import type { ProjectAdapterManifest } from "./contracts.js";

/** 平台中立的空项目适配器，仅作为未经过配置加载边界的安全默认值。 */
export const EMPTY_PROJECT_ADAPTER: ProjectAdapterManifest = {
  workspaces: [],
  pageParameters: {
    defaultRoute: "",
    templateParameter: "",
    pageReadyEvent: "",
    actionSucceededEvent: "",
  },
  resultAnalysis: {
    pageOpenedEvents: [],
  },
  accountProfiles: {
    providers: {},
  },
  repair: {
    displayName: "修复任务",
    threadNamePrefix: "修复",
    fixingMessage: "修复任务执行中",
  },
};
