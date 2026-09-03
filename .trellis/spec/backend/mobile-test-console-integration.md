# Mobile Test Console Integration

This document is the authoritative integration contract for Mobile Test Console (MTC). It covers the platform core, project configuration, Runner and Project Provider plugins, task persistence, Result Bundle ingestion, and the App / mini-program product boundary. Project-specific routes, accounts, fixtures, commands, and business labels belong in each integrated repository.

## Scenario: Artifact retention and project cleanup adapters

### 1. Scope / Trigger

- Trigger: a project declares `artifactRetention` or a user opens the Test Storage section.
- MTC owns retention policy, protected-run calculation, storage checks, confirmation, background scheduling, task-index updates, and audit persistence.
- The integrated project owns run-to-path mapping and deletion inside its declared artifact root.

### 2. Signatures

```ts
interface ArtifactRetentionConfig {
  enabled: boolean;
  autoCleanup: boolean;
  artifactsRoot: string;
  cleanup: CommandDefinition;
  policy: ArtifactRetentionPolicy;
}

type ArtifactCleanupMode = "plan" | "apply";
```

The request schema is `mobile-test-console.artifact-cleanup-request.v1`; the result schema is `mobile-test-console.artifact-cleanup-result.v1`. A request may set `discoverCandidates: true` with an empty candidate list to ask the project adapter for its selectable run inventory.

```text
node tests/mtc/cleanup-run.mjs \
  --request {{cleanup.requestPath}} \
  --artifacts-root {{results.artifactsRoot}}
```

### 3. Contracts

- `artifactRetention.artifactsRoot` resolves relative to `project.root` and works independently from legacy `taskResults`.
- MTC protects active tasks, retained tasks, active repair jobs, recent runs, recent successful runs per platform, and recent failed runs per platform.
- `plan` and `apply` receive candidate and protected run IDs. Project adapters reject unsafe run IDs and operate only under the configured artifact root.
- A project may group one run across several namespaced directories below the root, such as `.test/results/<runId>` and `.test/runtime/<runId>`. The adapter returns their aggregate file count, byte count, and relative paths as one item.
- Manual inventory uses adapter-owned run-to-directory semantics. MTC may select returned run IDs and re-plan the exact selection before apply.
- Manual selection protects active tasks, retained tasks, and active repair jobs. Policy recency and count protections guide automatic cleanup and remain user-overridable through explicit selection.
- Adapter result items must reference unique run IDs from the current candidate set. Unknown or duplicate run IDs invalidate the response.
- MTC removes task indexes only when the top-level result reports `ok: true`, and only for items that return `deleted` or `missing`.
- Failed and partial adapter results remain visible and auditable.
- Test start checks artifact-root writability and the configured free-space safety threshold.
- Repair worktree cleanup applies only to expired terminal jobs, archives the repair patch before removing the worktree, and still runs when no project artifact candidate exists.
- Existing artifacts are never deleted during first-time migration. A read-only plan is generated before user-confirmed apply.

### 4. Validation & Error Matrix

| Condition | Result |
| --- | --- |
| `artifactRetention.artifactsRoot` is absent | Test Storage reports the current config field as missing and cleanup stays unavailable |
| Request schema or mode is invalid | Project adapter exits before file measurement or deletion |
| Candidate or protected run ID is unsafe | Project adapter exits before resolving a target path |
| A run directory is a symlink or resolves outside the root | Project adapter rejects the run and preserves the external target |
| `plan` succeeds | Response reports files and bytes while all run directories remain present |
| `apply` partially fails | Response sets top-level `ok: false`, reports `partial` or `failed`, and MTC preserves task indexes |

### 5. Good / Base / Bad Cases

- Good: a mini-program project declares `.test` as its root and maps one run to both `results/<runId>` and `runtime/<runId>`.
- Base: a run exists only in `results`; the adapter reports the existing directory and treats a later repeated apply as `missing`.
- Bad: MTC core scans project-specific directory names or the adapter accepts arbitrary paths from the request.

### 6. Tests Required

- Cover active, retained, recent-success, recent-failure, and active-repair protection.
- Cover dry-run immutability, apply/index ordering, adapter failures, path traversal, symlink boundaries, idempotent missing runs, and overlapping run-ID prefixes.
- Cover storage low-water blocking and repair patch archival.
- Load the Starter cleanup adapter through the public config schema and execute both plan and apply.
- Load a mini-program config with `artifactRetention.artifactsRoot`, scan real run directories through the MTC inventory API, and assert the Test Storage UI renders the root, total size, selectable run count, and per-run file sizes.

### 7. Wrong vs Correct

#### Wrong

```js
artifactRetention: {
  artifactsRoot: ".test/results",
  cleanup: { args: ["cleanup.mjs", "--path", "{{user.path}}"] },
}
```

#### Correct

```js
artifactRetention: {
  enabled: true,
  autoCleanup: false,
  artifactsRoot: ".test",
  cleanup: {
    executable: "node",
    args: [
      "tests/mtc/cleanup-run.mjs",
      "--request", "{{cleanup.requestPath}}",
      "--artifacts-root", "{{results.artifactsRoot}}",
    ],
  },
}
```

## Scenario: Project families and run targets

### 1. Scope / Trigger

- Trigger: a project declares `project.integrationType`, device platforms, or mini-program run targets in `mobile-test.config.cjs`.
- This contract applies to config loading, catalog onboarding, `/api/snapshot`, workspace selection, and test-target selection.
- `ProjectFamily` is the product-navigation boundary. `RunTarget` is the scheduling boundary.

### 2. Signatures

```ts
type DevicePlatform = "android" | "ios" | "harmony";
type TargetPlatform = string;
type ProjectIntegrationType = "lynx-app" | "app" | "mini-program";
type ProjectFamily = "app" | "mini-program";

function projectFamilyOf(type: ProjectIntegrationType): ProjectFamily;

type RunTarget = AppRunTarget | MiniProgramRunTarget;

interface AppRunTarget {
  key: string;
  kind: "app";
  label: string;
  platform: DevicePlatform;
  runtime: "native";
  concurrencyKey: string;
  device: Device;
}

interface MiniProgramRunTarget {
  key: string;
  kind: "mini-program";
  label: string;
  platform: TargetPlatform;
  runtime: string;
  appId: string;
  concurrencyKey: string;
  extensions?: Record<string, unknown>;
}
```

```js
testing: {
  targets: [{
    key: "wechat-devtools",
    label: "WeChat DevTools",
    kind: "mini-program",
    platform: "wechat",
    runtime: "wechat-devtools",
    appId: "wx-example",
    concurrencyKey: "example-wechat",
    healthCheck: {
      executable: "node",
      args: ["tests/mtc/check-runtime.mjs", "--app-id", "{{target.appId}}"],
    },
  }],
}
```

### 3. Contracts

- `projectFamilyOf("lynx-app")` and `projectFamilyOf("app")` return `app`; `projectFamilyOf("mini-program")` returns `mini-program`.
- Device discovery remains constrained to `DevicePlatform`. Project targets and Provider manifests may use platform strings such as `wechat`.
- App run targets are derived from live devices through `appRunTargetOf(device)`. Their concurrency key equals the device key.
- Mini-program run targets are config-owned immutable snapshots. MTC validates and displays their identity while the project owns runtime semantics in `extensions`.
- `testing.targets[].key` and `concurrencyKey` are unique within one project. A target key follows `^[a-z][a-z0-9-]*$`.
- Each test declares at least one execution surface: `platforms` for App devices or `targetKeys` for configured run targets.
- Every `tests[].targetKeys` value references one declared `testing.targets` key.
- `/api/snapshot` returns live App devices in `devices` and configured run targets in `targets`.
- Catalog onboarding keeps the stable step ID `devices`. App projects verify device tools and live devices; mini-program projects run each target health check and present that step as the run environment.
- Registering an existing project config persists the catalog entry and immediately verifies every onboarding step before returning. A persisted pending config step is rechecked from the project card; config generation is offered only after verification confirms the file is missing.
- A failed target health check preserves non-empty stdout and stderr in the tool detail so project-owned structured diagnostics remain visible.
- The browser keeps separate App and mini-program project lists. App execution renders device controls and App workspaces. Mini-program execution renders run targets and the project/test workspaces.
- Changing the selected test within the active project reconciles the current resource selection against the next test. Mini-program selections keep keys declared by the next `targetKeys`; App selections keep device keys whose platform belongs to the next `platforms`. Project and family changes clear the selection.

