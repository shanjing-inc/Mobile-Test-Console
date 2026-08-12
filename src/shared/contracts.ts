export const PLATFORMS = ["android", "ios", "harmony"] as const;
export const PAGE_PARAMETER_PLATFORMS = ["all", ...PLATFORMS] as const;

export type Platform = (typeof PLATFORMS)[number];
export type PageParameterPlatform = (typeof PAGE_PARAMETER_PLATFORMS)[number];

export type DeviceConnectionState =
  | "available"
  | "offline"
  | "unauthorized"
  | "unavailable";

export type DeviceType = "physical" | "emulator" | "simulator";
export type DeviceControlState = "ready" | "startable" | "unavailable";
export type DevicePreparationStatus = "ready" | "required" | "unavailable";

export interface DevicePreparation {
  id: string;
  label: string;
  status: DevicePreparationStatus;
  detail: string;
  installable: boolean;
  blocksTests: boolean;
}

export interface Device {
  key: string;
  id: string;
  name: string;
  manufacturer?: string;
  platform: Platform;
  type: DeviceType;
  connectionState: DeviceConnectionState;
  osVersion: string;
  detail: string;
  controlState: DeviceControlState;
  controlReason: string;
  preparations?: DevicePreparation[];
}

export interface SelectParameterOption {
  value: string;
  label: string;
  description?: string;
}

export interface SelectParameterDefinition {
  id: string;
  label: string;
  type: "select";
  defaultValue: string;
  options: SelectParameterOption[];
}

export const CURRENT_ACCOUNT_SESSION = "current-session";

export interface AccountProfileParameterDefinition {
  id: string;
  label: string;
  type: "account-profile";
  defaultValue: typeof CURRENT_ACCOUNT_SESSION;
  capability: string;
}

export type TestParameterDefinition = SelectParameterDefinition | AccountProfileParameterDefinition;

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
export const TERMINAL_TASK_STATUSES: readonly TaskStatus[] = ["passed", "failed", "cancelled", "interrupted"];

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
  /** 修复验证任务运行在独立 worktree 时记录其代码根目录。 */
  workspaceRoot?: string;
  repairJobId?: string;
}

export interface TaskResultArtifact {
  id: string;
  label: string;
  mimeType: string;
  sizeBytes: number;
}

export interface TaskResultApiCall {
  index: number;
  ts: string;
  eventType: string;
  page: string;
  apiType: string;
  method: string;
  url: string;
  host: string;
  path: string;
  endpoint: string;
  operationName: string;
  status: string | number;
  result: string;
  durationMs: number | null;
  request: unknown;
  response: unknown;
  network: {
    dnsType: string;
    dnsIps: string;
    connectIp: string;
    protocol: string;
  };
}

export interface TaskResultRun {
  runId: string;
  caseRunId: string;
  caseRunCount: number;
  caseId: string;
  executionKind?: "page-replay" | "scenario" | "suite" | string;
  targetPage: string;
  launchPage: string;
  routeParams?: Record<string, unknown>;
  parameterProfileId?: string;
  expectedFinalPage?: string;
  actualFinalPage?: string;
  pageSequence?: Array<{ page: string; bundleName?: string; events: string[]; startedAt?: string; finishedAt?: string }>;
  assertions?: Array<Record<string, unknown>>;
  passBasis?: Array<{ kind: string; passed: boolean; description: string }>;
  scenario: string;
  fixture: string;
  platform: string;
  device: string;
  status: string;
  errorSummary: string;
  requiredEvents: string[];
  missingEvents: string[];
  runtimeEventCount: number;
  uiActionCount: number;
  apiCalls: TaskResultApiCall[];
  screenshots: TaskResultArtifact[];
  evidenceFiles: string[];
  failureLogExcerpt: string;
}

export interface TaskResult {
  schemaVersion: "mobile-test-console.task-result.v1";
  generatedAt: string;
  taskId: string;
  runId: string;
  total: number;
  caseRunCount: number;
  passed: number;
  failed: number;
  warnings: string[];
  preconditions?: TaskResultPrecondition[];
  runs: TaskResultRun[];
}

