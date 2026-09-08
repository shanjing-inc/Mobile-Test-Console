# Execution plan

- [x] Extract shared UUID resolution while preserving account helper compatibility; add page storage/path helpers and resolve page-only configurations.
- [x] Implement validated page-state migration, backups, atomic locked updates, recovery, and regression tests.
- [x] Reconcile service mutations against current stored state; preserve omitted navigation and pass the durable file to replay.
- [x] Carry launch navigation through browser drafts/history selection and add regression tests.
- [x] Wire API/runtime constructors, Provider/Runner/lifecycle templates, and repair snapshots to the same page path.
- [x] Run page/storage/config/repair/web regressions, account compatibility regressions, lint, typecheck, schema, and build/package checks; compare full-suite failures with the established baseline.
- [x] Migrate the active project's preserved page state and verify profiles, recordings, navigation, and source preservation using aggregate diagnostics.
- [x] Cross-review final changes, update contracts and validation notes, and commit the follow-up requested in the ongoing session.

## Unified backup execution

- [x] Add portable page and project backup contracts; implement full-package validation/coordinator and page merge import/export.
- [x] Wire selected-project API routes and initialize both persistent namespaces for profile-capable configs.
- [x] Share unified backup controls across account/page workspaces with legacy import compatibility and explicit account-only local recovery labels.
- [x] Verify synthetic export/import round trips, legacy files, invalid second sections without writes, conflict/repeat/default/active-recording semantics, project isolation, partial I/O failure, UI/API routing and size limits.
- [x] Run targeted and full checks, compare known baseline failures, validate live export counts read-only, update docs/specs, review and commit.