### 4. Validation & Error Matrix

| Condition | Result |
| --- | --- |
| Duplicate target key | `CONFIG_INVALID` with the second target path |
| Duplicate target concurrency key | `CONFIG_INVALID` with the second target path |
| Target kind differs from `mini-program` | Config schema rejection |
| Target lacks platform, runtime, App ID, or concurrency key | Config schema rejection |
| Test declares neither `platforms` nor `targetKeys` | `CONFIG_INVALID` |
| App test declares `targetKeys` | `CONFIG_INVALID` |
| Test references an unknown target key | `CONFIG_INVALID` |
| Mini-program target has no health check | Onboarding reports the target as configured and leaves runtime verification waiting |
| Health check exits nonzero | Onboarding step becomes `blocked` with bounded stdout/stderr detail |
| Health check exits zero | Onboarding step becomes `verified` and records command/tool detail |

### 5. Good / Base / Bad Cases

- Good: an App project declares Android and iOS, then MTC derives one run target per connected device.
- Good: a mini-program project declares a `wechat-devtools` target and verifies it through a project-owned command.
- Base: a mini-program project has no live device discovery providers; its configured targets remain available.
- Bad: platform core maps a project ID to a vendor runtime or business route.
- Bad: the browser mixes mini-program targets into the App device list.

### 6. Tests Required

- Assert all project integration types map to the correct family.
- Parse a mini-program target, expose it through the snapshot, and verify its extensions survive cloning.
- Reject duplicate target keys, duplicate concurrency keys, unknown test target keys, and App tests with target keys.
- Assert health-check template values, cwd, exit-code handling, onboarding state, and tool detail.
- Assert App / mini-program project filters, workspace visibility, target/device controls, and narrow-screen layout.
- Assert test changes preserve shared mini-program targets and matching App devices while removing resources unsupported by the next test.

### 7. Wrong vs Correct

#### Wrong

```ts
type Platform = "android" | "ios" | "harmony" | "wechat";
```

#### Correct

```ts
type DevicePlatform = "android" | "ios" | "harmony";
type TargetPlatform = string;
```

## Scenario: Target-aware task scheduling and persistence

### 1. Scope / Trigger

- Trigger: a caller creates, cancels, resumes, deletes, or reads a task through the public HTTP API or `TaskManager`.
- This contract protects App compatibility while making the frozen target authoritative for new tasks.

### 2. Signatures

```ts
interface StartTasksRequest {
  testId: string;
  deviceKeys?: string[];
  targetKeys?: string[];
  parameters: Record<string, string>;
}

interface TestTask {
  id: string;
  runId: string;
  projectId: string;
  testId: string;
  target?: RunTarget;
  device: Device;
  status: TaskStatus;
  resultUri?: string;
}

POST /api/tasks
POST /api/tasks/:taskId/stop
DELETE /api/tasks/:taskId
```

### 3. Contracts

- A start request selects one surface: `deviceKeys` or `targetKeys`.
- `deviceKeys` resolve against current discovery and create App run targets. Device availability, platform support, preparations, and account-profile requirements run before task creation.
- `targetKeys` resolve against `tests[].targetKeys` and configured mini-program targets. Device preparation and account-profile validation are skipped for this path.
- One task is created per selected target. Each task freezes the target, runner selection, parameters, command, project ID, and run ID.
- `TestTask.target` is authoritative for rendering, command templates, concurrency, and Runner plans.
- `TestTask.device` remains required during the v1 compatibility period. Mini-program tasks receive a virtual device derived from the target; new code does not use this placeholder for runtime decisions.
- App targets use a FIFO queue keyed by device key. The queue head executes immediately when its device is idle; later App tasks for that device remain `queued`. Queues for different devices execute independently.
- An App task in `queued`, `preparing`, or `running` reserves its pair of `testId` and device key. A repeated start for that pair returns `TASK_DUPLICATE`, HTTP 409. A request containing any duplicate pair creates no tasks. A different App test may join the same device queue.
- Active mini-program tasks lock by `target.concurrencyKey`.
- One `TaskManager` instance establishes the mini-program lock before its first asynchronous persistence boundary. Concurrent `start()` calls therefore observe the first registered active task and only one call can acquire a given `concurrencyKey`.
- Busy mini-program starts fail immediately with `TARGET_BUSY`; task queuing and cross-process locking are separate capabilities.
- Cancellation aborts the Runner signal, calls optional Runner cancellation, persists the request, and finalizes the task as `cancelled`. Cancelling an App task that is still queued starts no Runner and leaves the next queued task eligible to run after the current task reaches a terminal state.
- State loading adds `appRunTargetOf(task.device)` to legacy tasks without a target. Tasks persisted as `queued`, `preparing`, or `running` become `interrupted` after service restart.
- A terminal Runner result may set `resultUri`. MTC persists the URI before result analysis is requested.

### 4. Validation & Error Matrix

| Condition | Result |
| --- | --- |
| Both selector arrays are absent or empty | `REQUEST_INVALID`, HTTP 400 |
| Both selector arrays contain values | `REQUEST_INVALID`, HTTP 400 |
| Unknown test ID | `TEST_UNKNOWN`, HTTP 404 |
| Unknown device key | `DEVICE_UNKNOWN`, HTTP 404 |
| Unavailable device | `DEVICE_UNAVAILABLE`, HTTP 409 |
| Device platform is absent from the test | `PLATFORM_UNSUPPORTED` |
| Unknown configured target | `TARGET_UNKNOWN`, HTTP 404 |
| Target is absent from the selected test | `TARGET_UNSUPPORTED` |
| Active task holds the concurrency key | `TARGET_BUSY`, HTTP 409 |
| Two concurrent starts request the same concurrency key | One start succeeds and one returns `TARGET_BUSY`, HTTP 409 |
| App device already has an executing task | Create a `queued` App task for that device; its queue position does not block tasks on other devices |
| Active App task has the same test ID and device key | `TASK_DUPLICATE`, HTTP 409; no new task is created |
| Service restarts with an active persisted task | Recover it as `interrupted` with a finished timestamp |

### 5. Good / Base / Bad Cases

- Good: two independent mini-program targets use different concurrency keys and execute concurrently.
- Good: two simultaneous starts share one concurrency key; one task is registered and the competing start receives `TARGET_BUSY`.
- Good: a legacy App task gains an App target during state loading and continues to render normally.
- Base: stopping an already terminal task returns the terminal snapshot.
- Bad: account-profile selection runs against the mini-program virtual device.
- Bad: a task reads the latest config target after execution begins and changes identity mid-run.

### 6. Tests Required

- Start App and mini-program tasks through HTTP and assert the frozen target in state and Runner plans.
- Reject mixed, empty, unknown, unsupported, unavailable, and busy selections with exact codes.
- Start two shared-key mini-program requests through `Promise.allSettled()`. Assert one fulfilled result, one `TARGET_BUSY` rejection, and one matching active task in `TaskManager.list()`.
- Start App tasks on two devices and assert both runners enter `running`; start three App tasks for one device and assert FIFO execution, queued cancellation, and continued scheduling.
- Reject repeated App starts for the same test ID and device in both `running` and `queued` states; assert a batch duplicate request remains atomic; allow a new task after the original reaches a terminal state and allow another test ID to join the device queue.
- Assert mini-program cancellation, concurrency locking, persistence, and service-restart recovery.
- Assert persisted App `queued` tasks recover as `interrupted` and never resume after restart.
- Assert old state without `target` migrates to an App target.
- Assert template resolution and UI labels prefer `target` over the compatibility device.

### 7. Wrong vs Correct

#### Wrong

```ts
await persist(task);
tasks.set(task.id, task);
```

This yields execution before the in-memory lock exists, so a concurrent start can acquire the same execution resource.

#### Correct

```ts
tasks.set(task.id, task);
await persist(task);
```

The synchronous registration makes the active task visible to every later `start()` call in the same `TaskManager` instance.

## Scenario: Manual re-test from terminal results

### 1. Scope / Trigger

- Trigger: a user re-tests a terminal task or selects one or more case runs from the result detail.
- MTC owns retry validation, task creation, scheduling, persistence, and Runner metadata.
- The integrated project consumes the optional retry metadata and maps it to project-specific filters.

### 2. Signatures

