# Mobile Test Console Integration

## 1. Scope / Trigger

- Apply this contract when an App repository integrates with the sibling `mobile-test-console` project.
- The console owns device discovery, task scheduling, process lifecycle, persistence, HTTP APIs, and the browser UI.
- The App repository owns its test definitions and runner commands through `qa/mobile-test.config.cjs`.
- This copy in the Mobile Test Console repository is authoritative for platform-core, Runner SDK, compatibility-facade, and public integration contracts.
- Fanli owns its adapter implementation and project-specific QA contracts. A shared contract change is synchronized to Fanli together with the corresponding adapter or compatibility change.

## Scenario: Codex failure repair loop (disabled)

> Status: disabled in the current Mobile Test Console integration. Fanli omits `codexRepair`; failed results are handled through the console's diagnostic context copy action and external manual workflows. The existing RepairJob and replay contracts remain documented for compatibility and future evaluation.

### 1. Scope / Trigger

- Trigger: a terminal failed page case is selected in Mobile Test Console and the developer confirms the Codex repair action.
- The console owns RepairJob persistence, worktree isolation, Codex process lifecycle, replay scheduling, and audit events. Fanli owns the replay command and page/account evidence formats.

### 2. Signatures

POST /api/tasks/:taskId/repairs with body { caseRunId?: string, projectDirectory?: string }
POST /api/tasks/:taskId/repairs/preview with body { caseRunId?: string }
POST /api/repairs/select-project-directory
POST /api/repairs/:repairJobId/retry-test

Project configuration includes codexRepair.enabled, mode=confirm, maxAttempts (1..2), sandbox=workspace-write, approvalPolicy=never, an execution provider, and a replay command.

### 3. Contracts

- caseRunId selects one failed result run. Repeating taskId + caseRunId + dirtyFingerprint returns the same active RepairJob.
- The configured project root is the default repair directory. When it is missing or is not a Git worktree, the browser requests the native directory picker and retries repair creation with the selected Git project root.
- Each RepairJob stores ReplaySnapshot, baseline commit/fingerprint, worktree and patch paths, Codex events/logs, attempt count, and latest replay result.
- `verificationFailureKind` distinguishes `precondition` from `assertion`. A failed precondition blocks replay with its actionable detail, preserves the current Codex attempt, and exposes only same-parameter replay. A terminal assertion failure exposes both same-parameter replay and creation of a fresh RepairJob.
- The Codex child runs inside the task worktree with workspace-write and approval_policy=never; stdout and stderr JSONL buffers are independent and flushed on close.
- With `appServer=true`, the console creates a persistent Codex App Server thread with `cwd` set to the selected Fanli project root and `runtimeWorkspaceRoots` set to the repair worktree. The thread ID is stored on the RepairJob. Desktop task-list visibility requires an independent capability check and must not be inferred from the presence of `codexThreadId`.
- RepairJob is the source of truth for repair status, evidence, worktree, patch, replay, and audit records. Codex thread visibility is an optional presentation capability.
- The browser UI keeps the repair workflow focused on creating a repair job and requesting same-parameter replay. Consecutive identical status events are coalesced; raw Codex JSONL remains available in the persisted repair log.
- A failed, blocked, or cancelled repair with `verificationStatus=pending` exposes `重新修复` and creates a new RepairJob. `重新复测` is reserved for jobs whose code repair completed and whose verification status is `failed`.
- fixed starts replay with the same platform, device key, account selection, page and route/profile parameters. A replay failure enters the next attempt up to maxAttempts; a second failure remains terminal for manual handling.
- Fanli's current configuration leaves `codexRepair` absent, so the console does not initialize the repair manager or render Codex repair actions.
- Failed result diagnostics expose a copy action containing the sanitized error summary, failure log excerpt, page, route parameters, missing events, failed API calls, failed interactions, and screenshot references.

### 4. Validation & Error Matrix

| Condition | Result |
| --- | --- |
| Repair disabled | CODEX_REPAIR_DISABLED (409) |
| Task is not failed/interrupted | REPAIR_TASK_NOT_FAILED (409) |
| Requested case is absent or passed | REPAIR_CASE_UNKNOWN (404) |
| Missing replay command | blocked with a persisted manual-action error |
| Service restarts during Codex or device replay | blocked, preserving prior evidence and patch |
| Codex spawn/exit/schema failure | failed, preserving logs and diff |
| Replay result contains a failed precondition before any page run | blocked with `verificationFailureKind=precondition`; preserve the Codex attempt and surface the precondition detail |
| Page assertions still fail after maxAttempts | failed with `verificationFailureKind=assertion`; allow replay or a fresh RepairJob |

### 5. Good/Base/Bad Cases

- Good: each selected failed case gets its own worktree and idempotency key.
- Good: a worktree includes the baseline commit, tracked dirty patch, and untracked project files while the developer worktree remains unchanged.
- Base: the original device is temporarily unavailable and the job remains waiting_device until timeout.
- Base: account replay reports that an Android device is locked; the job becomes blocked and asks the developer to unlock the device before replaying.
- Bad: the UI creates a task-level repair job without sending the selected caseRunId.
- Bad: one shared buffer merges stdout and stderr chunks and loses a trailing JSONL event.
- Bad: an authentication, device-lock, or installation precondition failure consumes a Codex code-repair attempt.

### 6. Tests Required

- Assert case-specific idempotency, unknown-case validation, snapshot capability flag, two-attempt replay, cancellation, and restart recovery.
- Assert the Codex command contains sandbox workspace-write and approval_policy=never, and that stdout/stderr tails are persisted independently.
- Assert the Fanli replay-snapshot command forwards frozen page/profile/account inputs for iOS, Android, and HarmonyOS.
- Assert a failed replay precondition preserves the attempt count, records `verificationFailureKind=precondition`, exposes its concise error, and does not schedule another Codex turn.
- Assert a terminal assertion failure records `verificationFailureKind=assertion` and exposes both repair and replay actions.

### 7. Wrong vs Correct

Wrong: createRepairJob(taskId)
Correct: createRepairJob(taskId, failedRun.caseRunId)

Wrong: treat every failed replay process as a page assertion failure and consume the next Codex attempt.
Correct: inspect `TaskResult.preconditions` before page runs; block on failed preconditions and reserve Codex attempts for failed page assertions.

### Codex error context propagation

- The console's Codex prompt must include an explicit, bounded diagnostic context for the selected `caseRunId`. The context includes `errorSummary`, `failureLogExcerpt`, failed `missingEvents`, failed `passBasis` assertions, failed API calls, and failed task-level preconditions when present.
- Before creating a RepairJob, the browser requests `/api/tasks/:taskId/repairs/preview` and displays the server-generated prompt in an in-page confirmation dialog. Cancel closes the dialog without creating a worktree or Codex thread; confirm calls the existing repair creation API exactly once.
- The preview and the actual Codex turn reuse the same prompt builder. Both include the selected device and frozen replay parameters; the preview uses a placeholder for the worktree path that is allocated after confirmation.
- The same prompt text is sent through both `codex exec` and the App Server `turn/start` input. `.codex-repair/input.json` remains the complete evidence source for details beyond the bounded prompt.
- Context selection is case-specific: a repair for one failed page run must not include another run's `errorSummary` or logs.
- Error context generation must tolerate an absent case run and surface failed task-level preconditions as the repair reason.

Wrong: send only `请阅读 .codex-repair/input.json` and expect Codex to discover the selected run's error by scanning the full snapshot.
Correct: send a bounded diagnostic summary for the selected `caseRunId`, then point Codex to `.codex-repair/input.json` for complete evidence.

Wrong: reconstruct the Codex prompt independently in the browser before confirmation.
Correct: render the server-generated repair preview, then submit the selected `caseRunId` after developer confirmation.

## 2. Signatures

Development command:

```bash
pnpm dev
```

The development command starts the platform shell and exposes the project onboarding workspace. Use `--config <path>` for an explicit project runtime. The local catalog keeps project registration and selection metadata; the developer switches to a project from the browser before project lifecycle work begins.

## Scenario: Independent three-platform Lynx example

### 1. Scope / Trigger

- Trigger: the independent `com.shanjing.example` fixture gains or changes Android, iOS, or HarmonyOS execution support.
- The fixture proves that one external Lynx repository can own native hosts, preparation, test commands, and result conversion through the public MTC contracts.

### 2. Signatures

```js
deviceProviders: ["android", "ios", "harmony"]
projectProviderPlugins: [{ module: "./qa/lynx-project-provider.cjs" }]
runnerPlugins: [{ module: "./qa/lynx-runner.cjs" }]

tests: [{
  id: "lynx-smoke",
  runnerId: "shanjing-example-runner",
  platforms: ["android", "ios", "harmony"],
  commands: {
    android: { executable: "node", args: ["qa/android-suite.cjs", "..."] },
    ios: { executable: "node", args: ["qa/ios-suite.cjs", "..."] },
    harmony: { executable: "node", args: ["qa/harmony-suite.cjs", "..."] },
  },
}]
```

```text
node qa/prepare.cjs --capabilities <ids> --platform <android|ios|harmony> --device <id> --device-type <physical|simulator>
MTC_IOS_DEVELOPMENT_TEAM=<Apple team ID>
MTC_HARMONY_HAP_PATH=<signed HAP path>
HARMONY_HVIGORW=<hvigorw path>
HARMONY_OHPM=<ohpm path>
HDC_PATH=<hdc path>
```

### 3. Contracts

- `com.shanjing.example` owns one minimal native host per platform and keeps the shared application ID `com.shanjing.example`.
- Its Provider manifest scopes the same five capabilities to `targetKinds=[app]`, `runtimes=[lynx]`, and all three platforms.
- `prepareRun()` returns a project-root command and forwards platform, device ID, and device type. Platform build, signing, installation, launch, logs, and screenshots stay inside the example repository.
- Every platform emits `MTC_EVENT page_opened` and `MTC_EVENT page_ready`, then writes `qa/artifacts/<runId>/raw-result.json` and runtime evidence.
- The Result Bundle keeps `project.id=shanjing-example`, `target.kind=app`, `target.runtime=lynx`, and derives `target.platform` from the active plan.
- iOS simulator builds use CocoaPods with Lynx/PrimJS `4.0.0`. iOS physical builds read the development team from the environment.
- HarmonyOS source contains an unsigned, credential-free build profile. Device installation consumes a developer-signed HAP from local build output or `MTC_HARMONY_HAP_PATH`.
- Git, npm packaging, and ESLint exclude generated native dependencies, build products, runtime state, and QA artifacts while retaining manifests, lock files, native source, and empty resource-directory markers.
- MTC `src/` stays free of the example application ID, route, native project path, and suite command names.

### 4. Validation & Error Matrix

| Condition | Result |
| --- | --- |
| Unsupported platform reaches `qa/prepare.cjs` | Fail with the platform value before any build command |
| iOS physical build lacks `MTC_IOS_DEVELOPMENT_TEAM` | Fail with development-team setup guidance |
| HarmonyOS install resolves an unsigned HAP | Fail with DevEco signing and `MTC_HARMONY_HAP_PATH` guidance |
| Required local tool is absent | Fail with the executable and environment-key guidance |
| Native host emits no `page_ready` within 15 seconds | Write failed raw result and exit with code 7 |
| Result Bundle platform differs from the active plan | Runtime ingestion rejects the bundle through the shared validation contract |

### 5. Good / Base / Bad Cases

- Good: an iOS simulator build installs the example, records both runtime events, captures a screenshot, and produces an iOS Result Bundle.
- Good: Android, iOS, and HarmonyOS commands all originate from `mobile-test.config.cjs` and project-owned scripts.
- Base: HarmonyOS CLI is absent on one workstation; config, Provider, Runner, native source, and static contract tests remain verifiable while onboarding reports the missing tool.
- Bad: MTC core selects an example-specific suite through an application ID branch.
- Bad: a HarmonyOS sample commits a certificate path, profile, keystore, or password.

### 6. Tests Required

- Load the example config and assert all three device providers, test platforms, command entries, Provider scope, and Runner registration.
- Call `prepareRun()` for each platform and assert project-root command ownership plus device-type forwarding.
- Assert Android `applicationId`, iOS `PRODUCT_BUNDLE_IDENTIFIER`, and HarmonyOS `bundleName` share `com.shanjing.example`.
- Build Result Bundles for all three platforms and assert the same App/Lynx identity with the active platform value.
- Scan MTC `src/` for the example identity, route, and suite paths; every search result stays empty.
- Run lint with locally installed CocoaPods and ohpm dependencies present; generated third-party source stays outside the lint input set.
- Run the Starter integration tests together with the independent example tests to detect public-contract regressions.
- On an available workstation, build Android and iOS simulator hosts and execute the iOS simulator suite through `page_ready` and screenshot capture.

### 7. Wrong vs Correct

#### Wrong

```ts
if (project.id === "shanjing-example") return runIosExample(plan);
```

#### Correct

```js
commands: {
  ios: {
    executable: "node",
    args: ["qa/ios-suite.cjs", "--device", "{{device.id}}"],
  },
}
```

Production command:

```bash
pnpm start -- --config ../fanli/qa/mobile-test.config.cjs --open
```

CLI options:

```text
--config, -c <path>    Optional; overrides the active catalog project
--project-catalog <path>  Optional; defaults to ~/.mobile-test-console/projects.json
--host <host>          Default: 127.0.0.1
--port <port>          Default: 4310
--open                 Open the browser page after startup
```

Project-owned task cleanup:

```js
taskDeletion: {
  cleanup: {
    executable: "node",
    args: ["path/to/cleanup.cjs", "--run-id", "{{task.runId}}"],
  },
}
```

HTTP API:

```text
GET  /api/health
GET  /api/snapshot
GET  /api/projects
GET  /api/projects/:projectId/detail
GET  /api/tasks/:taskId/result
GET  /api/tasks/:taskId/artifacts/:artifactId
POST /api/projects
POST /api/projects/select-directory
POST /api/projects/select-config
POST /api/projects/setup/preview
POST /api/projects/setup/apply
DELETE /api/projects/:projectId
POST /api/projects/:projectId/onboarding/verify
POST /api/projects/:projectId/setup/preview
POST /api/projects/:projectId/setup/apply
POST /api/projects/:projectId/activate
POST /api/result-bundles
POST /api/tasks
POST /api/devices/start
POST /api/tasks/:taskId/stop
DELETE /api/tasks/:taskId
```

## Scenario: Project workbench test capability by catalog entry

### 1. Scope / Trigger

- Trigger: the developer selects a registered project in the left project workbench navigation.
- The platform loads the selected project's registered configuration for the right-side detail; source code and test definitions remain owned by the project repository.

### 2. Signatures

`GET /api/projects/:projectId/detail`

### 3. Contracts

- Response: `{ project, tests, executionReady }`.
- `project` is the complete registered catalog entry.
- `tests` is the `toPublicTests(config.tests)` projection containing only public test IDs, labels, descriptions, runners, platforms, and parameters.
- The configuration project ID and root must match the catalog entry.
- `executionReady` requires `project`, `template`, `devices`, and `capabilities` to be verified.
- The top project navigation always renders `项目概览`, `执行测试`, `页面列表`, `业务脚本`, and `账号画像` in that order.
- During onboarding, `项目概览` remains enabled and the other four entries remain visible and disabled with an explanatory `title`.
- After onboarding, `执行测试` is enabled for the active runtime project. The other three tools are enabled only when their IDs appear in `adapter.workspaces`.
- The project catalog is an application-level left sidebar with add, select, and removal actions. The right workbench renders the selected project's overview, onboarding checks, and repair actions.
- Every registered project exposes its removal action in the left project list, including the active runtime project.

### 4. Validation & Error Matrix

| Condition | Error code or behavior |
| --- | --- |
| projectId is not registered | `PROJECT_UNKNOWN`, HTTP 404 |
| Configuration cannot be loaded | `PROJECT_CONFIG_INVALID`, HTTP 409 |
| Configuration ID or root differs from the catalog entry | `PROJECT_CONFIG_INVALID`, HTTP 409 |
| No project is selected | Four project capabilities remain visible and disabled |
| Selected project is inactive | Capabilities remain disabled until runtime activation |
| `executionReady=false` | Capabilities remain disabled and the browser returns to `项目概览` |
| Workspace is absent from `adapter.workspaces` | The workspace remains visible and disabled with a config hint |

### 5. Good / Base / Bad Cases

- Good: the selected active project has `executionReady=true`, so `执行测试` is enabled and opens the test workbench.
- Base: a pre-run check is incomplete, so all five entries remain visible and only `项目概览` is interactive.
- Base: an inactive project can expose its test definitions while requiring a project switch before execution.
- Bad: the browser requires post-run Smoke or Result Bundle evidence before it allows the first test execution, or treats the active project's `snapshot.tests` as the test list for every registered project.

### 6. Tests Required

- API tests assert project metadata, public test definitions, and onboarding state.
- API tests assert clear errors for unknown projects, missing configuration, and metadata drift.
- Browser rendering tests assert the left project selector, four onboarding steps, fixed five-entry navigation, disabled reasons, and workspace declarations.

### 7. Wrong vs Correct

Wrong: reuse `/api/snapshot` `tests` for every selected project.

Correct: call `/api/projects/:projectId/detail` for the selected project, then have the server load that project configuration and project its test definitions.

Wrong: hide project workspaces while onboarding is incomplete.

Correct: render all five entries and disable unavailable capabilities with `workspaceDisabledReason`.

## Scenario: Host device tool environment and onboarding gate

### 1. Scope / Trigger

- Trigger: MTC discovers Android or HarmonyOS tools outside the shell `PATH`, or a project Runner starts a nested build, install, or device command.
- The platform owns host tool discovery and process-environment propagation. Projects declare target platforms through `deviceProviders` and consume the inherited environment.

### 2. Signatures

```ts
resolveDeviceExecutable(executable, options): string
buildDeviceToolEnv(options): NodeJS.ProcessEnv
applyDeviceToolEnv(targetEnv?, options?): NodeJS.ProcessEnv

interface ProjectToolCheck {
  id: string;
  label: string;
  executable: string;
  status: "ready" | "blocked";
  path: string;
  version: string;
  detail: string;
  guidance: string[];
}
```

- `src/server/cli.ts` and `src/server/lifecycle-cli.ts` call `applyDeviceToolEnv()` before loading project providers, runners, lifecycle commands, or task managers.
- Project onboarding verification invokes `adb version`, `xcode-select -p`, or `hdc version` according to the registered project's `deviceProviders` before device discovery.

### 3. Contracts

- Android resolution priority is `ANDROID_ADB_PATH`, `ANDROID_SDK_ROOT`, `ANDROID_HOME`, then the macOS default SDK location.
- HarmonyOS resolution priority is `HARMONY_HDC_PATH`, `HARMONY_SDK_HOME`, `DEVECO_SDK_HOME`, installed OpenHarmony SDK versions, then DevEco command-line locations.
- Resolved tool directories are prepended once to the MTC process `PATH`. Every project command inherits that process environment, including nested scripts that invoke `adb` or `hdc` by command name.
- Absolute host tool paths remain local machine settings. Project configuration declares supported platforms and runner commands without embedding developer-specific absolute paths.
- The project overview keeps test execution locked until required tools, connected devices, authorization, device preparations, and project capabilities are verified.
- The `devices` onboarding step returns one `ProjectToolCheck` for every platform declared by `deviceProviders`: Android checks `adb version`, iOS checks `xcode-select -p`, and HarmonyOS checks `hdc version`.
- A tool check exposes its executable name, resolved local path, detected version or selected Xcode developer directory, command result detail, and installation or environment-key guidance when blocked. Stored catalog entries may omit `tools`; catalog loading normalizes that legacy state to an empty list.
- The project overview renders these checks as individual entries inside the expandable `设备环境` step. Each entry shows availability, executable, version, path, detail, and blocked-tool guidance. Tool-title layout reserves flexible title width so long labels remain readable alongside the status.

### 4. Validation & Error Matrix

| Condition | Onboarding result |
| --- | --- |
| Android declares `deviceProviders: ["android"]` and `adb version` fails | `devices=blocked`; show Android Platform Tools and Android environment-key guidance |
| HarmonyOS is declared and `hdc version` fails | `devices=blocked`; show DevEco and HarmonyOS environment-key guidance |
| iOS is declared outside a selected macOS Xcode toolchain | `devices=blocked`; show Xcode Command Line Tools guidance |
| Tool succeeds and no ready device exists | `devices=waiting`; identify missing, offline, unauthorized, or unprepared devices |
| Tool and at least one ready device per declared platform succeed | `devices=verified`; include ready tool names in the summary |
| A legacy catalog record omits `devices.tools` | Preserve the record and expose an empty tool list until the next verification |

### 5. Good / Base / Bad Cases

- Good: MTC resolves `~/Library/Android/sdk/platform-tools/adb`, prepends its directory to `process.env.PATH`, and a Fanli Runner's nested script can invoke `adb` directly.
- Base: `adb` is installed in a custom directory and `ANDROID_ADB_PATH` points to it; verification and task execution use the same resolved environment.
- Bad: device discovery uses an absolute `adb` path while task Runners inherit the original shell `PATH`, allowing onboarding to pass and APK installation to fail with `spawn adb ENOENT`.
- Bad: the overview provides only a toolchain summary, leaving developers without the detected path, version, failed command context, or remediation steps.

### 6. Tests Required

- Unit-test default and explicit `adb`/`hdc` resolution priority and PATH de-duplication.
- Assert both CLI entry points apply the device-tool environment before Runner Runtime loading.
- Assert a project with missing `adb` receives a blocked devices step, actionable environment-key guidance, and `executionReady=false`.
- Assert device verification returns a tool entry for each declared platform and preserves executable, status, path, version, detail, and guidance fields.
- Assert browser rendering shows every ready tool's status, executable, version, and path; assert a blocked tool exposes its configuration guidance.
- Assert catalog loading accepts historical onboarding entries without `tools`.
- Execute the full project test suite with a supported Node version after changing environment propagation.

### 7. Wrong vs Correct

Wrong: resolve `adb` only inside `SystemCommandRunner.capture()`, then launch project Runners from the unchanged `process.env`.

Correct: apply the resolved device-tool directories to the MTC process environment before constructing any lifecycle, provider, or task Runner.

Wrong: collapse host-tool readiness into one opaque device-environment sentence.

Correct: return and render platform-specific tool checks with command identity, resolved path, version, failure detail, and direct configuration guidance.

## Scenario: iOS 真机开发服务探测

### 1. Scope / Trigger

- Trigger: `devicectl list devices` 发现已配对的 iOS 真机，MTC 需要判断设备是否具备安装、启动和自动化测试能力。
- Applies to App Connector 设备发现、共享 `Device` 状态和浏览器设备列表、运行记录。

### 2. Signatures

```bash
xcrun devicectl list devices --quiet --json-output <list-file>
xcrun devicectl device info details --device <identifier> --quiet --json-output <detail-file>
```

```ts
parseIosPhysicalDevices(output: string): Device[]
parseIosPhysicalDeviceDetails(output: string): Device
```

### 3. Contracts

- 列表结果提供 `identifier`、`pairingState`、`transportType`、`tunnelState`、设备名称和系统版本；`wired + paired` 表示真机已经物理连接，即使首次列表探测的 tunnel 仍为 `disconnected`。
- MTC 对每台物理连接的 iOS 真机继续执行 details 探测，并读取 `developerModeStatus`、`ddiServicesAvailable`、`osVersionNumber` 和最新 tunnel 状态。
- `connectionState=available` 表达设备已连接；`controlState=ready` 表达开发服务可执行测试。两个状态分别呈现物理连接和测试控制能力。
- `ddiServicesAvailable=false` 保持 `connectionState=available`，设置 `controlState=unavailable`，并引导用户升级至支持当前 iOS 版本的 Xcode、重新连接并解锁设备。
- 设备列表和运行记录都显示平台及设备类型，例如 `iOS · 真机`、`iOS · 模拟器`。

### 4. Validation & Error Matrix

