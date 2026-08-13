import {
  appRunTargetOf,
} from "../shared/contracts.js";
import type {
  ConnectorCapabilityId,
  ConnectorCapabilityManifest,
  Device,
  TaskRetrySource,
  TestTask,
  TestTarget,
} from "../shared/contracts.js";
import type { ProjectProvider } from "./project-provider.js";

export const RUNNER_ID_PATTERN = /^[a-z][a-z0-9-]*$/;
export const LEGACY_COMMAND_RUNNER_ID = "legacy-command-runner";
export const RUNNER_PLUGIN_API_VERSION = "mobile-test-console.runner-plugin.v1" as const;

export interface CommandResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface CommandRunner {
  capture(
    executable: string,
    args: string[],
    timeoutMs?: number,
    options?: { cwd?: string; env?: Record<string, string> },
  ): Promise<CommandResult>;
}

export type RunnerEventType =
  | "status"
  | "log"
  | "capability"
  | "artifact"
  | "result"
  | "error"
  | "cancelled";

export interface RunnerEvent {
  type: RunnerEventType;
  runId: string;
  timestamp: string;
  message?: string;
  level?: "info" | "warn" | "error";
  source?: "runner" | "connector" | "stdout" | "stderr";
  data?: unknown;
}

export interface RunnerCommand {
  executable: string;
  args: string[];
  cwd?: string;
  env?: Record<string, string>;
}

export function retryEnvironmentOfPlan(plan: Pick<RunPlan, "metadata">): Record<string, string> {
  const retry = plan.metadata?.retry;
  if (!retry || typeof retry !== "object") return {};
  const source = retry as Partial<TaskRetrySource>;
  return {
    MTC_RETRY_SCOPE: String(source.scope ?? ""),
    MTC_RETRY_ATTEMPT: String(source.attempt ?? ""),
    MTC_RETRY_CASE_RUN_IDS: (source.caseRunIds ?? []).join(","),
    MTC_RETRY_CASE_IDS: (source.caseIds ?? []).join(","),
    MTC_RETRY_TARGET_PAGES: (source.targetPages ?? []).join(","),
    MTC_RETRY_CASES: JSON.stringify(source.caseRuns ?? []),
    MTC_RETRY_SOURCE_TASK_ID: String(source.taskId ?? ""),
    MTC_RETRY_SOURCE_RUN_ID: String(source.runId ?? ""),
  };
}

export interface RunPlan {
  runId: string;
  projectId: string;
  testId: string;
  runnerId?: string;
  device: Device;
  target?: TestTarget;
  command?: RunnerCommand;
  requiredCapabilities?: ConnectorCapabilityId[];
  metadata?: Record<string, unknown>;
}

export interface RunnerContext {
  signal: AbortSignal;
  emit(event: RunnerEvent): void;
}

export interface RunnerResult {
  runId: string;
  status: "passed" | "failed" | "cancelled";
  exitCode: number | null;
  error?: string;
  /** 兼容旧 runner 的结果文件位置，由 importer 进一步处理。 */
  resultUri?: string;
  metadata?: Record<string, unknown>;
}

export interface InProcessRunner {
  readonly id: string;
  run(plan: RunPlan, context: RunnerContext): Promise<RunnerResult>;
  cancel?(runId: string): Promise<void> | void;
  shutdown?(): Promise<void> | void;
}

export interface RunnerPluginContext {
  configPath: string;
  project: Readonly<{ id: string; name: string; root: string }>;
  stateDir: string;
  options: Readonly<Record<string, unknown>>;
  services: Readonly<RunnerPluginServices>;
}

export interface RunnerPluginServices {
  createCommandRunner(id: string): InProcessRunner;
  createProviderCommandRunner(
    id: string,
    providerId: string,
    requiredCapabilities: readonly string[],
  ): InProcessRunner;
  requireProjectProvider(providerId: string, requiredCapabilities?: readonly string[]): ProjectProvider;
}

export interface RunnerPlugin {
  apiVersion: typeof RUNNER_PLUGIN_API_VERSION;
  createRunners(context: RunnerPluginContext): InProcessRunner[] | Promise<InProcessRunner[]>;
}

export function defineRunnerPlugin(plugin: RunnerPlugin): RunnerPlugin {
  return plugin;
}

export interface RunnerResolver {
  resolve(plan: RunPlan): InProcessRunner;
}

