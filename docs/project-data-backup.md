# Project data backup

The **项目数据备份** panel in both account and page workspaces exports the selected project's account profiles, page parameter profiles, full launch navigation, actions, assertions, and both recording histories in one JSON file. Exports contain login credentials and parameter values. Keep files in protected backup storage.

Select a JSON file, then choose **确认合并导入** to merge it into the current project. The shared import limit is 40 MiB. Old account-only exports are accepted and restore their account section. Source project names are informational; the destination keeps its own identity, directories, and migration metadata. Both persistent namespaces resolve when either profile provider is enabled, so imports remain available when another provider is enabled later.

## Portable format and API

```ts
{
  schemaVersion: "mobile-test-console.project-data-backup.v1",
  exportedAt: string,
  project: { name: string },
  accountProfiles: { schemaVersion: "mobile-test-console.account-profile-state.v1", profiles: [], recordings: [] },
  pageParameters: { schemaVersion: "mobile-test-console.page-parameter-state.v1", profiles: [], recordings: [] }
}
```

`GET /api/project-data/export` returns this format with `Cache-Control: no-store` and attachment filename `project-data-backup.json`. `POST /api/project-data/import` accepts the combined format or the previous account-only state format, and returns `{ "ok": true }` on completion. Both endpoints follow `x-mtc-project-id` or the existing project query parameter. Existing `/api/account-profiles/export` and `/import` retain their wire formats and 20 MiB import limit.

## Merge and failure behavior

The coordinator validates both complete sections before changing either store. Each store retains its existing lock, private automatic backups, and atomic file publication. Imports preserve existing records; differing records with the same identity receive deterministic suffixed IDs. Identical repeated imports remain idempotent. The destination's page default selection takes precedence. Imported active recordings become terminal and can be restarted through the recording UI.

The two stores commit separately. If account import completes and page import fails, the API returns `PROJECT_DATA_IMPORT_PARTIAL` (500), and the UI retains the selected file for retry. Resolve the storage failure and import the same file again; the idempotent merge completes remaining work while preserving concurrent edits. Invalid packages return `PROJECT_DATA_BACKUP_INVALID` (400); oversized requests return 413. Error responses omit raw file content.

The account workspace's **账号自动备份** controls restore account data from local account snapshots. Periodic combined exports provide portable recovery for both kinds of data.