| Condition | Device result |
| --- | --- |
| paired、wired、tunnel connected、Developer Mode enabled、DDI available | `available + ready` |
| paired、wired、首次 tunnel disconnected | `available + unavailable`，继续执行 details 探测 |
| Developer Mode disabled | `available + unavailable`，展示开发者模式开启路径 |
| `ddiServicesAvailable=false` | `available + unavailable`，展示当前 iOS 版本对应的 Xcode 升级引导 |
| 设备未配对 | `offline + unavailable`，展示连接和信任引导 |
| details 命令失败且错误包含 Developer Disk Image | `available + unavailable`，归一化为 Xcode/DDI 引导 |

### 5. Good / Base / Bad Cases

- Good: iPhone 已连接并配对，details 明确 DDI 可用，设备可以选择并执行测试。
- Base: 首次 list 返回 tunnel disconnected，details 随后返回 connected，MTC 使用 details 的最终控制状态。
- Bad: 仅依据首次 `tunnelState` 把 wired、paired 的真机标记为离线。
- Bad: 把 `ddiServicesAvailable=false` 的设备显示为可执行测试，任务启动后才在安装或启动阶段失败。

### 6. Tests Required

- Unit: `wired + paired + tunnel disconnected` 保持 `connectionState=available` 并等待开发服务详情。
- Unit: details 的 Developer Mode、DDI 和系统版本映射为明确的控制状态和修复引导。
- Integration: 设备发现执行 list 后继续执行 `device info details --device <id>`，并使用详情文件生成最终设备状态。
- UI: 不可控制的真机展示 `controlReason`，运行记录展示平台和真机/模拟器类型。

### 7. Wrong vs Correct

Wrong: `tunnelState !== "connected"` 时直接把已配对的 USB 真机标记为离线。

Correct: 先用 pairing 和 transport 判断物理连接，再通过 details 的 Developer Mode、DDI 和 tunnel 状态判断测试控制能力。

## 3. Contracts

- `schemaVersion` must equal `mobile-test-console.config.v1`.
- `project.id`, test IDs, and parameter IDs use `^[a-z][a-z0-9-]*$`.
- `project.root` and `stateDir` resolve relative to the configuration file directory.
- `deviceProviders` contains any subset of `android`, `ios`, and `harmony`.
- `iosSimulator` is optional and declares the Xcode `workspace` and `scheme`; `workspace` resolves relative to `project.root`.
- With `iosSimulator` configured, discovery retains every simulator returned by `simctl`, intersects each UDID with `xcodebuild -showdestinations`, and exposes `ready`, `startable`, or `unavailable` through the shared device contract.
- The iOS device list sorts control states as `ready`, `startable`, then `unavailable`. Devices within one state use natural name order; same-name simulators use descending numeric OS-version order and the device key as the stable fallback. Other platforms retain their existing name-and-key order.
- A shut-down simulator becomes startable only when its UDID appears in the current scheme destinations. A destination query failure keeps discovered devices visible and marks simulators unavailable with the query error.
- `POST /api/devices/start` accepts a device key from a fresh discovery snapshot, then revalidates that it is an iOS simulator in the `startable` state before running `simctl boot`, opening Simulator, and waiting for `simctl bootstatus -b`.
- Concurrent start requests for one device key return `DEVICE_START_IN_PROGRESS`; independent simulator keys may start concurrently.
- `lifecycle.startup` runs once before the HTTP server listens; `lifecycle.shutdown` runs once after active tasks and the HTTP server stop. Project lifecycle is reserved for project-wide service setup; test-specific QA bundle preparation is a Project Provider capability.
- A lifecycle command failure aborts startup or reports shutdown failure through a `LIFECYCLE_<PHASE>_FAILED` error.
- Every test declares at least one command under `default`, `android`, `ios`, or `harmony`.
- Browser requests may select only declared tests, devices, parameters, and parameter option values.
- A select parameter option may declare `description`. The browser displays the selected option's description below the control and updates it when the value changes.
- Fanli's Lynx suite options describe the covered page checks or business chains and include the current case count. Update these descriptions whenever suite membership changes.
- Task deletion accepts only terminal `passed`, `failed`, `cancelled`, and `interrupted` tasks, removes the complete task including its logs from memory, and persists the updated task list before returning.
- Active `queued`, `preparing`, and `running` tasks remain under the stop lifecycle and cannot be deleted.
- `taskDeletion.cleanup` is optional. When declared, it runs with the project root as `cwd` before the task is removed from memory or `state.json`.
- Task cleanup command templates may use `projectRoot`, `configPath`, `process.pid`, `device.*`, `task.*`, and the deleted task's declared `params.*` values.
- A cleanup command failure returns `TASK_DELETE_CLEANUP_FAILED`; the task remains in memory and persisted state so the user can retry after fixing the local cleanup problem.
- The Fanli cleanup command removes entries under `qa/history/artifacts/` whose name equals `task.runId` or starts with `${task.runId}-`. It validates the run ID and preserves every non-matching entry.
- After a successful delete response, the browser removes the task from its local snapshot immediately and filters that task ID from already-in-flight snapshot responses. Device rediscovery latency must not delay or reverse the visible deletion.
- The browser uses an in-page confirmation dialog that identifies the selected task and states that its local test files will be removed.
- The browser request helper sets `Content-Type: application/json` only when a request body exists. Bodyless `DELETE` and `POST` requests omit the header so Fastify dispatches them to their routes.
- Lifecycle command templates may use `projectRoot`, `configPath`, and `process.pid`.
- Development mode owns lifecycle commands in the stable `scripts/dev.mjs` parent. The watched API child receives `MTC_LIFECYCLE_MANAGED=1`, so source reloads restart HTTP handling without restoring and rebuilding Lynx bundles.
- Before running project startup, the development parent probes ports `4310` and `4311`. When `/api/health` confirms an existing console, the command reports its URL and exits successfully. Other port owners produce exit code 2. Both paths prevent duplicate lifecycle registration and Vite fallback.
- Device command templates may additionally use `device.*`, `task.*`, and declared `params.*` tokens.
- On macOS, device discovery resolves `adb` from `ANDROID_ADB_PATH`, `ANDROID_SDK_ROOT`, `ANDROID_HOME`, and `~/Library/Android/sdk/platform-tools/adb`; it resolves `hdc` from `HARMONY_HDC_PATH`, SDK environment roots, installed `~/Library/OpenHarmony/Sdk/<version>/toolchains/hdc`, and DevEco command-line locations. Explicit environment paths take precedence, and resolved tool directories are prepended to project command environments so adapter subprocesses inherit the same device tools.
- Development mode uses API port `4310` and Vite port `4311` by default.
- The Vite proxy key is `/api/`. This path boundary preserves the frontend source module `/api.ts` while forwarding HTTP API routes.
- The default host is the loopback address `127.0.0.1`.

Task start request:

```json
{
  "testId": "lynx-suite",
  "deviceKeys": ["android:device-id"],
  "parameters": { "suite": "smoke" }
}
```

## 4. Validation & Error Matrix

| Condition | Error code or behavior |
| --- | --- |
| Configuration module cannot be imported | `CONFIG_LOAD_FAILED` |
| Configuration schema, ID, command, or default value is invalid | `CONFIG_INVALID` |
| Startup lifecycle command exits unsuccessfully | `LIFECYCLE_STARTUP_FAILED`; HTTP server does not listen |
| Shutdown lifecycle command exits unsuccessfully | `LIFECYCLE_SHUTDOWN_FAILED` |
| Watched API source changes in development | Restart the API child; keep the parent lifecycle participant registered and skip project cleanup/prepare |
| Both development ports are occupied and `/api/health` returns `{ "ok": true }` | Report `http://127.0.0.1:4311/` and exit with code 0 before lifecycle startup |
| Development port is occupied by another process | Exit with code 2 before lifecycle startup and list occupied ports |
| Request contains an undeclared parameter | `PARAMETER_UNKNOWN` |
| Parameter value is outside declared options | `PARAMETER_INVALID` |
| Template contains an unknown token | `TEMPLATE_TOKEN_UNKNOWN` |
| Test ID is unknown | `TEST_UNKNOWN` with HTTP 404 |
| Deleted task ID is unknown | `TASK_UNKNOWN` with HTTP 404 |
| Deleted task is queued, preparing, or running | `TASK_ACTIVE` with HTTP 409; task and process remain active |
| Task cleanup command exits unsuccessfully or cannot start | `TASK_DELETE_CLEANUP_FAILED` with HTTP 500; memory and `state.json` retain the task |
| A bodyless request declares `Content-Type: application/json` | Fastify returns `FST_ERR_CTP_EMPTY_JSON_BODY` before the route runs; remove the JSON content type from that request |
| Fanli cleanup receives an unsafe run ID | Cleanup command fails before reading or removing artifact entries |
| Device list is empty | `DEVICE_REQUIRED` |
| Device is absent or unavailable | `DEVICE_UNKNOWN` or `DEVICE_UNAVAILABLE` |
| Simulator start key is unknown | `DEVICE_UNKNOWN` with HTTP 404 |
| Start target is not an iOS simulator or is not startable | `DEVICE_START_UNAVAILABLE` with HTTP 409 |
| The same simulator already has a start operation | `DEVICE_START_IN_PROGRESS` with HTTP 409 |
| Simulator boot, Simulator open, or boot-status wait fails | `DEVICE_START_FAILED` with HTTP 500 |
| Device already owns an active task | `DEVICE_BUSY` with HTTP 409 |
| Test has no command for the device platform | `COMMAND_UNAVAILABLE` |
| Port is outside `1..65535` | CLI exits with code 2 |
| API route is unknown in production | `NOT_FOUND` with HTTP 404 |

## 5. Good / Base / Bad Cases

- Good: the App repository declares runner commands in its own configuration, and the console receives the configuration path through `--config`.
- Good: a source-fingerprinted startup command prepares one shared build, and device commands consume that artifact.
- Good: `pnpm dev` prepares once, multiple `tsx watch` API reloads reuse the same lifecycle owner, and final process exit cleans up once.
- Good: a second `pnpm dev` detects the active instance before prepare and points the user to the existing page.
- Good: deleting a terminal task removes it from the next snapshot and persisted state while preserving other tasks.
- Good: the Fanli cleanup command removes `run-123` and `run-123-ios-case`, then leaves `run-1234-ios-case` in place.
- Good: the shared browser request helper adds the JSON content type to `POST /api/tasks` because that request has a serialized body.
- Base: a single-platform App declares one provider and one platform command.
- Base: a project without `taskDeletion.cleanup` deletes the console record and embedded logs from `state.json`.
- Base: the browser opens an in-page confirmation dialog before deleting one terminal task and closes its detail panel immediately after the API succeeds.
- Bad: console source code contains an App repository absolute path or a business-specific test ID.
- Bad: a delete action implicitly stops and removes an active task.
- Bad: the task is removed from state before the project cleanup command reports success.
- Bad: artifact cleanup uses a substring match that can remove unrelated run directories.
- Bad: the Vite proxy uses `/api` and captures the `/api.ts` frontend module, leaving the React root empty in development.
- Bad: every `tsx watch` API reload runs project shutdown and startup, leaving port `4310` unavailable during bundle restore/build.
- Bad: Vite silently selects `4312` while the API process fails on occupied port `4310`.
- Bad: a shared request helper adds the JSON content type to bodyless stop and delete requests, causing Fastify to reject them before route handling.

## 6. Tests Required

- Validate accepted and rejected project configuration objects.
- Verify select option descriptions survive configuration parsing, and options without a description receive an empty string.
- Assert startup and shutdown lifecycle commands each execute once and resolve `process.pid`.
- Assert independently created lifecycle helpers can prepare and clean up with the same stable owner PID used by the development parent.
- Assert the development port probe accepts free ports, recognizes a healthy existing console, and rejects unhealthy or unrelated port owners before lifecycle startup.
- Assert local Web imports resolve to real source files.
- Assert the Vite proxy contains `/api/` and excludes `/api`.
- Inject `GET /api/snapshot` and `POST /api/tasks` requests and verify response contracts.
- Parse all `simctl` devices, parse iOS Simulator destination UDIDs, and verify the `ready`, `startable`, and `unavailable` classification matrix.
- Verify iOS device ordering across control states, natural device names, same-name simulator OS versions, and the stable key fallback; verify other platforms keep their existing order.
- Verify a destination query failure preserves the simulator snapshot while preventing start actions.
- Inject `POST /api/devices/start` and verify request validation, discovery revalidation, the complete boot command sequence, and same-device concurrency rejection.
- Render the device row and verify startable, starting, and unavailable states; mock the browser request and assert the current device key is sent.
- Inject `DELETE /api/tasks/:taskId` for terminal, active, and unknown tasks; verify persistence, `TASK_ACTIVE`, and `TASK_UNKNOWN`.
- Resolve a configured deletion command and assert `task.runId`, `task.testId`, `device.*`, and `params.*` token values. Reject an unknown token.
- Run task deletion with successful and failing cleanup commands. Assert cleanup precedes state removal, and assert `TASK_DELETE_CLEANUP_FAILED` preserves the task in memory and `state.json`.
- Test the Fanli `delete-run` command with matching run-ID directories, a nearby non-matching directory, and an unsafe run ID.
- Verify one active task per device, parallel tasks across devices, cancellation, persistence, and interrupted-task recovery.
- Verify the terminal-task in-page confirmation dialog, immediate local removal, focused-detail closure, and deleted-ID filtering across stale polling responses.
- Mock `fetch` and assert bodyless stop/delete calls omit `Content-Type`, while task-start calls with a JSON body include `application/json`.
- Exercise deletion through the browser and assert the row count decreases, the matching artifact directory is removed, `state.json` loses the task, and a page refresh keeps it deleted.
- Run `pnpm check` in `mobile-test-console` to cover lint, Vitest, TypeScript, Vite, and server builds.
- Open `http://127.0.0.1:4311/` and verify the device list and test controls render.

## 7. Wrong vs Correct

### Wrong

```ts
server: {
  proxy: {
    "/api": "http://127.0.0.1:4310",
  },
}
```

### Correct

```ts
server: {
  proxy: {
    "/api/": "http://127.0.0.1:4310",
  },
}
```

### Wrong

```ts
await tasks.stop(taskId);
await tasks.delete(taskId);
```

### Correct

```ts
// 活动任务使用停止操作；终态任务提供独立删除操作。
if (ACTIVE_TASK_STATUSES.includes(task.status)) {
  await tasks.stop(task.id);
} else {
  await tasks.delete(task.id);
}
```

### Wrong

```ts
await fetch(input, {
  ...init,
  headers: { "Content-Type": "application/json", ...(init?.headers || {}) },
});
```

### Correct

```ts
const headers = new Headers(init?.headers);
if (init?.body != null && !headers.has("Content-Type")) {
  headers.set("Content-Type", "application/json");
}
await fetch(input, { ...init, headers });
```

### Wrong

```ts
this.tasks.delete(taskId);
await runCleanup(task);
await this.persistNow();
```

## Scenario: Device snapshot stale-while-revalidate

### 1. Scope / Trigger

- Trigger: the browser polls task and repair status every second while device discovery may run `xcodebuild`, `devicectl`, `adb`, `hdc`, and project preparation checks.
- The console keeps task status polling responsive while device state refreshes independently.

### 2. Signatures

```text
GET /api/snapshot
GET /api/snapshot?refresh=1
DeviceDiscoveryService.snapshot({ refresh?: boolean })
DeviceDiscoveryService.discover()
```

### 3. Contracts

- The default snapshot uses a 30-second in-memory device cache. A missing cache returns `devices=[]`, `deviceErrors={}`, and `deviceDiscoveryPending=true` immediately, then starts discovery in the background.
- An expired cache returns the previous devices immediately with `deviceDiscoveryPending=true`, then refreshes in the background.
- Concurrent background, explicit, and action-triggered discovery calls share one in-flight platform discovery promise.
- `refresh=1` waits for the current or next complete discovery and returns `deviceDiscoveryPending=false`.
- Task, repair-job, test-definition, and timestamp fields are generated for every snapshot request and never wait for a new device scan on the default polling path.
- Successful simulator start and device-preparation installation invalidate the cached device snapshot. The browser follows those actions with `refresh=1`.
- Device-sensitive actions continue to call fresh `discover()` before validation and execution.

### 4. Validation & Error Matrix

| Condition | Result |
| --- | --- |
| No cached device snapshot | Return runtime state immediately with an empty device list and start one background discovery |
| Cached snapshot is younger than 30 seconds | Return it without running device commands |
| Cached snapshot is expired | Return stale data and start one background refresh |
| Multiple refreshes overlap | Reuse one in-flight discovery |
| `refresh=1` is requested | Wait for discovery and return the resulting devices/errors |
| Background discovery fails unexpectedly | Preserve the previous cache; a later poll or manual refresh may retry |

### 5. Good/Base/Bad Cases

- Good: one-second task polling returns quickly while an iOS destination query runs in the background.
- Base: the first request after service startup shows device discovery in progress and later polls populate the device list.
- Bad: every `/api/snapshot` request invokes all configured device providers and preparation checks.

### 6. Tests Required

- Assert a cache miss returns immediately and starts background discovery.
- Assert concurrent snapshot and discovery calls execute one underlying provider command.
- Assert an expired cache remains visible while refresh runs and is replaced after completion.
- Assert `GET /api/snapshot?refresh=1` returns fresh devices with `deviceDiscoveryPending=false`.
- Assert the browser manual-refresh request includes `refresh=1`.
- Run `pnpm check` in Mobile Test Console.

### 7. Wrong vs Correct

Wrong:

```ts
app.get("/api/snapshot", async () => ({
  devices: (await devices.discover()).devices,
  tasks: tasks.list(),
}));
```

Correct:

```ts
const discovery = await devices.snapshot({ refresh: request.query.refresh === "1" });
return {
  devices: discovery.devices,
  deviceDiscoveryPending: discovery.refreshing,
  tasks: tasks.list(),
};
```

## Scenario: Task-scoped QA result analysis

### 1. Scope / Trigger

- Trigger: an App repository exposes local QA artifacts through the sibling console after a task reaches a terminal state.
- The App adapter owns business-specific artifact discovery and normalization. The console owns schema validation, task authorization, caching, attachment containment, and rendering.

### 2. Signatures

Project result provider:

```js
taskResults: {
  artifactsRoot: "qa/history/artifacts",
  provider: {
    executable: "node",
    args: [
      "path/to/adapter.cjs",
      "result",
      "--run-id", "{{task.runId}}",
      "--artifacts-root", "{{results.artifactsRoot}}",
    ],
  },
}
```

HTTP API:

```text
GET /api/tasks/:taskId/result
GET /api/tasks/:taskId/result?refresh=1
GET /api/tasks/:taskId/artifacts/:artifactId
```

Provider schema: `mobile-test-console.task-result.v1`.

### 3. Contracts

- `taskResults.artifactsRoot` resolves relative to the project root and defines the complete attachment trust boundary.
- `taskResults.provider` runs with the project root as `cwd` and may use `task.*`, `device.*`, declared `params.*`, and `results.artifactsRoot` template values.
- The provider emits UTF-8 JSON no larger than 16 MiB and completes within 30 seconds.
- The provider result `runId` must equal `task.runId`. Each result entry `runId` must equal it or start with `${task.runId}-`.
- Result reads are available for terminal tasks only. The default result read uses a task fingerprint cache; `refresh=1` executes the provider again and replaces that cache.
- `/api/snapshot` remains lightweight and excludes result bodies and image bytes.
- Screenshot responses use opaque task-scoped IDs. Browser responses never expose local absolute paths.
- The attachment resolver compares `realpath` values, requires containment below `artifactsRoot`, and accepts regular PNG, JPEG, or WebP files only.
- Request, response, and failure-log previews are sanitized by the App adapter before they cross the provider boundary. The console displays those previews and does not expose raw evidence downloads.

Minimal provider response:

```json
{
  "schemaVersion": "mobile-test-console.task-result.v1",
  "generatedAt": "2026-07-21T00:00:00.000Z",
  "runId": "task-run-id",
  "total": 1,
  "passed": 1,
  "failed": 0,
  "warnings": [],
  "runs": []
}
```

### 4. Validation & Error Matrix

| Condition | Error code or behavior |
| --- | --- |
| Project has no result provider | `TASK_RESULT_UNAVAILABLE` with HTTP 404 |
| Task ID is unknown | `TASK_UNKNOWN` with HTTP 404 |
| Task is queued, preparing, or running | `TASK_RESULT_ACTIVE` with HTTP 409 |
| Provider exits unsuccessfully or times out | `TASK_RESULT_PROVIDER_FAILED` with HTTP 500 |
| Provider emits invalid JSON, an invalid schema, or a mismatched root `runId` | `TASK_RESULT_INVALID` with HTTP 500 |
| A run belongs to another task | Ignore the run and append a warning |
| Screenshot is missing, outside the root, escapes through a symlink, or has an unsupported extension | Ignore the screenshot and append a warning |
| Attachment ID is absent from the current task result | `TASK_ARTIFACT_UNKNOWN` with HTTP 404 |
| Result files are updated after the first terminal read | `refresh=1` re-runs the provider and replaces the cached result |

### 5. Good / Base / Bad Cases

- Good: the Fanli adapter reuses `qa-lynx-test-report.cjs`, aggregates directories equal to or prefixed by the console run ID, and emits sanitized API previews plus screenshot references.
- Good: the result page shows overview, screenshot, API, evidence, and log tabs while fetching result content separately from snapshot polling.
- Good: the browser refresh action calls `GET .../result?refresh=1` after late artifacts finish writing.
- Base: a terminal run without summaries returns zero runs plus a warning, while the run record and logs remain usable.
- Bad: the generic console parses Fanli filenames or business-specific runtime event fields.
- Bad: the provider returns raw secrets or the browser receives host filesystem paths.
- Bad: path-prefix string checks authorize attachments without resolving symlinks.

### 6. Tests Required

- Validate accepted and rejected `taskResults` configuration and template tokens.
- Assert terminal result loading, active-task rejection, provider failure, invalid JSON, invalid schema, and mismatched `runId` behavior.
- Assert cached reads reuse the provider and `refresh=1` invokes it again.
- Assert relative, absolute, `../`, missing, unsupported-extension, and symlink-escape screenshot references stay inside the real artifact root.
- Inject result and attachment HTTP routes; assert image MIME type, inline disposition, `nosniff`, and unknown attachment handling.
- Assert snapshot responses contain no result body or image data.
- Test the App adapter with exact and prefixed run directories, missing summaries, screenshots, API previews, and sanitized failure evidence.
- Render overview, screenshot, API, evidence, loading, empty, and error states; verify JSON copy actions and encoded task/attachment URLs.
- Exercise a historical task in the in-app browser and verify decoded images, API request/response content, refresh, desktop layout, and mobile overflow.

### 7. Wrong vs Correct

#### Wrong

```ts
const candidate = path.resolve(request.params.filePath);
return reply.send(createReadStream(candidate));
```

#### Correct

```ts
const realRoot = await fs.realpath(config.taskResults.artifactsRoot);
const realCandidate = await fs.realpath(candidate);
const relativePath = path.relative(realRoot, realCandidate);
if (!relativePath || relativePath.startsWith(`..${path.sep}`) || path.isAbsolute(relativePath)) {
  throw new ConsoleError("TASK_ARTIFACT_UNKNOWN", "Attachment is unavailable", 404);
}
```

#### Wrong

```ts
await fetchTaskResult(taskId); // The refresh button still reuses the server cache.
```

#### Correct

```ts
await fetchTaskResult(taskId, true); // Sends ?refresh=1 and re-runs the provider.
```

### Correct

```ts
await runCleanup(task);
this.tasks.delete(taskId);
await this.persistNow();
```

## Scenario: Page parameter catalog, recording, and replay

### 1. Scope / Trigger

- Trigger: a Lynx QA page reads route parameters and automated execution needs a repeatable parameter set for the selected page, scenario, platform scope, and environment.
- The console owns the page-parameter workspace, recording lifecycle, profile validation, local persistence, and HTTP APIs.
- The App adapter owns catalog discovery, device observation, route-parameter transport, secret resolution, and runner integration.
- The selected MVP extends a parameter profile into a scenario profile with normalized navigation, semantic actions, and result assertions.

### 2. Signatures

Project provider configuration:

```js
pageParameters: {
  provider: {
    executable: "node",
    args: ["packages/lynx/scripts/qa/qa-page-parameters.cjs"],
  },
}
```

Provider commands:

```text
<provider> catalog
<provider> recording-start  --recording-id <id> --device <id> --platform <platform> --environment <environment>
<provider> recording-status --recording-id <id> --device <id> --platform <platform> --environment <environment>
<provider> recording-stop   --recording-id <id> --device <id> --platform <platform> --environment <environment>
<provider> replay           --page <pageId> --profile-id <profileId> --profiles <state-path> --device <id> --platform <platform> --device-type <type> --environment <environment> --run-id <id>
```

HTTP API:

```text
GET    /api/page-parameters
POST   /api/page-parameter-recordings
GET    /api/page-parameter-recordings/:recordingId
POST   /api/page-parameter-recordings/:recordingId/stop
POST   /api/page-parameters/:pageId/profiles/:profileId/replay
PUT    /api/page-parameters/:pageId/profiles/:profileId
POST   /api/page-parameters/:pageId/profiles/:profileId/default
DELETE /api/page-parameters/:pageId/profiles/:profileId/default
DELETE /api/page-parameters/:pageId/profiles/:profileId
```

Runner arguments and command template value:

```text
--environment <environment>
--page-parameter-profiles <absolute-state-path>
{{pageParameters.statePath}}
```

### 3. Contracts

- `pageParameters.provider` is optional and uses the App project root as `cwd`. The console appends one provider action after the configured arguments.
- Catalog and recording provider responses use `mobile-test-console.page-parameter-provider.v1`; the browser response uses `mobile-test-console.page-parameters.v1`; persisted state uses `mobile-test-console.page-parameter-state.v1`.
- The page-parameter provider accepts `catalog`, `recording-start`, `recording-status`, `recording-stop`, and `replay` actions. `replay` receives page, profile, platform, device, environment, run ID, and `pageParameters.statePath` arguments, then returns a pass/fail payload plus bounded output and an optional structured summary.
- The Fanli catalog contains exactly the user-facing pages selected by the generated `all-pages` suite, then enriches those entries from QA manifest route parameters, Lynx entry ownership, and static `getPageParam` / `getPageParams` reads.
- Every catalog entry exposes `dynamicParameters` as machine-readable state. Dynamic reads set it to `true` and may also produce human-readable warnings for manual confirmation; browser filtering and status badges never parse warning text.
- The Fanli catalog includes pages that declare at least one semantic `input` target even when their route-parameter set is empty. This keeps login and search inputs available in the recording editor.
- `POST /api/page-parameter-recordings` accepts `{ "deviceKey": string, "environment": string }`, revalidates the current device snapshot, and permits one active recording per device key.
- `POST /api/page-parameters/:pageId/profiles/:profileId/replay` accepts `{ "deviceKey": string }`, revalidates the device, accepts a profile for the exact device platform or `all`, and invokes the provider `replay` action for one page profile.
- A recording observation contains `observationId`, `pageId`, `bundle`, `previousPageId`, `values`, `capturedAt`, and optional `rawData`. `rawData` is the provider's already-redacted source event for troubleshooting and review. Harmony derives a stable observation ID from recording ID, event timestamp, and page ID.
- The browser schedules the next status poll after the current request completes. The service merges observations by `capturedAt + pageId + bundle + values`, then sorts them by capture time.
- `PUT /api/page-parameters/:pageId/profiles/:profileId` accepts `scenario`, optional `platform`, optional `isDefault`, `environment`, `accountLabel`, `values`, optional `capturedKeys`, optional `source`, optional `recordedAt`, and optional `expiresAt`. The platform defaults to `all`, which makes the saved profile reusable on Android, iOS, and Harmony; an explicit platform keeps a platform-specific profile. A required key present in `capturedKeys` with a `literal` empty value is a valid captured route key; manually authored empty required values remain invalid.
- `isDefault=true` marks one page profile as the default route-parameter source and clears the marker from every other profile on that page. `POST .../default` sets the marker, `POST .../default` with `{ "isDefault": false }` clears it, and `DELETE .../default` also clears it. Legacy profiles without the marker are treated as non-default.
- A profile may carry `navigation: { route: "huigou://lynx", params: Record<string, string> }`, `actions`, and `assertions`. Existing profiles without these fields remain valid and receive an empty action/assertion list plus a default route derived from `page.bundle`.
- A page-profile interaction action authored by the browser has `type` in `tap | input | select | submit | waitFor`, a semantic `target`, and optional `value` / `timeoutMs`. Persisted legacy profiles may still contain `screenshot` actions for compatibility. The provider catalog declares allowed targets and action types; the console rejects unknown targets and unsupported action types before persistence. Screenshots remain runner evidence and are not page-interaction locator steps.
- An assertion has `type` in `runtimeEvent | visible | text | selected`, with an event name for `runtimeEvent` or a catalog target for UI assertions. Text assertions carry `value`.
- The Fanli provider exposes `targets` and `assertionTargets` from page QA sidecars. A target ID uses the `<page>.<area>.<action-or-state>` convention and maps to platform selectors inside the sidecar.
- A target carries `{ id, label, kind, actions, platforms?, platformActions?, defaultAssertions? }`. `kind` classifies buttons, inputs, tabs, list items, and operable regions; `platforms` limits target availability; `platformActions` narrows action capability per platform; `defaultAssertions` supplies the project-owned expected response.
- Stable semantic IDs are the cross-project boundary. Each project provider owns business target discovery, platform selector mapping, default assertions, risk labels, and any custom target metadata. The console owns generic editing, validation, device scheduling, and result rendering.
- The browser exposes every declared target action in one ordered page-interaction editor. QA-injected script/client negotiation executes semantic targets; `input` and `select` steps carry editable values, and every step carries at least one response assertion. The editor does not add screenshot steps.
- A profile scoped to one platform exposes that platform's target/action capabilities. An `all` profile accepts only actions supported by every platform; when an operator selects a platform-specific target while drafting an `all` profile, the browser narrows the profile scope to a compatible platform before save.
- The page-parameter editor presents three explicit sources: `当前路由参数` contains the selected observation or the current manually edited draft, `历史数据` contains persisted profiles, and the expandable `代码读取到的其他参数` section contains static-analysis suggestions. A route key with an empty string remains a captured key.
- When the current page has no captured or manually entered route values, the editor initializes from that page's marked default profile; the most recently recorded profile is the fallback when no default is marked. The selection is recomputed for each page, while existing manual and captured values remain authoritative, including captured empty strings.
- The page list supports page-label and bundle search, a parameter-required filter, and distinct states for declared fields, dynamic reads, and directly testable parameter-free pages.
- The history profile view provides `单页回放`; the console sends the selected page/profile ID and device to the provider and renders the pass/fail output without changing the saved profile.
- The browser places device recording controls and the selected-page replay result in one top-level `录制与测试` control panel, so the latest failure or pass state stays adjacent to the recording context.
- Selecting another page clears visible route values, value origins, actions, assertions, profile metadata, parameter-tab state, and replay output before loading that page's draft. A replay response carries the page/profile context that started it; responses from a previous selection cannot repopulate the current page result.
- The page editor keeps the page-scoped `保存页面测试` and `测试当前页面` controls visible across the current-parameter and history views. It saves the current draft and starts one page replay only after the operator explicitly selects an available device.
- The capture view renders `rawData` inside a collapsed `<details>` block and keeps the parsed fields editable below it.
- Historical profile values enter the current draft through an explicit `用于当前测试` action or the latest-profile shortcut. These actions replace the current route-parameter draft with the selected profile, mark the values as `history`, and keep the profile ID available for saving or editing. The test-result toolbar also offers a profile selector that replays a persisted profile directly without mutating the current draft. Static-analysis suggestions enter through an explicit per-field action and continue to supplement the draft.
- History rows expose set-default and clear-default actions. A page keeps at most one marked default; deleting or clearing it leaves the latest-history fallback available.
- The editor stores value origins as `captured`, `history`, `suggested`, or `manual` for review before profile save. The saved profile contains the current draft values after those explicit choices.
- A field with `requirement=required` must contain a non-empty value before save or replay. A conditional candidate group with `alternatives` accepts one non-empty candidate and reports the complete candidate list when every candidate is empty.
- Page actions may carry nested `assertions`; the service validates each action assertion against the page assertion targets and the runner executes those assertions immediately after the corresponding action.
- The replay summary uses `{ pageOpened, expectedPage, actualPage, actionCount, actionPassed, assertionCount, assertionPassed, missingEvents, steps }`. Each step exposes type, semantic target, status, message, and evidence source. The structured summary contains semantic metadata only; input values and resolved secrets remain inside the protected profile/runner boundary.
- The runner overlays resolved profile navigation parameters on the manifest route parameters and forwards `semanticActions` and `assertions` with the child platform command. Platform shells keep the navigation object structured until App launch; Base64 is a transport detail for Harmony and Android.
- Each profile value declares `literal`, `secretRef`, or `runtimeResolver`. Sensitive catalog fields accept `secretRef` or `runtimeResolver`; stored literal sensitive values are rejected.
- Profiles persist at `<stateDir>/page-parameters.json`. Writes use a `.next` file, atomic rename, a serialized write queue, and file mode `0600`.
- Runner selection matches `pageId`, exact platform or `all`, and `environment`, then overlays resolved values on the manifest case route parameters. An unexpired exact-platform profile wins over an `all` profile; an explicit `isDefault` profile wins when the route has no values, and the newest unexpired history profile is the fallback when no default is marked.
- `literal` copies the configured value. `secretRef` reads the named environment variable. `runtimeResolver` requires a registered resolver and fails with the profile ID and field name when absent.
- The parent Lynx runner passes resolved `qa-page`, `qa-scenario`, and `qa-route-params` to the platform runner. A platform runner preserves these upstream values when it reloads the manifest.
- Harmony transports route parameters through UTF-8 JSON encoded as Base64 in `qaRouteParamsBase64`. `EntryBuildVariant` decodes it before saving `routeParams` and recording state in `AppStorage`.
- Harmony emits `lynx_page_parameters_observed` through `HarmonyQaEventDetail`. The provider associates events by recording ID and sanitizes sensitive fields before returning them to the console.
- Harmony one-click treats `Device not found or connected`, `[Empty]`, and `[Fail][E001005]` as device disconnection and reports `设备连接已中断`.
- A console platform one-click may omit the target page and fixture. The Fanli Harmony adapter must omit empty `qaPage` and `qaFixture` Want parameters because `aa start --ps` requires every key to have a non-empty argument value.

### 4. Validation & Error Matrix

| Condition | Error code or behavior |
| --- | --- |
| Project has no page-parameter provider | `PAGE_PARAMETERS_UNAVAILABLE` with HTTP 404 |
| Provider exits unsuccessfully or times out | `PAGE_PARAMETER_PROVIDER_FAILED` with HTTP 502 |
| Provider emits invalid JSON | `PAGE_PARAMETER_PROVIDER_INVALID` with HTTP 502 |
| Recording device key is unknown | `DEVICE_UNKNOWN` with HTTP 404 |
| Recording device is unavailable | `DEVICE_UNAVAILABLE` with HTTP 409 |
| Device already owns an active recording | `PAGE_PARAMETER_RECORDING_ACTIVE` with HTTP 409 |
| Recording ID is unknown | `PAGE_PARAMETER_RECORDING_UNKNOWN` with HTTP 404 |
| Replay profile ID is unknown | `PAGE_PARAMETER_PROFILE_UNKNOWN` with HTTP 404 |
| Replay device platform differs from an explicitly scoped profile platform | `PAGE_PARAMETER_REPLAY_PLATFORM_MISMATCH` with HTTP 409; an `all` profile is accepted on every supported platform |
| Replay provider returns a failed payload | HTTP 200 with `replay.status = "failed"` and bounded output/error |
| Page ID is absent from the current catalog | `PAGE_PARAMETER_PAGE_UNKNOWN` with HTTP 404 |
| A required profile field is empty | `PAGE_PARAMETER_REQUIRED` |
| A sensitive field uses `literal` | `PAGE_PARAMETER_SENSITIVE_LITERAL` |
| An action target is absent from the catalog | `PAGE_SCENARIO_TARGET_UNKNOWN` |
| An action type is not declared for its target | `PAGE_SCENARIO_ACTION_UNSUPPORTED` |
| An input action has no value | `PAGE_SCENARIO_ACTION_VALUE_REQUIRED` |
| An action has no response assertion | `PAGE_SCENARIO_ACTION_ASSERTION_REQUIRED` |
| A UI assertion target is absent from the catalog | `PAGE_SCENARIO_ASSERTION_TARGET_UNKNOWN` |
| A runtime event assertion has no event name | `PAGE_SCENARIO_ASSERTION_EVENT_REQUIRED` |
| A text assertion has no expected text | `PAGE_SCENARIO_ASSERTION_VALUE_REQUIRED` |
| A page profile is marked default | Existing page default marker is cleared before the new marker is persisted |
| Profile ID is unknown during deletion | `PAGE_PARAMETER_PROFILE_UNKNOWN` with HTTP 404 |
| `secretRef` environment variable is empty | Runner fails and identifies the profile, field, and environment variable |
| `runtimeResolver` has no registered resolver | Runner fails and identifies the profile and field |
| Harmony HDC output contains a known disconnection marker | Classify as device disconnection and preserve the underlying HDC output in logs |

### 5. Good / Base / Bad Cases

- Good: an operator records `pageSearchIndex` on any device, saves a `default` / `all` / `qa` profile, and later Android, iOS, and Harmony runs inject the recorded `q`, `search_page_mode`, and `mall_type` values.
- Good: a search scenario stores `search.header.input`, `search.tab.tb`, and `search.header.submit` semantic actions; the same profile is selected on each platform while sidecars own selector details.
- Good: a Harmony-only region declares `platforms=["harmony"]`; selecting it narrows the draft profile to Harmony and the server rejects an `all` profile containing that action.
- Good: a provider supplies a navigation assertion for a navigation button and a selected-state assertion for a Tab; the console renders and persists both while remaining business-agnostic.
- Good: a login page with no route fields appears in the catalog through its input target, and the operator saves phone/password values as input actions followed by submit.
- Good: repeated Harmony log reads produce one semantic observation in the console, and each browser poll begins after the prior provider request finishes.
- Good: a token field stores an environment-variable name with `secretRef`; the runner resolves the secret only during execution.
- Base: a page with static parameter reads appears as `missing` until an operator saves its first profile.
- Base: an expired profile remains visible as `expired` for renewal and is excluded from replay selection.
- Base: an empty route draft uses the page default profile, then the newest history profile when no default exists; a page with no history remains empty.
- Bad: a platform sub-runner reloads the QA manifest and replaces the route parameters selected by the parent runner.
- Bad: the console stores platform coordinates as the scenario contract and requires every project to duplicate Android, iOS, and Harmony actions.
- Bad: the editor unions QA manifest fields into the current observation and labels every union member as a device-captured route parameter.
- Bad: a historical profile silently overwrites a route key captured with an empty value.
- Bad: Harmony passes raw non-ASCII JSON through shell string arguments and changes Chinese parameter bytes.
- Bad: each fixed-interval browser tick starts another HDC query while the previous query remains active.
- Bad: HDC disconnection is reported as an App process-liveness failure.

### 6. Tests Required

- Validate `pageParameters.provider` configuration and resolve the provider actions plus `{{pageParameters.statePath}}`.
- Inject all page-parameter HTTP routes; assert request validation, device revalidation, active-recording conflict, observation merge, required-field checks, sensitive-field checks, save, and delete behavior.
- Inject the single-page replay route; assert exact profile ID forwarding, platform mismatch rejection, provider pass/fail mapping, and bounded output.
- Assert persisted state uses the expected schema, atomic replacement, serialized writes, and `0600` permissions.
- Build the Fanli catalog from the generated `all-pages` suite, manifest route parameters, and static page-parameter reads; assert the exact page set, page ownership, required fields, sensitive strategies, and explicit dynamic-read state.
- Parse Harmony `HarmonyQaEventDetail` lines; assert run-ID filtering, stable observation IDs, route values, sensitive-field sanitization, and semantic deduplication.
- Assert observations retain the redacted source event in `rawData`, and the browser renders it in a collapsed inspection block.
- Assert profile selection across page, exact platform, `all` platform scope, environment, expiry, exact-scene priority, and `default` fallback.
- Assert `literal`, resolved `secretRef`, missing `secretRef`, and unregistered `runtimeResolver` behavior.
- Assert the parent runner and Harmony child runner preserve resolved page, scene, and route parameters.
- Assert UTF-8 route JSON survives Harmony Base64 encode/decode with Chinese values.
- Assert scenario validation, semantic target/action compatibility, assertion target validation, and backward-compatible profile defaults.
- Assert target kinds, platform scopes, platform action overrides, provider default assertions, and the required action-assertion rule survive catalog-to-profile round trips.
- Assert the browser exposes declared input/select/tap/submit/wait actions in one ordered editor, filters screenshot-only targets and legacy screenshot steps, and persists action-scoped assertions.
- Assert profile-platform changes and historical-profile loading refresh the visible target/action capability set, while an `all` draft can narrow to a compatible platform when a platform-specific target is selected.
- Assert replay summaries report page/action/assertion counts and semantic step evidence only; action input values and resolved secrets remain protected.
- Assert the browser separates observation keys, historical profile keys, and code-analysis suggestions; assert an empty observed value remains captured and historical supplementation preserves it.
- Assert the latest historical profile is visible in the current-parameter view, explicit application replaces the draft values, deletion clears the selected profile, and the test-result profile selector replays the chosen persisted profile directly.
- Assert default-profile set/clear operations keep one marker per page, prefer the marker over a newer profile for an empty route draft, fall back to the newest history profile, preserve an existing manual or captured value, and recompute the selection after page switching.
- Assert the recording controls and replay result render in the same top-level control panel, and switching from a populated page to another page clears route fields, actions, assertions, profile metadata, tabs, and replay output. Resolve an old replay after the switch and assert that its result remains discarded.
- Assert page search/filter state uses explicit catalog fields, and current-page testing requires an explicitly selected available device.
- Assert the runner forwards normalized navigation, semantic actions, and assertions without leaking sensitive values into command logs.
- Assert `[Fail][E001005] Device not found or connected` reaches the device-disconnection error branch.
- Run the Harmony ArkTS/HAP build after changing route transport or event payload types.
- Complete one recording/profile-save/replay flow through `http://127.0.0.1:4311/` and verify the device receives the recorded values.

### 7. Wrong vs Correct

#### Wrong

```js
const childCase = loadManifestCase(caseId);
await runHarmony(childCase.routeParams);
```

#### Correct

```js
const routeParams = JSON.parse(optionalString(args, "qa-route-params", JSON.stringify(childCase.routeParams || {})));
await runHarmony(routeParams);
```

#### Wrong

```ts
const fields = [...page.fields, ...Object.keys(observation.values)];
```

#### Correct

```ts
const capturedFields = Object.keys(observation.values);
const currentDraft = supplementHistoryOnlyWhenExplicitlyRequested(observation, profile);
```

#### Wrong

```ts
timer = window.setInterval(() => void refreshRecording(recordingId), 1500);
```

#### Correct

```ts
const poll = async () => {
  await refreshRecording(recordingId);
  timer = window.setTimeout(() => void poll(), 1500);
};
```

#### Wrong

```text
--ps qaRouteParams '{"q":"录制关键词"}'
```

#### Correct

```text
--ps qaRouteParamsBase64 <UTF-8 JSON Base64>
```

## Scenario: Local account-profile recording and replay

### 1. Scope / Trigger

- Trigger: Mobile Test Console records a successful third-party login or Taobao commerce authorization on a QA App and later replays that account identity.
- Applies to console configuration, provider process calls, local state, HTTP APIs, browser summaries, deletion, expiry, and replay validation.

### 2. Signatures

- Configuration: `accountProfiles.provider: { executable, args, cwd?, env? }`.
- Provider schema: `mobile-test-console.account-profile-provider.v1`.
- Provider actions: `recording-start`, `recording-status`, `recording-stop`, and `replay`; every replay command includes `--profile-id <id>` and `--provider <provider>`.
- Template variable: `{{accountProfiles.statePath}}`, resolved to `<stateDir>/account-profiles.json`.
- HTTP APIs: `GET /api/account-profiles`, `GET /api/account-profiles/:profileId/source?provider=<provider>`, `POST /api/account-profile-recordings`, `GET /api/account-profile-recordings/:recordingId`, `POST /api/account-profile-recordings/:recordingId/stop`, `POST /api/account-profile-recordings/:recordingId/terminate`, `POST /api/account-profiles/:profileId/replay`, and `DELETE /api/account-profiles/:profileId`.

## Scenario: 全页面测试登录前置

### 1. Scope / Trigger

- Trigger: Mobile Test Console 启动 Fanli `all-pages` 套件。
- Applies to 测试参数配置、账号画像筛选、Fanli suite runner、登录探测产物和任务结果展示。

### 2. Signatures

- 测试参数：`{ id: "account-profile", type: "account-profile", defaultValue: "current-session", capability: "login" }`。
- suite 参数：`--account-profiles <state-path> --account-profile <current-session|profileId:provider>`。
- 前置产物：`qa/history/artifacts/<runId>/auth-preflight.json`，schema `fanli.qa.auth-preflight.v1`。
- 任务结果：`mobile-test-console.task-result.v1` 的可选 `preconditions[]`。

### 3. Contracts

- 控制台与账号画像公共协议使用 `platform` 和可选 `appId` 表达目标应用，不把 Android `applicationId`、iOS bundle ID 或 Harmony bundle name 写入画像数据。Fanli provider 通过 `resolvePlatformAppId(platform, explicitAppId)` 解析平台原生命令所需的真实标识。
- 默认映射为 Android/iOS `com.shanjing.fanli`、Harmony `com.shanjing.huigou`；`--app-id` 用于 QA 变体显式覆盖。Android one-click 接收 `--package-name`，iOS/Harmony one-click 接收 `--bundle-id`。
- Android 账号画像写入将 `mkdir`、`touch`、`chmod`、`dd` 和 `mv` 作为独立的 `adb shell run-as <appId>` 命令执行。载荷先写入权限为 `0600` 的 `<profile>.json.next`，完成后原子替换正式文件；ADB 参数数组不使用拆分的 `sh -c` 命令。
- 控制台 UI 和 Fanli preflight runner 将画像平台作为录制来源，按测试环境、`login` capability 和 `expiresAt` 校验账号画像；登录画像可在 Android、iOS 与 Harmony 设备间回放。
- Huawei Provider 仅适用于华为设备：Harmony 设备直接满足条件，Android 设备要求发现结果中的 `manufacturer` 匹配 `Huawei` 或 `华为`。控制台录制设备列表、录制 API、回放列表、任务启动和 Fanli 自动画像选择统一执行该门禁。
- `all-pages` 的构建安装 setup 首个页面固定为 `login-index`；随后运行 `render-pageUserIndex`，要求至少一条 `endpoint=member` 的 API 事件全部为 2xx 且 `result=success`。
- 正式 `all-pages` 的 78 个用户页面用例同样以 `login-index` 开始；setup 和登录前置产物继续独立于正式统计。
- 当前会话有效时记录 `action=reused-session`。`current-session` 探测失效时，runner 在同环境、具备 `login` capability 且未过期的 Provider 分支中按 `recordedAt` 选择最新画像；显式 `profileId:provider` 保持指定选择。画像回放后重新执行会员会话探测，复验成功后记录 `action=account-profile-replay`。
- 开发端口复用只保留已经运行的 Console 服务和共享 QA 构建。每个任务都会启动新的 Fanli adapter Node 进程，因此 adapter 脚本改动会被新任务读取；Lynx、sidecar、Native 或 QA 构建输入改动继续要求重启服务。
- 登录前置只准备宿主登录态。正式页面继续使用原路由参数、真实接口、动作和断言。
- `<runId>-setup-*` 与 `<runId>-preflight-*` 目录不进入正式页面数量、通过率和失败率；`preconditions[]` 单独进入结果页。
- 空 `parameterProfileId` 省略整个 `--page-parameter-profile-id` 参数，避免 CLI 将空 flag 解析为字符串 `"true"`。

