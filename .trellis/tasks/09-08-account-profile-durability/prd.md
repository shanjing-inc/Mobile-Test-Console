# Durable account profiles

Account profiles currently follow path-derived runtime state directories, so a checkout move or identity change makes existing profiles disappear from the console.

## Accepted scope
- Store profiles in the MTC user data directory under a persistent UUID.
- Persist only non-secret identity metadata beside project config; preserve path-derived runtime IDs and task isolation.
- Migrate legacy state directories once, keep originals, preserve conflicting versions.
- Back up before every changed write, use atomic durable writes and cross-process locking.
- Provide user-driven export/import and backup recovery in the account workspace.
- Preserve source data when a file is corrupt; recover the latest valid backup with a visible warning.

## Change boundary
Storage identity and AccountProfileStore own durability. Config command placeholders and repair snapshots consume the same profile path. Service/API/contracts and the account workspace expose backup operations. No App native, Lynx build, or unrelated state-store changes.

## Validation
Cover identity moves, migration/restart/deletion, conflicting imports, backup recovery, failed writes, concurrent instances/processes, provider paths and project-scoped HTTP/UI. Run the full MTC quality gate. Verify live existing profile counts without logging credentials.

## Follow-up: page parameters and launch navigation

The user reported that page parameter profiles and page launch parameters are also missing. The legacy page store still contains 28 profiles and 48 recordings, while the active path-derived runtime directory has no page state. Applying a historical profile in the editor also drops its navigation before a later save.

- Give page profiles and recordings persistent project storage with migration from current and configured legacy runtime directories, preserving complete values, navigation, actions, assertions, and source files.
- Use the same persistent project UUID while keeping account and page state in distinct namespaces. Page-only projects must resolve identity independently of account-provider enablement.
- Preserve existing current data and conflicting legacy versions; migration must remain idempotent after edits/deletions and restart.
- Back up changed writes, publish atomically, serialize concurrent updates, and surface corrupt/unreadable state without replacing it with an empty state.
- Keep the selected historical profile's launch navigation across editing, saving, replay, draft restoration, and page changes. An API update omitting navigation preserves the previous profile navigation.
- All Provider/Runner/lifecycle command paths and repair snapshots must use the same page state as the service.
- Restore and verify the affected local profiles with structural equality checks and counts only; keep parameter/credential values out of diagnostics.
