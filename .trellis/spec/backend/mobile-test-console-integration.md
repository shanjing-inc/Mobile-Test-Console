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

### 3. Contracts

- `artifactRetention.artifactsRoot` resolves relative to `project.root` and works independently from legacy `taskResults`.
- MTC protects active tasks, retained tasks, active repair jobs, recent runs, recent successful runs per platform, and recent failed runs per platform.
- `plan` and `apply` receive candidate and protected run IDs. Project adapters reject unsafe run IDs and operate only under the configured artifact root.
- Manual inventory uses adapter-owned run-to-directory semantics. MTC may select returned run IDs and re-plan the exact selection before apply.
- Manual selection protects active tasks, retained tasks, and active repair jobs. Policy recency and count protections guide automatic cleanup and remain user-overridable through explicit selection.
- Adapter result items must reference unique run IDs from the current candidate set. Unknown or duplicate run IDs invalidate the response.
- MTC removes task indexes only when the top-level result reports `ok: true`, and only for items that return `deleted` or `missing`.
- Failed and partial adapter results remain visible and auditable.
- Test start checks artifact-root writability and the configured free-space safety threshold.
- Repair worktree cleanup applies only to expired terminal jobs, archives the repair patch before removing the worktree, and still runs when no project artifact candidate exists.
- Existing artifacts are never deleted during first-time migration. A read-only plan is generated before user-confirmed apply.

### 4. Tests Required

- Cover active, retained, recent-success, recent-failure, and active-repair protection.
- Cover dry-run immutability, apply/index ordering, adapter failures, path traversal, symlink boundaries, idempotent missing runs, and overlapping run-ID prefixes.
- Cover storage low-water blocking and repair patch archival.
- Load the Starter cleanup adapter through the public config schema and execute both plan and apply.

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
- Active App tasks lock by device key. Active mini-program tasks lock by `target.concurrencyKey`.
- Cancellation aborts the Runner signal, calls optional Runner cancellation, persists the request, and finalizes the task as `cancelled`.
- State loading adds `appRunTargetOf(task.device)` to legacy tasks without a target. Tasks persisted as active become `interrupted` after service restart.
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
| Service restarts with an active persisted task | Recover it as `interrupted` with a finished timestamp |

### 5. Good / Base / Bad Cases

- Good: two independent mini-program targets use different concurrency keys and execute concurrently.
- Good: a legacy App task gains an App target during state loading and continues to render normally.
- Base: stopping an already terminal task returns the terminal snapshot.
- Bad: account-profile selection runs against the mini-program virtual device.
- Bad: a task reads the latest config target after execution begins and changes identity mid-run.

### 6. Tests Required

- Start App and mini-program tasks through HTTP and assert the frozen target in state and Runner plans.
- Reject mixed, empty, unknown, unsupported, unavailable, and busy selections with exact codes.
- Assert mini-program cancellation, concurrency locking, persistence, and service-restart recovery.
- Assert old state without `target` migrates to an App target.
- Assert template resolution and UI labels prefer `target` over the compatibility device.

### 7. Wrong vs Correct

#### Wrong

```ts
const runtime = task.device.connectorId;
```

#### Correct

```ts
const runtime = task.target?.runtime;
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
```

### 3. Contracts

- Plugin module paths resolve relative to the project config file.
- A plugin exports the exact API version and returns uniquely identified providers or runners.
- Every test capability is declared in `testing.capabilities`, belongs to its `providerId`, and exists in the registered Provider manifest before HTTP listen.
- Provider scope accepts platform strings beyond device platforms and remains bounded by target kind and runtime.
- `prepareRun()` returns validated commands. The Provider command Runner executes them before the test command and forwards stdout, stderr, cancellation, and exit status.
- `collectResult()` is required when the Provider declares `result.analysis`. Providers without that capability omit result collection.
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
| Cleanup receives an unsafe run ID | Project cleanup exits before touching files |

### 5. Good / Base / Bad Cases

- Good: a mini-program project wraps its existing Vitest and E2E commands and emits one Result Bundle shape.
- Good: a project health check reports missing tools with actionable guidance.
- Base: a legacy App uses `legacy-command-runner` and platform command definitions.
- Bad: MTC core imports a project's page IDs, environment file, or fixture implementation.
- Bad: a project changes its ordinary test command to satisfy MTC and breaks direct local usage.

### 6. Tests Required

- Load plugins through production config/runtime boundaries and assert API versions, IDs, scopes, and capabilities.
- Assert Provider preparation order, command cwd/env/template values, cancellation, and result collection.
- Assert malformed plugins, duplicate IDs, missing capabilities, and result-analysis contract mismatches fail before execution.
- Run project adapter tests for runtime diagnostics, Result Bundle conversion, run-ID cleanup, and credential/path sanitization.
- Keep ordinary project test commands runnable outside MTC.

### 7. Wrong vs Correct

#### Wrong

```ts
if (plan.projectId === "example") return runExampleSuite(plan);
```

#### Correct

```js
runnerPlugins: [{ module: "./tests/mtc/runner-plugin.cjs" }]
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

## Design Decisions

### Project-owned domain semantics

MTC owns stable transport and orchestration contracts. Integrated repositories own runtime tools, business flows, fixtures, accounts, result conversion, and cleanup. This keeps the platform source free of product-specific IDs and makes each adapter independently testable.

### Device compatibility during target migration

`TestTask.device` remains required for the v1 state and UI compatibility window. `TestTask.target` is authoritative for all new scheduling behavior. Removing the compatibility device requires a versioned state/API migration.

### Native mini-program connectors

The first mini-program integration uses a Project Provider and Runner around the project's proven commands. A future native connector can implement attach, launch, reload, screenshot, log, and network capabilities under the existing target/connector contracts.

## Quality Gate

Run the full platform gate after any shared-contract change:

```bash
pnpm check
git diff --check
rg -n -i "<project-brand-or-business-id>" src README.md docs tests examples
```

Run each integrated project's adapter unit tests, type-check, runtime health check, and at least one real task through MTC. Browser verification covers desktop and narrow viewports, project-family switching, target selection, terminal status, logs, Result Bundle statistics, screenshot serving, and console warnings/errors.
