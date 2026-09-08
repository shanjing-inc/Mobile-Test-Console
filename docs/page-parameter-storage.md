# Page parameter storage and launch navigation

Page profiles and recording history live under `~/.mobile-test-console/page-parameters/<project-uuid>/page-parameters.json`. The UUID follows `project.storageId`, the `mobile-test.identity.json` sidecar beside config, or the existing local identity index. Account and page profiles share that identity and use separate data directories. A project with only `pageParameters` configured also receives persistent storage.

Keep the sidecar with the project config when moving a checkout. Runtime task IDs and task/artifact storage still follow the checkout path. Changing the persistent UUID selects a different profile vault.

## Migration and recovery

Config loading migrates page state before command execution. It checks the current runtime `stateDir` and the legacy directory associated with the configured `project.id`, preserves original files, and retains complete profiles and recordings. Profiles include parameter `values`, launch `navigation.route/params`, actions, and assertions.

Migration records source paths in the same atomic state write. Restarting preserves later edits and deletions. Profiles use the composite identity `(pageId, profileId)`. Conflicting versions receive deterministic suffixed IDs; the current default profile takes precedence. Identical profiles from multiple source directories share one migrated copy.

Every changed write first backs up the previous complete bytes under `page-parameter-backups/`. The first write creates an initial snapshot. Files have mode `0600`, new private directories have mode `0700`, and writes use a process-shared lock, exclusive temporary files, file flushes, and atomic replacement. Backup retention keeps all automatic copies.

Missing or corrupt main state recovers from the newest valid backup with a visible warning, retaining corrupt source bytes. Unsupported future state blocks automatic replacement. Permission and disk I/O errors propagate so that unreadable data cannot become an empty store. Corrupt legacy files stop migration and remain available for repair.

The original source and automatic backups remain on the same machine. Include the page vault in the user's protected off-device backup strategy for disk-loss recovery.

## Startup and replay

`pageParameters.statePath` resolves to the persistent page file in Runner, Provider, lifecycle, result, and target command templates. Direct page replay passes that same path through `--profiles`. Repair preparation copies it into the existing protected repair snapshot directory.

The browser carries launch navigation with the parameter draft. Selecting historical data, editing fields, moving between pages, saving, and replaying preserve that selected navigation. Applying a captured observation uses its navigation. An API update that omits `navigation` retains the existing profile navigation; an explicit `navigation` replaces it.

The page list displays migrated profiles and a migration notice. Historical field values and launch parameters are restored together.
