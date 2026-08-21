export const PLATFORMS = ["android", "ios", "harmony"] as const;
export const PAGE_PARAMETER_PLATFORMS = ["all", ...PLATFORMS] as const;

export type DevicePlatform = (typeof PLATFORMS)[number];
/** 兼容既有设备相关 API；新代码优先使用 DevicePlatform。 */
export type Platform = DevicePlatform;
export type TargetPlatform = string;
export type PageParameterPlatform = (typeof PAGE_PARAMETER_PLATFORMS)[number];

export type DeviceConnectionState =
  | "available"
  | "offline"
  | "unauthorized"
  | "unavailable";

export type DeviceType = "physical" | "emulator" | "simulator";
export type DeviceControlState = "ready" | "startable" | "unavailable";
export type DevicePreparationStatus = "ready" | "required" | "unavailable";

/** 平台测试目标。设备是执行资源，目标是被测 App 或小程序实例。 */
export type TargetKind = "app" | "mini-program";

export interface TestTarget {
  key: string;
  kind: TargetKind;
  platform: string;
  runtime: string;
  appId?: string;
  version?: string;
  environment?: string;
  connectorId?: string;
  /** 项目适配器可以放置领域字段，平台只透传并持久化。 */
  extensions?: Record<string, unknown>;
}

export interface AppRunTarget {
  key: string;
  kind: "app";
  label: string;
  platform: DevicePlatform;
  runtime: "native";
  concurrencyKey: string;
  device: Device;
}

export interface MiniProgramRunTarget {
  key: string;
  kind: "mini-program";
  label: string;
  platform: TargetPlatform;
  runtime: string;
  appId: string;
  concurrencyKey: string;
  extensions?: Record<string, unknown>;
}

/** 创建任务时冻结的执行资源。 */
export type RunTarget = AppRunTarget | MiniProgramRunTarget;

export function appRunTargetOf(device: Device): AppRunTarget {
  return {
    key: device.key,
    kind: "app",
    label: device.name,
    platform: device.platform,
    runtime: "native",
    concurrencyKey: device.key,
    device: structuredClone(device),
  };
}

export type ConnectorCapabilityId =
  | "device.discover"
  | "device.health"
  | "device.start"
  | "device.prepare"
  | "device.unlock"
  | "target.app.install"
  | "target.app.launch"
  | "target.mini-program.attach"
  | "target.mini-program.launch"
  | "target.mini-program.reload"
  | "evidence.screenshot"
  | "evidence.recording"
  | "evidence.network"
  | "evidence.logs"
  | "result.export"
  | (string & {});

export interface ConnectorCapability {
  id: ConnectorCapabilityId;
  version: number;
  limits?: Record<string, number | string | boolean>;
}

export interface ConnectorCapabilityManifest {
  schemaVersion: "mobile-test-console.capabilities.v1";
  connectorId: string;
  scope: {
    platform: string;
    deviceType?: DeviceType[];
    targetKinds?: TargetKind[];
    runtime?: string[];
  };
  capabilities: ConnectorCapability[];
  constraints?: {
    requires?: string[];
    excludes?: string[];
  };
  version?: string;
  extensions?: Record<string, unknown>;
}

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
  /** 当前设备由哪个 Connector 提供，以及它支持的底层能力。 */
  connectorId?: string;
  capabilities?: ConnectorCapabilityId[];
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

export interface PageSelectionPresetFilter {
  priorities?: string[];
  tags?: string[];
  testScopes?: string[];
}

export interface PageSelectionPreset {
  value: string;
  label: string;
  description?: string;
  filter: PageSelectionPresetFilter;
}

export interface PageSelectionParameterDefinition {
  id: string;
  label: string;
  type: "page-selection";
  defaultValue: string;
  source: "page-parameters";
  presets: PageSelectionPreset[];
}

export type TestParameterDefinition =
  | SelectParameterDefinition
  | AccountProfileParameterDefinition
  | PageSelectionParameterDefinition;

export type TestKind = "general" | "page" | "flow";

export interface ProjectTestEnvironment {
  id: string;
  label: string;
  description: string;
}

export interface ProjectTestCapabilityDeclaration {
  id: string;
  label: string;
  description: string;
  guidance: string[];
  providerId: string;
  required: boolean;
}