```ts
interface TaskRetrySource {
  taskId: string;
  runId: string;
  scope: "task" | "cases" | "failed-cases";
  attempt: number;
  caseRunIds?: string[];
  caseIds?: string[];
  targetPages?: string[];
}

interface TestTask {
  retryOf?: TaskRetrySource;
}

POST /api/tasks/:taskId/retry
{ "caseRunIds": ["case-run-id"] }
{ "targetPages": ["pages/demo/index"] }
```

### 3. Contracts

- A retry creates a new task and run while preserving the source task and result.
- The new task reuses the source test, parameters, and frozen run target.
- The source task must be terminal.
- `TaskManager.start` assigns `retryOf.attempt` from the complete persisted retry lineage immediately before enqueueing. API handlers may propose an attempt value, while the task manager remains authoritative so sibling requests receive monotonically increasing attempts.
- An explicit case range contains unique `caseRunId` values from the source `TaskResult`, including passed cases.
- A page range contains unique `targetPage` values and is mutually exclusive with `caseRunIds`; MTC resolves every matching source run, freezes the resulting case/page scope, and returns `RETRY_PAGE_UNKNOWN` when any requested page is absent.
- MTC projects the selected runs into stable `caseRunIds`, `caseIds`, `targetPages`, and `caseRuns` fields. Each `caseRuns` item carries the direct source ID plus invocation identity such as `parameterProfileId` and `routeParams`.
- `TestTask.retryOf` survives persistence and the Runner plan exposes the same value as `metadata.retry`.
- Runner commands receive the optional retry context as environment variables: `MTC_RETRY_SCOPE`, `MTC_RETRY_ATTEMPT`, `MTC_RETRY_CASE_RUN_IDS`, `MTC_RETRY_CASE_IDS`, `MTC_RETRY_TARGET_PAGES`, `MTC_RETRY_SOURCE_TASK_ID`, and `MTC_RETRY_SOURCE_RUN_ID`. Command templates may use `{{retry.scope}}`, `{{retry.attempt}}`, `{{retry.caseRunIds}}`, `{{retry.caseIds}}`, `{{retry.targetPages}}`, `{{retry.sourceTaskId}}`, and `{{retry.sourceRunId}}`.
- A project Runner must apply `MTC_RETRY_TARGET_PAGES` or `MTC_RETRY_CASE_IDS` to its page/case selector. MTC cannot infer project-specific navigation from a generic command.
- Retry execution passes through storage capacity, device preparation, account profile, platform support, and target concurrency gates.
- A Runner or project adapter may ignore `metadata.retry`; this produces a complete execution of the original test while retaining the requested range for audit.
- Retry tasks have a bounded watchdog. Timeout aborts and cancels the Runner, persists a failed terminal task with the timeout diagnosis, and releases the source retry lock.
- A task terminal transition is at most once. The first transition owns persistence; concurrent stop, watchdog, and Runner-result paths await the same transition, and completion listeners run exactly once.
- Retry cancellation is best effort. `AbortSignal` and optional `Runner.cancel()` are both invoked, while terminal persistence never waits for the cancellation Promise. Synchronous and asynchronous cancellation failures become diagnostic logs after the terminal transition.
- Task-state writes are serialized. A failed write rejects its current caller while resetting the internal queue so a later terminal transition or diagnostic save can retry.
- The run monitor collapses retry tasks into their root source task. While any descendant retry has an active status, the root row and detail header expose `正在重试`, all retry actions remain disabled, and run-group mutations such as deletion or retention changes remain locked.
- After every retry descendant reaches a terminal status, `/api/snapshot` projects a failed or interrupted root task to `passed` only when the merged root `TaskResult` has at least one run and `failed === 0`. The projected response sets `status: "passed"`, `phase: "重试后通过"`, `exitCode: 0`, and clears the display error. `TaskManager` keeps the original root status, exit code, error, and logs for diagnostics, retention, and audit.
- Retry lineage, scheduling locks, result merging, retention locks, deletion, and state persistence traverse the complete internal task collection. The public run list may cap recent rows, but it must include the ancestors of every visible retry and must never become the source of truth for persistence or internal operations.
- `TaskManager.delete(rootTaskId)` traverses the retry lineage. It returns `TASK_ACTIVE` while any descendant is active; after every descendant reaches a terminal state, one delete removes the complete lineage and its project-owned artifacts.
- Terminal retries merge into the root result in creation order. Each retry replaces only matching runs whose new status is `passed`; failed, cancelled, interrupted, malformed, or missing retry results preserve the existing item and its evidence. Matching precedence is exact `caseRunId`, invocation identity (`caseId`, `targetPage`, `parameterProfileId`, and `routeParams`), unique `caseId + targetPage`, then a unique `caseId` or unique `targetPage`. Nested retries whose direct-source `caseRunId` is absent from the root use their stable `caseIds` and `targetPages` scope to find root candidates. Ambiguous or unmatched fallback keys preserve the source item. A batch retry may therefore update its passed items while retaining the previous content of failed items.
- Retry creation prepares command overrides before mutating source retention or inserting tasks, then persists the source-retention change and new tasks together. A plan-construction failure leaves the source task unchanged.

### 4. Validation & Error Matrix

| Condition | Result |
| --- | --- |
| Unknown task | `TASK_UNKNOWN`, HTTP 404 |
| Active source task | `TASK_NOT_RETRYABLE`, HTTP 409 |
| Non-terminal source task | `TASK_NOT_RETRYABLE`, HTTP 409 |
| Unknown case run | `RETRY_CASE_UNKNOWN`, HTTP 404 |
| Duplicate case run IDs | `RETRY_CASE_DUPLICATE`, HTTP 400 |
| Busy frozen target | `TARGET_BUSY`, HTTP 409 |
| Retention change while a descendant retry is active | `TASK_ACTIVE`, HTTP 409; preserve the current retention flag |
| Delete source while a descendant retry is active | `TASK_ACTIVE`, HTTP 409; preserve the complete retry lineage |
| Retry item status differs from `passed`, or retry analysis is unavailable | Preserve the current source item and append a warning |
| A retry lineage is terminal and the merged root has one or more passed runs with no failures | `/api/snapshot` projects the root task as passed while persisted task state remains unchanged |
| A retry lineage is active, unavailable, empty, or has a merged failure | `/api/snapshot` preserves the persisted root task status |
| Retry fallback matches more than one source item | Preserve every ambiguous source item and append no replacement |
| Nested retry direct-source IDs are absent from the root | Restrict candidates by the stable case/page scope, then apply ordinary identity matching |
| Public run history exceeds its display limit | Persist the complete task collection and cap only `/api/snapshot` output |
| Retry `Runner.cancel()` throws, rejects, or never settles | Preserve the stop/watchdog terminal status, release retry locks, and record any observable cancellation error |
| Watchdog, stop, and Runner completion overlap | The first registered terminal transition wins; persist and notify exactly once |
| A state write fails | Reject the current transition without poisoning later writes; allow a subsequent save attempt |

### 5. Good / Base / Bad Cases

- Good: a passed page module is re-tested, the source row shows `正在重试`, and only that result item is replaced after completion.
- Good: retry A passes and retry B fails; the final source result contains the new A item and the original B item.
- Good: the final retry replaces the last failed root case; the run monitor and detail header show `重试后通过`, while raw task logs retain the first failure.
- Good: two runs share a page and case ID while using different parameter profiles; reversed retry output still replaces the matching invocation.
- Base: a terminal retry restores deletion and retention controls on the source row.
- Base: cancellation never settles; the retry still reaches its stop or watchdog terminal status and releases the source lock.
- Bad: terminal persistence waits for `Runner.cancel()` or notifies completion listeners from two competing terminal paths.
- Bad: the source row enables deletion while an active retry still belongs to its lineage.

### 6. Tests Required