### 4. Validation & Error Matrix

| Condition | Error code or behavior |
| --- | --- |
| 当前会员会话有效 | 复用会话并启动 78 个正式页面 |
| 会话失效且参数为 `current-session`，存在有效 login 画像 | 自动回放最新画像，复验通过后启动 78 个正式页面 |
| 会话失效且参数为 `current-session`，没有有效 login 画像 | 写入失败前置，报告目标平台和环境，停止正式页面 |
| 画像格式不符合 `profileId:provider` | 参数校验失败 |
| 画像环境、登录能力或有效期不匹配 | 控制台阻止启动 |
| Android 账号画像读取或回放 | `run-as com.shanjing.fanli` 访问 Android QA App 沙箱 |
| Android 账号画像目录创建、载荷写入或原子提交失败 | 报告对应阶段并停止后续命令；正式画像文件保留上一份完整数据 |
| Harmony 账号画像读取或回放 | `hdc file recv/send -b com.shanjing.huigou` 访问 Harmony QA App 沙箱 |
| QA 变体提供 `--app-id` | provider 与平台 one-click 使用显式标识，画像协议保持不变 |
| Redmi 等非华为 Android 选择 Huawei Provider | 录制或显式回放返回 `ACCOUNT_PROFILE_DEVICE_MISMATCH`；自动选择跳过该分支 |
| 画像回放失败或复验仍失败 | 写入失败前置，停止正式页面 |
| setup 或 preflight 生成 summary | 作为前置证据保留，不计入正式统计 |

### 5. Good/Base/Bad Cases

- Good: Harmony 当前会话 401，`current-session` 自动选择最新的 `qa-account-wechat:wechat`，完成回放和会员接口复验，再运行全部页面。
- Good: Harmony 录制的微信画像在 Android 回放时写入 `com.shanjing.fanli` 沙箱，并通过 Android one-click 启动同一应用。
- Base: 设备已有有效会话，登录探测通过并直接执行全部页面。
- Bad: 为消除正式用例中的 401，将页面接口替换为固定成功响应或降低页面断言标准。

### 6. Tests Required

- Unit: `account-profile` 配置 schema、默认值、命令模板和画像格式校验。
- Unit: 当前会话复用、失效后最新画像筛选、自动画像回放、显式画像回放、回放后会员接口复验和失败前置写入。
- Unit: Redmi 过滤和拒绝 Huawei Provider，Huawei Android 与 Harmony 允许；录制和 suite provider 命令包含设备厂商。
- Unit: 平台应用标识映射、显式覆盖、one-click 参数名和 Android/Harmony 沙箱命令分别使用正确应用标识。
- Unit: Android 画像写入按 `mkdir -> touch -> chmod -> dd -> mv` 执行，载荷进入 `0600` 临时文件，任一阶段失败时停止后续命令。
- Unit: setup/preflight 目录从正式统计排除，`preconditions[]` 进入任务结果。
- Unit: 空参数画像 ID 不生成 `--page-parameter-profile-id`。
- Unit: setup 命令的首个页面用例固定为 `login-index`。
- Unit: 正式 `all-pages` 的首个用例固定为 `login-index`，总数保持 78。
- Device: Harmony `all-pages` 先显示登录前置通过，再精确统计 78 个正式页面。

### 7. Wrong vs Correct

#### Wrong

```js
const ANDROID_PACKAGE = "com.shanjing.huigou";
runAs(ANDROID_PACKAGE, profilePath);
```

#### Correct

```js
const appId = resolvePlatformAppId(platform, args["app-id"]);
runPlatformSandboxCommand(platform, appId, profilePath);
```

#### Wrong

```js
spawnSync("adb", ["shell", "run-as", appId, "sh", "-c", "mkdir -p files/account-profiles && cat > files/account-profiles/profile.json"]);
```

#### Correct

```js
runAs(appId, "mkdir", "-p", "files/account-profiles");
runAs(appId, "touch", "files/account-profiles/profile.json.next");
runAs(appId, "chmod", "600", "files/account-profiles/profile.json.next");
runAs(appId, "dd", "of=files/account-profiles/profile.json.next", { input: payload });
runAs(appId, "mv", "files/account-profiles/profile.json.next", "files/account-profiles/profile.json");
```

#### Wrong

```js
runPageSuite();
ignoreUnauthorizedFailures();
```

#### Correct

```js
const session = verifyMemberSession();
if (!session.valid) replaySelectedOrLatestAccountProfile();
verifyMemberSession();
runPageSuiteWithOriginalAssertions();
```

### 3. Contracts

- The state file uses `mobile-test-console.account-profile-state.v1`, atomic replacement, serialized writes, and mode `0600`. Each current profile uses `mobile-test-console.account-profile.v2` and stores shared scope fields plus `providerEntries[]`.
- Each `providerEntries[]` item owns `provider`, `accountUid`, `sourceDeviceKey`, `capabilities`, `captures`, `recordedAt`, `validatedAt`, and `expiresAt`. Recording another Provider under the same `profileId` appends a branch; recording the same Provider replaces that branch and preserves every other branch.
- A profile ID is bound to one recording-source platform and environment. Recording the same ID from another source platform returns `ACCOUNT_PROFILE_SCOPE_MISMATCH` before the Provider starts; the stored platform remains provenance metadata and does not restrict a `login` Provider replay target.
- Legacy `mobile-test-console.account-profile.v1` objects are normalized in memory to one v2 Provider entry when read. The next successful state mutation persists the normalized aggregate form.
- On state load, a profile is backfilled from its own `stopped` recordings when a Provider branch is missing. Matching requires the same `profileId`, platform, and environment; the newest complete recording wins per Provider. Explicit v2 branches remain authoritative. Failed, empty, malformed, mixed-Provider, and cross-scope recordings are ignored, and a missing profile is never created from history alone. A changed migration is persisted atomically with mode `0600` and remains idempotent.
- Stored Provider entries contain the original whitelisted Native and GraphQL capture values. The collection API contains per-entry `captureSummaries` with field paths, a 12-character SHA-256 digest, and a masked UID; it omits `captures` and the raw UID. The local console exposes one selected Provider branch on demand through `mobile-test-console.account-profile-source.v1`, including `accountUid`, `captures`, metadata, and recorded values.
- The provider receives `profileId`, provider, platform, environment, device identity, device manufacturer, and run identity. Recording and replay commands carry `--device-manufacturer`; replay receives the profile state path through configuration plus the selected Provider and must not receive a serialized profile in process arguments.
- A successful non-commerce recording requires one successful Native capture and one OAuth GraphQL result containing `uid` and `session_key`. Taobao commerce requires a successful Native capture.
- Replay resolves one branch by `profileId + provider`, then rejects a missing branch, expired branch, or cross-platform branch without `login` capability. A passed replay updates only the selected branch's `validatedAt` and reports both the target platform and source platform.
- Deletion removes the complete aggregate profile and every historical recording with the same `profileId`, so Native callbacks, OAuth results, session keys, tokens, and other captured payloads leave `account-profiles.json` together. The browser opens an in-page confirmation dialog naming the account label and profile ID before sending `DELETE /api/account-profiles/:profileId`.
- A profile with a `starting` or `recording` session cannot be deleted. The operator must stop/save or terminate the matching session first.
- The browser renders metadata, capabilities, capture field names, digests, and masked identifiers in the default view. Each Provider branch offers an explicit `查看源数据` action that fetches the source endpoint, renders formatted JSON in a bounded scroll area, and copies the complete response on command. Switching profiles or deleting a profile closes the source panel.
- The browser's recording form supplies Provider-specific defaults so ordinary recordings create separate profiles: `wechat -> qa-account-wechat / QA 微信账号`, `qq -> qa-account-qq / QA QQ 账号`, `taobao -> qa-account-taobao / QA 淘宝账号`, `huawei -> qa-account-huawei / QA 华为账号`, and `taobao-commerce -> qa-account-taobao-commerce / QA 淘宝授权账号`. When the current fields still equal the previous Provider defaults, changing the authorization scene updates both fields atomically. A manually edited profile ID or account label remains unchanged; an explicitly reused profile ID continues to support intentional multi-Provider aggregation.
- The browser filters recording and replay device choices by Provider compatibility. Huawei lists Harmony targets and Android targets whose discovered manufacturer matches Huawei; the service repeats the check before creating recording state or invoking the Provider.
- `GET /api/account-profiles` returns every recording sorted by `startedAt`. The browser renders every `starting` or `recording` session, polls the collection, and keeps normal stop/save and immediate termination as separate actions.
- One device owns at most one active account recording. Independent devices may record concurrently, and serialized state mutations preserve all sessions.
- Normal stop calls the provider and creates a profile when the required captures are complete. Immediate termination skips the provider, writes `status=failed`, sets `stoppedAt`, records `用户终止录制会话`, and releases the device.
- Provider start, status, or stop responses apply only while the stored session remains active. A response that arrives after immediate termination must preserve the terminal state.
- The recording route only activates the QA recorder. Provider data comes from the real Native callback and successful OAuth GraphQL response. Harmony providers access private sandbox captures and replay profiles through HDC's `-b com.shanjing.huigou` debug-application channel.
- Harmony replay creates the sandbox subdirectory by sending a local `account-profiles` directory to `/data/storage/el2/base/haps/entry/files` with `hdc file send -m -b com.shanjing.huigou`. A direct single-file send to `files/account-profiles/<profileId>.json` is valid only after that parent directory already exists and therefore cannot implement first replay.

### 4. Validation & Error Matrix

| Condition | Error code or behavior |
| --- | --- |
| Project has no provider | `ACCOUNT_PROFILE_UNAVAILABLE` with HTTP 404 |
| Device is unknown or unavailable | `DEVICE_UNKNOWN` or `DEVICE_UNAVAILABLE` |
| Device already has an active account recording | `ACCOUNT_RECORDING_ACTIVE` with HTTP 409 |
| Huawei Provider targets a non-Huawei Android device | `ACCOUNT_PROFILE_DEVICE_MISMATCH` with HTTP 409 before recording state or Provider invocation |
| Recording or profile ID is unknown | `ACCOUNT_RECORDING_UNKNOWN` or `ACCOUNT_PROFILE_UNKNOWN` |
| Existing profile ID belongs to another platform or environment | `ACCOUNT_PROFILE_SCOPE_MISMATCH` with HTTP 409 |
| Authorization scene changes while the form still uses generated defaults | Replace profile ID and account label with the selected Provider defaults |
| Authorization scene changes after a profile ID or account label was manually edited | Preserve the manually entered value |
| Active recording is terminated | Persist `failed` plus `用户终止录制会话`; release the device without calling the provider |
| Provider response arrives after termination | Ignore the stale response and preserve the terminal recording |
| Harmony provider omits the HDC debug-application channel | Private sandbox access returns `Permission denied`; surface provider failure instead of treating it as an empty capture set |
| First Harmony replay sends one file to a missing `files/account-profiles` parent | HDC returns `[Fail]Error opening file: no such file or directory`; send the complete local directory to the existing `files` root |
| Provider exits unsuccessfully or emits invalid JSON/schema | `ACCOUNT_PROFILE_PROVIDER_FAILED` or `ACCOUNT_PROFILE_PROVIDER_INVALID` |
| Recording lacks a required successful boundary | Recording becomes `failed`; no profile is created |
| Replay device platform differs and the selected branch lacks `login` capability | `ACCOUNT_PROFILE_PLATFORM_MISMATCH` with HTTP 409 |
| Selected Provider branch is absent | `ACCOUNT_PROFILE_PROVIDER_UNKNOWN` with HTTP 404 |
| Source request omits or supplies an unknown Provider | `REQUEST_INVALID` with HTTP 400 |
| Selected Provider branch expiry is empty, invalid, or in the past | `ACCOUNT_PROFILE_EXPIRED` with HTTP 409 |
| Deleted profile has a `starting` or `recording` session | `ACCOUNT_PROFILE_RECORDING_ACTIVE` with HTTP 409; preserve the profile and recording |
| Profile deletion succeeds | Remove the profile and all recordings with the same `profileId`; return `{ ok: true }` |
| Provider returns replay failure | HTTP 200 with `replay.status = failed` and bounded non-secret output |

### 5. Good / Base / Bad Cases

- Good: a provider returns successful whitelisted captures, the state file retains the values, and the collection API exposes only paths plus digests.
- Good: WeChat, Huawei, QQ, Taobao login, and Taobao commerce recordings reuse one profile ID and appear as independent Provider branches in one browser profile.
- Good: re-recording Huawei replaces the Huawei branch while preserving WeChat, QQ, Taobao login, and Taobao commerce captures.
- Good: a legacy v1 Taobao profile loads as one v2 Provider entry and replays through the explicit Taobao selection.
- Good: selecting Taobao in a fresh recording form shows `qa-account-taobao` and `QA 淘宝账号`, so the saved profile appears as its own row.
- Good: a manually entered `fixed-member` profile ID remains `fixed-member` when the operator changes the authorization scene, allowing deliberate aggregation.
- Good: loading the existing state after an earlier single-Provider overwrite restores missing Huawei, QQ, and Taobao-commerce branches from complete stopped recordings and persists the aggregate once.
- Good: a Harmony provider reads the Native callback and OAuth response from `diagnostics/<runId>/account-profile-captures.jsonl` through `hdc file recv -b com.shanjing.huigou`.
- Good: a first Harmony replay sends `<temp>/account-profiles` to `/data/storage/el2/base/haps/entry/files`, creates the subdirectory, and makes `<profileId>.json` readable by `NativeDiagnosticsModule`.
- Good: replay passes only `profileId` in the route and validates persisted login state plus a member query before returning success.
- Good: the account list loads masked summaries, then an operator explicitly opens one Huawei branch and sees its full local capture JSON with a copy action.
- Good: two devices record concurrently, both sessions remain visible, and either row can stop/save or terminate independently.
- Good: a delayed provider start returns after the operator terminates the session, and the session remains failed and releases its device.
- Good: deleting a stopped profile through the confirmation dialog removes its profile row, historical recordings, and stored authorization payloads.
- Base: a cancelled Native authorization continues through the deterministic QA auth profile and creates no recorded account profile.
- Base: a stopped or failed historical recording stays in local state while the active-session list filters it out.
- Bad: raw `session_key`, access token, authorization code, or the complete capture object appears in the collection API response, command argument, log, report, or default browser state before an explicit source request.
- Bad: the account collection response eagerly includes every branch's raw capture payload before the operator requests source data.
- Bad: deletion removes metadata while leaving the secret capture payload reachable in another console state record.
- Bad: the browser selects only the first active recording or a late provider callback overwrites an operator termination.
- Bad: stopping a recording filters the profile list by `profileId` and writes a new single-Provider object, discarding previously recorded branches.
- Bad: a plain HDC file read fails permission checks and the console reports `录制期间未捕获账号授权数据` even though callback captures exist.
- Bad: Harmony replay sends `<temp>/<profileId>.json` directly to `/data/storage/el2/base/haps/entry/files/account-profiles/<profileId>.json` before the parent directory exists.

### 6. Tests Required

- Assert configuration parsing and provider command resolution include `{{accountProfiles.statePath}}` for provider and task commands.
- Assert successful recording, required-boundary validation, cross-platform login replay, expiry, platform-scoped authorization mismatch, Provider-branch mismatch, validation timestamp updates, and deletion.
- Assert device discovery retains Android/Harmony manufacturer, Huawei recording-device filtering excludes Redmi, and Huawei recording/replay accepts Huawei Android plus Harmony.
- Delete a stopped profile and assert both `profiles[]` and matching `recordings[]` are absent from persisted state, including a known secret value. Attempt deletion during an active session and assert `ACCOUNT_PROFILE_RECORDING_ACTIVE` plus unchanged state.
- Record two Providers under one profile ID; assert both branches remain. Re-record one Provider; assert only that branch changes.
- Load a legacy v1 state object; assert the snapshot exposes one v2 Provider entry and explicit replay selects it.
- Seed one v2 profile plus historical stopped recordings; assert scope filtering, newest-complete selection, explicit-branch precedence, atomic persistence, `0600` mode, and idempotent second load.
- Exercise the browser identity defaults for all Providers, assert Taobao and Taobao-commerce use distinct profile IDs, and assert manual profile ID/label edits survive Provider changes.
- Start recordings concurrently on two devices and assert both active sessions remain in the snapshot.
- Terminate a session while its provider start is delayed; assert the terminal state survives the late response and the same device can start another recording.
- Render all active recording rows and assert each row exposes stop/save and terminate actions without horizontal overflow at desktop and 375 px widths.
- Serialize the collection response and assert known codes, tokens, OpenIDs, session keys, and the `captures` property are absent.
- Request one branch's source endpoint; assert the selected Provider's raw UID and captures are present, while unknown profiles, missing Providers, and unknown Provider branches return their specified errors.
- Exercise the source-view API URL, formatted JSON panel, copy action, close action, profile-switch reset, and mobile overflow behavior.
- Assert `account-profiles.json` contains the original values and has mode `0600`.
- Assert Harmony provider read/write commands use the debug-application channel and parse two successful WeChat captures from a physical-device sandbox.
- Assert Harmony replay sends the local `account-profiles` directory to the application `files` root, and cover the HDC directory-transfer failure message.
- Render the account workspace and exercise record, stop, replay, and delete against mocked APIs.
- Render the deletion confirmation and assert it contains the account label, profile ID, historical recording scope, cancel action, and destructive confirmation action.
- Run `pnpm check` in Mobile Test Console.

### 7. Wrong vs Correct

#### Wrong

```text
qa-account-profiles replay --profile-json '{"captures":[...]}'
```

#### Correct

```text
qa-account-profiles --profiles {{accountProfiles.statePath}} replay --profile-id fixed-account --provider wechat
```

#### Wrong

```text
hdc file send -b com.shanjing.huigou <temp>/qa-account-wechat.json /data/storage/el2/base/haps/entry/files/account-profiles/qa-account-wechat.json
```

#### Correct

```text
hdc file send -m -b com.shanjing.huigou <temp>/account-profiles /data/storage/el2/base/haps/entry/files
```

#### Wrong

```ts
const activeRecording = snapshot.recordings.find(item => item.status === "recording");
await store.save(staleStateAfterProviderReturn);
```

#### Correct

```ts
const activeRecordings = snapshot.recordings.filter(item => ["starting", "recording"].includes(item.status));
await store.update(state => applyProviderResultOnlyWhenActive(state, recordingId, payload));
```

#### Wrong

```ts
state.profiles = state.profiles.filter(item => item.profileId !== profileId);
```

#### Correct

```ts
assertNoActiveRecording(state.recordings, profileId);
state.profiles = state.profiles.filter(item => item.profileId !== profileId);
state.recordings = state.recordings.filter(item => item.profileId !== profileId);
```

## Scenario: Android 设备依赖预检与安装

### 1. Scope / Trigger

- Trigger: 项目测试需要设备侧辅助包，操作者需要在启动任务前确认安装状态并完成一次性准备。
- Applies to Mobile Test Console 项目配置、设备快照、安装 API、并发保护、浏览器设备行和 Fanli Maestro 驱动脚本。

### 2. Signatures

- 配置：`devicePreparations[]: { id, label, platforms, blocksTests, readyDetail, requiredDetail, check, install? }`。
- 命令模板：`check` 与 `install` 使用通用命令定义，支持 `{{device.key}}`、`{{device.id}}`、`{{device.platform}}`、`{{device.type}}`、`{{device.name}}` 和 `{{device.manufacturer}}`。
- 设备快照：`Device.preparations?: Array<{ id, label, status, detail, installable, blocksTests }>`，其中 `status` 为 `ready | required | checking | installing | failed`。
- HTTP API：`POST /api/devices/preparations/install`，请求体 `{ deviceKey: string, preparationId: string }`，成功响应 `{ device, preparation }`。
- Fanli 命令：`node packages/lynx/scripts/qa/qa-maestro-driver.cjs <check|install> --device <serial>`。

### 3. Contracts

- 设备发现完成基础连接检查后，按平台执行每个项目准备项的 `check` 命令，并把结果附加到对应设备的 `preparations[]`。
- `check` 退出码为 `0` 时状态为 `ready`；其他退出码为 `required`，详情使用项目声明的 `requiredDetail`。
- 安装 API 只接受当前快照中存在的设备和配置中存在、支持该平台且声明 `install` 命令的准备项。
- 同一 `deviceKey + preparationId` 同时只运行一个安装命令。安装成功后服务立即重新执行同一准备项的 `check`，并以复检结果响应。
- `blocksTests=true` 的未就绪准备项阻止对应设备启动测试；`blocksTests=false` 只提供提前提示和安装入口，测试 runner 根据用例是否包含设备驱动动作执行最终门禁。
- Fanli `maestro-driver` 同时检查 `dev.mobile.maestro` 和 `dev.mobile.maestro.test`。安装命令通过带 `--no-reinstall-driver` 的最小 Maestro flow 触发官方驱动安装并在 flow 结束时保留双包，完成后再次检查两个包。该参数允许安装缺失包，只关闭 Maestro 的结束卸载和后续强制重装行为。
- Redmi 等设备返回 `INSTALL_FAILED_USER_RESTRICTED` 时，错误详情必须提示开启开发者选项中的“通过 USB 安装”并确认设备安装提示。
- 项目未声明 `devicePreparations` 时，设备发现、快照和任务启动保持原有行为。

### 4. Validation & Error Matrix

| Condition | Error code or behavior |
| --- | --- |
| 设备和准备项均有效，安装与复检成功 | HTTP 200，返回 `status=ready` |
| 设备不存在或已断开 | 返回设备未知错误，保持现有快照 |
| 准备项不存在或平台不匹配 | 返回准备项未知错误，不执行命令 |
| 准备项缺少 `install` | 返回不可安装错误 |
| 同设备同准备项正在安装 | 返回安装进行中冲突 |
| 安装命令成功，复检仍失败 | 返回复检失败并保留 `required` 或 `failed` 状态 |
| `blocksTests=true` 且状态未就绪 | 启动任务前返回准备项未就绪错误 |
| `blocksTests=false` 且状态未就绪 | 设备仍可选择；runner 在需要该驱动的用例开始前检查 |
| Maestro 只存在一个驱动包 | `check` 退出码为 1，设备行显示“安装驱动” |
| 首次准备省略 `--no-reinstall-driver` | Maestro flow 成功后主动卸载双包，安装后复检失败 |
| Android 拒绝 USB 安装 | 安装失败消息包含“通过 USB 安装”和设备确认说明 |

### 5. Good/Base/Bad Cases

- Good: Redmi 连接后显示“缺少 dev.mobile.maestro 或 dev.mobile.maestro.test”，操作者开启 USB 安装权限并点击“安装驱动”，双包复检成功后状态更新为已就绪。
- Base: Android 双驱动已存在，设备行直接显示“Maestro 双驱动已安装”，安装按钮隐藏。
- Base: iOS 和 Harmony 没有匹配的平台准备项，设备快照不附加 Maestro 状态。
- Bad: 只检查 `dev.mobile.maestro.test`，遗漏主包后让动作测试进入 Maestro 启动阶段。
- Bad: 安装命令退出码为 0 后直接报告成功，省略设备包复检。
- Bad: 首次准备时省略 `--no-reinstall-driver`，导致 Maestro 2.x 在成功 flow 结束时清理刚安装的驱动。
- Bad: 因驱动缺失改写页面参数、账号画像、业务动作或断言，使测试结果偏离生产工作流。

### 6. Tests Required

- Unit: 配置 schema、默认空数组、设备模板变量和未知模板变量校验。
- Unit: Android 设备发现附加 `required`/`ready` 状态，iOS/Harmony 跳过 Android 准备项。
- Unit: 安装接口校验设备、准备项、平台和安装能力；安装成功后执行复检。
- Unit: 同设备同准备项并发安装只启动一个子进程，其他请求返回冲突。
- Unit: `blocksTests=true` 阻止任务，`blocksTests=false` 保持设备可测试。
- Unit: Fanli Maestro 检查要求两个包同时存在，安装命令包含 `--no-reinstall-driver`，并把 `INSTALL_FAILED_USER_RESTRICTED` 转换为可操作提示。
- UI: 缺失驱动时设备行显示准备详情和“安装驱动”；安装中禁用重复操作；成功后按钮消失；失败消息进入现有消息区。
- Integration: 在真实 Android 设备执行 `check -> install -> check`，确认两个包均可由 `adb shell pm path` 查询。
- Quality gate: Mobile Test Console 执行 `pnpm check`；Fanli 执行聚焦 QA 测试、Lynx typecheck 与 `git diff --check`。