export interface ProjectTestResultContract {
  schemaVersion: string;
  artifactsRoot: string;
}

export interface ProjectTestingTargetHealthCheck {
  executable: string;
  args: string[];
  cwd?: string;
  env?: Record<string, string>;
}

export interface ProjectTestingTarget {
  key: string;
  label: string;
  kind: "mini-program";
  platform: TargetPlatform;
  runtime: string;
  appId: string;
  concurrencyKey: string;
  healthCheck?: ProjectTestingTargetHealthCheck;
  extensions?: Record<string, unknown>;
}

/** 项目配置声明的测试边界。平台只校验、调度和展示这些声明。 */
export interface ProjectTestingManifest {
  environments: ProjectTestEnvironment[];
  capabilities: ProjectTestCapabilityDeclaration[];
  targets?: ProjectTestingTarget[];
  result?: ProjectTestResultContract;
}

export interface PublicTestDefinition {
  id: string;
  label: string;
  testType: string;
  description: string;
  kind: TestKind;
  runnerId: string;
  providerId?: string;
  requiredCapabilities: string[];
  platforms: Platform[];
  targetKeys?: string[];
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

export interface TaskRetrySource {
  taskId: string;
  runId: string;
  scope: "task" | "cases" | "failed-cases";
  attempt: number;
  caseRunIds?: string[];
  caseIds?: string[];
  targetPages?: string[];
  /** 选中用例的页面启动信息，供项目 Runner 精确回放。 */
  caseRuns?: TaskRetryCase[];
}

export interface TaskRetryCase {
  caseRunId: string;
  caseId: string;
  targetPage: string;
  launchPage: string;
  routeParams?: Record<string, unknown>;
  parameterProfileId?: string;
}

export interface TestTask {
  id: string;
  runId: string;
  projectId: string;
  testId: string;
  testLabel: string;
  /** 创建任务时冻结的 Runner 选择；旧状态文件允许省略。 */
  runnerId?: string;
  /** 新任务的权威执行目标；历史状态加载时由 device 补齐。 */
  target?: RunTarget;
  /** App 任务兼容字段；小程序任务使用虚拟设备占位以兼容历史展示与存储。 */
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
  /** Runner 完成结果分析后返回的平台存储位置。 */
  resultUri?: string;
  /** 修复验证任务运行在独立 worktree 时记录其代码根目录。 */
  workspaceRoot?: string;
  repairJobId?: string;
  /** 手动重试任务的直接来源与请求范围。 */
  retryOf?: TaskRetrySource;
  /** 用户显式保留的运行不会进入自动或手动清理候选。 */
  retained?: boolean;
}

export interface ArtifactRetentionPolicy {
  maxAgeDays: number;
  maxRuns: number;
  maxBytes: number;
  minimumFreeBytes: number;
  keepSuccessfulPerPlatform: number;
  keepFailedPerPlatform: number;
  repairWorktreeMaxAgeDays: number;
}

export interface ArtifactStorageSnapshot {
  artifactRoot: string;
  available: boolean;
  writable: boolean;
  totalBytes: number;
  usedBytes: number;
  freeBytes: number;
  mountPoint: string;
  fileSystem: string;
  checkedAt: string;
  issue: string;
}

export interface ArtifactCleanupPlanItem {
  runId: string;
  taskIds: string[];
  status: "planned" | "deleted" | "missing" | "skipped" | "partial" | "failed";
  reason: string;
  relativePaths: string[];
  files: number;
  bytes: number;
}

export interface ArtifactCleanupPlan {
  schemaVersion: "mobile-test-console.artifact-cleanup-plan.v1";
  projectId: string;
  mode: "plan" | "apply";
  generatedAt: string;
  supported: boolean;
  protectedRunIds: string[];
  items: ArtifactCleanupPlanItem[];
  estimatedBytes: number;
  estimatedFiles: number;
  bytesFreed: number;
  filesRemoved: number;
  storage: ArtifactStorageSnapshot;
  warnings: string[];
  errors: string[];
}

export const ARTIFACT_RUN_ID_PATTERN = /^[A-Za-z0-9._-]+$/;

export interface ArtifactCleanupApplyRequest {
  runIds?: string[];
}

export interface ArtifactRetentionSnapshot {
  schemaVersion: "mobile-test-console.artifact-retention.v1";
  enabled: boolean;
  autoCleanup: boolean;
  policy: ArtifactRetentionPolicy;
  storage: ArtifactStorageSnapshot;
  retainedRunIds: string[];
  latestPlan: ArtifactCleanupPlan | null;
  latestCleanup: ArtifactCleanupPlan | null;
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

export const PROJECT_INTEGRATION_TYPES = ["lynx-app", "app", "mini-program"] as const;
export type ProjectIntegrationType = (typeof PROJECT_INTEGRATION_TYPES)[number];
export type ProjectFamily = "app" | "mini-program";

export function projectFamilyOf(integrationType: ProjectIntegrationType): ProjectFamily {
  return integrationType === "mini-program" ? "mini-program" : "app";
}

export const PROJECT_EXECUTION_PREREQUISITE_STEP_IDS = [
  "project",
  "template",
  "devices",
  "capabilities",
] as const;

export const PROJECT_ONBOARDING_STEP_IDS = PROJECT_EXECUTION_PREREQUISITE_STEP_IDS;
export type ProjectOnboardingStepId = (typeof PROJECT_ONBOARDING_STEP_IDS)[number];
export type ProjectOnboardingStepStatus = "pending" | "waiting" | "blocked" | "verified";
export type ProjectToolCheckStatus = "ready" | "blocked";
export type ProjectCapabilityCheckStatus = "ready" | "missing";

export interface ProjectToolCheck {
  id: string;
  label: string;
  executable: string;
  status: ProjectToolCheckStatus;
  path: string;
  version: string;
  detail: string;
  guidance: string[];
}

export interface ProjectCapabilityCheck {
  id: string;
  label: string;
  status: ProjectCapabilityCheckStatus;
  detail: string;
  guidance: string[];
}

export interface ProjectTestEntryCheck {
  id: string;
  label: string;
  testType: string;
  description: string;
  runnerId: string;
  platforms: Platform[];
  targetKeys?: string[];
  parameterLabels: string[];
}

export interface ProjectOnboardingStep {
  id: ProjectOnboardingStepId;
  status: ProjectOnboardingStepStatus;
  summary: string;
  issues: string[];
  checkedAt: string;
  tools?: ProjectToolCheck[];
  capabilities?: ProjectCapabilityCheck[];
  testEntries?: ProjectTestEntryCheck[];
}

/** 已登记的本机项目。运行时始终由 CLI 当前加载的项目配置决定。 */
export interface ProjectCatalogEntry {
  id: string;
  name: string;
  root: string;
  configPath: string;
  integrationType: ProjectIntegrationType;
  platforms: Platform[];
  active: boolean;
  createdAt: string;
  updatedAt: string;
  onboarding: ProjectOnboardingStep[];
}

export interface ProjectCatalogResponse {
  schemaVersion: "mobile-test-console.project-catalog.v1";
  activeProjectId: string;
  projects: ProjectCatalogEntry[];
}

/** 选中项目的配置详情，供项目工作台展示可用测试入口。 */
export interface ProjectCatalogDetailResponse {
  project: ProjectCatalogEntry;
  tests: PublicTestDefinition[];
  /** 项目已通过执行测试所需的运行前检查。 */
  executionReady: boolean;
}

export type ProjectSetupStep = "config" | "devices" | "capabilities";
export type ProjectSetupActionKind = "write-file" | "command" | "manual";

export interface ProjectSetupAction {
  id: string;
  kind: ProjectSetupActionKind;
  label: string;
  detail: string;
  target?: string;
  command?: string;
  cwd?: string;
  contentPreview?: string;
}

export interface ProjectSetupPlan {
  schemaVersion: "mobile-test-console.project-setup.v1";
  planId: string;
  step: ProjectSetupStep;
  projectId?: string;
  projectDirectory: string;
  summary: string;
  actions: ProjectSetupAction[];
  canApply: boolean;
  blockingReason: string;
}

export interface PreviewProjectInitializationRequest {
  projectDirectory: string;
  platforms: Platform[];
}

export interface ApplyProjectInitializationRequest extends PreviewProjectInitializationRequest {
  planId: string;
}

export interface ApplyProjectSetupRequest {
  step: Exclude<ProjectSetupStep, "config">;
  planId: string;
}

export interface ProjectSetupActionResult {
  actionId: string;
  status: "completed" | "manual";
  detail: string;
}

export interface ProjectSetupApplyResponse {
  plan: ProjectSetupPlan;
  catalog: ProjectCatalogResponse;
  results: ProjectSetupActionResult[];
}

export interface ProjectActivationResponse {
  catalog: ProjectCatalogResponse;
  projectId: string;
  configPath: string;
  restartRequired: true;
}

export interface RegisterProjectRequest {
  projectDirectory: string;
  configFile: string;
}

export interface ProjectConfigSelection {
  projectDirectory: string;
  configFile: string;
  configPath: string;
  configFound: boolean;
}

export interface ProjectProviderManifestSummary {
  schemaVersion: "mobile-test-console.project-provider.v1";
  providerId: string;
  scope: {
    targetKinds: TargetKind[];
    runtimes?: string[];
    platforms?: TargetPlatform[];
  };
  capabilities: Array<{ id: string; version: number }>;
}

export interface PageParameterAdapterManifest {
  defaultRoute: string;
  templateParameter: string;
  pageReadyEvent: string;
  actionSucceededEvent: string;
}

export interface ResultAnalysisAdapterManifest {
  pageOpenedEvents: string[];
}

export interface AccountProfileCapabilityRule {
  module?: string;
  methods?: string[];
  capability: string;
}

export interface AccountProfileProviderAdapterManifest {
  label: string;
  recordingLabel: string;
  defaultProfileId: string;
  defaultAccountLabel: string;
  requiredCapability: string;
  crossPlatformCapability?: string;
  devicePlatforms: Platform[];
  deviceTextIncludes: string[];
  requiredCaptureKinds: AccountProfileCaptureKind[];
  requiredResultFields: string[];
  capabilityRules: AccountProfileCapabilityRule[];
}

export interface AccountProfileAdapterManifest {
  providers: Record<AccountProfileProvider, AccountProfileProviderAdapterManifest>;
}

export interface RepairAdapterManifest {
  displayName: string;
  threadNamePrefix: string;
  fixingMessage: string;
}

export const PROJECT_WORKSPACE_IDS = ["page-parameters", "business-scripts", "account-profiles"] as const;
export type ProjectWorkspaceId = (typeof PROJECT_WORKSPACE_IDS)[number];

export interface ProjectAdapterManifest {
  workspaces: ProjectWorkspaceId[];
  pageParameters: PageParameterAdapterManifest;
  resultAnalysis: ResultAnalysisAdapterManifest;
  accountProfiles: AccountProfileAdapterManifest;
  repair: RepairAdapterManifest;
}

export interface ConsoleSnapshot {
  project: ProjectSummary;
  testing: ProjectTestingManifest;
  adapter?: ProjectAdapterManifest;
  connectors?: ConnectorCapabilityManifest[];
  projectProviders?: ProjectProviderManifestSummary[];
  devices: Device[];
  targets?: RunTarget[];
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
  deviceKeys?: string[];
  targetKeys?: string[];
  parameters: Record<string, string>;
}

export interface StartTasksResponse {
  tasks: TestTask[];
}

export interface RetryTaskRequest {
  caseRunIds?: string[];
}

export interface RetryTaskResponse {
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
  caseId?: string;
  priority?: string;
  tags?: string[];
  testScope?: string;
  platforms?: Platform[];
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
  platform: PageParameterPlatform;
  targetKey?: string;
  targetKind?: TargetKind;
  targetPlatform?: string;
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
  /** 小程序运行目标引用；App 录制继续使用 deviceKey/deviceId。 */
  targetKey?: string;
  targetKind?: TargetKind;
  targetLabel?: string;
  targetRuntime?: string;
  targetAppId?: string;
  targetPlatform?: string;
  deviceKey: string;
  deviceId: string;
  platform: PageParameterPlatform;
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
  adapter?: PageParameterAdapterManifest;
  pages: PageParameterPage[];
  recordings: PageParameterRecording[];
  warnings: string[];
}

export interface StartPageParameterRecordingRequest {
  deviceKey?: string;
  targetKey?: string;
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

export type AccountProfileProvider = string;
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
  providers?: Record<AccountProfileProvider, AccountProfileProviderAdapterManifest>;
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