- Cover task persistence and Runner metadata round-trip, including more tasks than the public run-list limit.
- Cover sibling attempt allocation, nested retry status refresh, source-retention rollback on plan failure, and lineage behavior beyond the public run-list limit.
- Cover unknown and active tasks, passed and unknown cases, duplicate case IDs, terminal-state validation, and busy targets.
- Cover duplicate `caseId` values across pages and duplicate page/case pairs across parameter profiles; assert that target page and invocation identity select the intended source item independent of result order.
- Cover App device and mini-program target reconstruction from the source task.
- Cover API request encoding and result-page actions for all failed cases and one arbitrary case.
- Cover active descendant retries across direct and multi-attempt lineages. Assert the root ID is identified, `正在重试` is rendered, deletion is disabled, and controls recover at terminal status.
- Cover `/api/snapshot` with a terminal retry lineage whose merged result is all passed. Assert only the response projection changes to `passed`, `重试后通过`, exit code zero, and no display error; assert persisted source state remains failed.
- Cover `TaskManager.delete(rootTaskId)` returning `TASK_ACTIVE` during retry and removing the full lineage after completion.
- Cover sequential sibling and nested retries, partial batch success, failed retry preservation, stable source `caseRunId`, and unavailable retry analysis.
- Cover hanging, synchronously throwing, and asynchronously rejecting cancellation hooks. Assert stop/watchdog terminal status is timely and cancellation diagnostics persist when available.
- Cover synchronous persistence re-entry and watchdog/Runner-result races. Assert the first terminal status wins and the completion listener runs once.
- Force one state write to fail, then assert a later save succeeds and can be loaded.

### 7. Wrong vs Correct

#### Wrong

```ts
if (run.status !== "failed") throw new Error("only failed cases can retry");
```

#### Correct

```ts
if (!TERMINAL_TASK_STATUSES.includes(source.status)) throw new ConsoleError("TASK_NOT_RETRYABLE", "终态任务才支持重新测试", 409);
// caseRunId may refer to a passed or failed module; the latest run becomes the focused result.
```

#### Wrong

```ts
const runtime = task.device.connectorId;
```

#### Correct

```ts
const runtime = task.target?.runtime;
```

#### Wrong

```ts
tasks: options.tasks.listVisible(),
```

#### Correct

```ts
tasks: await projectRetryTaskStatuses(options.tasks.listVisible(), options.tasks, taskResults),
```

#### Wrong

```tsx
<button onClick={() => deleteTask(source.id)}>删除</button>
```

#### Correct

```tsx
const retrying = activeRetryRootTaskIds(snapshot.tasks).has(source.id);
<button disabled={retrying} title={retrying ? "正在重试，完成后可删除" : "删除此运行记录"}>删除</button>
```

#### Wrong

```ts
await stateStore.save(taskManager.listVisible());
```

#### Correct

```ts
await stateStore.save(taskManager.list());
snapshot.tasks = taskManager.listVisible();
```

#### Wrong

```ts
await runner.cancel(task.runId);
await finalize(task, "failed", null, timeoutMessage);
```

#### Correct

```ts
const finalization = finalize(task, "failed", null, timeoutMessage);
controller.abort();
cancelRunnerBestEffort(task, finalization);
await finalization;
```

## Scenario: Project Provider and Runner ownership

### 1. Scope / Trigger

- Trigger: an integrated repository registers Project Provider or Runner plugins and maps tests to those plugins.
- The project owns commands, environment checks, preparation, result conversion, and cleanup. MTC owns validation, orchestration, persistence, cancellation, and UI presentation.

### 2. Signatures

```ts
const PROJECT_PROVIDER_PLUGIN_API_VERSION =
  "mobile-test-console.project-provider-plugin.v1";
const PROJECT_PROVIDER_MANIFEST_SCHEMA_VERSION =
  "mobile-test-console.project-provider.v1";
const RUNNER_PLUGIN_API_VERSION =
  "mobile-test-console.runner-plugin.v1";

interface ProjectProviderManifest {
  schemaVersion: "mobile-test-console.project-provider.v1";
  providerId: string;
  scope: {
    targetKinds: Array<"app" | "mini-program">;
    runtimes?: string[];
    platforms?: TargetPlatform[];
  };
  capabilities: Array<{ id: string; version: number }>;
}

interface RunPlan {
  runId: string;
  projectId: string;
  testId: string;
  runnerId?: string;
  device: Device;
  target?: TestTarget;
  command?: RunnerCommand;
  requiredCapabilities?: string[];
}

interface ProjectProvider {
  prepareRun?(request: { plan: Readonly<RunPlan>; capabilities: readonly string[] }): {
    commands: RunnerCommand[];
  };
  cleanupRun?(request: {
    plan: Readonly<RunPlan>;
    result: Readonly<RunnerResult>;
  }): {
    commands: RunnerCommand[];
  };
}
```

### 3. Contracts

- Plugin module paths resolve relative to the project config file.
- A plugin exports the exact API version and returns uniquely identified providers or runners.
- Every test capability is declared in `testing.capabilities`, belongs to its `providerId`, and exists in the registered Provider manifest before HTTP listen.
- Provider scope accepts platform strings beyond device platforms and remains bounded by target kind and runtime.
- `prepareRun()` returns validated commands. The Provider command Runner executes them before the test command and forwards stdout, stderr, cancellation, and exit status.
- `collectResult()` is required when the Provider declares `result.analysis`. Providers without that capability omit result collection.
- `cleanupRun()` returns validated commands for resources registered during `prepareRun()`. After a prepared run reaches a pass, failure, or cancellation result, MTC executes cleanup with an independent signal so a user cancellation still releases project resources.
- Cleanup receives the final pre-cleanup `RunnerResult`. A cleanup command failure changes the task result to `failed` and appends `项目资源清理失败: ...`; the original result error remains attached.
- A shared QA coordinator participant ID derives from `plan.runId`. Provider cleanup releases that same ID and forwards the Runner exit code, allowing the coordinator to restore standard resources after the last successful participant leaves.
- Command templates support `projectRoot`, `configPath`, `task.id`, `task.runId`, `params.*`, and mini-program `target.key`, `target.label`, `target.kind`, `target.platform`, `target.runtime`, `target.appId`, and `target.concurrencyKey`.
- App commands retain the `device.*` template contract.
- Cleanup accepts only the current task run ID and removes project-owned resources for that run. It runs as part of terminal task deletion.
- A project may expose Unit, Smoke, page, and flow entries through separate test definitions while sharing one Provider and Runner.

### 4. Validation & Error Matrix

| Condition | Result |
| --- | --- |
| Plugin API version differs | Config/runtime initialization fails |
| Provider or Runner ID is invalid or duplicated | Config/runtime initialization fails |
| Provider manifest scope is empty | Provider validation fails |
| Capability ID is malformed or duplicated | Provider validation fails |
| Test references an undeclared capability | Config validation fails |
| Provider lacks a required capability | Runtime initialization fails |
| Provider declares `result.analysis` without `collectResult()` | Provider validation fails |
| Provider implements `collectResult()` without `result.analysis` | Provider validation fails |
| Preparation command is malformed | Runner fails before test execution |
| `cleanupRun()` output is malformed | Runner marks the result failed and records the cleanup error |
| Cleanup command exits nonzero | Runner marks the final task failed while preserving the preceding result error |
| User cancellation arrives before cleanup | Cleanup still runs with a fresh, unaborted signal |
| Cleanup receives an unsafe run ID | Project cleanup exits before touching files |

### 5. Good / Base / Bad Cases

- Good: a mini-program project wraps its existing Vitest and E2E commands and emits one Result Bundle shape.
- Good: a project health check reports missing tools with actionable guidance.
- Good: a QA Provider registers `mobile-test-console-${plan.runId}` and releases that exact participant during `cleanupRun()`.
- Base: a legacy App uses `legacy-command-runner` and platform command definitions.
- Bad: MTC core imports a project's page IDs, environment file, or fixture implementation.
- Bad: a project changes its ordinary test command to satisfy MTC and breaks direct local usage.

### 6. Tests Required

- Load plugins through production config/runtime boundaries and assert API versions, IDs, scopes, and capabilities.
- Assert Provider preparation order, command cwd/env/template values, cancellation, result collection, and cleanup execution after successful, failed, and cancelled commands.
- Assert cleanup uses an unaborted signal after cancellation and cleanup failure changes the final result to `failed`.
- Assert malformed plugins, duplicate IDs, missing capabilities, and result-analysis contract mismatches fail before execution.
- Run project adapter tests for runtime diagnostics, Result Bundle conversion, run-ID cleanup, and credential/path sanitization.
- Keep ordinary project test commands runnable outside MTC.

### 7. Wrong vs Correct

#### Wrong

```ts
if (plan.projectId === "example") return runExampleSuite(plan);
```

#### Wrong

```ts
prepareRun: request => ({
  commands: [{ args: ["prepare", "--id", process.pid] }],
}),
```

#### Correct

```js
cleanupRun: request => ({
  commands: [{
    args: ["cleanup", "--id", `mobile-test-console-${request.plan.runId}`],
  }],
})
```

## Scenario: Path-derived project identity and live Runner screenshots