### 7. Wrong vs Correct

#### Wrong

```ts
const driverReady = adbPackageExists(device, "dev.mobile.maestro.test");
await startEveryTest(device);
```

#### Correct

```ts
const preparation = await checkProjectPreparation(device, "maestro-driver");
if (preparation.blocksTests && preparation.status !== "ready") {
  throw devicePreparationRequired(preparation);
}
```

#### Wrong

```ts
await runInstallCommand(device);
return { status: "ready" };
```

#### Correct

```ts
await runInstallCommand(device);
return await runPreparationCheck(device, preparation);
```

## Scenario: Business-script recording, publishing, and replay

### 1. Scope / Trigger

- Trigger: an operator records a Native/Lynx business path on a device, edits the generated draft, publishes reusable Scenarios, or combines versioned Scenarios into a Suite.
- Applies to console persistence and APIs, the project-owned recording provider, Harmony `uiRecord`, semantic action normalization, secret handling, Scenario replay, and Suite expansion.

### 2. Signatures

- Provider actions: `recording-start`, `recording-status`, `recording-stop`, `replay-scenario`, and `replay-suite`.
- Provider state token: `{{businessScripts.statePath}}`.
- Harmony raw capture: `hdc shell uitest uiRecord record`, `hdc shell uitest uiRecord read`, and `hdc file recv /data/local/tmp/record.csv <artifact-path>`.

### 3. Contracts

- `businessScripts.provider` owns platform capture and replay. The console owns recording sessions, editable drafts, immutable published versions, Scenario definitions, Suite composition, persistence, APIs, and browser rendering.
- The provider schema is `mobile-test-console.business-script-provider.v1`; public snapshots use `mobile-test-console.business-scripts.v1`; persisted state uses `mobile-test-console.business-script-state.v1` with atomic replacement and mode `0600`.
- Harmony recording launches the QA App, starts `hdc shell uitest uiRecord record`, stops the recorder with SIGINT, and reads `/data/local/tmp/record.csv` through both `uiRecord read` and `hdc file recv` fallback paths.
- The provider returns `status=recording` only after the `uiRecord` output contains `Started Recording Successfully`, so the browser cannot expose an active recorder before the device is accepting actions.
- A draft step preserves its semantic target, original point, hierarchy reference, before/after page instance fields, and review status. Harmony soft-keyboard text is outside the recording contract. The browser can convert a recorded tap into an input step and edit `inputBinding` as `literal`, `secretRef`, or `runtimeResolver`; environment-backed bindings synchronize their matching variable declarations into the saved draft.
- A draft must contain at least one Scenario before publication. Each Scenario references declared step and assertion IDs. Publishing creates an immutable integer version; later edits produce another version.
- Draft editing may preserve `needs-review` steps. Publication requires every step to be resolved, validates stable tap/input targets, accepts literal input values, validates environment-backed variable bindings, and rejects missing or cyclic `setupRef` dependencies.
- A Suite contains ordered `{ scriptId, version, scenarioId }` references and a platform matrix. Suite replay expands references in order and returns one replay result per Scenario.
- Deleting a published version removes only the exact `{ scriptId, version }` entry. The draft, other published versions, and the script version counter remain available.
- Version counters are persisted as a high-water mark. Publishing after the latest version is deleted increments the historical maximum instead of reusing the deleted number.
- Version deletion removes every matching Scenario reference from saved Suites. A Suite whose Scenario list becomes empty is deleted in the same serialized state update.
- The published-history panel renders every stored version, grouped by Script ID and ordered by descending version, so any exact historical version can be selected for deletion. Suite selection may continue to default to the latest version of each Script.
- The browser opens an in-page confirmation dialog naming the exact `scriptId@version` and the Suite-reference cleanup scope before sending the bodyless `DELETE` request.
- Suite save validates every referenced Script version against every platform in the matrix. Recording creation and all business-script state mutations use a serialized store update so concurrent requests cannot create duplicate active sessions or versions.
- `{{businessScripts.statePath}}` resolves to `<stateDir>/business-scripts.json` in provider and task command templates.

HTTP API:

```text
GET  /api/business-scripts
POST /api/business-script-recordings
GET  /api/business-script-recordings/:recordingId
POST /api/business-script-recordings/:recordingId/stop
PUT  /api/business-script-drafts/:draftId
POST /api/business-script-drafts/:draftId/publish
DELETE /api/business-scripts/:scriptId/versions/:version
PUT  /api/business-suites/:suiteId
POST /api/business-scripts/:scriptId/versions/:version/scenarios/:scenarioId/replay
POST /api/business-suites/:suiteId/replay
```

### 4. Validation & Error Matrix

| Condition | Error code or behavior |
| --- | --- |
| Device already owns an active business recording | `BUSINESS_SCRIPT_RECORDING_ACTIVE` with HTTP 409 |
| Recorder output contains diagnostics or malformed optional fields | Preserve readable actions, retain bounded diagnostics, and mark unresolved steps for review |
| Recorder process exits before its ready marker or remains unready for eight seconds | Fail the start request and release the detached recorder process |
| Operator changes a recorded tap to `input` | Initialize an empty `literal` binding and expose the strategy/value editor |
| Input binding uses `literal` | Persist the final test input value directly and require no variable declaration |
| Input binding uses `secretRef` or `runtimeResolver` | Persist the matching draft variable declaration and require the same strategy during publication |
| Draft has no Scenario or references unknown steps/assertions | Reject publication with a validation error |
| Published version already exists | Keep it immutable and publish later edits under the next integer version |
| Deleted Script or version is unknown | `BUSINESS_SCRIPT_VERSION_UNKNOWN` with HTTP 404; preserve state |
| Deleted version is referenced by Suites | Remove matching Scenario references; delete Suites that become empty; return the cleanup counts |
| Latest published version was deleted and the draft is published again | Allocate `versionCounters[scriptId] + 1`; never reuse a deleted version number |
| Suite references a missing version/Scenario or unsupported platform | Reject the replay plan before device execution |
| Provider start, stop, or replay exits unsuccessfully | Persist the recording/replay failure and bounded provider output |

### 5. Good / Base / Bad Cases

- Good: one Harmony recording produces a draft with semantic targets and screenshots/hierarchy references; the operator converts the input-field tap to a literal `牙膏` step before publishing two Scenarios.
- Good: a Suite expands two versioned Scenario references in declaration order and reports one result for each Scenario.
- Good: deleting `checkout@2` preserves `checkout@1`, `checkout@3`, and the editable draft while removing only Suite entries that reference `checkout@2`.
- Good: deleting version 3 and publishing again creates version 4 because the persisted counter remains at 3.
- Base: one Scenario replays one feature and records its Script ID, version, Scenario ID, case run, and evidence.
- Bad: publishing a `secretRef` or `runtimeResolver` input whose variable declaration is missing or uses another strategy.
- Bad: mutating a published version after a historical run references it.
- Bad: deriving the next version only from currently stored versions, which reuses a deleted latest version number.
- Bad: leaving Suite references that point to a deleted Script version.

### 6. Tests Required

- Parse JSON-line `record.csv` data with optional `windowBounds` and diagnostic lines; cover tap, swipe, back, key input redaction, semantic targets, raw points, and review states.
- Convert a recorded tap to input in the browser; assert it receives an empty literal binding, accepts a manually entered value, synchronizes `secretRef` and `runtimeResolver` declarations, and persists the edited draft.
- Verify one active recording per device, draft persistence, Scenario reference validation, immutable version increments, Suite expansion, platform validation, and provider failures.
- Delete one published version and assert the draft and sibling versions remain, matching Suite references are removed, empty Suites are deleted, and a repeated delete returns `BUSINESS_SCRIPT_VERSION_UNKNOWN`.
- Delete the highest version, publish again, and assert the new version increments the persisted high-water mark.
- Render the published-version confirmation dialog, cancel without mutation, confirm with a bodyless `DELETE`, clear matching browser selections, and refresh the published list.
- Render all stored versions of the same Script in descending version order while keeping the Suite picker on the latest version.
- Complete one Harmony physical-device start, manual action, stop, CSV-read, draft-generation cycle.
- Assert recording start waits for `Started Recording Successfully` before persisting the active session.
- Run `pnpm check` in Mobile Test Console.

### 7. Wrong vs Correct

#### Wrong

```ts
draft.steps.push({ type: "input", value: rawRecordedText });
published.versions[version] = editedDraft;
```

#### Correct

```ts
draft.steps.push({ type: "input", inputBinding: { strategy: "literal", value: "测试关键词" } });
published.versions[nextVersion] = structuredClone(validatedDraft);
```

#### Wrong

```ts
const nextVersion = Math.max(0, ...currentVersions) + 1;
state.scripts.splice(versionIndex, 1);
```

#### Correct

```ts
state.versionCounters[scriptId] = Math.max(
  state.versionCounters[scriptId] ?? 0,
  deletedVersion,
);
state.scripts.splice(versionIndex, 1);
removeSuiteReferences(state, scriptId, version);
```

## Scenario: Platform-neutral Result Bundle ingestion

### 1. Scope / Trigger

- Trigger: an App or mini-program project exports completed test evidence for platform-owned storage and analysis.
- Applies to `test-analysis.run.v1`, HTTP push, local file import, idempotency, Fanli legacy-result conversion, artifact URI normalization, and compatibility with the existing task result API.

### 2. Signatures

HTTP API:

```text
GET  /api/result-bundles
GET  /api/result-bundles/:runId
POST /api/result-bundles
```

Local file import:

```bash
mobile-test-console-result --config <project-config> --file <result-bundle.json>
pnpm result:import -- --config <project-config> --file <result-bundle.json>
```

Fanli compatibility export:

```bash
node packages/lynx/scripts/qa/qa-mobile-test-console.cjs bundle \
  --run-id <run-id> \
  --environment <environment> \
  --source-revision <revision>
```

### 3. Contracts

- `test-analysis.run.v1` is the platform-neutral ingestion contract. It contains `project`, `target`, `run`, `cases`, `artifacts`, `warnings`, `provenance`, and optional metadata.
- `target.kind` is `app` or `mini-program`; `target.platform` and `target.runtime` remain open strings so new runtimes can integrate without changing the platform core enum.
- `run.runId` uses `^[A-Za-z0-9._-]+$` and is the ingestion idempotency key within one configured project state directory.
- Each case carries stable `caseRunId`, status, steps, assertions, evidence references, API calls, and bounded failure context. Each evidence reference resolves to an artifact ID declared in the same bundle.
- Artifacts use a URI plus optional `sha256`, MIME type, size, label, and role. Fanli converts workspace paths to `project://fanli/...`; absolute project paths stay inside the Fanli adapter.
- Ingested bundles persist atomically under `<stateDir>/result-bundles/<runId>.json` with mode `0600`.
- Re-ingesting the same canonical content returns `duplicate`. Reusing a run ID with different canonical content returns `RESULT_BUNDLE_CONFLICT`.
- Concurrent ingestion for one run ID serializes writes and returns one `created` response plus duplicate responses for equivalent followers.
- The existing `mobile-test-console.task-result.v1` provider, `/api/tasks/:taskId/result`, task state, task cleanup, and current browser result view remain available during migration.
- Fanli `bundle` reads the same QA summaries as the legacy result provider, converts screenshots, recordings, evidence, assertions, API calls, and failure context, and leaves the source artifacts unchanged.
- Shared Result Bundle contracts stay independent of Node-only storage and hashing APIs. Canonical hashing and filesystem persistence belong to the server layer.

### 4. Validation & Error Matrix

| Condition | Error code or behavior |
| --- | --- |
| Schema version, target kind, project ID, run ID, or required field is invalid | `RESULT_BUNDLE_INVALID` with HTTP 400 |
| Local import file is unreadable or contains invalid JSON | `RESULT_BUNDLE_FILE_INVALID` |
| Run ID contains path separators or traversal tokens | `RESULT_BUNDLE_RUN_ID_INVALID` with HTTP 400 |
| Same run ID and canonical content already exist | Return `status=duplicate` with the existing fingerprint and summary |
| Same run ID and different canonical content already exist | `RESULT_BUNDLE_CONFLICT` with HTTP 409; preserve the original bundle |
| Stored bundle JSON or schema is invalid | `RESULT_BUNDLE_STATE_INVALID` with HTTP 500 |
| Queried run ID has no ingested bundle | `RESULT_BUNDLE_UNKNOWN` with HTTP 404 |
| Fanli has no matching QA summaries | Export a valid bundle with `run.status=unknown`, zero cases, and the legacy warning |

### 5. Good / Base / Bad Cases

- Good: Fanli exports one App bundle whose artifact URIs contain project-relative paths and whose metadata records the legacy schema version.
- Good: a WeChat mini-program fixture uses `target.kind=mini-program`, `platform=wechat`, and the same case/assertion/artifact model as App results.
- Good: two concurrent identical pushes create one state file and return one `created` plus one `duplicate` result.
- Base: an offline tool imports one local JSON file through `mobile-test-console-result` and later reads it through the HTTP list/detail APIs.
- Bad: platform core source contains `huigou://lynx`, Fanli page IDs, or vendor login module names.
- Bad: a project adapter sends absolute workstation paths through the Result Bundle HTTP response.
- Bad: a retry overwrites an existing run ID with different content.

### 6. Tests Required

- Parse valid App and mini-program bundles; reject old schemas and malformed IDs.
- Ingest, list, and retrieve a bundle; verify the persisted state path and summary counts.
- Re-ingest identical content sequentially and concurrently; assert one create, duplicate followers, and one file.
- Reuse a run ID with modified status; assert `RESULT_BUNDLE_CONFLICT` and unchanged stored content.
- Inject the HTTP push/list/detail routes; verify created, missing, invalid, and conflict responses.
- Convert a Fanli QA summary with screenshots and evidence; assert the legacy schema metadata and the absence of absolute project paths.
- Run `pnpm check` in Mobile Test Console and the Fanli `qa-mobile-test-console` Node tests.

### 7. Wrong vs Correct

#### Wrong

```ts
await fs.writeFile(`${stateDir}/${bundle.run.runId}.json`, JSON.stringify(bundle));
```

#### Correct

```ts
const parsed = parseResultBundle(input);
const fingerprint = fingerprintCanonicalContent(parsed);
await resultBundleStore.ingest(parsed, fingerprint);
```

#### Wrong

```js
artifact.uri = screenshot.absolutePath;
```

#### Correct

```js
artifact.uri = projectArtifactUri(screenshot.absolutePath);
```

## Scenario: Project adapter manifest boundary

### 1. Scope / Trigger

- Trigger: Mobile Test Console needs project-specific routing, runtime-event, account-provider, result-diagnosis, or repair-task semantics.
- The project repository owns these values through `mobile-test-console.config.v1.adapter`; platform services and React workspaces consume the parsed manifest.
- `loadProjectConfig()` resolves omitted adapters to `EMPTY_PROJECT_ADAPTER`; project semantics therefore stay opt-in through an explicit manifest.
- The v1 compatibility entry remains available when `compatibility.v1ProjectAdapterDefaults=true`; the loader imports `src/compat/v1-project-adapter.ts` on that branch and receives the platform-neutral empty manifest.
- Server, shared, and browser runtime code uses `EMPTY_PROJECT_ADAPTER` as the safe default for internal objects that bypass configuration loading.

### 2. Signatures

```js
compatibility: {
  v1ProjectAdapterDefaults?: boolean, // default false
},

adapter: {
  workspaces: Array<"page-parameters" | "business-scripts" | "account-profiles">,
  pageParameters: {
    defaultRoute: string,
    templateParameter: string,
    pageReadyEvent: string,
    actionSucceededEvent: string,
  },
  resultAnalysis: { pageOpenedEvents: string[] },
  accountProfiles: {
    providers: {
      [providerId]: {
        label: string,
        recordingLabel: string,
        defaultProfileId: string,
        defaultAccountLabel: string,
        requiredCapability: string,
        crossPlatformCapability?: string,
        devicePlatforms?: ("android" | "ios" | "harmony")[],
        deviceTextIncludes?: string[],
        requiredCaptureKinds?: ("native" | "graphql")[],
        requiredResultFields?: string[],
        capabilityRules?: Array<{ module?: string, methods?: string[], capability: string }>,
      },
    },
  },
  repair: {
    displayName: string,
    threadNamePrefix: string,
    fixingMessage: string,
  },
}
```

Compatibility and runtime signatures:

```ts
resolveV1ProjectAdapter(
  adapter: ProjectAdapterManifest | undefined,
): ProjectAdapterManifest;

resolveProjectAdapter(
  config: Pick<LoadedProjectConfig, "adapter">,
): ProjectAdapterManifest;
```

Public propagation:

```text
mobile-test.config.cjs
  -> configSchema
  -> explicit adapter or EMPTY_PROJECT_ADAPTER
  -> LoadedProjectConfig.adapter (complete manifest)
  -> GET /api/snapshot.adapter
  -> result diagnosis and page-parameter workspace

mobile-test.config.cjs compatibility.v1ProjectAdapterDefaults=true
  -> dynamic import of src/compat/v1-project-adapter.ts
  -> V1_PROJECT_ADAPTER_DEFAULTS only when adapter is omitted

mobile-test.config.cjs
  -> AccountProfileService
  -> GET /api/account-profiles.providers
  -> account-profile workspace and task profile selection
```

### 3. Contracts

- `src/server`, `src/shared`, and `src/web` contain platform-neutral adapter field names and matching logic. Project route strings, runtime event names, provider modules, and repair labels live in each project's `mobile-test.config.cjs` or adapter plugin.
- Raw v1 configuration with an omitted `adapter` receives `EMPTY_PROJECT_ADAPTER`, keeping the platform default free of project workspaces, routes, events, account providers, and repair labels.
- `compatibility.v1ProjectAdapterDefaults` defaults to `false`. Setting it to `true` selects the platform-neutral v1 compatibility shape for legacy configs; it does not restore any project's route, account, or repair semantics.
- An explicit `adapter` has priority over the compatibility switch. Existing projects declare their complete manifest in their own config and therefore follow the platform-neutral load path.
- An explicit `adapter: {}` is a project declaration and resolves to platform-neutral schema defaults: no project workspaces, empty route/template/event values, no page-open events, no account providers, and generic repair labels.
- `EMPTY_PROJECT_ADAPTER` is the runtime fallback for manually constructed or partially mocked internal config objects. It has the same platform-neutral shape as an explicit empty adapter and contains no compatibility values.
- Runtime services, shared contracts, and React components must not import `V1_PROJECT_ADAPTER_DEFAULTS`. The compatibility module is dynamically imported by the enabled rollback branch and consumed directly by compatibility-focused tests.
- `adapter.workspaces` is the project UI registration boundary. The platform always exposes test execution and result analysis; project tools are rendered only when their IDs are declared. Valid IDs are `page-parameters`, `business-scripts`, and `account-profiles`, with duplicate IDs rejected during config loading.
- Page profile saving adds `pageReadyEvent` once and builds fallback navigation from `defaultRoute` plus `templateParameter`. Catalog or request navigation remains higher priority.
- Result diagnosis treats any configured `pageOpenedEvents` member as page-open evidence. Expected/actual page mismatch remains a second independent failure signal.
- Account recording completeness requires every configured capture kind and result field. Capability rules match optional module plus method sets and add the declared capability.
- Device compatibility succeeds when the target platform appears in `devicePlatforms` or the device text contains one configured `deviceTextIncludes` value. Empty matcher lists allow every device.
- Account provider IDs and labels come from `GET /api/account-profiles.providers`. The browser initializes from the first returned provider, and an empty provider map renders a disabled selector and disables recording start.
- Repair App Server logs, thread names, and fixing status use the `repair` manifest.
- Explicit project adapters own their complete account-provider definition set. Provider lookup returns `undefined` for IDs absent from that set.

### 4. Validation & Error Matrix

| Condition | Result |
| --- | --- |
| Adapter field has an invalid type, empty required label, or unknown platform | `CONFIG_INVALID` during config load |
| Config omits `adapter` and the compatibility switch | `loadProjectConfig()` returns `EMPTY_PROJECT_ADAPTER` |
| Config enables `v1ProjectAdapterDefaults` and omits `adapter` | `loadProjectConfig()` dynamically loads `V1_PROJECT_ADAPTER_DEFAULTS` |
| Config enables `v1ProjectAdapterDefaults` and declares `adapter` | The explicit adapter wins |
| Project declares `adapter: {}` | Config loading returns the complete platform-neutral adapter shape |
| Internal config object bypasses `loadProjectConfig()` and omits `adapter` | `resolveProjectAdapter()` returns `EMPTY_PROJECT_ADAPTER` |
| Explicit adapter omits a provider later selected by the API | Recording fails completeness/capability checks with the existing account-profile error contract |
| Account provider map is empty | Browser shows `项目未配置授权场景`, keeps the selector disabled, and prevents recording start |
| Required capture kind or result field is absent | Recording becomes `failed`; no profile entry is generated |
| Device fails every configured platform/text matcher | `ACCOUNT_PROFILE_DEVICE_MISMATCH` with HTTP 409 |
| Required replay capability is absent | `ACCOUNT_PROFILE_CAPABILITY_MISMATCH` with HTTP 409 |
| Page adapter has an empty default route | Persist navigation only when the provider or request supplies it |
| Explicit adapter contains an unknown or duplicate workspace ID | `CONFIG_INVALID` during config load |

### 5. Good / Base / Bad Cases

- Good: a project declares its route, runtime events, provider capability rules, and repair labels in its own `mobile-test.config.cjs`.
- Good: the demo config declares generic route and event names and an empty account provider set.
- Good: an existing project declares its complete adapter and loads with the compatibility switch at its default `false` value.
- Good: a historical v1 config enables `v1ProjectAdapterDefaults`, omits `adapter`, and receives the platform-neutral compatibility manifest once.
- Base: a generic config omits `adapter` and receives `EMPTY_PROJECT_ADAPTER`.
- Base: a unit test constructs `{ adapter: undefined }` directly and receives `EMPTY_PROJECT_ADAPTER` from the runtime resolver.
- Base: a page catalog supplies complete navigation, so the platform stores it directly and leaves adapter fallback unused.
- Bad: `src/server/page-parameters.ts` inserts a project route or event literal.
- Bad: `src/server/account-profiles.ts` branches on one provider ID or native module name.
- Bad: the browser duplicates provider labels or device-vendor rules in component constants.
- Bad: a runtime service imports `V1_PROJECT_ADAPTER_DEFAULTS` and silently restores project behavior for an incomplete internal object.

### 6. Tests Required

- Parse a generic adapter manifest and assert defaulted matcher arrays plus declared route/event values.
- Load a generic config without `adapter` and assert `loadProjectConfig()` returns `EMPTY_PROJECT_ADAPTER` plus `v1ProjectAdapterDefaults=false`.
- Enable `v1ProjectAdapterDefaults` without an adapter and assert the loader returns `V1_PROJECT_ADAPTER_DEFAULTS`.
- Enable `v1ProjectAdapterDefaults` with an explicit adapter and assert the explicit provider set wins.
- Load a config with `adapter: {}` and assert empty workspaces, route/template/events, page-open events, and account providers plus generic repair labels.
- Call runtime adapter helpers with an internal config that omits `adapter`; assert `EMPTY_PROJECT_ADAPTER` and an undefined compatibility provider.
- Parse workspace registrations, reject unknown/duplicate IDs, and assert v1 defaults remain platform-neutral.
- Assert a custom account capture rule adds its capability, required fields determine completeness, and platform/text device matching behaves consistently.
- Run account profile, page parameter, result analysis, and repair job tests with explicit project-owned fixtures.
- Render the account-profile workspace with an empty provider map; assert the selector and recording action stay disabled.
- Load a project's `mobile-test.config.cjs` through `loadProjectConfig` and assert all declared provider entries survive validation.
- Search `src/server`, `src/shared`, and `src/web` outside `src/compat` for Fanli route, Lynx event, native module, provider ID, and repair label literals; expect zero matches.
- Run `pnpm check` in Mobile Test Console and the Fanli Mobile Test Console adapter tests.

