# Verification — 2026-09-08

## Implemented
- Persistent UUID sidecar plus local identity index; profile vault outside source checkouts.
- Legacy directory merge with source preservation and migration markers.
- Initial snapshot and backup before each changed write; atomic publication, private modes and cross-process locking.
- Explicit export/import, conflict preservation and backup merge recovery in HTTP and UI.
- Provider command paths and protected repair snapshots use the durable profile path.

## Earlier implementation validation
- Focused account/config/web tests: 71 passed. Dedicated vault HTTP test: 1 passed.
- Full suite: 448 passed, 10 failed across 50 test files. The 10 failing test names exactly match an isolated HEAD baseline (436 passed, 10 failed before this change).
- Type check: the same 3 pre-existing diagnostics in page-inspection-theme.ts and its test fixtures, reproduced in the isolated HEAD baseline.
- Lint, generated schema check, frontend bundle, server bundle, SDK declarations and package contents check passed (144 packaged files).
- Open-source check still flags the existing Linux absolute path in tests/page-parameters.test.ts. This file is unchanged; the isolated baseline reproduces the same finding.
- pnpm 10.28.2 frozen/offline lockfile verification passed in an isolated directory. Existing dependency resolutions were preserved while adding proper-lockfile and its types.
- Live migration: 5 profiles and 6 recordings. Full profile and recording objects are deeply equal to the retained previous file; one initial backup exists; main file mode is 0600. Credential values were excluded from diagnostic output.
- Browser: backup controls and all 5 profiles render. Desktop width 1280 and narrow width 390 match document scrollWidth; no browser warning/error logs.
- git diff --check passed.

## Delivery state
The user requested review and a Git commit on MTC main. The integrated project's generated mobile-test.identity.json is non-secret and should be committed with its QA config. Original legacy files are retained. Full repository gate remains blocked by the baseline failures; task archival is pending gate disposition.

## Review and fixes — 2026-09-08

- Replaced object-rest summary projections with explicit allowed fields for profiles, provider entries, and recordings. An HTTP regression first reproduced imported extension credentials appearing in summaries, then passed after the fix. Explicit export still preserves the complete imported payload.
- Backup recovery now propagates permission and disk I/O failures. EACCES/EIO regressions verify that load/update reject, a missing main file stays absent, and existing backup bytes remain unchanged. Invalid JSON/future-version backups still fall through to older valid backups.
- Import applies the same completed-recording provider recovery as loading before conflict comparison. Repeated imports now retain stable profile and recording IDs, including conflicts; tests assert three imports preserve credentials and leave the input unchanged.
- Final full suite: 449 passed, 14 failed across 50 files. An isolated archive of HEAD `a7c92dd` using the same Node 24 runtime produced 432 passed and the identical 14 failed test names across 48 files. No new failing tests were introduced. The four failures beyond the earlier report are macOS `/var` versus `/private/var` path expectations.
- Final type check reproduces the same three HEAD diagnostics: `src/server/page-inspection-theme.ts:46`, `tests/page-inspection-theme.test.ts:24`, and `:99`.
- Lint, generated-schema check, frontend bundle, server bundle, Runner/SDK declarations, package contents (144 files), and whitespace validation pass. The standard `pnpm check` stops at the pre-existing test failures; the standard build remains blocked by type-check failures, so its bundling stages were validated separately.
- Open-source scanning still reports the Linux absolute path in `tests/page-parameters.test.ts`; that file is byte-identical to HEAD.
- Storage/service tests: 41 passed, including 14 durability tests. The extended vault HTTP test and both web backup tests pass in the final full run.
- Existing live-data migration and browser-layout evidence above belongs to the earlier implementation validation. This review used synthetic test data and introduced no browser-layout changes.


## Page parameter follow-up — 2026-09-08