### 1. Scope / Trigger

- Trigger: MTC loads a project config, restores a project catalog, starts a task, or receives a Runner screenshot event.
- MTC owns project-instance identity. Provider and Runner IDs remain stable plugin registration keys shared by every checkout of the same integration.

### 2. Signatures

```ts
resolveProjectIdentity(root: string): Promise<{ id: string; root: string }>

interface RunnerArtifactEventData {
  schemaVersion: "mobile-test-console.runner-artifact.v1";
  uri: `project://${string}/${string}`;
  role: "screenshot";
  label: string;
  mimeType: "image/jpeg" | "image/png" | "image/webp";
}

GET /api/tasks/:taskId/artifacts/:artifactId
```

### 3. Contracts

- `loadProjectConfig()` resolves `project.root` through `realpath` and generates `<directory-slug>-<sha1-prefix>` from that canonical absolute path.
- `project.id` in `mobile-test.config.cjs` is an optional compatibility input. Runtime config, default state directory, catalog entries, tasks, Runner plans, and new Result Bundles use the generated identity.
- Catalog startup migrates legacy keys and `activeProjectId` by stored project root while preserving project metadata. Historical tasks retain their persisted `projectId` and `workspaceRoot`.
- A Runner screenshot event carries the current `runId` and MTC-injected project ID. Its URI is project-relative and contains no host absolute path.
- MTC accepts JPEG, PNG, and WebP live screenshots up to 20 MiB. The URI extension, declared MIME type, on-disk file type, and binary signature must agree when the event is accepted and when the attachment is read.
- Task state deduplicates live screenshots by URI, preserves at most 100 entries, and persists accepted entries. Active and terminal screenshots share the task-scoped artifact endpoint.
- Active task details expose screenshot and log tabs. The screenshot tab renders `等待首张截图` until the first accepted event and shows a visible load error when an image cannot be read.
- Terminal task presentation uses the persisted Result Bundle as the authoritative screenshot source.

### 4. Validation & Error Matrix

| Condition | Result |
| --- | --- |
| Config omits or keeps a legacy `project.id` | Load succeeds and runtime identity comes from the canonical root |
| Two different roots have the same directory name or configured ID | Each root receives a distinct path fingerprint |
| A symlink and its real target are loaded | Both resolve to one project identity |
| Catalog migration maps two different canonical roots to one generated ID | Initialization fails with `PROJECT_ID_COLLISION` |
| Artifact event run ID or project URI differs from the task | Ignore the event and append a bounded diagnostic log |
| Artifact URI is absolute, traverses upward, or resolves through an escaping symlink | Reject artifact access with a task artifact error |
| Artifact file is missing | Return `TASK_ARTIFACT_MISSING`, HTTP 404 |
| Artifact extension and MIME disagree, the binary signature is forged, the path is not a file, or size is zero / over 20 MiB | Ignore the live event with a bounded diagnostic; attachment revalidation returns `TASK_ARTIFACT_INVALID`, HTTP 409 |
| More than 100 unique live screenshots arrive | Retain the newest 100 task entries |

### 5. Good / Base / Bad Cases

- Good: two worktrees reuse one config, Provider ID, and Runner ID while MTC assigns separate project IDs and task roots.
- Good: a page-matrix Runner publishes each stable JPEG after it is written; the active gallery grows without duplicate entries.
- Base: a Runner emits logs only; the active screenshot tab remains in its waiting state.
- Bad: a business config computes its own worktree ID or a Result Bundle falls back to a locally generated project ID.
- Bad: MTC scans a project-specific results directory to infer screenshot ownership.

### 6. Tests Required

- Assert missing, fixed, and stale configured IDs all produce the canonical path identity at the config boundary.
- Assert same-name roots differ, symlink roots converge, catalog keys migrate, and historical task artifact URIs still use `task.projectId`.
- Assert Runner artifact schema, run/project matching, URI traversal, deduplication, 100-item cap, persistence, missing files, escaping symlinks, extension/MIME mismatch, forged signatures, and zero/over-20-MiB files.
- Assert active screenshot waiting/gallery/error states and terminal Result Bundle handoff.
- Integrate a project config without `project.id`; assert MTC supplies the ID to Runner events and Result Bundle screenshot URIs.

### 7. Wrong vs Correct

#### Wrong

```js
project: { id: deriveId(__dirname), root: __dirname }
```

#### Correct

```js
project: { name: "Example", root: __dirname }
// plan.projectId is supplied by MTC and reused in artifact URIs.
```

## Scenario: Platform-neutral Result Bundle and artifacts

### 1. Scope / Trigger

- Trigger: a Runner or Project Provider emits `result-bundle://runs/<runId>` and the browser requests result analysis or image artifacts.
- This boundary covers ingestion validation, compatibility projection, screenshot hydration, path security, caching, and refresh.

### 2. Signatures

```ts
interface RunnerResult {
  runId: string;
  status: "passed" | "failed" | "cancelled";
  exitCode: number | null;
  resultUri?: string;
}

GET /api/tasks/:taskId/result
GET /api/tasks/:taskId/result?refresh=1
GET /api/tasks/:taskId/artifacts/:artifactId
```

```json
{
  "schemaVersion": "test-analysis.run.v1",
  "project": { "id": "example", "name": "Example" },
  "target": {
    "kind": "mini-program",
    "runtime": "wechat-devtools",
    "platform": "wechat",
    "appId": "wx-example"
  },
  "run": { "runId": "example-run", "status": "passed" },
  "cases": [],
  "artifacts": [{
    "id": "screen",
    "uri": "project://example/.test/results/example-run/screenshots/home.png",
    "role": "screenshot",
    "mimeType": "image/png"
  }]
}
```

### 3. Contracts

- Bundle ingestion validates schema version, run ID, project ID, target, cases, artifact IDs, references, and URI syntax before persistence.
- `bundle.run.runId` equals the task run ID and `bundle.project.id` equals the task project ID.
- Project adapters convert absolute source paths to `project://<project-id>/<project-relative-path>` before returning a bundle.
- With legacy `taskResults` configured, screenshot hydration remains bounded by its resolved `artifactsRoot`.
- With Provider Result Bundle ingestion and no legacy `taskResults`, `project://` screenshots are resolved relative to `task.workspaceRoot` or `config.project.root` and bounded by that same real project root.
- URI segments reject empty values, dot segments, encoded traversal, path separators, queries, and fragments.
- Both the allowed root and candidate pass through `realpath`; a symlink escaping the root is rejected.
- Supported image extensions are PNG, JPEG, and WebP. Public responses expose generated artifact IDs and metadata, then serve bytes through the artifact API.
- `refresh=1` rebuilds the compatibility projection and artifact map from the persisted Result Bundle.
- Bundle warnings are preserved. Hydration adds bounded warnings for invalid or unavailable references.

### 4. Validation & Error Matrix

| Condition | Result |
| --- | --- |
| Task is active | `TASK_RESULT_ACTIVE`, HTTP 409 |
| Result URI is invalid or missing | `TASK_RESULT_INVALID`, HTTP 500 |
| Bundle run/project differs from task | `TASK_RESULT_INVALID`, HTTP 500 |
| Artifact URI uses another project ID | Ignore reference and add a warning |
| URI contains traversal or invalid encoding | Ignore reference and add a warning |
| Real candidate escapes the allowed root | Ignore reference and add a warning |
| Screenshot file is missing or unreadable | Ignore reference and add a warning |
| MIME extension is unsupported | Ignore reference and add a warning |
| Artifact ID is absent from the hydrated cache | `TASK_ARTIFACT_UNKNOWN`, HTTP 404 |

### 5. Good / Base / Bad Cases

- Good: a mini-program flow bundle maps project-relative screenshots without declaring legacy result settings.
- Good: a legacy App keeps screenshots constrained to its configured artifacts directory.
- Base: a valid bundle has no screenshots and still presents cases, assertions, logs, and API records.
- Bad: a bundle serializes a developer home path in artifact URIs or warnings.
- Bad: screenshot hydration treats an empty legacy artifacts root as the Provider bundle security root.

### 6. Tests Required

- Ingest and project a valid App and mini-program bundle through `TaskResultService`.
- Assert Provider bundles without `taskResults` load screenshots under the real project root.
- Assert legacy bundles honor `taskResults.artifactsRoot`.
- Reject project mismatch, run mismatch, traversal, outside paths, escaping symlinks, unsupported image types, and missing files.
- Assert refresh bypasses cache and artifact serving returns exact bytes and MIME type.
- Scan serialized project bundles for developer-specific absolute paths.

