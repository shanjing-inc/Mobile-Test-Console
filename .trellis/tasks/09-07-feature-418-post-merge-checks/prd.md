# FEATURE-418 Post-merge contract checks

## Goal
Deliver the approved local follow-up to the merged screenshot-results work as a separate pull request against main. Align examples, documentation, generated schema and tests with existing path-derived project identity and per-project runtimes, then restore the TypeScript build gate.

## Scope
- Migrate the 14 reviewed tracked changes from the previous worktree, preserving its original files.
- Correct the theme parameter insertion type and complete the two TestDefinition fixtures.
- Verify the private-path scanner still detects real local paths and credentials while accepting route-like text.
- Publish clean task artifacts; preserve historical personal research and journals locally.

## Verified Background
The previous screenshot-results pull request is merged. Its source worktree contains a reviewed follow-up across README, onboarding documentation, three example configurations, the generated configuration schema, the open-source scanner, and seven configuration/runtime integration test files. Those changes have user approval for a separate follow-up pull request. The baseline for this task is main at a7c92dd.

`src/server/project-identity.ts` supplies `projectIdFromRoot` and canonical root resolution. `loadProjectConfig()` in `src/server/config.ts` already applies this identity. The public JSON Schema still required the legacy input ID, and several tests expected configured IDs or noncanonical temporary paths. On macOS, a temporary path may resolve through a filesystem alias; expected output paths must respect that behavior. Provider and Runner identifiers serve plugin registration, so fixture registration IDs must remain stable as the host assigns different project instance IDs.

`src/server/page-inspection-theme.ts` injects a select parameter into a structural array whose visible element type contains only id and type. The options property on its inline literal fails TypeScript excess-property checking. Two fixtures in `tests/page-inspection-theme.test.ts` additionally omit the required TestDefinition description. Existing runtime tests pass despite these three type errors because Vitest transpilation does not execute the full TypeScript check.

`scripts/check-open-source.mjs` scans Git-visible public text and detects local home-directory paths and credential markers. Relative page routes can contain the same home segment, so the reviewed path boundary correction needs executable coverage while preserving the credential checks. `package.json` pins pnpm 10.28.2, and CI runs the check pipeline with Node 18.20.7 and Node 22.

## Out of Scope
Business repositories, mini-program adapters, screenshot layout, browser or developer-tool window management, runtime identity algorithms, and historical task-state migration retain their existing behavior. This change does not publish old personal journals or research artifacts, upgrade dependencies, or merge the resulting pull request automatically.

## Acceptance
- [ ] Config accepts omitted legacy project.id; runtime identity uses the canonical project root. Schema validation and example loading exercise the same contract.
- [ ] Provider and Runner registration IDs remain stable across project instances; integration tests pass the generated project ID into run plans and results.
- [ ] Theme injection remains idempotent, preserves project overrides, and clones mutable options. Repeated calls and independent option mutation have regression assertions.
- [ ] Lint, full tests, schema generation check, open-source scan, build and package checks pass on Node 18 and 22 via `pnpm check`.
- [ ] Real path and synthetic credential fixtures fail the public scanner; approved route segments and placeholder roots pass.
- [ ] A dedicated branch and supplemental PR target main; the original dirty worktree remains recoverable and the new branch contains no personal local-path artifacts.

## Approval
The user approved this scope and commit/push/PR delivery in the FEATURE-418 review thread before implementation.
