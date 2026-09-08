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
