export const PLATFORMS = ["android", "ios", "harmony"] as const;

export type Platform = (typeof PLATFORMS)[number];

export type DeviceConnectionState =
  | "available"
  | "offline"
  | "unauthorized"
  | "unavailable";

export type DeviceType = "physical" | "emulator" | "simulator";

export interface Device {
  key: string;
  id: string;
  name: string;
  platform: Platform;
  type: DeviceType;
  connectionState: DeviceConnectionState;
  osVersion: string;
  detail: string;
}

export interface SelectParameterOption {
  value: string;
  label: string;
}

export interface SelectParameterDefinition {
  id: string;
  label: string;
  type: "select";
  defaultValue: string;
  options: SelectParameterOption[];
}

export type TestParameterDefinition = SelectParameterDefinition;

export interface PublicTestDefinition {
  id: string;
  label: string;
  description: string;
  platforms: Platform[];
  parameters: TestParameterDefinition[];
}

export type TaskStatus =
  | "queued"
  | "preparing"
  | "running"
  | "passed"
  | "failed"
  | "cancelled"
  | "interrupted";

export const ACTIVE_TASK_STATUSES: readonly TaskStatus[] = ["queued", "preparing", "running"];

export interface TestTask {
  id: string;
  runId: string;
  projectId: string;
  testId: string;
  testLabel: string;
  device: Device;
  parameters: Record<string, string>;
  status: TaskStatus;
  phase: string;
  createdAt: string;
  startedAt: string;
  finishedAt: string;
  exitCode: number | null;
  error: string;
  logs: string[];
}

export interface ProjectSummary {
  id: string;
  name: string;
  root: string;
}

export interface ConsoleSnapshot {
  project: ProjectSummary;
  devices: Device[];
  deviceErrors: Partial<Record<Platform, string>>;
  tests: PublicTestDefinition[];
  tasks: TestTask[];
  updatedAt: string;
}

export interface StartTasksRequest {
  testId: string;
  deviceKeys: string[];
  parameters: Record<string, string>;
}

export interface StartTasksResponse {
  tasks: TestTask[];
}

export interface ApiErrorPayload {
  error: {
    code: string;
    message: string;
  };
}
