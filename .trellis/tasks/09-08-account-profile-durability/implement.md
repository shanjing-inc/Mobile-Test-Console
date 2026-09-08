# Execution plan

- [x] Extract shared UUID resolution while preserving account helper compatibility; add page storage/path helpers and resolve page-only configurations.
- [x] Implement validated page-state migration, backups, atomic locked updates, recovery, and regression tests.
- [x] Reconcile service mutations against current stored state; preserve omitted navigation and pass the durable file to replay.
- [x] Carry launch navigation through browser drafts/history selection and add regression tests.
- [x] Wire API/runtime constructors, Provider/Runner/lifecycle templates, and repair snapshots to the same page path.
- [x] Run page/storage/config/repair/web regressions, account compatibility regressions, lint, typecheck, schema, and build/package checks; compare full-suite failures with the established baseline.
- [x] Migrate the active project's preserved page state and verify profiles, recordings, navigation, and source preservation using aggregate diagnostics.
- [x] Cross-review final changes, update contracts and validation notes, and commit the follow-up requested in the ongoing session.
