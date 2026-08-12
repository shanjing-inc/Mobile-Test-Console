# 测试产物保留与清理设计

## Data flow

```text
设备 App 当前 caseRunId 诊断
  -> Fanli 平台采集脚本
  -> 当前用例产物目录
  -> Fanli Result Provider
  -> MTC 结果分析

MTC 保留策略
  -> 结构化清理请求
  -> 项目清理适配器 plan/apply
  -> 结构化清理结果
  -> MTC 任务索引与存储统计
```

## Phase 1: iOS collection boundary

`qa-ios-oneclick.cjs` 使用当前 `context.runId` 作为唯一诊断范围。

### Simulator

- Source: `<app-container>/Documents/diagnostics/<runId>`
- Destination: `<artifact-dir>/ios-diagnostics/<runId>`
- Runtime log follows the same run-scoped rule when the device layout provides a run directory.

### Physical device

- `devicectl device copy from` source: `Documents/diagnostics/<runId>`
- Destination: `<artifact-dir>/ios-diagnostics/<runId>`
- Artifact manifest keeps the existing `ios-diagnostics/<runId>/...` shape.

### Failure behavior

- Missing current-run diagnostics produces the existing artifact collection warning.
- Evidence validation continues to use `hasDiagnosticsManifest`, `hasDiagnosticsAction`, and screenshot counting against the current run directory.
- Device-side deletion is deferred until a project cleanup command can confirm host-side collection and result ingestion.

## Phase 2: project cleanup adapter

Fanli owns run-to-path resolution and exposes `plan` / `apply` through its MTC adapter command. MTC supplies protected and candidate run IDs through a request file. The adapter returns file counts, byte counts, skipped items, errors, and released bytes.

For manual cleanup, MTC sends `discoverCandidates: true` with an empty candidate list. The adapter groups its own directories into selectable run IDs, so the platform remains independent from Fanli's case-directory naming. The UI submits only checked run IDs; MTC revalidates strong protections and re-plans the exact selection before apply.

## Phase 3: MTC policy

MTC owns protection rules, retention limits, cleanup scheduling, preview, audit records, external artifact roots, and MTC-owned repair worktree cleanup. Project-specific paths remain behind the adapter contract.

### Apply and audit boundary

- Adapter result items are accepted only when each `runId` belongs to the current candidate set and appears once.
- Task indexes are removed only when the adapter reports top-level `ok: true`; `partial`, `failed`, and top-level failure results remain visible.
- Command failures are persisted as a failed apply audit before the API returns the error.
- Automatic governance serializes startup and task-completion checks. Expired terminal repair worktrees are considered even when the project has no artifact candidate.

## Delivered v1 boundary

- v1 blocks a new run when the artifact root is unavailable, unwritable, or below the configured free-space safety threshold.
- v1 removes the observed iOS write amplification by collecting only the current run diagnostics.
- Per-run write estimation, live `writtenBytes` accounting, and mid-run evidence throttling require a versioned Runner/Provider budget contract and remain a follow-up phase.
- Device-side diagnostics deletion remains deferred until Result Bundle ingestion can acknowledge durable host-side evidence.
- Existing historical runs remain read-only until the generated dry-run report receives explicit apply confirmation.

## Safety

- Every local deletion target must resolve below a configured root.
- Active task and repair run IDs are protected before project adapter execution.
- Existing historical data is only processed after a dry-run report and explicit confirmation.
- Collection changes preserve the existing Result Bundle relative artifact paths.

## Verification

- Unit-test simulator and physical-device command construction.
- Verify only the current run directory is copied when historical run directories exist.
- Run `pnpm --dir packages/lynx qa:test`.
- Run MTC contract, integration, and open-source checks in later phases.
