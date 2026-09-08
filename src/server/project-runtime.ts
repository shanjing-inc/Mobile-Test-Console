import type { ProjectProviderManifestSummary } from "../shared/contracts.js";
import type { ArtifactRetentionService } from "./artifact-retention.js";
import { ArtifactRetentionStore, ArtifactRetentionService as RuntimeArtifactRetentionService } from "./artifact-retention.js";
import type { CommandRunner } from "./command-runner.js";
import { AccountProfileStore } from "./account-profile-store.js";
import { AccountProfileService } from "./account-profiles.js";
import { BusinessScriptStore } from "./business-script-store.js";
import { BusinessScriptService } from "./business-scripts.js";
import { DeviceDiscoveryService } from "./devices.js";
import type { LoadedProjectConfig } from "./config.js";
import { ProjectLifecycle } from "./lifecycle.js";
import { PageParameterStore } from "./page-parameter-store.js";
import { PageParameterService } from "./page-parameters.js";
import type { ProjectCatalogService } from "./project-catalog.js";
import { RepairJobManager } from "./repair-job-manager.js";
import { RepairJobStore } from "./repair-job-store.js";
import type { ResultBundleStore as ResultBundleStoreType } from "./result-bundle-store.js";
import { ResultBundleStore } from "./result-bundle-store.js";
import type { TaskResultService as TaskResultServiceType } from "./task-results.js";
import { TaskResultService } from "./task-results.js";
import { loadRunnerRuntime } from "./runner-runtime.js";
import { StateStore } from "./state-store.js";
import { TaskExecutionCoordinator } from "./task-execution-coordinator.js";
import { TaskManager } from "./task-manager.js";

export interface ProjectRuntime {
  config: LoadedProjectConfig;
  devices: DeviceDiscoveryService;
  tasks: TaskManager;
  taskResults: TaskResultServiceType;
  pageParameters: PageParameterService;
  accountProfiles: AccountProfileService;
  businessScripts: BusinessScriptService;
  resultBundles: ResultBundleStoreType;
  repairs?: RepairJobManager;
  artifacts: ArtifactRetentionService;
  projectProviders: ProjectProviderManifestSummary[];
  shutdown(): Promise<void>;
}

export interface CreateProjectRuntimeOptions {
  commandRunner: CommandRunner;
  executionCoordinator: TaskExecutionCoordinator;
  lifecycleManaged?: boolean;
  startLifecycle?: boolean;
}

export async function createProjectRuntime(
  config: LoadedProjectConfig,
  options: CreateProjectRuntimeOptions,
): Promise<ProjectRuntime> {
  const devices = new DeviceDiscoveryService(
    options.commandRunner,
    config.deviceProviders,
    config.iosSimulator,
    config,
  );
  const resultBundles = new ResultBundleStore(config.stateDir);
  const runnerRuntime = await loadRunnerRuntime(config, [], resultBundles);
  const tasks = new TaskManager(
    config,
    new StateStore(config.stateDir),
    runnerRuntime.compatibilityRunner,
    runnerRuntime.resolver,
    undefined,
    undefined,
    options.executionCoordinator,
  );
  await tasks.initialize();
  const taskResults = new TaskResultService(config, tasks, resultBundles);
  const pageParameters = new PageParameterService(config, new PageParameterStore(config.pageParameterStorage?.directory ?? config.stateDir, config.pageParameterStorage?.legacyDirectories));
  const accountProfiles = new AccountProfileService(
    config,
    new AccountProfileStore(config.accountProfileStorage?.directory ?? config.stateDir, config.adapter, config.accountProfileStorage?.legacyDirectories, config.accountProfileStorage?.id),
  );
  const businessScripts = new BusinessScriptService(config, new BusinessScriptStore(config.stateDir));
  const repairs = config.codexRepair?.enabled
    ? new RepairJobManager(
        config,
        new RepairJobStore(config.stateDir),
        tasks,
        taskResults,
        devices,
        options.commandRunner,
      )
    : undefined;
  if (repairs) await repairs.initialize();
  const artifacts = new RuntimeArtifactRetentionService(
    config,
    tasks,
    new ArtifactRetentionStore(config.stateDir),
    repairs,
    options.commandRunner,
  );
  await artifacts.initialize();
  const lifecycle = new ProjectLifecycle(config);
  if (options.startLifecycle && !options.lifecycleManaged) await lifecycle.startup();

  return {
    config,
    devices,
    tasks,
    taskResults,
    pageParameters,
    accountProfiles,
    businessScripts,
    resultBundles,
    repairs,
    artifacts,
    projectProviders: runnerRuntime.providers.manifests(),
    async shutdown() {
      if (repairs) await repairs.shutdown();
      await artifacts.shutdown();
      await tasks.shutdown();
      if (options.startLifecycle && !options.lifecycleManaged) await lifecycle.shutdown();
    },
  };
}

export type ProjectRuntimeFactory = (config: LoadedProjectConfig) => Promise<ProjectRuntime>;

export class ProjectRuntimeRegistry {
  private readonly runtimes = new Map<string, ProjectRuntime>();
  private readonly pending = new Map<string, Promise<ProjectRuntime>>();

  constructor(
    private readonly defaultRuntime: ProjectRuntime,
    private readonly catalog: ProjectCatalogService,
    private readonly factory: ProjectRuntimeFactory,
  ) {
    this.runtimes.set(defaultRuntime.config.project.id, defaultRuntime);
  }

  async resolve(projectId = ""): Promise<ProjectRuntime> {
    const resolvedProjectId = projectId.trim() || this.defaultRuntime.config.project.id;
    const existing = this.runtimes.get(resolvedProjectId);
    if (existing) return existing;
    const inflight = this.pending.get(resolvedProjectId);
    if (inflight) return inflight;

    const loading = this.load(resolvedProjectId);
    this.pending.set(resolvedProjectId, loading);
    try {
      return await loading;
    } finally {
      this.pending.delete(resolvedProjectId);
    }
  }

  loaded(): ProjectRuntime[] {
    return [...this.runtimes.values()];
  }

  async shutdown(): Promise<void> {
    await Promise.allSettled(this.pending.values());
    await Promise.allSettled(this.loaded().map(runtime => runtime.shutdown()));
  }

  private async load(projectId: string): Promise<ProjectRuntime> {
    const config = await this.catalog.loadRuntimeConfig(projectId);
    const runtime = await this.factory(config);
    if (runtime.config.project.id !== projectId) {
      await runtime.shutdown();
      throw new Error(`项目 Runtime 身份不一致: ${projectId} != ${runtime.config.project.id}`);
    }
    this.runtimes.set(projectId, runtime);
    return runtime;
  }
}
