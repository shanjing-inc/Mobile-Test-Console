# Durable account profiles

MTC stores account profiles under `~/.mobile-test-console/account-profiles/<storage-id>/account-profiles.json`. Account credentials, recording history and automatic backups are local user data. Keep exported copies in a protected backup location to cover disk failure or moving to another computer.

## Persistent project identity

When a project config enables `accountProfiles`, MTC creates `mobile-test.identity.json` beside the config on first load. Commit this non-secret file with the project's test configuration. Moving or cloning a checkout with this file keeps the profile association on the same computer. Worktrees sharing this identity also share profiles; their runtime project IDs and test-result directories remain isolated by checkout path.

A project may instead declare an explicit UUID in `project.storageId`:

```js
project: {
  name: "Example App",
  root: "..",
  storageId: "4755e8fc-2c8e-41a1-9d13-3e46f1e96898",
}
```

Use a unique UUID for each independent project. This example UUID is illustrative. Explicit configuration takes precedence over the sidecar. It also supports read-only project configurations. Changing an established storage ID selects a different vault; preserve the previous ID to reconnect, or export/import to transfer profiles.

MTC keeps a second copy of the identity association in `~/.mobile-test-console/account-profile-identities/`. If the sidecar is removed at a known config location, the local index recreates it with the same UUID. Retain the sidecar or explicit ID when moving to a new location. The index uses the config directory only for lookup; profile storage is keyed by the persistent UUID.

## Migration

On first profile access, MTC merges both the current `stateDir/account-profiles.json` and the historical `~/.mobile-test-console/<configured-project-id>/account-profiles.json`, when present. Source files stay intact. Successful source paths are recorded in the durable state, so restarting MTC preserves later deletions and edits. The UI reports migrated source paths.

For other historical locations, select their `account-profiles.json` through **选择导入文件** and confirm the merge. The importer supports v1 single-provider profiles and v2 aggregate profiles. It validates the complete file before writing. Different profiles with the same ID receive deterministic suffixed IDs, preserving both versions; importing the same content repeatedly is idempotent. Imported active recordings are finalized as failed, since their original device session cannot resume through a file import.

`stateDir` continues to configure task and business-script state. Page parameters share the persistent project UUID and use a separate [page-parameter vault](page-parameter-storage.md). `accountProfiles.statePath` in Provider, Runner and repair commands resolves to the durable account profile file. Repair snapshots copy that file into the protected snapshot directory.

## Backups and recovery

- Each changed write first saves the previous complete file under `backups/`. The first write saves an initial snapshot; existing valid files without backups receive one on first access. Identical writes create no extra backup. Backups are retained without automatic pruning.
- Profile mutations use a cross-process lock, exclusive temporary files, flush-to-disk and atomic replacement. Files use mode `0600`; new private directories use `0700`. Windows access control follows the user directory's ACLs.
- Missing or corrupt main files recover from the newest valid backup when available. Corrupt bytes are retained, and a persistent warning asks the user to verify recent changes. An unsupported future schema version fails without automatic replacement.
- Without a valid backup, corrupt state blocks normal writes and preserves the file. Explicit import can recover it and backs up the original bytes first.
- **合并恢复** merges a selected backup into current state. It restores missing profiles and preserves conflicting current versions. Current state is backed up before the merge.
- **导出画像** downloads profiles and recording history. Export contains login credentials; normal list and backup metadata APIs return summaries. Import accepts at most 20 MiB per request. Internal migration paths and notices are excluded from exported files.

Automatic backups share the same disk as the main vault. Keep periodic exports in a separately protected backup location for device replacement and disk-loss recovery. Project artifact cleanup and catalog removal preserve the vault.

## HTTP endpoints

All endpoints use the existing active-project routing (`x-mtc-project-id`).

| Operation | Endpoint |
| --- | --- |
| Summaries and backup metadata | `GET /api/account-profiles` |
| Explicit credential export | `GET /api/account-profiles/export` |
| Merge import | `POST /api/account-profiles/import` |
| Merge a backup | `POST /api/account-profiles/backups/:backupId/restore` |

Export uses `Cache-Control: no-store` and an attachment filename. Import and restore return `{ "ok": true }`; refresh summaries after success. Validation errors include field paths only.
