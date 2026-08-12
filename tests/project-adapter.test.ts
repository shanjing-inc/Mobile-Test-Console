import { describe, expect, it } from "vitest";
import type { AccountProfileCapture } from "../src/shared/contracts.js";
import type { LoadedProjectConfig } from "../src/server/config.js";
import {
  accountProfileCapabilities,
  isCompleteAccountProfileRecording,
  resolveAccountProfileProviderAdapter,
  resolveProjectAdapter,
  supportsAccountProfileProviderAdapter,
} from "../src/server/project-adapter.js";
import { EMPTY_PROJECT_ADAPTER } from "../src/shared/project-adapter-defaults.js";

describe("项目适配器", () => {
  it("未经过配置加载边界的配置使用平台中立空适配器", () => {
    expect(resolveProjectAdapter({})).toEqual(EMPTY_PROJECT_ADAPTER);
    expect(resolveAccountProfileProviderAdapter({}, "wechat")).toBeUndefined();
  });

  it("通过清单解析账号完整性、设备范围和捕获能力", () => {
    const config = {
      adapter: {
        workspaces: ["account-profiles"],
        pageParameters: { defaultRoute: "demo://page", templateParameter: "bundle", pageReadyEvent: "page_ready", actionSucceededEvent: "action_ok" },
        resultAnalysis: { pageOpenedEvents: ["page_ready"] },
        accountProfiles: { providers: { "demo-auth": {
          label: "Demo",
          recordingLabel: "Demo 登录",
          defaultProfileId: "demo-account",
          defaultAccountLabel: "Demo 账号",
          requiredCapability: "login",
          crossPlatformCapability: "login",
          devicePlatforms: ["ios"],
          deviceTextIncludes: ["demo-device"],
          requiredCaptureKinds: ["native"],
          requiredResultFields: ["token"],
          capabilityRules: [{ module: "DemoAuthModule", methods: ["authorize"], capability: "refresh-token" }],
        } } },
        repair: { displayName: "Demo", threadNamePrefix: "Demo", fixingMessage: "Demo" },
      },
    } as Pick<LoadedProjectConfig, "adapter">;
    const definition = resolveAccountProfileProviderAdapter(config, "demo-auth");
    const captures: AccountProfileCapture[] = [{
      captureId: "capture-1",
      kind: "native",
      provider: "demo-auth",
      module: "DemoAuthModule",
      method: "authorize",
      params: {},
      result: { token: "token-1", result: "success" },
      capturedAt: "2026-08-05T00:00:00.000Z",
    }];

    expect(isCompleteAccountProfileRecording(definition, captures)).toBe(true);
    expect(accountProfileCapabilities(definition, captures)).toEqual(["login", "refresh-token"]);
    expect(supportsAccountProfileProviderAdapter(definition, device("ios", "Simulator"))).toBe(true);
    expect(supportsAccountProfileProviderAdapter(definition, device("android", "Demo-Device 1"))).toBe(true);
    expect(supportsAccountProfileProviderAdapter(definition, device("android", "Other"))).toBe(false);
  });
});

function device(platform: "android" | "ios", name: string) {
  return { platform, name, manufacturer: "", detail: "" };
}