### 7. Wrong vs Correct

#### Wrong

```ts
export function resolveProjectAdapter(config: LoadedProjectConfig) {
  return config.adapter ?? V1_PROJECT_ADAPTER_DEFAULTS;
}
```

#### Correct

```ts
if (parsedConfig.adapter) return structuredClone(parsedConfig.adapter);
if (!parsedConfig.compatibility.v1ProjectAdapterDefaults) {
  return structuredClone(EMPTY_PROJECT_ADAPTER);
}

const { resolveV1ProjectAdapter } = await import("../compat/v1-project-adapter.js");
return resolveV1ProjectAdapter(undefined);

// 运行时内部对象使用平台中立默认值。
export function resolveProjectAdapter(config: Pick<LoadedProjectConfig, "adapter">) {
  return config.adapter ?? EMPTY_PROJECT_ADAPTER;
}
```

#### Wrong

```ts
if (recording.provider === "project-commerce") {
  capabilities.add("project-oauth");
}
```

#### Correct

```ts
const definition = resolveAccountProfileProviderAdapter(config, recording.provider);
const capabilities = accountProfileCapabilities(definition, recording.captures);
```

#### Wrong

```tsx
setAssertions([{ type: "runtimeEvent", event: "project_page_ready" }]);
```

#### Correct

```tsx
setAssertions(defaultAssertions(adapter.pageReadyEvent));
```

#### Wrong

```tsx
<button onClick={() => setWorkspaceView("accounts")}>账号画像</button>
```

#### Correct

```tsx
{resolveWorkspaceViews(snapshot.adapter?.workspaces).map(view => (
  <WorkspaceTab key={view} view={view} />
))}
```

## Scenario: Runner SDK and connector boundary

### 1. Scope / Trigger

- Trigger: execution responsibilities are moving from the console task process into reusable App and mini-program runners.
- The platform owns scheduling, task state, persistence, Result Bundle ingestion, and analysis. A runner owns one run's command lifecycle and event stream. A connector owns device/runtime protocol capabilities.
- `mobile-test-console.config.v1` remains supported through `LegacyTaskRunner` and `LegacyTaskRunnerConnector`.

### 2. Signatures

```ts
interface InProcessRunner {
  readonly id: string;
  run(plan: RunPlan, context: RunnerContext): Promise<RunnerResult>;
  cancel?(runId: string): Promise<void> | void;
  shutdown?(): Promise<void> | void;
}

interface RunnerResolver {
  resolve(plan: RunPlan): InProcessRunner;
}

interface RunnerPlugin {
  apiVersion: "mobile-test-console.runner-plugin.v1";
  createRunners(context: RunnerPluginContext): InProcessRunner[] | Promise<InProcessRunner[]>;
}

interface RunnerPluginContext {
  configPath: string;
  project: Readonly<{ id: string; name: string; root: string }>;
  stateDir: string;
  options: Readonly<Record<string, unknown>>;
  services: Readonly<RunnerPluginServices>;
}

interface RunnerPluginServices {
  createCommandRunner(id: string): InProcessRunner;
}

class InProcessRunnerRegistry implements RunnerResolver {
  constructor(defaultRunnerId?: string);
  register(runner: InProcessRunner): void;
  unregister(runnerId: string): boolean;
  get(runnerId: string): InProcessRunner | undefined;
  list(): InProcessRunner[];
  resolve(plan: RunPlan): InProcessRunner;
}

interface RunPlan {
  runnerId?: string;
}

// mobile-test-console.config.v1
runnerPlugins?: Array<{
  module: string;
  options?: Record<string, unknown>;
}>;

tests: Array<{
  runnerId?: string; // default: legacy-command-runner
  commands?: PlatformCommandMap; // required only by legacy-command-runner
}>;

interface CommandRunner {
  capture(
    executable: string,
    args: string[],
    timeoutMs?: number,
    options?: { cwd?: string; env?: Record<string, string> },
  ): Promise<{ code: number; stdout: string; stderr: string }>;
}

interface DeviceConnector {
  readonly id: string;
  readonly manifest: ConnectorCapabilityManifest;
  discover(signal?: AbortSignal): Promise<ConnectorDevice[]>;
  start?(device: ConnectorDevice, signal?: AbortSignal): Promise<ConnectorDevice>;
  prepare?(
    device: ConnectorDevice,
    request: { action: "check" } | { action: "install"; preparationId: string },
    signal?: AbortSignal,
  ): Promise<ConnectorDevice>;
}

interface ConnectorSelection {
  platform?: string;
  runtime?: string;
  deviceType?: DeviceType;
  targetKind?: TargetKind;
  requiredCapabilities?: string[];
}

interface InProcessConnectorRegistry {
  register(connector: DeviceConnector): void;
  select(selection?: ConnectorSelection): DeviceConnector | undefined;
  manifests(): ConnectorCapabilityManifest[];
}

interface DeviceDiscoveryOptions {
  connectorRegistry?: InProcessConnectorRegistry;
  cacheMaxAgeMs?: number;
  now?: () => number;
}

interface ConnectorCapabilityManifest {
  schemaVersion: "mobile-test-console.capabilities.v1";
  connectorId: string;
  scope: { platform: string; deviceType?: DeviceType[]; targetKinds?: TargetKind[]; runtime?: string[] };
  capabilities: Array<{ id: string; version: number; limits?: Record<string, number | string | boolean> }>;
}

new TaskManager(
  config: LoadedProjectConfig,
  store: StateStore,
  runner?: InProcessRunner,
  runnerResolver?: RunnerResolver,
)

createRunnerRuntime(
  config: Pick<LoadedProjectConfig, "tests">,
  additionalRunners?: InProcessRunner[],
): {
  compatibilityRunner: LegacyTaskRunner;
  resolver: InProcessRunnerRegistry;
}

loadRunnerRuntime(
  config: LoadedProjectConfig,
  additionalRunners?: InProcessRunner[],
): Promise<RunnerRuntime>
```

### 3. Contracts

- `RunPlan` carries `runId`, project/test IDs, a device snapshot, an optional App or mini-program `TestTarget`, the legacy command, and required capability IDs.
- `RunnerEvent` carries the run ID, timestamp, event type (`status`, `log`, `capability`, `artifact`, `result`, `error`, `cancelled`), source, and optional structured data.
- App manifests declare install/launch and evidence capabilities for Android, iOS, and HarmonyOS. Mini-program manifests declare `targetKinds=["mini-program"]` and attach/launch/reload capabilities; a mini-program target must include a non-empty `appId`.
- Sidecar implementations use `mobile-test-console.sidecar.v1` handshake messages and reuse the same manifest and runner event types.
- `test.runnerId` uses lowercase kebab-case and defaults to `legacy-command-runner`. The parsed value is exposed in `PublicTestDefinition`, frozen into `TestTask`, and copied to `RunPlan` so execution, persistence, and diagnostics share one selection key.
- `InProcessRunnerRegistry` validates runner IDs and duplicate registration, then resolves the exact `RunPlan.runnerId`. Plans created from older state or internal fixtures may omit the field and use the registry default.
- `createRunnerRuntime()` always registers one `LegacyTaskRunner`, accepts additional in-process runners for SDK embedding, and validates every configured test reference before the CLI starts project lifecycle or HTTP services. Missing registrations fail startup as `CONFIG_INVALID`.
- `loadRunnerRuntime()` resolves every `runnerPlugins[].module` from the project configuration file location, loads CJS or ESM, validates `mobile-test-console.runner-plugin.v1`, calls `createRunners()` with project context and plugin options, and then delegates registration to `createRunnerRuntime()`.
- Relative plugin paths resolve from the configuration directory. Package specifiers resolve through the App project's dependency graph. The project configuration and runner plugins share one trusted local-code boundary.
- Plugin context exposes frozen top-level project metadata and options. Plugins own interpretation of their options and return runner instances with lowercase kebab-case IDs and a callable `run()` method.
- Plugin context exposes `services.createCommandRunner(id)`, which returns the platform command runner with stdout/stderr, exit-code, cancellation, and shutdown semantics. Project plugins own Runner IDs and registration while the platform owns the reusable process lifecycle.
- Only `legacy-command-runner` requires a platform/default command. A custom runner may omit `commands`; its `RunPlan.command` stays absent so the plugin receives a platform-neutral plan.
- `mobile-test-console/runner` is the public ESM and TypeScript declaration entry for plugin contracts, helpers, Runner SDK, and connector contracts.
- Fanli assigns `fanli-lynx-app-runner` to `lynx-page-tests` and `lynx-flow-tests`; `platform-oneclick` uses `fanli-platform-oneclick-runner`. The project plugins preserve stdout/stderr, exit code, cancellation, and Result Bundle collection.
- `MTC_LYNX_APP_RUNNER=0` removes Fanli Provider/Runner registration and maps all three test entries to `legacy-command-runner` as the rollback path.
- `TaskManager` builds the complete `RunPlan` before calling `RunnerResolver.resolve(plan)`. The resolver may select a runner from the test, target, device, runtime, or required capabilities without moving queue, task-state, persistence, or result mapping into the runner.
- While a task is running, `TaskManager` retains its selected runner under the task ID. `stop(taskId)` aborts that task's signal and calls `cancel(runId)` on the same runner instance.
- `shutdown()` stops active tasks, waits for their runner calls to settle, and invokes `shutdown()` once per selected runner instance. The identity-based set also covers one shared runner selected for multiple tasks.
- The third `TaskManager` constructor argument remains the single-runner compatibility injection. When the fourth argument is absent, an internal resolver always returns that runner; the default value is `LegacyTaskRunner`. When an explicit resolver is present, an unused third-argument fallback is outside the managed runner lifecycle.
- A registered connector's `id` must equal `manifest.connectorId`; the registry validates the manifest before accepting it. `LegacyTaskRunnerConnector` normalizes the manifest ID to its adapter ID before validation.
- `DeviceDiscoveryService` creates an App connector registry for the configured Android, iOS, and HarmonyOS platforms unless a registry is injected through `DeviceDiscoveryOptions.connectorRegistry`.
- Discovery selects a connector by `targetKind="app"` and `device.discover`, then returns devices carrying `connectorId` and the manifest capability IDs. `GET /api/snapshot` exposes the selected registry manifests in `connectors`.
- `src/runner/app-device-connectors.ts` owns adb/xcrun/xcodebuild/devicectl/hdc commands, vendor output parsers, manufacturer lookup, iOS destination classification, and simulator boot/open/bootstatus. It depends only on runner/shared ports.
- `src/compat/v1-device-connectors.ts` composes the generic App Connector registry with the v1 project preparation lifecycle. `src/server/devices.ts` owns cache, ordering, concurrency, device-state validation, and Connector selection; it contains no vendor command or output parser.
- `CommandRunner` and `CommandResult` belong to the Runner SDK. `SystemCommandRunner` is the Node `execFile` adapter and re-exports those types for compatibility.
- The v1 project adapter wraps device preparation commands behind the selected Connector `prepare` port. The connector owns preparation checks, installation, and post-install rechecks; the service retains fresh device validation, per-device/preparation concurrency control, response validation, and discovery-cache invalidation.
- iOS simulator boot/open/bootstatus execute through the selected Connector `start` port; the service retains device-state validation, per-device concurrency control, and discovery-cache invalidation.

### 4. Validation & Error Matrix

| Condition | Result |
| --- | --- |
| Manifest schema is unknown | Reject registration with a capability protocol incompatibility error |
| Connector ID is not lowercase kebab-case | Reject registration with an invalid connector ID error |
| Manifest contains duplicate or non-positive-version capabilities | Reject registration with an invalid capability error |
| Required platform, target kind, runtime, device type, or capability does not match | Connector selection returns no match; scheduler reports a precondition failure |
| Configured platform has no App connector with `device.discover` | Device discovery records an error for that platform and keeps other platform results |
| A custom registry is injected for tests or a project | Discovery uses the injected registry and does not execute the default platform command provider |
| Selected connector lacks `device.start` or a `start()` implementation | `DEVICE_START_UNAVAILABLE` with HTTP 409 |
| Connector start command fails | `DEVICE_START_FAILED` with HTTP 500; the discovery cache remains available for retry |
| Selected connector lacks `device.prepare` or a `prepare()` implementation | `DEVICE_PREPARATION_UNAVAILABLE` with HTTP 409 for install requests; discovery keeps the base device snapshot |
| v1 preparation ID is unknown for the device platform | `DEVICE_PREPARATION_UNKNOWN` with HTTP 404 |
| v1 preparation install command fails or its post-install check stays unready | `DEVICE_PREPARATION_FAILED` with HTTP 500; the discovery cache remains available for retry |
| Mini-program target has an empty `appId` | Reject target before attach/launch |
| Configured `runnerId` is not lowercase kebab-case | `CONFIG_INVALID` during config load |
| A configured test references a runner absent from the CLI registry | `CONFIG_INVALID` before lifecycle startup and HTTP listen |
| A runner plugin module cannot be resolved or imported | `CONFIG_LOAD_FAILED` before lifecycle startup |
| A runner plugin protocol/export/factory result is invalid | `CONFIG_INVALID` before lifecycle startup |
| Two plugins return the same runner ID or try to replace the legacy runner | `CONFIG_INVALID` with the duplicate registration detail |
| A `legacy-command-runner` test omits all commands | `CONFIG_INVALID` during config load |
| A custom-runner test omits commands | Accept the config and deliver a `RunPlan` without `command` |
| `MTC_LYNX_APP_RUNNER=0` | Fanli skips the Lynx App plugins and resolves page, flow, and One-click entries through `legacy-command-runner` |
| An embedded SDK plan references an unregistered runner | `InProcessRunnerRegistry.resolve()` throws `Runner 未注册: <id>` |
| A plan omits `runnerId` and the registry has a default | Resolve the default runner; CLI uses `legacy-command-runner` |
| Legacy command is missing from a legacy run plan | Return a failed `RunnerResult` and emit an `error` event |
| Runner signal is aborted or connector `cancel()` is called | Terminate the child process tree, emit `cancelled`, and return `status=cancelled` |
| `RunnerResolver.resolve(plan)` throws | Finalize that task as failed with `exitCode=null` and persist the resolver error; other tasks keep their own runner lifecycle |
| A selected runner returns `status=failed` | Map its `exitCode` and `error` to the task result and finalize the task as failed |

### 5. Good / Base / Bad Cases

- Good: select an iOS connector for an App target only when its manifest includes the requested runtime and evidence capabilities.
- Good: the default device service registers only configured App connectors, selects them by capability, and exposes their manifests in the snapshot.
- Good: App Connector behavior tests import vendor parsers from `src/runner/app-device-connectors.ts`, while service tests import cache and ordering behavior from `src/server/devices.ts`.
- Good: iOS simulator start validation stays in `DeviceDiscoveryService`, while boot/open/bootstatus command details stay inside the iOS Connector lifecycle implementation.
- Good: the v1 adapter resolves project preparation commands, while `DeviceDiscoveryService` calls only the Connector `prepare` port and validates the returned preparation snapshot.
- Good: route a mini-program attach flow through a connector that advertises `target.mini-program.attach` and preserves the target `appId`.
- Good: resolve two concurrent tasks to different runner instances and send each stop request only to the runner selected for that task.
- Good: resolve multiple tasks to one shared runner and call its `shutdown()` exactly once.
- Good: Fanli's default config resolves page and flow entries through `fanli-lynx-app-runner` and One-click through `fanli-platform-oneclick-runner` before project preparation.
- Good: an embedded project registers `custom-runner`, selects it on one test, and leaves other tests on the legacy default.
- Good: an App project loads `./qa/mobile-runner.mjs`, passes project-specific options, and runs a command-free test through `project-runner`.
- Good: a published project runner imports `defineRunnerPlugin` and SDK types from `mobile-test-console/runner`.
- Good: Fanli's `mtc-lynx-runner-plugin.cjs` uses `services.createCommandRunner("fanli-lynx-app-runner")`, so Lynx test semantics stay in Fanli and process control stays in MTC.
- Good: the Fanli observation window runs page, flow, and One-click entries with project Runners while the environment switch keeps a complete legacy rollback.
- Base: run a Fanli command through `LegacyTaskRunner`; existing logs and task result provider behavior remain unchanged.
- Bad: put adb/xcrun/hdc command parsing or Fanli page IDs into the platform scheduler.
- Bad: resolve or execute project preparation commands directly inside `DeviceDiscoveryService`.
- Bad: call a platform discovery command directly from `DeviceDiscoveryService.performDiscovery()` without selecting a registered connector.
- Bad: treat an online device as a runnable mini-program target without checking attach/runtime capabilities.

### 6. Tests Required

- Validate App manifests for each platform and reject invalid IDs/schema/capability versions.
- Select connectors by platform, target kind, device type, runtime, and required capabilities; assert unsupported selections return no connector.
- Inject a registry into `DeviceDiscoveryService`, assert discovery uses only the injected connector, and assert `connectorManifests()` returns its validated manifest.
- Assert Android/iOS/Harmony parser and command behavior through the App Connector owner module; audit that `src/server/devices.ts` contains no adb/xcrun/xcodebuild/devicectl/hdc execution.
- Assert the Runner SDK `CommandRunner` port remains structurally compatible with `SystemCommandRunner` and project command test doubles.
- Assert the default HTTP snapshot exposes App connector manifests and discovered device connector capabilities.
- Inject an iOS Connector with `start()`, assert the service preserves startability and concurrency validation, and assert the Connector receives the start operation.
- Assert a Connector without `device.start` returns `DEVICE_START_UNAVAILABLE` before any command executes.
- Inject a Connector with `prepare()`, assert discovery sends `action="check"`, installation sends `action="install"` with the selected ID, and the returned preparation is ready.
- Assert the v1 preparation adapter preserves command templates, install/check ordering, `DEVICE_PREPARATION_*` errors, per-device/preparation concurrency, and discovery-cache invalidation.
- Validate a mini-program target's `appId` and attach/launch/reload manifest requirements.
- Parse omitted and explicit `test.runnerId` values; assert the default is `legacy-command-runner` and invalid IDs produce `CONFIG_INVALID`.
- Register legacy and custom runners, assert default and explicit resolution, and reject invalid IDs, duplicate registration, and unknown plan references.
- Build the CLI runner runtime from Fanli config and assert both test IDs resolve to `legacy-command-runner`; assert an unavailable configured runner fails before startup.
- Load relative CJS and ESM runner plugins, assert context/options propagation, and reject missing modules, incompatible protocol versions, invalid factory results, malformed runners, and duplicate IDs.
- Assert `services.createCommandRunner()` creates a named runner with the same command, log, cancellation, and shutdown behavior as the legacy facade.
- Load Fanli config with and without `MTC_LYNX_APP_RUNNER=0`; assert plugin list, test Runner IDs, and runtime Registry entries match the selected mode.
- Parse a custom-runner test without commands and assert its selected runner receives a `RunPlan` whose `command` is absent; continue rejecting a command-free legacy test.
- Build the public runner entry and assert its JavaScript and declaration outputs are included in the package export map.
- Assert `runnerId` propagates through public tests, persisted tasks, and the exact `RunPlan` received by the resolver.
- Execute a legacy command and assert stdout/stderr events, exit status, and process-tree cancellation.
- Inject a `RunnerResolver`, assert it receives the exact `RunPlan` passed to the selected runner, and assert stdout/stderr events plus failed `RunnerResult` fields map to the task.
- Run concurrent tasks through different runners, stop one task, and assert only its selected runner receives that task's `runId`.
- Resolve multiple tasks to a shared runner and assert shutdown runs once; also assert an unused fallback runner supplied with an explicit resolver is not shut down.
- Construct `TaskManager` with only the third runner argument and assert the compatibility path still routes every plan to that runner.
- Validate sidecar handshake protocol version and missing manifest/connector errors.

### 7. Wrong vs Correct

#### Wrong

```ts
if (device.platform === "android") return runAdbCommand(device.id);
```

#### Correct

```ts
const connector = registry.select({
  platform: target.platform,
  targetKind: target.kind,
  runtime: target.runtime,
  requiredCapabilities: plan.requiredCapabilities,
});
if (!connector) throw new Error("没有满足目标能力的连接器");
```

#### Wrong

```ts
if (platform === "android") return discoverAndroid(runner);
```

#### Correct

```ts
const connector = registry.select({
  platform,
  targetKind: "app",
  requiredCapabilities: ["device.discover"],
});
if (!connector) throw new Error(`未找到 ${platform} App 设备连接器`);
return connector.discover();
```

#### Wrong

```ts
await runner.capture("xcrun", ["simctl", "boot", device.id]);
```

#### Correct

```ts
const connector = registry.get(device.connectorId);
if (!connector?.start) throw new ConsoleError("DEVICE_START_UNAVAILABLE", "连接器未提供启动能力", 409);
return connector.start(device);
```

#### Wrong

```ts
const command = resolveDevicePreparationCommand(config, definition, "install", device);
return runner.capture(command.executable, command.args);
```

#### Correct

```ts
const connector = registry.get(device.connectorId);
if (!connector?.prepare) {
  throw new ConsoleError("DEVICE_PREPARATION_UNAVAILABLE", "连接器未提供准备能力", 409);
}
return connector.prepare(device, { action: "install", preparationId });
```

#### Wrong

```ts
await this.runner.cancel?.(task.runId);
```

#### Correct

```ts
this.runnerControllers.get(taskId)?.abort();
await this.taskRunners.get(taskId)?.cancel?.(task.runId);
```

#### Wrong

```ts
const tasks = new TaskManager(config, store);
```

#### Correct

```ts
const runtime = createRunnerRuntime(config, projectRunners);
const tasks = new TaskManager(config, store, runtime.compatibilityRunner, runtime.resolver);
```

#### Wrong

```ts
const plugin = await import(config.runnerPlugins[0].module);
```

#### Correct

```ts
const runtime = await loadRunnerRuntime(config);
const tasks = new TaskManager(config, store, runtime.compatibilityRunner, runtime.resolver);
```

## Scenario: Project provider plugin boundary for Lynx App

### 1. Scope / Trigger

- Trigger: a project Runner needs project-owned build, install, account preflight, page-parameter, or result-analysis capabilities.
- Mobile Test Console owns the versioned provider contract, plugin loading, validation, registry, and Runner service lookup.
- Fanli owns the Lynx App provider manifest and keeps the existing command implementation in the project repository during this migration stage.

### 2. Signatures

```ts
interface ProjectProvider {
  readonly id: string;
  readonly manifest: {
    schemaVersion: "mobile-test-console.project-provider.v1";
    providerId: string;
    scope: {
      targetKinds: Array<"app" | "mini-program">;
      runtimes?: string[];
      platforms?: Array<"android" | "ios" | "harmony">;
    };
    capabilities: Array<{ id: string; version: number }>;
  };
  prepareRun?(
    request: ProjectProviderRunPreparationRequest,
  ): ProjectProviderRunPreparation | Promise<ProjectProviderRunPreparation>;
  collectResult?(
    request: ProjectProviderResultCollectionRequest,
  ): ProjectProviderResultCollection | Promise<ProjectProviderResultCollection>;
}

interface ProjectProviderRunPreparationRequest {
  plan: Readonly<RunPlan>;
  capabilities: readonly string[];
}

interface ProjectProviderRunPreparation {
  commands: RunnerCommand[];
}

interface ProjectProviderResultCollectionRequest {
  plan: Readonly<RunPlan>;
  result: Readonly<RunnerResult>;
  signal: AbortSignal;
}

interface ProjectProviderResultCollection {
  bundle: unknown;
}

interface ProjectProviderPlugin {
  apiVersion: "mobile-test-console.project-provider-plugin.v1";
  createProviders(context: ProjectProviderPluginContext): ProjectProvider[] | Promise<ProjectProvider[]>;
}

interface RunnerPluginServices {
  createCommandRunner(id: string): InProcessRunner;
  createProviderCommandRunner(
    id: string,
    providerId: string,
    requiredCapabilities: readonly string[],
  ): InProcessRunner;
  requireProjectProvider(providerId: string, requiredCapabilities?: readonly string[]): ProjectProvider;
}

projectProviderPlugins?: Array<{
  module: string;
  options?: Record<string, unknown>;
}>;
```