### 7. Wrong vs Correct

#### Wrong

```ts
const root = resolveTaskArtifactsRoot(config, task); // empty for Provider-only bundles
```

#### Correct

```ts
const root = config.taskResults
  ? resolveTaskArtifactsRoot(config, task)
  : task.workspaceRoot || config.project.root;
```

## Scenario: Suite Result Bundle presentation

### 1. Scope / Trigger

- 触发：Result Bundle 的 case metadata 含 `executionKind: "suite"`。
- 适用：Unit 测试套件列表、统计、测试点详情和失败诊断。

### 2. Signatures

```ts
isSuiteResultRun(run): boolean
suiteTestSummary(run): {
  total: number; passed: number; failed: number; skipped: number;
  durationMs: number; tests: SuiteTestPoint[];
}
```

### 3. Contracts

- Suite 列表展示 `caseId`、源文件、测试点总数、通过/失败/跳过数量和总耗时。
- Suite 分支隐藏页面跳转、设备、接口、截图和动作摘要；普通 Page/Scenario 分支保持现有字段。
- 测试点从 `run.assertions` 读取 `name`、`fullName`、`status`、`durationMs` 和 `errorSummary`。
- 工具栏在纯 Suite 运行中同时显示套件数和测试点数；空结果保持通用空态。
- Suite 失败保留复制错误、单套件重试和批量失败重试入口。

### 4. Validation & Error Matrix

| 条件 | 处理 |
| --- | --- |
| 所有结果为 Suite | 使用 Suite 专用统计和详情 |
| 结果为空 | 使用通用空结果展示，不推断为 Suite |
| Suite 含跳过测试点 | 单独统计并显示“跳过”状态 |
| 测试点状态缺失 | 显示“未知”，保留测试点名称 |
| 390px 视口 | 标题可换行，操作按钮和标签栏不产生横向溢出 |

### 5. Good / Base / Bad Cases

- Good：展开 Suite 后按行查看中文测试点名称、状态、耗时和失败摘要。
- Base：通过 Suite 显示完成统计，失败 Suite 显示复制错误入口。
- Bad：在 Suite 卡片显示 `? → ?`、`未记录设备` 或将测试点平铺成页面用例。

### 6. Tests Required

- `tests/web-results.test.ts` 覆盖 Suite SSR、统计、详情、失败诊断和空结果。
- `tests/web-layout.test.ts` 覆盖 390px 标签栏与操作区域布局。
- 执行 `pnpm lint`、`pnpm typecheck` 和完整 `pnpm test`。

### 7. Wrong vs Correct

#### Wrong

```tsx
<small>{run.executionKind} · {run.launchPage || "?"} → {run.actualFinalPage || "?"}</small>
```

#### Correct

```tsx
<small>单元测试套件 · {run.targetPage || "未记录源文件"}</small>
<span>{summary.total} 个测试点 · {summary.failed} 失败 · {formatDurationMs(summary.durationMs)}</span>
```

## Scenario: User-facing test entry metadata

### 1. Scope / Trigger

- Trigger: an integrated project adds operator-facing classification or usage guidance to `tests[]`.
- The project config owns its test names, types, descriptions, dependencies, and recommended execution cadence. MTC validates, projects, persists, and displays that metadata.

### 2. Signatures

```ts
interface TestDefinition {
  label: string;
  testType?: string;
  description: string;
  kind?: "general" | "page" | "flow";
}

interface PublicTestDefinition {
  label: string;
  testType: string;
  description: string;
  kind: "general" | "page" | "flow";
}
```

### 3. Contracts

- `testType` is optional config metadata with an empty-string default.
- `kind` remains the scheduling category. `testType` is the operator-facing classification.
- `toPublicTests()` normalizes every public test to a string `testType`.
- Project catalog onboarding persists the normalized field in `ProjectTestEntryCheck`; historical records receive the same empty-string default.
- The test selector formats typed entries as `<testType> · <label>`. The selected-entry summary and project catalog render the type only when it has content.
- Descriptions remain project-owned text and include coverage, key dependencies, and recommended cadence when those details guide test selection.

### 4. Validation & Error Matrix

| Condition | Result |
| --- | --- |
| `testType` is a string | Preserve and expose the configured value |
| `testType` is omitted | Normalize to `""` and preserve the existing label/description layout |
| `testType` has another JSON type | Reject the project config through `CONFIG_INVALID` |
| A persisted catalog entry predates `testType` | Load it with `testType: ""` |

### 5. Good / Base / Bad Cases

- Good: a mini-program test declares `testType: "Service compatibility"` and a description covering the backend dependency and merge cadence.
- Base: an existing App test omits `testType`; its selector label and description keep their prior presentation.
- Bad: a project repurposes `kind` as display copy and changes scheduling behavior while editing operator guidance.

### 6. Tests Required

- Parse a configured `testType` and assert it survives `toPublicTests()`.
- Parse a legacy config and assert the normalized public field is `""`.
- Load a historical catalog entry without `testType` and assert its normalized field is `""`.
- Render typed and legacy selector labels, selected-entry summaries, and catalog entry details.
- Run schema generation/check, type-check, lint, and the full platform test suite after changing this contract.

### 7. Wrong vs Correct

#### Wrong

```js
tests: [{ label: "Compatibility", kind: "Service compatibility" }]
```

#### Correct

```js
tests: [{
  label: "Compatibility",
  testType: "Service compatibility",
  kind: "page",
  description: "Uses an isolated database and a real backend; run before merge.",
}]
```

## Scenario: Project-family-aware initialization

### 1. Scope / Trigger

- Trigger: a user opens the project-registration page from the App or mini-program sidebar tab and selects a directory without an MTC configuration.
- The selected `ProjectFamily` determines the generated configuration and registration result.

### 2. Signatures

```ts
interface PreviewProjectInitializationRequest {
  projectDirectory: string;
  platforms: Platform[];
  family: "app" | "mini-program";
}

interface ApplyProjectInitializationRequest extends PreviewProjectInitializationRequest {
  planId: string;
}

POST /api/projects/setup/preview
POST /api/projects/setup/apply
```

### 3. Contracts

- The browser passes the active sidebar family into both preview and apply requests; the saved setup context preserves the same family.
- App initialization requires one or more device platforms and produces the existing `lynx-app` configuration, device providers, and device-based Smoke test.
- Mini-program initialization sends `platforms: []`, hides App platform controls, produces `integrationType: "mini-program"`, and declares a config-owned mini-program run target plus a target-keyed Smoke test.
- The generated mini-program target uses placeholder tool and App-ID values that the integrated project replaces before runtime verification.

### 4. Validation & Error Matrix

| Condition | Result |
| --- | --- |
| `family` is absent or unknown | HTTP 400 request validation error |
| App request has an empty `platforms` array | HTTP 400 request validation error |
| Mini-program request has one or more platforms | HTTP 400 request validation error |
| A preview plan is applied with a different family or changed files | `PROJECT_SETUP_PLAN_STALE` |
| Generated paths already exist | Preview remains non-applicable and reports the conflicting paths |

### 5. Good / Base / Bad Cases

- Good: the mini-program tab initializes a project with `deviceProviders: []`, a `mini-program-devtools` target, and a test that references its `targetKeys`.
- Base: the App tab initializes an Android project and retains the Lynx App configuration skeleton.
- Bad: UI state uses the mini-program tab while the apply request omits `family`; the server rejects the request before plan generation.

### 6. Tests Required

- Service test previews and applies each family, then loads the generated configuration and asserts the integration type and execution surface.
- HTTP API test supplies `family: "app"` for the existing App initialization route.
- Web component test renders mini-program registration with the App platform fieldset absent.
- Run lint, type-check, the full test suite, and production build after changing this request contract.

### 7. Wrong vs Correct

#### Wrong

```ts
onPreviewInitialization({ projectDirectory, platforms });
```

#### Correct

```ts
onPreviewInitialization({
  projectDirectory,
  platforms: family === "mini-program" ? [] : platforms,
  family,
});
```

## Scenario: Manual legacy test-command onboarding

### 1. Scope / Trigger

- Trigger: a mini-program project already owns its test command and a user opens `添加自定义命令` from the execution workspace.
- MTC owns the structured entry contract, validation, preview, persistence, runtime refresh, and retry metadata transport.
- The project owns command semantics, framework selection, test implementation, and Result Bundle generation.
- Command input comes from explicit user fields. Project files are not scanned to infer or rank command candidates.

