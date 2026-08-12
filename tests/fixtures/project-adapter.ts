import type { AccountProfileProviderAdapterManifest, ProjectAdapterManifest } from "../../src/shared/contracts.js";

const loginProvider = (label: string, defaultProfileId: string, defaultAccountLabel: string): AccountProfileProviderAdapterManifest => ({
  label,
  recordingLabel: `${label}登录`,
  defaultProfileId,
  defaultAccountLabel,
  requiredCapability: "login",
  crossPlatformCapability: "login",
  devicePlatforms: [],
  deviceTextIncludes: [],
  requiredCaptureKinds: ["native", "graphql"],
  requiredResultFields: ["uid", "session_key"],
  capabilityRules: [],
});

/** 账号、页面参数与修复测试共用的项目侧领域清单。 */
export const TEST_PROJECT_ADAPTER: ProjectAdapterManifest = {
  workspaces: ["page-parameters", "business-scripts", "account-profiles"],
  pageParameters: {
    defaultRoute: "demo://lynx",
    templateParameter: "bundle",
    pageReadyEvent: "page_ready",
    actionSucceededEvent: "action_succeeded",
  },
  resultAnalysis: {
    pageOpenedEvents: ["page_opened", "page_ready"],
  },
  accountProfiles: {
    providers: {
      wechat: loginProvider("微信", "qa-account-wechat", "QA 微信账号"),
      qq: loginProvider("QQ", "qa-account-qq", "QA QQ 账号"),
      taobao: loginProvider("淘宝", "qa-account-taobao", "QA 淘宝账号"),
      huawei: {
        ...loginProvider("华为", "qa-account-huawei", "QA 华为账号"),
        devicePlatforms: ["harmony"],
        deviceTextIncludes: ["huawei", "华为"],
      },
      "taobao-commerce": {
        label: "电商授权",
        recordingLabel: "电商授权录制",
        defaultProfileId: "qa-account-taobao-commerce",
        defaultAccountLabel: "QA 电商授权账号",
        requiredCapability: "taobao-commerce-auth",
        devicePlatforms: [],
        deviceTextIncludes: [],
        requiredCaptureKinds: ["native"],
        requiredResultFields: [],
        capabilityRules: [
          { module: "DemoCommerceLoginModule", methods: ["getSession", "login"], capability: "taobao-session" },
          { module: "DemoCommerceLoginModule", methods: ["oauth2"], capability: "taobao-oauth2" },
        ],
      },
    },
  },
  repair: {
    displayName: "测试项目修复任务",
    threadNamePrefix: "测试项目修复",
    fixingMessage: "测试项目修复中",
  },
};