export class InProcessRunnerRegistry implements RunnerResolver {
  private readonly runners = new Map<string, InProcessRunner>();

  constructor(private readonly defaultRunnerId?: string) {
    if (defaultRunnerId) validateRunnerId(defaultRunnerId);
  }

  register(runner: InProcessRunner): void {
    validateInProcessRunner(runner);
    if (this.runners.has(runner.id)) throw new Error(`Runner 已注册: ${runner.id}`);
    this.runners.set(runner.id, runner);
  }

  unregister(runnerId: string): boolean {
    return this.runners.delete(runnerId);
  }

  get(runnerId: string): InProcessRunner | undefined {
    return this.runners.get(runnerId);
  }

  list(): InProcessRunner[] {
    return [...this.runners.values()];
  }

  resolve(plan: RunPlan): InProcessRunner {
    const runnerId = plan.runnerId ?? this.defaultRunnerId;
    if (!runnerId) throw new Error(`运行计划未声明 Runner: ${plan.runId}`);
    const runner = this.runners.get(runnerId);
    if (!runner) throw new Error(`Runner 未注册: ${runnerId}`);
    return runner;
  }
}

export interface ConnectorDevice extends Device {
  connectorId: string;
  capabilities: ConnectorCapabilityId[];
}

export type ConnectorPreparationRequest =
  | { action: "check" }
  | { action: "install"; preparationId: string };

export interface DeviceConnector {
  readonly id: string;
  readonly manifest: ConnectorCapabilityManifest;
  discover(signal?: AbortSignal): Promise<ConnectorDevice[]>;
  start?(device: ConnectorDevice, signal?: AbortSignal): Promise<ConnectorDevice>;
  prepare?(
    device: ConnectorDevice,
    request: ConnectorPreparationRequest,
    signal?: AbortSignal,
  ): Promise<ConnectorDevice>;
  healthCheck?(device: ConnectorDevice, signal?: AbortSignal): Promise<{ ok: boolean; detail?: string }>;
  cancel?(operationId: string): Promise<void> | void;
  exportArtifacts?(runId: string, signal?: AbortSignal): Promise<unknown[]>;
}

export interface ConnectorSelection {
  platform?: string;
  runtime?: string;
  deviceType?: Device["type"];
  targetKind?: TestTarget["kind"];
  requiredCapabilities?: ConnectorCapabilityId[];
}

export class InProcessConnectorRegistry {
  private readonly connectors = new Map<string, DeviceConnector>();

  register(connector: DeviceConnector): void {
    validateCapabilityManifest(connector.manifest);
    if (connector.id !== connector.manifest.connectorId) {
      throw new Error(`连接器 ID 与能力清单不一致: ${connector.id}/${connector.manifest.connectorId}`);
    }
    if (this.connectors.has(connector.id)) {
      throw new Error(`连接器已注册: ${connector.id}`);
    }
    this.connectors.set(connector.id, connector);
  }

  unregister(connectorId: string): boolean {
    return this.connectors.delete(connectorId);
  }

  get(connectorId: string): DeviceConnector | undefined {
    return this.connectors.get(connectorId);
  }

  list(): DeviceConnector[] {
    return [...this.connectors.values()];
  }

  select(selection: ConnectorSelection = {}): DeviceConnector | undefined {
    return this.list().find(connector => {
      const scope = connector.manifest.scope;
      if (selection.platform && scope.platform !== selection.platform) return false;
      if (selection.runtime && scope.runtime && !scope.runtime.includes(selection.runtime)) return false;
      if (selection.deviceType && scope.deviceType && !scope.deviceType.includes(selection.deviceType)) return false;
      if (selection.targetKind && scope.targetKinds && !scope.targetKinds.includes(selection.targetKind)) return false;
      const capabilities = new Set(connector.manifest.capabilities.map(item => item.id));
      return (selection.requiredCapabilities ?? []).every(capability => capabilities.has(capability));
    });
  }

  manifests(): ConnectorCapabilityManifest[] {
    return this.list().map(connector => structuredClone(connector.manifest));
  }
}

export function createRunnerEvent(
  runId: string,
  type: RunnerEventType,
  data: Omit<RunnerEvent, "runId" | "type" | "timestamp"> = {},
): RunnerEvent {
  return { runId, type, timestamp: new Date().toISOString(), ...data };
}