### 2. Signatures

```ts
interface ProjectTestEntryEditorResponse {
  schemaVersion: "mobile-test-console.project-test-entry-editor.v1";
  project: ProjectCatalogEntry;
  targets: MiniProgramRunTarget[];
  mainConfigTests: PublicTestDefinition[];
  editableTests: PublicTestDefinition[];
  entriesPath: string;
}

interface PreviewProjectTestEntryRequest {
  mode: "create";
  entry: ProjectTestEntryInput;
  commandLine?: string;
}

parseTestCommandLine(commandLine): { executable: string; args: string[] }
createUniqueTestEntryId(commandLine, existingIds): string

interface ProjectTestEntryPlan {
  schemaVersion: "mobile-test-console.project-test-entry-plan.v1";
  planId: string;
  projectId: string;
  entriesPath: string;
  contentPreview: string;
  commandPreview: ResolvedCommand;
  aiGuidance: string;
  warnings: string[];
  canApply: boolean;
}

GET  /api/projects/:projectId/test-entry-editor
POST /api/projects/:projectId/test-entries/preview
POST /api/projects/:projectId/test-entries/apply
```

The optional sidecar next to `mobile-test.config.cjs` has this file signature:

```json
{
  "schemaVersion": "mobile-test-console.test-entries.v1",
  "tests": []
}
```

### 3. Contracts

- `mobile-test.entries.json` is the only file written by the visual editor. `mobile-test.config.cjs` remains byte-identical.
- `loadProjectConfig()` loads main-config tests first, appends sidecar tests in file order, and reports both source paths when IDs conflict.
- The quick form accepts a single `commandLine`; the shared tokenizer converts it to `executable` plus ordered `args` in both browser and server code. Persisted entries and task execution remain structured and never enable a shell.
- The tokenizer supports whitespace, single quotes, double quotes, empty quoted arguments, and Windows/UNC backslashes. It rejects pipes, redirects, command chaining, variable expansion, backticks, and unterminated quotes.
- The browser generates a stable lowercase test ID from the parsed command, prefixes digit-leading or non-Latin results with `test-` / `custom-test`, and adds a numeric suffix when either source already owns the candidate.
- A visual entry uses `runnerId: "legacy-command-runner"` and one structured command with `executable`, ordered `args`, optional project-relative `cwd`, and optional `env` string values.
- The quick form defaults to every configured mini-program target, `kind: "general"`, `testType: "自定义测试"`, project-root `cwd`, and empty environment/parameter collections. Advanced fields may override those defaults.
- Mini-program entries select at least one key from `testing.targets`; every template token and parameter default must satisfy the shared config schema.
- A page entry confirms that its project script consumes `MTC_RETRY_TARGET_PAGES`, `MTC_RETRY_CASE_IDS`, and `MTC_RETRY_CASE_RUN_IDS` before preview.
- Preview resolves a representative command with default parameter values and retry metadata. It performs no command execution and no file write. Every browser-visible plan field, including `commandPreview`, `contentPreview`, `aiGuidance`, and the plan returned by apply, replaces environment values with `<redacted>`; the internal write payload preserves the original values and is never serialized into an API response.
- `planId` covers project ID, main-config digest, sidecar digest, and normalized request. Apply rebuilds the plan inside the catalog operation queue and rejects stale or competing plans.
- Apply writes the sidecar and backup through same-directory exclusive temporary files followed by atomic rename. It preserves an existing sidecar mode, creates a new sidecar with mode `0600`, and replaces a pre-existing `.bak` path without following its symlink target.
- Both lexical paths and resolved symlink ancestors must remain under the project root. The exact parent value `..` is an escape, as are `../...`, absolute paths, and resolved symlink ancestors outside the root. Config loading and apply validate this boundary before reading sidecar content or computing its digest, including after a preview-to-apply symlink swap.
- A successful apply refreshes the catalog editor response and the active in-memory config so the test appears in the current snapshot and run workspace.
- AI guidance contains field rules, target keys, retry keys, template syntax, and the current draft. Environment values are replaced with `<redacted>`.
- The execution workspace is the only UI surface that opens this flow. The project overview remains focused on onboarding status, runtime activation, and storage management.

### 4. Validation & Error Matrix

| Condition | Result |
| --- | --- |
| Project is unknown | `PROJECT_UNKNOWN`, HTTP 404 |
| Project family is outside mini-program | `PROJECT_TEST_ENTRY_UNSUPPORTED`, HTTP 409 |
| Runner differs from `legacy-command-runner` | `PROJECT_TEST_ENTRY_RUNNER_UNSUPPORTED`, HTTP 409 |
| `commandLine` is empty or contains unsupported shell syntax | `PROJECT_TEST_ENTRY_COMMAND_INVALID`, HTTP 409; preserve the browser draft |
| Test ID already exists in either source | `PROJECT_TEST_ENTRY_DUPLICATE`, HTTP 409 |
| Target key, parameter, command shape, or cross-field rule is invalid | `CONFIG_INVALID`, HTTP 409 |
| Command template token is unknown | `TEMPLATE_TOKEN_UNKNOWN` |
| Default command is absent | `COMMAND_UNAVAILABLE`, HTTP 409 |
| `cwd`, sidecar path, or a resolved symlink ancestor escapes the project root | `PROJECT_TEST_ENTRY_PATH_OUTSIDE`, HTTP 409 |
| Plan ID is unknown or evicted | `PROJECT_TEST_ENTRY_PLAN_UNKNOWN`, HTTP 409 |
| Main config or sidecar changes after preview | `PROJECT_TEST_ENTRY_PLAN_STALE`, HTTP 409; preserve the current files |
| Sidecar JSON/schema is invalid or IDs conflict across sources | `CONFIG_INVALID` with the sidecar and conflicting source paths |

### 5. Good / Base / Bad Cases

- Good: a user enters `pnpm test:e2e:pickup-code-sort`; MTC generates a unique ID, selects all targets, materializes `{ executable: "pnpm", args: ["test:e2e:pickup-code-sort"] }`, previews, and writes one sidecar entry.
- Base: a legacy project keeps every test in `mobile-test.config.cjs`; the absent sidecar loads as an empty collection and execution remains unchanged. Existing structured preview callers may omit `commandLine`.
- Bad: a command contains `&&`, `|`, redirection, `$VAR`, or backticks; validation stops before plan creation. Package scripts remain explicit user input and are never scanned or guessed.

### 6. Tests Required

- Config tests cover missing sidecar, valid merge order, source partitions, invalid JSON/schema, internal duplicate IDs, and cross-source duplicate diagnostics.
- Command-line tests cover ordinary arguments, single/double quotes, empty arguments, Windows and UNC paths, every rejected shell operator, valid generated IDs, digit-leading commands, non-Latin fallback, and collision suffixes.
- Catalog tests cover command-line materialization, preview immutability, apply, symlink-safe backup replacement, preview-to-apply symlink swaps, new and preserved file modes, main-config byte identity, concurrent plans, stale plans, unknown targets/templates, runner enforcement, exact-parent traversal, sibling traversal, and symlink boundaries.
- HTTP tests cover all three endpoints, assert the active runtime config and returned editor snapshot contain the applied entry, and prove preview/apply response bodies contain no environment values while the persisted sidecar retains them.
- Web tests cover the single-page quick fields, automatic defaults, advanced fields, page-retry confirmation, save error retention, AI redaction, apply refresh, execution-workspace ownership, and the absence of a project-overview action.
- Browser verification uses a `390x844` viewport and asserts equal document `scrollWidth` and `clientWidth`.

### 7. Wrong vs Correct

#### Wrong

```ts
const command = `pnpm test && pnpm report`;
await spawn(command, { shell: true });
```

#### Correct

```ts
const preview = await catalog.previewTestEntry(projectId, {
  mode: "create",
  commandLine: "pnpm test:e2e:pickup-code-sort",
  entry: quickFormDefaults,
});
await catalog.applyTestEntry(projectId, { planId: preview.planId });
```

## Scenario: Runtime test-entry source and command preview

### 1. Scope / Trigger

- Trigger: a user selects a mini-program test entry, target, or parameter in the execution workspace.
- MTC exposes preset and project-sidecar entries through one selector and resolves the same structured command contract used by task creation.
- Preview is read-only. It creates no task, starts no Runner, executes no command, and writes no project file.