export interface TaskResultPrecondition {
  id: string;
  label: string;
  status: "passed" | "failed";
  action: "reused-session" | "account-profile-replay" | "failed";
  profileId?: string;
  provider?: string;
  detail: string;
  checkedAt: string;
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
  deviceDiscoveryPending?: boolean;
  tests: PublicTestDefinition[];
  tasks: TestTask[];
  codexRepairEnabled?: boolean;
  repairJobs?: RepairJob[];
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

export interface StartDeviceResponse {
  device: Device;
}

export interface InstallDevicePreparationResponse {
  device: Device;
  preparation: DevicePreparation;
}

export interface TaskResultResponse {
  result: TaskResult;
}

export type RepairJobStatus =
  | "queued"
  | "investigating"
  | "fixing"
  | "verifying"
  | "fixed"
  | "waiting_device"
  | "blocked"
  | "failed"
  | "cancelled";

export type RepairVerificationStatus = "pending" | "passed" | "failed";

export interface RepairReplaySnapshot {
  schemaVersion: "mobile-test-console.replay-snapshot.v1";
  projectId: string;
  workspace: string;
  baselineCommit: string;
  dirtyFingerprint: string;
  taskId: string;
  runId: string;
  caseRunId: string;
  testId: string;
  testLabel: string;
  targetPage: string;
  launchPage: string;
  platform: Platform;
  device: Device;
  parameters: Record<string, string>;
  taskError: string;
  taskLogs: string[];
  result: TaskResult;
  createdAt: string;
}

export interface RepairEvent {
  at: string;
  status: RepairJobStatus;
  message: string;
}

export interface RepairJob {
  repairJobId: string;
  projectId: string;
  taskId: string;
  runId: string;
  caseRunId: string;
  testId: string;
  testLabel: string;
  targetPage: string;
  platform: Platform;
  status: RepairJobStatus;
  verificationStatus: RepairVerificationStatus;
  verificationFailureKind?: "precondition" | "assertion";
  attempt: number;
  maxAttempts: number;
  createdAt: string;
  updatedAt: string;
  baselineCommit: string;
  dirtyFingerprint: string;
  worktreePath: string;
  patchPath: string;
  diff: string;
  replayTaskId: string;
  codexThreadId?: string;
  error: string;
  logs: string[];
  events: RepairEvent[];
  snapshot: RepairReplaySnapshot;
  latestVerificationResult?: TaskResult;
}

export interface RepairJobsResponse {
  schemaVersion: "mobile-test-console.repair-jobs.v1";
  jobs: RepairJob[];
}

export interface CreateRepairJobResponse {
  job: RepairJob;
}

export interface RepairJobPreview {
  schemaVersion: "mobile-test-console.repair-preview.v1";
  taskId: string;
  caseRunId: string;
  targetPage: string;
  launchPage: string;
  platform: Platform;
  device: Pick<Device, "id" | "name" | "type" | "manufacturer">;
  parameters: Record<string, string>;
  failureContext: string;
  prompt: string;
}

export interface RepairJobPreviewResponse {
  preview: RepairJobPreview;
}

export type PageParameterValueStrategy = "literal" | "secretRef" | "runtimeResolver";
export type PageParameterStatus = "missing" | "recorded" | "expired" | "failed";
export type PageParameterRequirement = "required" | "optional" | "conditional" | "unknown";
export type PageScenarioActionType = "tap" | "input" | "select" | "submit" | "waitFor" | "screenshot";
export type PageScenarioAssertionType = "runtimeEvent" | "visible" | "text" | "selected";
export type PageScenarioTargetKind =
  | "button"
  | "control"
  | "input"
  | "select"
  | "tab"
  | "region"
  | "list-item"
  | (string & Record<never, never>);

export interface PageScenarioNavigation {
  route: string;
  params: Record<string, string>;
}

export interface PageScenarioTarget {
  id: string;
  label: string;
  actions: PageScenarioActionType[];
  /** 页面 QA 注入目标的语义类别，帮助控制台按目标类型组织操作。 */
  kind?: PageScenarioTargetKind;
  /** 目标可执行的平台范围；省略表示三端通用。 */
  platforms?: Platform[];
  /** 平台差异动作能力；省略时使用 actions。 */
  platformActions?: Partial<Record<Platform, PageScenarioActionType[]>>;
  /** QA 项目为该目标提供的默认响应断言。 */
  defaultAssertions?: PageScenarioAssertion[];
  description?: string;
}

export interface PageScenarioAction {
  type: PageScenarioActionType;
  target: string;
  value?: string;
  timeoutMs?: number;
  assertions?: PageScenarioAssertion[];
}

export interface PageScenarioAssertion {
  type: PageScenarioAssertionType;
  target?: string;
  event?: string;
  value?: string;
}

export interface PageParameterField {
  key: string;
  required: boolean;
  requirement?: PageParameterRequirement;
  alternatives?: string[];
  evidence?: string[];
  sensitive: boolean;
  strategies: PageParameterValueStrategy[];
  description: string;
}

export interface PageParameterCatalogEntry {
  pageId: string;
  label: string;
  bundle: string;
  source: string;
  fields: PageParameterField[];
  dynamicParameters?: boolean;
  navigation?: PageScenarioNavigation;
  targets?: PageScenarioTarget[];
  assertionTargets?: string[];
  warnings: string[];
}

export interface PageParameterValue {
  strategy: PageParameterValueStrategy;
  value: string;
}

export interface PageParameterProfile {
  profileId: string;
  pageId: string;
  scenario: string;
  /** 画像适用平台；all 表示所有支持的平台。 */
  platform: PageParameterPlatform;
  /** 页面路由参数为空时优先使用的画像；同一页面最多一组。 */
  isDefault?: boolean;
  environment: string;
  accountLabel: string;
  values: Record<string, PageParameterValue>;
  navigation?: PageScenarioNavigation;
  actions?: PageScenarioAction[];
  assertions?: PageScenarioAssertion[];
  source: "recording" | "manual" | "manifest";
  recordedAt: string;
  validatedAt: string;
  expiresAt: string;
  version: 1;
}

export interface PageParameterObservation {
  observationId: string;
  pageId: string;
  bundle: string;
  previousPageId: string;
  values: Record<string, string>;
  navigation?: PageScenarioNavigation;
  capturedAt: string;
  /** provider 收到的脱敏原始事件，保留用于录制排查和复核。 */
  rawData?: string;
}

export type PageParameterRecordingStatus = "starting" | "recording" | "stopped" | "failed";
export type PageParameterReplayStatus = "passed" | "failed";
export type PageParameterReplayStepStatus = "passed" | "failed" | "skipped" | "pending";

export interface PageParameterReplayStep {
  index: number;
  kind: "action" | "assertion" | "page";
  type: string;
  target?: string;
  status: PageParameterReplayStepStatus;
  message?: string;
  evidence?: string;
}

export interface PageParameterReplaySummary {
  pageOpened: boolean;
  expectedPage?: string;
  actualPage?: string;
  actionCount: number;
  actionPassed: number;
  assertionCount: number;
  assertionPassed: number;
  missingEvents: string[];
  steps: PageParameterReplayStep[];
}

export interface PageParameterReplay {
  replayId: string;
  pageId: string;
  profileId: string;
  platform: Platform;
  environment: string;
  status: PageParameterReplayStatus;
  startedAt: string;
  finishedAt: string;
  output: string;
  error: string;
  summary?: PageParameterReplaySummary;
}

export interface PageParameterRecording {
  recordingId: string;
  deviceKey: string;
  deviceId: string;
  platform: Platform;
  environment: string;
  status: PageParameterRecordingStatus;
  startedAt: string;
  stoppedAt: string;
  error: string;
  observations: PageParameterObservation[];
}

export interface PageParameterPage extends PageParameterCatalogEntry {
  status: PageParameterStatus;
  profiles: PageParameterProfile[];
}

export interface PageParametersResponse {
  schemaVersion: "mobile-test-console.page-parameters.v1";
  pages: PageParameterPage[];
  recordings: PageParameterRecording[];
  warnings: string[];
}

export interface StartPageParameterRecordingRequest {
  deviceKey: string;
  environment: string;
}

export interface SavePageParameterProfileRequest {
  scenario: string;
  platform?: PageParameterPlatform;
  isDefault?: boolean;
  environment: string;
  accountLabel: string;
  values: Record<string, PageParameterValue>;
  /** 录制观察中实际出现的参数键，允许区分捕获到的空值与缺失键。 */
  capturedKeys?: string[];
  navigation?: PageScenarioNavigation;
  actions?: PageScenarioAction[];
  assertions?: PageScenarioAssertion[];
  source?: PageParameterProfile["source"];
  recordedAt?: string;
  expiresAt?: string;
}

export const ACCOUNT_PROFILE_PROVIDERS = ["wechat", "qq", "taobao", "huawei", "taobao-commerce"] as const;
export type AccountProfileProvider = typeof ACCOUNT_PROFILE_PROVIDERS[number];
export type AccountProfileCaptureKind = "native" | "graphql";
export type AccountProfileRecordingStatus = "starting" | "recording" | "stopped" | "failed";
export type AccountProfileReplayStatus = "passed" | "failed";

export interface AccountProfileCapture {
  captureId: string;
  kind: AccountProfileCaptureKind;
  provider: AccountProfileProvider;
  module?: string;
  method?: string;
  operationName?: string;
  params: Record<string, unknown>;
  result: Record<string, unknown>;
  capturedAt: string;
}

export interface AccountProfileCaptureSummary {
  captureId: string;
  kind: AccountProfileCaptureKind;
  provider: AccountProfileProvider;
  module?: string;
  method?: string;
  operationName?: string;
  parameterKeys: string[];
  resultKeys: string[];
  digest: string;
  capturedAt: string;
}

export interface AccountProfileProviderEntry {
  provider: AccountProfileProvider;
  accountUid: string;
  sourceDeviceKey: string;
  capabilities: string[];
  captures: AccountProfileCapture[];
  recordedAt: string;
  validatedAt: string;
  expiresAt: string;
}

export interface AccountProfile {
  schemaVersion: "mobile-test-console.account-profile.v2";
  profileId: string;
  accountLabel: string;
  platform: Platform;
  environment: string;
  providerEntries: AccountProfileProviderEntry[];
  version: 2;
}

export interface AccountProfileRecording {
  recordingId: string;
  profileId: string;
  accountLabel: string;
  provider: AccountProfileProvider;
  deviceKey: string;
  deviceId: string;
  deviceType: DeviceType;
  deviceManufacturer?: string;
  platform: Platform;
  environment: string;
  status: AccountProfileRecordingStatus;
  startedAt: string;
  stoppedAt: string;
  error: string;
  captures: AccountProfileCapture[];
}

export interface AccountProfileProviderEntrySummary extends Omit<AccountProfileProviderEntry, "accountUid" | "captures"> {
  accountUidMasked: string;
  captureSummaries: AccountProfileCaptureSummary[];
}

export interface AccountProfileSummary extends Omit<AccountProfile, "providerEntries"> {
  providerEntries: AccountProfileProviderEntrySummary[];
}

export interface AccountProfileSourceResponse {
  schemaVersion: "mobile-test-console.account-profile-source.v1";
  profileId: string;
  accountLabel: string;
  platform: Platform;
  environment: string;
  version: 2;
  providerEntry: AccountProfileProviderEntry;
}

export interface AccountProfileRecordingSummary extends Omit<AccountProfileRecording, "captures"> {
  captureSummaries: AccountProfileCaptureSummary[];
}

export interface AccountProfileReplay {
  replayId: string;
  profileId: string;
  provider: AccountProfileProvider;
  platform: Platform;
  sourcePlatform: Platform;
  environment: string;
  status: AccountProfileReplayStatus;
  startedAt: string;
  finishedAt: string;
  output: string;
  error: string;
}

export interface AccountProfilesResponse {
  schemaVersion: "mobile-test-console.account-profiles.v1";
  profiles: AccountProfileSummary[];
  recordings: AccountProfileRecordingSummary[];
  warnings: string[];
}

export interface StartAccountProfileRecordingRequest {
  deviceKey: string;
  profileId: string;
  accountLabel: string;
  provider: AccountProfileProvider;
  environment: string;
}

export type BusinessScriptRecordingStatus = "starting" | "recording" | "stopped" | "failed";
export type BusinessStepActionType = "tap" | "input" | "swipe" | "back" | "waitFor" | "screenshot" | "pageTransition";
export type BusinessTargetStrategy = "accessibilityId" | "text" | "point" | "system";

export interface BusinessScriptStep {
  stepId: string;
  name: string;
  kind: "action" | "system" | "pageTransition";
  actionType: BusinessStepActionType;
  semanticTarget?: { strategy: BusinessTargetStrategy; value: string; status: "resolved" | "needs-review" };
  rawPoint?: { x: number; y: number } | null;
  start?: [number, number] | null;
  end?: [number, number] | null;
  inputBinding?: { strategy: "literal" | "secretRef" | "runtimeResolver"; value: string };
  timeoutMs?: number;
  pageId?: string;
  beforePageInstanceId?: string;
  afterPageInstanceId?: string;
  screenshotRef?: string;
  hierarchyRef?: string;
  status: "resolved" | "needs-review";
  raw?: Record<string, unknown>;
}

export interface BusinessScriptAssertion {
  assertionId: string;
  type: "page" | "visible" | "text" | "runtimeEvent";
  page?: string;
  target?: string;
  value?: string;
  event?: string;
}

export interface BusinessScenario {
  scenarioId: string;
  name: string;
  setupRef?: string;
  startPage: string;
  expectedFinalPage: string;
  tags: string[];
  stepIds: string[];
  assertionIds: string[];
}

export interface BusinessScriptDraft {
  draftId: string;
  recordingId: string;
  name: string;
  platformScope: Platform[];
  startPage: string;
  expectedFinalPage: string;
  variables: Array<{ name: string; strategy: "literal" | "secretRef" | "runtimeResolver"; sensitive: boolean }>;
  steps: BusinessScriptStep[];
  assertions: BusinessScriptAssertion[];
  scenarios: BusinessScenario[];
  warnings: string[];
  createdAt: string;
  updatedAt: string;
}

export interface BusinessScriptRecording {
  recordingId: string;
  deviceKey: string;
  deviceId: string;
  platform: Platform;
  environment: string;
  appBuild: string;
  status: BusinessScriptRecordingStatus;
  startedAt: string;
  stoppedAt: string;
  error: string;
  draftId: string;
}

export interface PublishedBusinessScript extends Omit<BusinessScriptDraft, "draftId" | "recordingId" | "warnings" | "updatedAt"> {
  schemaVersion: "mobile-test-console.business-script.v1";
  scriptId: string;
  version: number;
  sourceDraftId: string;
  publishedAt: string;
}

export interface BusinessSuite {
  suiteId: string;
  name: string;
  scenarioRefs: Array<{ scriptId: string; version: number; scenarioId: string }>;
  platformMatrix: Platform[];
  updatedAt: string;
}

export interface BusinessScriptReplay {
  replayId: string;
  scriptId: string;
  version: number;
  scenarioId: string;
  platform: Platform;
  status: "planned" | "passed" | "failed";
  startedAt: string;
  finishedAt: string;
  output: string;
  error: string;
}

export interface BusinessScriptsResponse {
  schemaVersion: "mobile-test-console.business-scripts.v1";
  recordings: BusinessScriptRecording[];
  drafts: BusinessScriptDraft[];
  scripts: PublishedBusinessScript[];
  suites: BusinessSuite[];
}

export interface StartBusinessScriptRecordingRequest {
  deviceKey: string;
  environment: string;
  appBuild: string;
}

export interface SaveBusinessScriptDraftRequest {
  name: string;
  startPage: string;
  expectedFinalPage: string;
  variables?: BusinessScriptDraft["variables"];
  steps: BusinessScriptStep[];
  assertions: BusinessScriptAssertion[];
  scenarios: BusinessScenario[];
}

export interface ApiErrorPayload {
  error: {
    code: string;
    message: string;
  };
}
