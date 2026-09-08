# Page parameter durability follow-up

## Boundaries

The runtime project ID and task/artifact state remain path-derived. Project profile data uses the UUID already established for account profiles. Shared identity resolution moves into a project-data module; account profile helpers retain their existing imports and directory format. Page data resides under `~/.mobile-test-console/page-parameters/<uuid>/`.

`LoadedProjectConfig.pageParameterStorage` carries the resolved directory and legacy candidates. `pageParameterStatePath(config)` owns every page-state path. Loaded configs initialize page migration before command consumers can execute; explicit in-memory test configs retain their given runtime directory when storage metadata is absent.

## Page state

`PageParameterStore` owns validation, migration markers, automatic backups, cross-process locking, atomic publication, and locked read/modify/write. Legacy migrations retain current versions and deterministic conflict copies keyed by `(pageId, profileId)`. Current default selection takes precedence when a legacy copy conflicts. Recording IDs are preserved or deterministically disambiguated. Operational read failures propagate and original data stays intact. Valid older backups can recover missing/corrupt state with notices.

`PageParameterService` uses locked update callbacks for mutations. Provider calls execute outside the storage lock; their results reconcile with the latest recording state. Saving an existing profile uses request navigation, then previous navigation, then catalog/default navigation.

## Browser drafts

Navigation belongs to the same page draft as parameter values. Applying historical profiles, applying observations, restoring page drafts, and editing fields preserve the selected navigation until another explicit source is selected. Saving and replaying materialize that draft navigation.

## Validation and recovery

Regression tests use synthetic values and temporary data roots. Live migration checks compare complete objects in memory and emit only counts/equality flags. Existing profile and recording source files are retained, automatic backup files are private, and runtime/task identity is unchanged. Rollback can reconnect the preserved legacy store; the persistent page vault remains recoverable independently.
