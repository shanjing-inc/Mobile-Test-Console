import type { ConnectorCapabilityManifest } from "../shared/contracts.js";
import { validateCapabilityManifest, type RunnerEvent, type RunPlan } from "./sdk.js";

/** 进程内 SDK 与未来厂商 sidecar 共用的最小 stdio 协议。 */
export const SIDECAR_PROTOCOL_VERSION = "mobile-test-console.sidecar.v1" as const;

export interface SidecarHandshake {
  type: "handshake";
  protocol: typeof SIDECAR_PROTOCOL_VERSION;
  connectorId: string;
  connectorVersion?: string;
  manifest: ConnectorCapabilityManifest;
}

export interface SidecarStartRequest {
  type: "start";
  requestId: string;
  plan: RunPlan;
}

export interface SidecarCancelRequest {
  type: "cancel";
  requestId: string;
  runId: string;
}

export interface SidecarCollectRequest {
  type: "collect";
  requestId: string;
  runId: string;
}

export type SidecarRequest = SidecarHandshake | SidecarStartRequest | SidecarCancelRequest | SidecarCollectRequest;

export interface SidecarEventMessage {
  type: "event";
  requestId: string;
  event: RunnerEvent;
}

export interface SidecarResponseMessage {
  type: "response";
  requestId: string;
  ok: boolean;
  result?: unknown;
  error?: { code: string; message: string; retryable?: boolean };
}

export type SidecarMessage = SidecarEventMessage | SidecarResponseMessage;

export function assertSidecarHandshake(value: unknown): asserts value is SidecarHandshake {
  if (!value || typeof value !== "object") throw new Error("sidecar handshake 无效");
  const message = value as Partial<SidecarHandshake>;
  if (message.type !== "handshake" || message.protocol !== SIDECAR_PROTOCOL_VERSION) {
    throw new Error(`sidecar 协议不兼容: ${String(message.protocol ?? "unknown")}`);
  }
  if (!message.connectorId || !message.manifest) throw new Error("sidecar handshake 缺少 connectorId 或 manifest");
  validateCapabilityManifest(message.manifest);
}