- Root cause: page profiles still followed the path-derived runtime directory. The legacy configured-ID directory retained 28 profiles and 48 recordings, while the active runtime directory had no page file. Page launch navigation is part of each stored profile.
- Added shared persistent project identity resolution with separate account/page namespaces. Page-only configs resolve identity and complete migration before command execution. Existing account storage locations and sidecar/index compatibility are preserved.
- Unified page Provider/Runner/lifecycle/result/replay paths and repair snapshots. Page stores validate state, preserve original sources and deterministic conflict copies, persist migration markers, back up changed writes, publish atomically, recover valid backups, and lock read/modify/write across processes.
- Service callbacks reconcile delayed Provider responses with current state, retaining concurrent edits/deletions and terminal recording statuses. Repeated observations preserve earlier navigation when later payloads omit it.
- Browser drafts retain historical/observation navigation through edits, page changes, saves, and replay. API updates omitting navigation keep the previous launch route and params.
- Cross-review reproduced duplicate legacy defaults after default demotion; a second equality check after normalization fixes that edge case and the regression covers two identical legacy sources.
- Final full suite: 472 passed, 14 failed across 52 files. The 14 failing names exactly match the earlier isolated HEAD baseline and the prior account-profile review. Type check still has only the same three page-inspection-theme diagnostics.
- Lint, schema check, frontend/server bundles, Runner/SDK declarations, package contents (145 files), and whitespace checks pass. Standard full check/build remain blocked by the documented baseline tests/types. Open-source scanning still misidentifies the existing `/api/page-parameters/home/profiles/...` fixture URL as a Linux home path.
- Live restored store: 28 profiles, 48 recordings, all complete objects deeply equal to the retained legacy data. All 28 profiles have launch navigation params. Main file mode is 0600 and one initial backup exists. Diagnostic output contained counts and equality flags only.
- Live active-project HTTP returned the same 28 profiles and 48 recordings, with a migration warning. Browser page-list verification displayed recorded status and history-filled fields; no horizontal overflow and no browser warnings/errors. Native-device execution was not performed; the replay integration test executes a synthetic Provider that reads the actual durable state file.
- Task remains open for repository baseline-gate disposition; both requested storage scopes are implemented and reviewed.


## Unified project backup — 2026-09-08

- Added one portable project backup and shared account/page UI with complete navigation/actions/assertions and both recording histories. Old account exports and endpoints remain compatible. API and browser share the new 40 MiB limit.
- Both namespaces resolve whenever either provider is configured. HTTP regression verifies request-scoped project selection, destination name, complete page profiles, repeat/legacy imports, sanitized malformed input, and 413 handling. Page-only config regression verifies stable account storage after moving the project and enabling accounts.
- Coordinator tests use synthetic real stores to verify full validation before writes, active-recording termination, conflict/default/repeat semantics, backups and second-stage failure/retry. Independent reviewer found no new defects; 50 relevant tests passed in its focused runs.
- Full suite: 488 passed, 14 failed (53 files). A fresh isolated archive of HEAD produced 472 passed, 14 failed (52 files); failing test names match exactly. Logs: `/tmp/mtc-unified-full-tests.log` and `/tmp/mtc-unified-baseline-tests.log`.
- Full lint and schema check passed. Typecheck retained exactly the three documented page-inspection-theme diagnostics. Open-source checker retained its known page-parameters API URL false positive. Individual Vite/server/Runner/SDK build steps and package check passed (148 packaged files); the standard build remains gated by existing type errors.
- Read-only live vault verification through the new export coordinator: 5 account profiles, 6 account recordings, 28 page profiles, 48 page recordings. All 28 pages retain navigation; every profile and recording object is preserved exactly; portable sections exclude migration metadata. Export credentials stayed in memory and diagnostic output contained aggregate checks only.
- The previous local API server was unavailable during this follow-up. Live verification read the vault identity index and state directly; HTTP integration uses synthetic stores. UI validation uses SSR/API tests; native browser file selection/download was not repeated.
- Docs and backend/frontend executable contracts updated. Task stays open for the previously recorded baseline-gate disposition. Feature review and Git delivery are complete for this scope.