export function validateRunnerId(runnerId: string): void {
  if (!RUNNER_ID_PATTERN.test(runnerId)) throw new Error(`Runner ID 无效: ${runnerId}`);
}

export function validateRunnerCommand(value: unknown): asserts value is RunnerCommand {
  if (!value || typeof value !== "object") throw new Error("Runner 命令无效");
  const command = value as Partial<RunnerCommand>;
  if (typeof command.executable !== "string" || command.executable.trim().length === 0) {
    throw new Error("Runner 命令缺少 executable");
  }
  if (!Array.isArray(command.args) || command.args.some(argument => typeof argument !== "string")) {
    throw new Error("Runner 命令 args 无效");
  }
  if (command.cwd !== undefined && (typeof command.cwd !== "string" || command.cwd.trim().length === 0)) {
    throw new Error("Runner 命令 cwd 无效");
  }
  if (command.env !== undefined && (!command.env || typeof command.env !== "object"
    || Array.isArray(command.env)
    || Object.values(command.env).some(item => typeof item !== "string"))) {
    throw new Error("Runner 命令 env 无效");
  }
}

export function validateInProcessRunner(value: unknown): asserts value is InProcessRunner {
  if (!value || typeof value !== "object") throw new Error("Runner 导出无效");
  const runner = value as Partial<InProcessRunner>;
  validateRunnerId(String(runner.id ?? ""));
  if (typeof runner.run !== "function") throw new Error(`Runner 缺少 run(): ${runner.id}`);
}

export function assertRunnerPlugin(value: unknown): asserts value is RunnerPlugin {
  if (!value || typeof value !== "object") throw new Error("Runner 插件导出无效");
  const plugin = value as Partial<RunnerPlugin>;
  if (plugin.apiVersion !== RUNNER_PLUGIN_API_VERSION) {
    throw new Error(`Runner 插件协议不兼容: ${String(plugin.apiVersion ?? "unknown")}`);
  }
  if (typeof plugin.createRunners !== "function") throw new Error("Runner 插件缺少 createRunners()");
}

export function createRunPlan(task: TestTask, command?: RunnerCommand): RunPlan {
  const device = task.device ?? (task.target?.kind === "app" ? task.target.device : undefined);
  if (!device) throw new Error(`运行任务缺少 App 设备兼容信息: ${task.runId}`);
  return {
    runId: task.runId,
    projectId: task.projectId,
    testId: task.testId,
    runnerId: task.runnerId ?? LEGACY_COMMAND_RUNNER_ID,
    device: structuredClone(device),
    ...(task.target ? { target: structuredClone(task.target) } : { target: appRunTargetOf(device) }),
    ...(command ? {
      command: {
        ...structuredClone(command),
        env: { ...(command.env ?? {}), ...retryEnvironmentOfPlan({ metadata: { retry: task.retryOf } }) },
      },
    } : {}),
    metadata: {
      taskId: task.id,
      parameters: structuredClone(task.parameters),
      ...(task.retryOf ? { retry: structuredClone(task.retryOf) } : {}),
    },
  };
}

export function requiredCapabilitiesSupported(
  manifest: ConnectorCapabilityManifest,
  required: readonly ConnectorCapabilityId[] = [],
): boolean {
  const available = new Set(manifest.capabilities.map(capability => capability.id));
  return required.every(capability => available.has(capability));
}

export function validateCapabilityManifest(manifest: ConnectorCapabilityManifest): void {
  if (manifest.schemaVersion !== "mobile-test-console.capabilities.v1") {
    throw new Error(`连接器能力协议不兼容: ${manifest.schemaVersion}`);
  }
  if (!/^[a-z][a-z0-9-]*$/.test(manifest.connectorId)) {
    throw new Error(`连接器 ID 无效: ${manifest.connectorId}`);
  }
  if (!manifest.scope.platform.trim()) throw new Error("连接器能力必须声明 platform");
  const ids = new Set<string>();
  for (const capability of manifest.capabilities) {
    if (!capability.id.trim() || !Number.isInteger(capability.version) || capability.version < 1) {
      throw new Error(`连接器能力无效: ${capability.id}`);
    }
    if (ids.has(capability.id)) throw new Error(`连接器能力重复: ${capability.id}`);
    ids.add(capability.id);
  }
}