Fanli page-parameter preparation command:

```text
node packages/lynx/scripts/qa/qa-mobile-test-console.cjs page-parameters-resolve \
  --suite <suite> --platform <android|ios|harmony> \
  --device <device-id> --device-type <type> --run-id <run-id> \
  --environment <environment> --page-parameter-profiles <state-path>
```

### 3. Contracts

- Provider modules use the same trusted local plugin boundary and config-relative CJS/ESM resolution as Runner plugins.
- Provider manifests use a lowercase kebab-case provider ID, one or more valid target kinds, optional runtime/platform scopes, and unique versioned capabilities.
- The provider registry loads before Runner plugins. `requireProjectProvider()` validates the exact provider ID and required capability set during Runner initialization, before lifecycle startup and HTTP listen.
- `createProviderCommandRunner()` requires a callable Provider with `prepareRun()`. The platform validates and executes each returned command with the shared command lifecycle, then executes the task command. Provider preparation failure or cancellation stops the task command.
- Fanli registers `fanli-lynx-app` with `app.build`, `app.install`, `account.preflight`, `page-parameters.resolve`, and `result.analysis` capabilities for Android, iOS, and HarmonyOS Lynx App targets.
- `fanli-lynx-app-runner` requires all five capabilities and creates a Provider command Runner for `app.build`, `app.install`, `account.preflight`, and `page-parameters.resolve`.
- `prepareRun()` maps the platform-neutral `RunPlan` to Fanli's `app-prepare`, `account-preflight`, and `page-parameters-resolve` commands in that order. `app-prepare` reuses the existing suite setup command and per-platform lock; `account-preflight` reuses the existing session check, account-profile replay, member API verification, and precondition artifact flow; `page-parameters-resolve` runs the existing Lynx suite with `--dry-run true --summary-only true` and the project-owned page-parameter state path.
- The project Runner suite command carries `--skip-app-prepare true` and `--skip-account-preflight true` after Provider preparation. The legacy rollback command keeps the original argument list and owns build, installation, account preflight, and page execution.
- A Provider that declares `result.analysis` must implement `collectResult()`. The project Runner calls it for every `passed` or `failed` execution result, including preparation failures, and skips collection for `cancelled` results.
- Fanli `collectResult()` reuses `buildResultBundle()` with the task workspace, artifact root, environment, and Runner status. Fanli owns legacy artifact conversion; the platform owns Result Bundle validation, idempotent ingestion, and analysis storage.
- Provider ingestion validates `runId`, `projectId`, and terminal `status` against the active `RunPlan` and `RunnerResult` before writing. A mismatch fails result analysis and leaves the Result Bundle store unchanged.
- Successful ingestion returns `result-bundle://runs/<runId>`. `ProjectProviderCommandRunner` places it in `RunnerResult.resultUri`, and `TaskManager` persists it on the terminal task before saving state.
- `TaskResultService` reads a persisted Result Bundle before considering `taskResults.provider`, maps it to the unchanged `mobile-test-console.task-result.v1` facade, and resolves screenshot artifact URIs through the existing realpath containment and MIME checks. Default reads use the task fingerprint cache; `refresh=1` reloads the stored bundle. Tasks without `resultUri` retain the legacy provider and refresh behavior.
- `MTC_LYNX_APP_RUNNER=0` removes both Fanli project-provider and Runner plugins and selects `legacy-command-runner`, preserving one rollback boundary.
- Mini-program provider and Connector implementations remain outside this Lynx App increment.

### 4. Validation & Error Matrix

| Condition | Result |
| --- | --- |
| Provider plugin module cannot be resolved | `CONFIG_LOAD_FAILED` before lifecycle startup |
| Provider plugin protocol, factory result, manifest, scope, or capability is invalid | `CONFIG_INVALID` before lifecycle startup |
| Two plugins register the same provider ID | `CONFIG_INVALID` with duplicate registration detail |
| Runner requires an absent provider or capability | `CONFIG_INVALID` during Runner plugin initialization |
| Provider command Runner references a manifest-only Provider | `CONFIG_INVALID` with the missing `prepareRun()` detail |
| Provider declares `result.analysis` without `collectResult()` | `CONFIG_INVALID` before lifecycle startup |
| `prepareRun()` throws or returns an invalid command | Fail the task during capability preparation and skip the task command |
| A Provider preparation command fails or is cancelled | Propagate the command result and skip the task command |
| Page parameter dry-run cannot load or resolve a selected profile | Fail capability preparation and skip the task command |
| `collectResult()` or Result Bundle ingestion fails | Return a failed Runner result, preserve the execution exit code, and persist no `resultUri` |
| Main or preparation command is cancelled | Keep the task cancelled and skip result collection |
| `MTC_LYNX_APP_RUNNER=0` | Fanli loads no project-provider/Runner plugin and uses the legacy command path |

### 5. Good/Base/Bad Cases

- Good: a project Provider returns App preparation, account preflight, and page-parameter resolution in order, the platform Runner executes each through the shared command lifecycle, and the task command starts formal page execution after all capabilities pass.
- Good: passed and failed Lynx runs both produce one idempotently stored Result Bundle, while the old task result and screenshot APIs read the stored analysis through their existing response contract.
- Base: `legacy-command-runner` executes the original suite command, which performs build, installation, account preflight, page execution, and result generation in the established order.
- Bad: a Provider calls `spawnSync()` inside `prepareRun()`, bypassing platform cancellation and process lifecycle ownership.
- Bad: a project Runner executes Provider preparation and then runs a task command that repeats embedded App preparation or account preflight.

### 6. Tests Required

- Load provider plugins from config-relative modules and preserve frozen project context plus plugin options.
- Validate provider IDs, manifest versions, scope values, capability IDs/versions, and duplicate registrations.
- Assert a Runner plugin can require an exact capability set and fails before startup when one capability is missing.
- Execute Provider preparation commands in array order before the task command; cover invalid output, failure, cancellation, and missing `prepareRun()`.
- Collect passed and failed Runner results, validate and ingest their bundles, persist `resultUri`, and skip collection for cancellation.
- Reject Provider bundles whose `runId`, `projectId`, or terminal status differs from the active task before any state file is created.
- Read the old task result facade from the stored bundle; cover cache refresh, preconditions, detailed case fields, artifact traversal, symlink escape, and legacy provider fallback.
- Load the real Fanli config and assert `fanli-lynx-app` plus `fanli-lynx-app-runner` register together.
- Load Fanli with `MTC_LYNX_APP_RUNNER=0` and assert both plugin lists are empty and all three tests select `legacy-command-runner`.
- Assert Fanli Provider preparation emits `app-prepare`, `account-preflight`, and `page-parameters-resolve`, forwards account/page-parameter state and selection, and the project Runner suite command carries both skip flags.
- Run the page-parameter preparation command for Android, iOS, and HarmonyOS; assert every selected case is planned, no device command executes, and `--summary-only true` leaves the detailed result list empty.
- Preserve the existing command-runner tests for stdout/stderr, exit status, cancellation, shutdown, and result-provider behavior.

### 7. Wrong vs Correct

#### Wrong

```js
prepareRun(request) {
  spawnSync("pnpm", ["qa:app:prepare", "--device", request.plan.device.id]);
  return { commands: [] };
}
```

#### Correct

```js
prepareRun(request) {
  return {
    commands: [
      {
        executable: process.execPath,
        args: ["qa/app-prepare.cjs", "--device", request.plan.device.id],
      },
      {
        executable: process.execPath,
        args: ["qa/account-preflight.cjs", "--device", request.plan.device.id],
      },
      {
        executable: process.execPath,
        args: ["qa/page-parameters-resolve.cjs", "--device", request.plan.device.id],
      },
    ],
  };
}
```

## Scenario: Lynx App onboarding and capability snapshot

### 1. Scope / Trigger

- Trigger: a new Lynx App developer needs to verify local devices, project eligibility, and the minimum MTC integration contract before running a test.
- The platform owns the onboarding presentation and device snapshot; the project owns App build, install, page, account, and result commands.
- Fanli is the reference adapter. Its business names, account providers, and page catalog stay outside the platform onboarding contract.

### 2. Signatures

```ts
GET /api/snapshot

interface ConsoleSnapshot {
  project: ProjectSummary;
  connectors?: ConnectorCapabilityManifest[];
  projectProviders: ProjectProviderManifestSummary[];
  devices: Device[];
  deviceErrors: Partial<Record<Platform, string>>;
  deviceDiscoveryPending?: boolean;
  tests: PublicTestDefinition[];
}

resolveOnboardingReadiness(snapshot: ConsoleSnapshot): {
  platforms: Array<{
    platform: Platform;
    status: "ready" | "attention" | "waiting" | "checking";
    devices: number;
    readyDevices: number;
    detail: string;
  }>;
  capabilities: Set<string>;
  integrationLevel: "basic" | "standard" | "complete";
  readyDeviceCount: number;
}
```

### 3. Contracts

- The API snapshot includes `projectProviders`, with `providerId`, `scope.targetKinds`, optional `scope.runtimes`, optional `scope.platforms`, and versioned capability IDs.
- The onboarding workspace is always available after the `tests` workspace and is the first view for a project with no run records and no completed browser marker.
- The completion marker uses `localStorage` key `mtc:onboarding:<project.id>:v1` with value `complete`; it only affects the local browser and never changes project state.
- Platforms are derived from connector scopes and declared test platforms. A platform with at least one available, ready device is `ready`; a discovery error or non-ready device is `attention`; an empty platform is `waiting`; active discovery is `checking`.
- `basic` means tests use command execution without a loaded Project Provider; `standard` means at least one Provider is registered; `complete` requires `app.build`, `app.install`, `account.preflight`, `page-parameters.resolve`, and `result.analysis`.
- The Starter template keeps project-specific work in `qa/prepare.cjs`, `qa/lynx-suite.cjs`, and `qa/result-bundle.cjs`; the Provider and Runner boundary remains reusable.
- The onboarding code sample uses only declared command tokens and never embeds Fanli account, route, or business identifiers.

### 4. Validation & Error Matrix

| Condition | Result |
| --- | --- |
| Snapshot request fails | Keep the existing error notice and show the onboarding loading state |
| `projectProviders` is absent in a legacy fixture | Treat it as an empty Provider list and report `basic` integration |
| Device discovery is pending | Show `checking` and keep refresh available |
| Platform has a connector error | Show `attention` with the connector error and block readiness for that platform |
| Platform has no discovered device | Show `waiting` with platform-specific connection guidance |
| Provider declares `result.analysis` without `collectResult()` | Reject configuration as `CONFIG_INVALID` before onboarding can report `complete` |
| Browser marks onboarding complete | Store only the project-scoped local marker; the top-level onboarding tab remains available |

### 5. Good/Base/Bad Cases

- Good: a new project opens onboarding, detects one Android device, lists the loaded Provider capabilities, copies a valid config sample, and moves to test execution after the developer confirms the check.
- Good: a Fanli project shows its five capabilities and project-specific workspaces while the onboarding text remains platform-neutral.
- Base: a command-only project shows device readiness and a basic integration path, then can run its first Smoke without a Provider.
- Bad: onboarding infers project capabilities from Fanli test IDs or absolute paths.
- Bad: the browser treats a device discovery error as a ready device because the device list is empty.

### 6. Tests Required

- Assert `/api/snapshot` includes Provider manifests when the CLI passes the loaded registry and remains compatible with legacy fixtures.
- Assert readiness classification for ready, attention, waiting, and checking platforms.
- Assert basic, standard, and complete integration levels from capability sets.
- Render onboarding and verify project name, platform error, capability IDs, Starter config, copy action, and completion action.
- Load and execute the Lynx App Starter Provider/Runner, then assert Result Bundle ingestion and `resultUri` persistence.
- Verify the workspace resolver keeps onboarding available when project workspaces are added or removed.

### 7. Wrong vs Correct

#### Wrong

```ts
const ready = snapshot.devices.length > 0;
```

#### Correct

```ts
const ready = snapshot.devices.some(device =>
  device.connectionState === "available" && device.controlState === "ready",
);
```

#### Wrong

```ts
const capabilities = ["app.build", "app.install"];
```

#### Correct

```ts
const capabilities = new Set(
  (snapshot.projectProviders ?? [])
    .flatMap(provider => provider.capabilities.map(capability => capability.id)),
);
```

<!-- Superseded by the project onboarding and setup-plan contract below.

## Scenario: Local project catalog and resumable onboarding verification

### 1. Scope / Trigger

- Trigger: a developer registers an additional App or mini-program project before it becomes the active MTC runtime project.
- The catalog owns local project metadata and onboarding verification results. Each project-owned `stateDir` continues to own tasks, accounts, page profiles, business scripts, and result artifacts.
- This phase supports multiple registered projects and one active project selected at process startup through `--config`. Runtime activation and task routing across registered projects are separate capabilities.

### 2. Signatures

```text
mobile-test-console --config <path> [--project-catalog <path>]
MTC_PROJECT_CATALOG=<path>

GET  /api/projects
POST /api/projects
POST /api/projects/select-directory
POST /api/projects/select-config
DELETE /api/projects/:projectId
POST /api/projects/:projectId/onboarding/verify
```

```ts
type ProjectIntegrationType = "lynx-app" | "app" | "mini-program";
type ProjectOnboardingStepId =
  | "project"
  | "template"
  | "devices"
  | "smoke"
  | "capabilities"
  | "analysis";
type ProjectOnboardingStepStatus = "pending" | "waiting" | "blocked" | "verified";

interface RegisterProjectRequest {
  projectDirectory: string;
  configFile: string;
}

interface ProjectCatalogResponse {
  schemaVersion: "mobile-test-console.project-catalog.v1";
  // 当前运行项目 ID；删除其登记后，该 ID 可以暂时不在 projects 中。
  activeProjectId: string;
  projects: ProjectCatalogEntry[];
}
```

### 3. Contracts

- The catalog path precedence is `--project-catalog`, then `MTC_PROJECT_CATALOG`, then `~/.mobile-test-console/projects.json`.
- The CLI initializes the catalog with the project loaded from `--config`, upserts that entry, marks it active, and keeps every other entry inactive. When stored `activeProjectId` matches the loaded project and its entry is absent, the absence is a persisted deletion marker and initialization keeps it absent.
- `POST /api/projects` requires an existing project directory and a project-relative config path. The config file must exist, load successfully, and resolve `project.root` to the selected directory.
- `POST /api/projects/select-directory` opens the operating system's directory picker, scans the selected directory for `mobile-test.config.cjs`, loads it when found, and returns the resolved `projectDirectory`, relative `configFile`, `configPath`, and `configFound`.
- `POST /api/projects/select-config` opens the operating system's file picker, loads the selected config, and returns the resolved `projectDirectory`, relative `configFile`, `configPath`, and `configFound`.
- The browser treats config-file selection as the primary flow. Both selection flows fill the read-only project-directory and config-file inputs; an already registered `configPath` points the user to the existing project entry.
- Registration metadata is read only from the loaded config: `project.id`, `project.name`, `project.integrationType` (defaulting to `app`), and `deviceProviders`. Browser requests must not submit duplicate metadata.
- Every registration and verification reloads the selected config. The loader clears the Node CommonJS cache for `.cjs` files and uses an incrementing ESM import query, so a changed configuration is reflected by the next verification.
- The resolved config path must stay inside the registered project directory. The same project ID or resolved config path cannot be registered twice.
- Missing config returns `PROJECT_CONFIG_REQUIRED`; an unreadable config or a config whose `project.root` does not match the selected directory returns `PROJECT_CONFIG_INVALID`.
- A catalog write uses a serialized write queue, writes `<catalog>.next`, and renames it over the catalog file so concurrent registrations and verifications persist in operation order.
- Verification reconstructs all six onboarding steps on every run, then checks the project directory, config file, config identity/root, declared devices/toolchains, Provider/Runner loading, and capability manifests.
- The six steps are presented as four pre-run checks followed by two post-run evidence checks. A successful manual verification refreshes the selected project detail so execution readiness changes immediately in the browser.
- A missing config during verification produces `template=waiting`; a malformed or mismatched config produces `template=blocked`; later dependent steps stay pending until the config loads.
- `smoke` remains waiting until the platform records a successful first run. `analysis` remains waiting after `result.analysis` is declared until a Result Bundle is ingested.
- Lynx App capability verification requires `app.build`, `app.install`, `account.preflight`, `page-parameters.resolve`, and `result.analysis`. Generic App and mini-program entries report the capabilities declared by their own Provider without inheriting Fanli semantics.
- A generic App with valid command tests and no Project Provider verifies its basic command capability. Lynx App keeps the capability step waiting until all five required capabilities are available.
- The project catalog stores metadata and onboarding state only. Registering or verifying a project never changes the active task runtime.
- `DELETE /api/projects/:projectId` removes any registered catalog entry, including the current runtime project. It preserves repository files, `mobile-test.config.cjs`, the project-owned `stateDir`, active tasks, and the loaded runtime configuration.
- Deleting the current runtime entry keeps `activeProjectId` unchanged while omitting that ID from `projects`. This persisted shape prevents startup from automatically restoring the deleted entry. Registering the same configuration again marks it active because its ID matches `activeProjectId`.
- The browser exposes deletion only in the left project list. Every deletion opens the in-page confirmation dialog, which names the project and explains the preserved files and current-runtime behavior before sending the DELETE request.
- Activation validates the target config and uses the CLI restart boundary to make the selected project active. The running process remains on the old config until the restart has completed.
- Activation checks `queued`, `preparing`, and `running` tasks before scheduling a restart. Project state remains isolated because each process loads the target project's own `stateDir`.
- Production CLI restarts through a detached replacement process with the target `--config`. Development mode writes the target config to `MTC_DEV_SWITCH_FILE`; `scripts/dev.mjs` shuts down the old project lifecycle and starts the managed server and Vite pair with the replacement config.
- `TaskManager` invokes its completion listener only after the terminal task snapshot is persisted. The CLI listener writes a passed task to the catalog's `smoke` step and writes any terminal task with `resultUri` to the `analysis` step.
- HTTP Result Bundle ingestion writes the catalog `analysis` step for the bundle's registered project. `runId`, `resultUri`, source platform, and terminal status become the displayed verification evidence.
- A manual onboarding verification recomputes directory, config, device, and Provider steps while retaining verified Smoke and Result Bundle evidence.
- Smoke and Result Bundle evidence persist a SHA-256 digest of the source config and a normalized Provider manifest digest. Startup and manual verification invalidate evidence whose config or Provider capability version digest differs, then request a new Smoke and Result Bundle.
- For the active project, an invalidated Smoke or analysis step exposes a browser rerun action. It selects a compatible declared test and opens the existing test-execution workspace; device and parameter confirmation remains in the task-start flow.

### 4. Validation & Error Matrix

| Condition | Result |
| --- | --- |
| Project directory is absent or inaccessible | `PROJECT_DIRECTORY_REQUIRED` with HTTP 409 |
| User cancels the project directory picker | `PROJECT_DIRECTORY_SELECTION_CANCELLED` with HTTP 409 |
| User cancels the project config picker | `PROJECT_CONFIG_SELECTION_CANCELLED` with HTTP 409 |
| The current platform has no supported directory picker | `DIRECTORY_PICKER_UNAVAILABLE` with HTTP 500 |
| Config path is absolute, equals the directory, or escapes the project root | `PROJECT_CONFIG_PATH_INVALID` with HTTP 409 |
| Project ID already exists | `PROJECT_EXISTS` with HTTP 409 |
| Resolved config path is already registered | `PROJECT_CONFIG_ALREADY_REGISTERED` with HTTP 409 |
| Project ID is unknown during verification | `PROJECT_UNKNOWN` with HTTP 404 |
| Project ID is unknown during removal | `PROJECT_UNKNOWN` with HTTP 404 |
| Removal targets the active runtime project | Remove the catalog entry, preserve `activeProjectId` and the loaded runtime configuration |
| Catalog service was omitted from an embedded app instance | `PROJECT_CATALOG_UNAVAILABLE` with HTTP 503 |
| Config file is missing | Persist `template=waiting` and keep dependent steps pending |
| Config ID or root differs from the catalog entry | Persist `template=blocked` with both resolved values |
| Toolchain discovery reports an error | Persist `devices=blocked` with platform-specific detail |
| No ready device exists for a requested platform | Persist `devices=waiting` |
| Provider or Runner fails to load | Persist `capabilities=blocked`; keep analysis pending |
| Active tasks exist during activation | `PROJECT_SWITCH_TASK_ACTIVE` with HTTP 409; the current process stays unchanged |
| Target config is missing | `PROJECT_SWITCH_CONFIG_REQUIRED` with HTTP 409 |
| Target config cannot load or its project identity/root differs | `PROJECT_SWITCH_CONFIG_INVALID` with HTTP 409 |
| A passed task completes for a registered project | Persist `smoke=verified` after the terminal task state is durable |
| A passed or failed terminal task contains `resultUri` | Persist `analysis=verified` with the run and result URI |
| HTTP Result Bundle belongs to a registered project | Persist `analysis=verified` after idempotent ingestion |
| Project config source or Provider capability version changes | Reset verified Smoke and analysis evidence to `waiting` with the change reason |

### 5. Good/Base/Bad Cases

- Good: a developer selects `qa/mobile-test.config.cjs`; MTC resolves `project.root` to the repository root, fills both registration fields, and points to an existing catalog entry when the config is already registered.
- Good: a developer opens a project directory; MTC scans up to the supported depth for `mobile-test.config.cjs` and fills the discovered relative path.
- Good: a developer removes an inactive project entry; the catalog no longer lists it while its source tree, config, and state directory remain available.
- Good: a developer confirms removal of the current runtime project; the list removes its entry while the running console and active tasks continue with the loaded configuration.
- Base: the current runtime entry is absent during restart; the persisted `activeProjectId` deletion marker keeps it absent until the developer registers that config again.
- Base: a command-only App has a valid config and ready device, verifies its basic command capability, and can execute while result analysis remains pending.
- Base: a mini-program entry is recorded in the shared target model while its execution Connector remains a future phase.
- Bad: registering a project silently switches the active runtime or writes task state into the catalog file.
- Bad: a config path such as `../mobile-test.config.cjs` is accepted because the file exists outside the project root.
- Bad: activation changes the catalog marker while leaving the current process serving the previous project without scheduling a restart.
- Bad: mark a task passed in the catalog before its terminal task snapshot has reached `state.json`.
- Bad: a catalog rerun action starts a test on an inferred device without showing the existing device and parameter confirmation controls.
- Bad: removing a catalog entry recursively deletes the project directory or its `stateDir`.

### 6. Tests Required

- Initialize a fresh catalog and assert the CLI config project is automatically registered and active.
- Register a second project, persist and reload it, and assert it remains inactive.
- Verify missing config, valid config, ready device, no Provider, complete Lynx App Provider, config mismatch, directory traversal, duplicate ID, and duplicate config-path behavior.
- Exercise project directory selection, config-file selection, and registration routes; assert validation errors preserve `ConsoleError` codes and HTTP statuses.
- Remove inactive and active projects through both service and HTTP APIs; assert entries disappear, source configs remain, active removal preserves `activeProjectId`, restart preserves the deletion marker, and re-registration restores `active=true`.
- Render the project sidebar and project deletion confirmation; assert the current runtime project's delete control is enabled and the dialog explains the preserved files and loaded runtime behavior.
- Exercise activation with active and terminal tasks, assert the active-task guard, target config validation, restart response, and CLI argument replacement.
- Start a production CLI on an isolated port, register a valid target config, activate it, and assert the replacement process reports the target project through `/api/snapshot`.
- Assert the completion listener receives a persisted terminal task, verifies Smoke on a pass, and verifies Result Bundle analysis for both Runner and HTTP ingestion paths.
- Assert a project with four verified pre-run checks returns `executionReady=true` while `onboardingComplete=false`, and the browser enables execution before Smoke and Result Bundle evidence exists.
- Assert a config-source change and a Provider capability-version change invalidate prior Smoke and Result Bundle evidence, including during console startup.
- Render the active project catalog with stale Smoke and analysis evidence, assert both rerun actions, and assert the recommended test selector prefers a compatible Smoke test.
- Render the project workspace and assert registration fields, active-project label, six steps, verification action, and responsive layout selectors.
- Run lint, TypeScript type-check, the full Vitest suite, the Vite browser build, server build, and Runner declaration build.