### 2. Signatures

```ts
type TestEntrySource = "preset" | "custom";

interface PublicTestDefinition {
  source: TestEntrySource;
}

interface PreviewTestCommandsRequest {
  testId: string;
  targetKeys: string[];
  parameters: Record<string, string>;
}

interface TestCommandPreview {
  targetKey: string;
  targetLabel: string;
  executable: string;
  args: string[];
  cwd: string;
  env: Record<string, "<redacted>">;
}

interface PreviewTestCommandsResponse {
  schemaVersion: "mobile-test-console.test-command-preview.v1";
  testId: string;
  commands: TestCommandPreview[];
}

POST /api/test-commands/preview
```

### 3. Contracts

- `toPublicTestsFromConfig()` projects main-config entries as `preset` and `mobile-test.entries.json` entries as `custom`, preserving main-config-first order. A historical in-memory config without source partitions projects every current test as `preset`.
- Preview accepts one active-project test ID, unique declared target keys, and declared string parameters. It applies defaults through `validateParameters()`.
- A `page-selection` preset is expanded through `expandPageSelectionParameters()` before command resolution, matching the task-start path. The resolved preview and created task therefore receive the same frozen page ID list.
- Each target is resolved through `resolveTargetCommand()`. Runtime-generated `task.id` and `task.runId` use `<runtime:task.id>` and `<runtime:task.runId>` placeholders.
- Every environment key is returned while every value is exactly `<redacted>`. The API never returns configured secret values.
- A custom Runner entry may omit `commands`. Its successful preview contains `commands: []`; the execution workspace identifies Runner ownership and keeps task start available. A legacy command Runner still requires a structured command.
- Saving an entry for the active project reloads the in-memory test partitions. The next snapshot contains the custom entry immediately, allowing the execution workspace to select it and issue a preview request.

### 4. Validation & Error Matrix

| Condition | Result |
| --- | --- |
| Request body is malformed, target keys repeat, or target list is empty | `REQUEST_INVALID`, HTTP 400 |
| Active project is outside mini-program | `TEST_COMMAND_PREVIEW_UNSUPPORTED`, HTTP 409 |
| Test ID is unknown | `TEST_UNKNOWN`, HTTP 404 |
| Target key is unknown | `TARGET_UNKNOWN`, HTTP 404 |
| Target exists but the test does not declare it | `TEST_TARGET_UNSUPPORTED`, HTTP 409 |
| Parameter is unknown or invalid | Existing `PARAMETER_UNKNOWN` / `PARAMETER_INVALID` error |
| Page preset resolves to no pages or explicit pages are unavailable | `PAGE_SELECTION_EMPTY` / `PAGE_SELECTION_UNKNOWN` |
| Legacy command Runner has no resolved command | `COMMAND_UNAVAILABLE`, HTTP 409 |
| Custom Runner owns the plan and declares no command | HTTP 200 with `commands: []` |

### 5. Good / Base / Bad Cases

- Good: two selected targets resolve two commands with ordered arguments, final `cwd`, runtime placeholders, and redacted environment values.
- Good: a page preset expands to concrete page IDs in both preview and task creation.
- Base: a custom Runner owns command generation; preview returns an empty command list and task start remains available.
- Bad: the browser reads command templates directly, displays environment secrets, or executes a command during preview.

### 6. Tests Required

- Config tests assert preset/custom projection order and historical fallback.
- API tests assert multi-target resolution, defaults, page-preset expansion, runtime placeholders, duplicate/unknown/unsupported targets, unknown parameters, and complete environment redaction.
- Runner compatibility tests assert a custom Runner with no command previews successfully and starts through its existing `RunPlan` path.
- Web tests assert source labels, single-command content, multi-command detail, Runner-owned state, stale-response rejection, start gating, and post-apply selection.
- Browser tests cover desktop and `390x844`; assert long command wrapping, modal bounds, and equal document `scrollWidth` / `clientWidth`.

### 7. Wrong vs Correct

#### Wrong

```ts
const command = interpolateInBrowser(test.commands.default, parameters);
return { ...command, env: test.commands.default.env };
```

#### Correct

```ts
const parameters = validateParameters(test, request.parameters);
await expandPageSelectionParameters(test, parameters, pageParameters, []);
const command = resolveTargetCommand(config, test, target, previewTask, parameters);
return redactCommandEnvironment(command);
```

## Design Decisions

### Explicit page selection validation

- An omitted page-selection parameter uses its configured default. An explicitly empty string represents an empty selection and fails validation.
- Explicit page IDs are frozen into the task request and validated against the current page-parameter catalog after target-platform filtering.
- Page IDs are opaque catalog identifiers and may contain route separators such as `pages/demo/index`; validation rejects separators used by the serialized list and control characters, then catalog membership provides the authoritative allowlist.
- Unknown or platform-incompatible explicit page IDs return `PAGE_SELECTION_UNKNOWN`. A preset with no matching pages returns `PAGE_SELECTION_EMPTY`.

### Single-case retry execution scope

- A single-case retry creates a new task/run/attempt while keeping the source task available for retention and audit.
- `RunPlan.metadata.retry` is the shared retry contract. Runner and Project Provider preparation commands and the final test command all receive the corresponding `MTC_RETRY_*` environment variables.
- Integrated test scripts consume `MTC_RETRY_TARGET_PAGES`, `MTC_RETRY_CASE_IDS`, and `MTC_RETRY_CASE_RUN_IDS` to limit execution and Result Bundle creation to the selected cases/pages.
- Each selected result item also persists `caseRuns` with `caseRunId`, `caseId`, `targetPage`, `launchPage`, route parameters, and parameter profile. Retry scripts use this record to launch the original page with the original invocation data and emit a result for that item.
- The final test command must receive the retry environment after Provider preparation; forwarding it only to preparation commands causes a retry to execute the full page set.

### Project-owned domain semantics

MTC owns stable transport and orchestration contracts. Integrated repositories own runtime tools, business flows, fixtures, accounts, result conversion, and cleanup. This keeps the platform source free of product-specific IDs and makes each adapter independently testable.

### Device compatibility during target migration

`TestTask.device` remains required for the v1 state and UI compatibility window. `TestTask.target` is authoritative for all new scheduling behavior. Removing the compatibility device requires a versioned state/API migration.

### Native mini-program connectors

The first mini-program integration uses a Project Provider and Runner around the project's proven commands. A future native connector can implement attach, launch, reload, screenshot, log, and network capabilities under the existing target/connector contracts.

## Scenario: Historical screenshot comparison

### 1. Scope / Trigger

- Trigger: a user selects two terminal tasks from registered projects, including a main checkout and a worktree, and opens the screenshot comparison workspace.
- MTC owns pairing, comparison HTTP, and the viewer. Each project Runtime still owns Result Bundle storage and screenshot files.

### 2. Signatures

```ts
POST /api/screenshot-comparisons
GET /api/projects/:projectId/screenshot-comparison/candidates

function screenshotComparisonKey(caseId: string, label: string): string;
```

Matching uses `caseId + screenshot.label`. Unmatched items retry once by `label` so page-matrix filenames such as `newCustomer-pages_index.jpg` still pair when case IDs drift.

### 3. Contracts

- Comparison handlers call `ProjectRuntimeRegistry.resolve(projectId)` for each side and do not reuse the request-scoped single Runtime.
- Artifact URLs include that side's `projectId` query parameter.
- Original images stay in the owning project. The comparison payload stores only `{projectId, taskId}` refs and pairing indexes.
- Presence values are `both`, `left-only`, and `right-only`. A missing source task or unreadable result fills `side.error` and still returns HTTP 200.
- Mini-program navigation includes the screenshot comparison workspace without an `adapter.workspaces` declaration.

### 4. Tests Required

- Pair page-matrix labels across different case IDs and mark a missing role as `left-only`.
- POST a cross-project comparison and assert each image URL carries its own `projectId`.
- Render missing-page copy and the slider when both images exist.

## Quality Gate

Run the full platform gate after any shared-contract change:

```bash
pnpm check
git diff --check
rg -n -i "<project-brand-or-business-id>" src README.md docs tests examples
```

Run each integrated project's adapter unit tests, type-check, runtime health check, and at least one real task through MTC. Browser verification covers desktop and narrow viewports, project-family switching, target selection, terminal status, logs, Result Bundle statistics, screenshot serving, and console warnings/errors.
