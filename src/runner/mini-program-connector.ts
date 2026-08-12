import type {
  ConnectorCapabilityId,
  ConnectorCapabilityManifest,
  TargetKind,
  TestTarget,
} from "../shared/contracts.js";
import {
  type ConnectorDevice,
  type DeviceConnector,
  validateCapabilityManifest,
} from "./sdk.js";

export interface MiniProgramTarget extends TestTarget {
  kind: "mini-program";
  appId: string;
  hostAppId?: string;
  devtoolsVersion?: string;
}

export interface MiniProgramSession {
  sessionId: string;
  target: MiniProgramTarget;
  device: ConnectorDevice;
  attachedAt: string;
  state: "attached" | "launched" | "reloading" | "detached";
}

/** 小程序 connector 的运行时 port。真实微信/支付宝工具可以在进程内或 sidecar 实现此接口。 */
export interface MiniProgramConnector extends DeviceConnector {
  readonly targetKind: Extract<TargetKind, "mini-program">;
  attach(target: MiniProgramTarget, device: ConnectorDevice, signal?: AbortSignal): Promise<MiniProgramSession>;
  launch(session: MiniProgramSession, signal?: AbortSignal): Promise<MiniProgramSession>;
  reload(session: MiniProgramSession, signal?: AbortSignal): Promise<MiniProgramSession>;
  detach(session: MiniProgramSession, signal?: AbortSignal): Promise<void>;
}

export const MINI_PROGRAM_CONNECTOR_CAPABILITIES: readonly ConnectorCapabilityId[] = [
  "device.discover",
  "device.health",
  "target.mini-program.attach",
  "target.mini-program.launch",
  "target.mini-program.reload",
  "evidence.screenshot",
  "evidence.logs",
  "result.export",
];

export function createMiniProgramConnectorManifest(
  connectorId: string,
  platform: string,
  options: {
    runtime?: string;
    capabilities?: Readonly<ConnectorCapabilityManifest["capabilities"]>;
    devtoolsVersion?: string;
  } = {},
): ConnectorCapabilityManifest {
  const manifest: ConnectorCapabilityManifest = {
    schemaVersion: "mobile-test-console.capabilities.v1",
    connectorId,
    scope: {
      platform,
      targetKinds: ["mini-program"],
      runtime: options.runtime ? [options.runtime] : undefined,
    },
    capabilities: options.capabilities
      ? [...options.capabilities]
      : MINI_PROGRAM_CONNECTOR_CAPABILITIES.map(id => ({ id, version: 1 })),
    extensions: options.devtoolsVersion ? { devtoolsVersion: options.devtoolsVersion } : undefined,
  };
  validateCapabilityManifest(manifest);
  return manifest;
}

export function assertMiniProgramTarget(target: TestTarget): asserts target is MiniProgramTarget {
  if (target.kind !== "mini-program") throw new Error(`目标类型必须是 mini-program: ${target.kind}`);
  if (!target.appId?.trim()) throw new Error("小程序目标必须声明 appId");
}

export function supportsMiniProgramTarget(
  manifest: ConnectorCapabilityManifest,
  target: MiniProgramTarget,
  requiredCapabilities: readonly ConnectorCapabilityId[] = [],
): boolean {
  try {
    assertMiniProgramTarget(target);
  } catch {
    return false;
  }
  if (!manifest.scope.targetKinds?.includes("mini-program")) return false;
  if (manifest.scope.platform !== target.platform) return false;
  if (manifest.scope.runtime && !manifest.scope.runtime.includes(target.runtime)) return false;
  const available = new Set(manifest.capabilities.map(item => item.id));
  return requiredCapabilities.every(capability => available.has(capability));
}