### 7. Wrong vs Correct

#### Wrong

```ts
await activateProject(await catalog.register(request));
```

#### Correct

```ts
await catalog.register(request);
// The process keeps using the configuration selected by --config.
```

#### Wrong

```ts
const configPath = path.resolve(request.configFile);
```

#### Correct

```ts
const configPath = path.resolve(projectRoot, request.configFile);
const relative = path.relative(projectRoot, configPath);
if (!relative || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
  throw new ConsoleError("PROJECT_CONFIG_PATH_INVALID", "Config must stay inside the project directory", 409);
}
```

#### Wrong

```ts
catalog.recordTaskCompletion(task);
await stateStore.save([task]);
```

#### Correct

```ts
await stateStore.save(terminalTasks);
await catalog.recordTaskCompletion(terminalTask);
```

#### Wrong

```ts
await startTasks({ testId: recommendedTest.id, deviceKeys: inferredDevices, parameters: {} });
```

#### Correct

```ts
setSelectedTestId(recommendedTest.id);
setWorkspaceView("tests");
// The developer selects devices and confirms parameters before task start.
```

#### Correct

```ts
catalog.projects.delete(project.id);
// 保留 activeProjectId，用于识别已加载的运行配置，并让删除标记在重启后继续生效。
await catalog.persist();
```
-->

## Scenario: Project onboarding and confirmed setup plans

### 1. Scope / Trigger

- Trigger: a developer selects a Lynx App directory, registers a configuration, or repairs an incomplete project environment.
- The catalog owns four onboarding checks: `project`, `template`, `devices`, and `capabilities`.
- The `template` check owns the verified test-entry snapshot rendered in the project overview.
- Smoke execution and Result Bundle analysis belong to the `执行测试` workspace and do not update onboarding state.

### 2. Signatures

```text
GET    /api/projects
GET    /api/projects/:projectId/detail
POST   /api/projects
DELETE /api/projects/:projectId
POST   /api/projects/:projectId/onboarding/verify
POST   /api/projects/setup/preview
POST   /api/projects/setup/apply
POST   /api/projects/:projectId/setup/preview
POST   /api/projects/:projectId/setup/apply
```

```ts
type ProjectOnboardingStepId = "project" | "template" | "devices" | "capabilities";
type ProjectSetupStep = "config" | "devices" | "capabilities";

interface ProjectCapabilityCheck {
  id: string;
  label: string;
  status: "ready" | "missing";
  detail: string;
  guidance: string[];
}

interface ProjectTestEntryCheck {
  id: string;
  label: string;
  description: string;
  runnerId: string;
  platforms: Platform[];
  parameterLabels: string[];
}

interface ProjectSetupPlan {
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
```

### 3. Contracts

- Directory selection scans for `mobile-test.config.cjs`. A missing file returns `configFound=false`, keeps the resolved project directory, and offers initialization.
- Initialization preview accepts `{ projectDirectory, platforms }` and returns file actions for the config, Smoke command skeleton, and integration guide without writing files.
- Setup preview for a registered project accepts `step=devices|capabilities`. Device plans contain executable installation commands only for missing supported tools and always describe required connection or authorization actions. Capability plans preserve existing files and create only missing Provider, Runner, and config-fragment templates.
- Every preview returns a SHA-256 `planId` derived from the current project path, public action metadata, executable arguments, content digests, conflicts, and apply eligibility.
- Apply rebuilds the plan and requires the submitted `planId` to match. File actions use exclusive creation, command actions run in the displayed `cwd`, and created files from the current apply attempt are removed when a later action fails.
- Apply automatically reruns catalog verification and returns `{ plan, catalog, results }`.
- Generated capability templates declare `integration.todo`; they do not claim the six required Lynx capabilities. The developer implements and declares `qa.bundle.prepare`, `app.build`, `app.install`, `account.preflight`, `page-parameters.resolve`, and `result.analysis` before capability verification passes.
- Lynx App capability verification returns exactly six ordered `ProjectCapabilityCheck` entries. Each entry exposes a Chinese label, the stable capability ID, `ready|missing`, its responsibility, and direct implementation guidance while missing.
- The project overview renders the six checks as a two-column capability list inside the expandable `项目能力` step and collapses it to one column on narrow screens. Ready entries show `已接入`; missing entries show `待接入` and their guidance.
- Generic App projects expose their declared Provider capabilities without inheriting the Lynx App six-capability requirement. Historical catalog records may omit `capabilities`; loading normalizes them to an empty list until the next verification.
- Successful config verification snapshots every declared test in config order as `ProjectTestEntryCheck`. Each entry keeps its public ID, label, description, Runner ID, supported platforms, and parameter labels without exposing executable commands.
- The project overview renders the `template.testEntries` snapshot as a two-column `测试入口清单`, with one card per test and a one-column narrow-screen fallback. Historical catalog records may omit `testEntries`; loading normalizes that state to an empty list until the next verification.
- The browser displays every action, target path, command, working directory, content preview, and impact statement before confirmation. Cancel closes the dialog without calling apply.
- The top project navigation always shows five peer entries. `项目概览` remains enabled; other entries use `workspaceDisabledReason`. `页面列表`, `业务脚本`, and `账号画像` additionally require their IDs in `adapter.workspaces`.

### 4. Validation & Error Matrix

| Condition | Result |
| --- | --- |
| Project directory is absent or inaccessible | `PROJECT_DIRECTORY_REQUIRED`, HTTP 409 |
| Initialization has no selected platform | Preview returns `canApply=false` with a platform reason |
| Planned target file already exists | Preview returns `canApply=false` and identifies conflicts |
| Submitted plan differs from the rebuilt plan | `PROJECT_SETUP_PLAN_STALE`, HTTP 409 |
| Current plan cannot run | `PROJECT_SETUP_BLOCKED`, HTTP 409 |
| Setup command exits unsuccessfully | `PROJECT_SETUP_COMMAND_FAILED`, HTTP 500; remove files created by this attempt |
| Project or config identity is unknown during setup | `PROJECT_UNKNOWN` or `PROJECT_CONFIG_INVALID` |
| Toolchain is ready and device authorization is pending | Device plan contains manual actions and `canApply=false` |
| Workspace is undeclared | Keep the navigation entry visible and disabled with an `adapter.workspaces` hint |
| A configured Provider omits one or more `testing.capabilities` entries | `capabilities=waiting`; return config-declared checks and mark every absent capability as `missing` |
| Every required config-declared capability is present in its Provider | `capabilities=verified`; return the declared checks as `ready` |
| Config validation succeeds with one or more tests | `template=verified`; summary count and ordered `testEntries` describe the same config snapshot |
| A legacy catalog record omits `template.testEntries` | Preserve the record and expose an empty test-entry list until the next verification |

### 5. Good / Base / Bad Cases

- Good: the developer selects an empty Lynx App directory, previews three file writes, confirms once, and receives an automatically registered and reverified project.
- Good: an existing capability template is preserved while MTC creates only the missing Runner and config fragment.
- Base: adb is installed and no Android device is authorized; the plan explains the manual connection step and verification remains waiting.
- Base: project detail loading fails because the config is missing; the project overview still renders all four checks and the initialization action.
- Good: a project expands `项目能力` and shows every config-declared capability with stable IDs, responsibilities, and `已接入` states.
- Good: a project expands `接入配置` and shows page, flow, and general test entries with IDs, descriptions, platforms, Runner IDs, and parameters.
- Base: a Provider implements only part of the declared list; every missing declaration remains visible with project-provided guidance.
- Bad: preview writes files, apply accepts a stale plan, or template generation overwrites an existing project-owned file.
- Bad: Smoke or Result Bundle completion is required to unlock the first test execution.
- Bad: the overview reports only `已检测到 6 项项目能力` and hides which capabilities were checked.
- Bad: the overview reports only `声明 2 个测试入口` and hides which test entries were verified.

### 6. Tests Required

- Assert initialization preview performs zero writes and returns stable file targets and previews.
- Assert apply creates the planned files, registers a new project, and automatically verifies its config.
- Assert a target created after preview changes the plan and produces `PROJECT_SETUP_PLAN_STALE`.
- Assert capability generation preserves existing project files and reports manual completion work.
- Assert command failure rolls back files created during the same apply attempt.
- Assert the API validates preview/apply payloads and preserves `ConsoleError` codes and HTTP statuses.
- Assert all five navigation entries remain rendered during onboarding; four are disabled with actionable titles.
- Assert execution readiness enables `执行测试`, and `adapter.workspaces` independently enables the three project tools.
- Assert verification returns config-declared capability checks with labels, IDs, statuses, details, and missing guidance.
- Assert the browser renders every declared capability label and ID in the expandable project-capability step.
- Assert legacy catalog entries without `capabilities` remain readable.
- Assert config verification snapshots every declared test entry with its ID, label, description, Runner ID, platforms, and parameter labels.
- Assert the browser renders every test entry inside the expandable configuration step and distinguishes parameterized entries from entries with no parameters.
- Assert legacy catalog entries without `testEntries` remain readable.

### 7. Wrong vs Correct

#### Wrong

```ts
await fs.writeFile(target, generatedContent);
```

#### Correct

```ts
await fs.writeFile(target, generatedContent, { flag: "wx" });
```

#### Wrong

```ts
await applySetup(request);
```

#### Correct

```ts
const current = await buildSetupPlan(request);
requireCurrentSetupPlan(current.plan, request.planId);
await executeSetupActions(current.actions);
await catalog.verify(projectId);
```

#### Wrong

```ts
updateStep(project, "capabilities", "verified", "已检测到 6 项项目能力", []);
```

#### Correct

```ts
updateStep(project, "capabilities", status, summary, missingIds, checkedAt, {
  capabilities: capabilityChecks,
});
```

#### Wrong

```ts
updateStep(project, "template", "verified", `配置已加载，声明 ${config.tests.length} 个测试入口`, []);
```

#### Correct

```ts
updateStep(project, "template", "verified", summary, [], checkedAt, {
  testEntries: createTestEntryChecks(toPublicTests(config.tests)),
});
```

## Scenario: Project activation across the development restart boundary

### 1. Scope / Trigger

- Trigger: `POST /api/projects/:projectId/activate` selects a registered project whose config differs from the running process.
- The activation response, API shutdown, development watcher, Vite proxy, and browser refresh form one restart contract.

### 2. Signatures

```text
POST /api/projects/:projectId/activate
GET  /api/snapshot
MTC_DEV_SWITCH_FILE=<absolute path>
```

```ts
waitForProjectActivation(projectId: string): Promise<boolean>
```

### 3. Contracts

- The API returns the complete activation response before invoking `onProjectSwitch`; the callback is registered on the raw response `finish` event.
- Development mode writes the selected config path to `MTC_DEV_SWITCH_FILE`, completes project cleanup, and terminates the `tsx watch` parent with a successful exit after the activation response finishes. `scripts/dev.mjs` waits for API port `4310` and Vite port `4311` to become available before it runs the selected project lifecycle and starts the replacement pair.
- The browser enters a project-switching state after the activation request succeeds. Its background snapshot refresh ignores expected connection failures during that state, polls `/api/snapshot` for up to 90 seconds, and reloads only after `snapshot.project.id` equals the requested project ID.
- Production mode keeps the detached replacement-process behavior and does not use the development watcher termination path.

### 4. Validation & Error Matrix

| Condition | Result |
| --- | --- |
| Active tasks exist | `PROJECT_SWITCH_TASK_ACTIVE`, HTTP 409; keep the current runtime |
| Target config is invalid | Project activation error; keep the current runtime |
| API is unavailable during restart | Browser polling continues until the retry budget expires |
| API or Vite has not released its port | Development parent waits for both ports; a bounded timeout reports the occupied-port diagnostic |
| New snapshot reports the requested project | Reload the browser and render the selected runtime |
| Retry budget expires | Keep the page available and show the restart-timeout diagnostic |

### 5. Good / Base / Bad Cases

- Good: the proxy receives HTTP 200, the old API exits after the response finishes, and the new snapshot reports the selected project.
- Base: several snapshot polls fail while API and Vite restart; the browser keeps the switching status visible and reloads when the target project becomes active.
- Bad: the API exits before the activation response is flushed, so Vite converts the interrupted proxy response into HTTP 500.
- Bad: the API child exits while `tsx watch` stays alive, leaving Vite running with no service on port 4310.
- Bad: the development parent starts the replacement lifecycle before the prior API and Vite listeners have released 4310 and 4311.

### 6. Tests Required

- Assert an injected activation response is HTTP 200 and the restart callback runs after response completion.
- Start development mode through `scripts/dev.mjs`, activate a second project through the Vite proxy, and assert `/api/snapshot` eventually reports that project.
- Repeat the activation in the opposite direction to cover successive watcher restarts.
- Assert the browser activation helper tolerates connection failures and stops when the requested project becomes active.
- Assert the browser background refresh does not replace the active switching status with a service-read error during the restart interval.
- Assert the development port helper waits for a temporarily occupied port to release before the replacement service starts.

### 7. Wrong vs Correct

#### Wrong

```ts
await onProjectSwitch(configPath);
return activation;
```

#### Correct

```ts
reply.raw.once("finish", () => void onProjectSwitch(configPath));
return activation;
```

## Scenario: Parameter-free console startup

### 1. Scope / Trigger

- Trigger: a developer runs `pnpm dev` without `--config` after projects have been registered through the console.

### 2. Signatures

```text
pnpm dev
pnpm dev -- --config <project-config>
MTC_PROJECT_CATALOG=<catalog-path>
```

### 3. Contracts

- Startup precedence is explicit `--config`, then `MTC_CONFIG`; no configured value starts the platform shell.
- The catalog stores project metadata and the active project ID at `~/.mobile-test-console/projects.json` by default.
- Parameter-free startup does not load catalog configurations. Its snapshot exposes project ID `mobile-test-console` and an empty test list so the browser can render project onboarding.
- Catalog entries stay available to select, repair, or switch from the browser even when a stored configuration is missing or invalid.
- Lifecycle startup and shutdown commands run only for a configured project. The platform shell does not invoke project-owned commands.

### 4. Validation & Error Matrix

| Condition | Result |
| --- | --- |
| Explicit config is supplied | Load that config and mark it active in the catalog |
| `MTC_CONFIG` is set | Treat it as the explicit config |
| No explicit config is supplied | Start platform shell and keep API available |
| Catalog contains registered projects | Keep catalog entries available without loading their configurations |
| Stored catalog entry is stale | Start platform shell; surface the entry status when the developer selects it |

### 5. Good / Base / Bad Cases

- Good: `pnpm dev` after a prior Fanli session starts the platform shell without Fanli preparation.
- Base: `pnpm dev` starts the project overview and allows adding, selecting, or switching a project through the UI.
- Bad: no config argument causes the process to exit before the project onboarding UI can load.
- Bad: starting the platform shell runs a stale project's lifecycle startup command.

### 6. Tests Required

- Resolve an empty catalog to the platform shell.
- Resolve a catalog with an active entry to the platform shell and preserve the catalog active ID.
- Assert explicit config precedence over the platform shell.
- Run `pnpm dev` with a real catalog and inspect `/api/snapshot` for the platform shell.

### 7. Wrong vs Correct

#### Wrong

```js
if (!config) process.exit(2);
```

#### Correct

```ts
const startupProject = await resolveStartupProject({ configPath, platformRoot });
```

## Scenario: Config-driven test capability and page/flow discovery

### 1. Scope / Trigger

- Trigger: a project declares runnable environments, Provider capabilities, page or flow tests, and the result contract in `mobile-test.config.cjs`.
- The config loader, runtime Provider registry, onboarding checks, snapshot API, task parameter validation, and execution UI share this contract.

### 2. Signatures

```ts
interface ProjectTestingManifest {
  environments: ProjectTestEnvironment[];
  capabilities: ProjectTestCapabilityDeclaration[];
  result?: { schemaVersion: string; artifactsRoot: string };
}

interface PublicTestDefinition {
  kind: "general" | "page" | "flow";
  providerId?: string;
  requiredCapabilities: string[];
}

type PageSelectionParameterDefinition = {
  type: "page-selection";
  source: "page-parameters";
  defaultValue: string;
  presets: PageSelectionPreset[];
};
```

### 3. Contracts

- `testing.environments` is the project-owned list of runnable environment IDs, labels, and descriptions.
- `testing.capabilities` declares capability ID, label, description, guidance, `providerId`, and whether the capability blocks onboarding.
- A test with `requiredCapabilities` also declares `providerId`. Every required ID belongs to the same declared Provider.
- `loadRunnerRuntime()` verifies that the registered Provider manifest contains every capability required by each test before the HTTP server starts.
- `taskResults.schemaVersion` and the resolved `artifactsRoot` become `ConsoleSnapshot.testing.result`; project result conversion remains inside its Provider or legacy result command.
- `kind="page"` can use `page-selection`. MTC reads the platform-neutral page catalog, applies config-declared preset filters, and passes either a preset value or comma-separated page IDs to the project Runner.
- Page catalog metadata may include `caseId`, `priority`, `tags`, `testScope`, and `platforms`. The project Provider owns every value; MTC only filters and renders them.
- `kind="flow"` uses project-declared parameters and commands. Flow IDs, grouping, page order, actions, and assertions stay in the project repository.

### 4. Validation & Error Matrix

| Condition | Result |
| --- | --- |
| Environment or capability IDs repeat | `CONFIG_INVALID` with the duplicated field path |
| Test references an undeclared capability | `CONFIG_INVALID` during config load |
| Required capability belongs to another Provider | `CONFIG_INVALID` during config load |
| Test declares capability requirements without `providerId` | `CONFIG_INVALID` during config load |
| Provider manifest lacks a test-required capability | `CONFIG_INVALID` before HTTP listen |
| Page-selection default does not reference a declared preset | `CONFIG_INVALID` during config load |
| Page-selection value is neither a preset nor valid page IDs | `PARAMETER_INVALID` when starting the task |
| App command test has no capability declarations | Treat it as a command-only runnable test |
| Lynx App or mini-program config has no capability declarations | Keep onboarding at `capabilities=waiting` with config guidance |

### 5. Good / Base / Bad Cases

- Good: a generic App declares its own Provider ID, capability names, result schema, and page presets; MTC starts without project strings in platform code.
- Good: page and flow tests share one Provider while exposing separate test entries and separate parameters.
- Base: a legacy command-only App declares no Provider capabilities and continues through the legacy runner.
- Bad: MTC core contains project page IDs, flow names, result paths, or a fixed six-capability list.
- Bad: the browser derives P0, P1, P2, or Smoke membership from project naming conventions instead of config/catalog metadata.

### 6. Tests Required

- Parse the complete testing manifest and expose the resolved result contract in the snapshot.
- Reject duplicate declarations, undeclared test capabilities, Provider mismatches, and invalid page-selection defaults.
- Reject a runtime whose Provider manifest lacks a test-required capability.
- Filter page presets by project-provided priority, tags, test scope, and selected device platforms.
- Preserve explicit page selection order after removing IDs absent from the catalog.
- Run all config, catalog, HTTP, web parameter, lint, type-check, and build checks without project semantics in MTC core.

### 7. Wrong vs Correct

#### Wrong

```ts
const required = ["app.build", "app.install", "result.analysis"];
```

#### Correct

```ts
const required = config.testing?.capabilities.filter(item => item.required) ?? [];
```

#### Wrong

```ts
if (preset === "p0") return fanliP0Pages;
```

#### Correct

```ts
return pages.filter(page => matchesPagePreset(page, preset.filter));
```

## Scenario: Public beta package and open-source release gate

### 1. Scope / Trigger

- Trigger: Mobile Test Console publishes a beta CLI/SDK package or accepts an integration change that affects external Lynx projects.
- The package manifest, SDK exports, generated JSON Schemas, generic fixtures, CI, and package-content audit form one release boundary.

### 2. Signatures

```text
mobile-test-console/sdk
mobile-test-console/runner
mobile-test-console/schemas/mobile-test.config.v1.json
mobile-test-console/schemas/test-analysis.run.v1.json

pnpm schema:generate
pnpm schema:check
pnpm test:integrations
pnpm check:open-source
pnpm check:package
pnpm check
```

### 3. Contracts

- `mobile-test-console/sdk` is the preferred public entry and exports Runner, Project Provider, Connector, Result Bundle types, protocol constants, and runtime validators. `mobile-test-console/runner` remains compatible for the `0.1.x` line.
- `ProjectConfigInput` is derived from the Zod `configSchema`; Result Bundle types and runtime validation are derived from `resultBundleSchema`.
- `scripts/generate-schemas.ts` generates both JSON Schemas from those Zod owners. Hand-authored schema copies are forbidden.
- The npm package includes compiled CLI/SDK files, generated schemas, license, security policy, onboarding docs, and generic examples. It excludes source, tests, Trellis state, dependencies, `.mtc-state`, and OS metadata.
- `check-open-source.mjs` rejects credentials, private keys, developer-specific absolute paths, tracked local runtime data, and project-domain names in platform `src/`.
- Integration coverage loads both `examples/lynx-app-starter` and `examples/com.shanjing.example`, validates their raw configs against JSON Schema, then registers each project's Provider and Runner through the production config/runtime boundary.
- CI runs on Node.js `18.20.7` and current LTS with pnpm `10.28.2`. `prepack` runs the complete `pnpm check` gate.

### 4. Validation & Error Matrix

| Condition | Result |
| --- | --- |
| Generated schema differs from its Zod owner | `pnpm schema:check` fails with regeneration guidance |
| Package is private or lacks license/SDK/schema exports | `pnpm check:open-source` fails |
| Platform source contains an application brand or route name | `pnpm check:open-source` fails with the source path |
| Publish set contains `.mtc-state`, source, tests, dependencies, or OS metadata | `pnpm check:package` fails with the package path |
| Starter or independent example cannot load its Provider/Runner | `pnpm test:integrations` fails before publication |
| SDK declaration or runtime entry is absent from `dist` | package-content check fails |
| A public contract needs an incompatible shape | introduce a new schema/API version and migration notes |

### 5. Good / Base / Bad Cases

- Good: a third-party Lynx project imports `ProjectConfigInput` from `mobile-test-console/sdk`, validates configuration with the exported schema, and registers its own Provider/Runner.
- Good: a Result Bundle field changes in the Zod owner, schema generation updates the tracked JSON, and CI validates the example bundle.
- Base: an existing `mobile-test-console/runner` integration continues through the documented `0.1.x` compatibility window.
- Bad: publish a package containing a developer home path, local state, account material, or an application-specific adapter.
- Bad: edit a JSON Schema independently from the Zod runtime validator.

### 6. Tests Required

- Import every public protocol constant through `src/sdk/index.ts` and assert its exact version.
- Validate both Lynx project configs and the mini-program Result Bundle fixture with exported JSON Schemas.
- Load both project configs through `loadProjectConfig()` and `loadRunnerRuntime()`; assert project-owned Provider and Runner IDs.
- Build CLI, compatibility Runner, and public SDK declarations before auditing npm package contents.
- Run the source security/brand scan and assert the package manifest is public, MIT-licensed, and on the beta version line.
- Run `pnpm check` on the minimum Node.js version and current LTS in CI.

### 7. Wrong vs Correct

#### Wrong

```json
{
  "private": true,
  "exports": { "./runner": "./src/runner/index.ts" }
}
```

#### Correct

```json
{
  "license": "MIT",
  "exports": {
    "./sdk": {
      "types": "./dist/sdk/index.d.ts",
      "import": "./dist/sdk/index.js"
    },
    "./schemas/mobile-test.config.v1.json": "./schemas/mobile-test.config.v1.schema.json"
  }
}
```
