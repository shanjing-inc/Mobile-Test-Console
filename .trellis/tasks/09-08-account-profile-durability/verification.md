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
