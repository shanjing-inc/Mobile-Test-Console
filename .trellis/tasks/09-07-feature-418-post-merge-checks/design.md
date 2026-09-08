# Design

Delivery correction: use the existing integration worktree and branch. Preserve the previously reviewed commit in history with a regular merge after recording the integrated working files, allowing both the original remote branch and the existing PR head to advance without rewriting history. Personal logs remain untracked and local. For Codex resolution tests, stub environment and filesystem existence with automatic cleanup so precedence and fallback are exercised deterministically on every host OS.

Keep the runtime identity implementation already merged into main unchanged. Update its consumers: configuration examples, schema required fields, documentation, and fixtures. Resolve expected project roots with realpath in filesystem tests and keep plugin IDs independent of project IDs.

Create the injected theme parameter as a typed SelectParameterDefinition before insertion into the structural parameter array. This preserves the helper's input compatibility while checking the full object and cloning option records. Supply required fixture descriptions and cover repeated injection and option isolation.

Retain the reviewed scanner boundary correction with focused executable tests for actual local paths, harmless route segments, placeholder roots, and existing credential rules. Avoid widening exclusions or adding project-specific data.

Personal research and journals stay local in the existing FEATURE-418 worktree. This task contains generic reproducible contracts and verification records only. Add any durable testing lesson to the existing code specification.

Risks: canonical paths vary by OS; fixture expectations must use the same canonicalization contract. Scanner false negatives need focused negative-case coverage. Build tools must execute under the claimed Node version, including package-manager child processes.

## Compatibility and Rollback
No API signature, persisted state shape, runtime dependency, or business command changes. The generated schema merely matches the already-optional input in the source schema. Existing configured IDs remain accepted as compatibility input, and runtime IDs continue to come from canonical paths. The typed theme variable produces the same JavaScript object shape and preserves independent option records.

The narrower scanner boundary is preferred over excluding entire files or routes, so unrelated path and credential detections keep their coverage. Tests execute the production scanner in a temporary Git repository with synthetic markers and remove that fixture after completion.

Record the integrated working files on `feature/feature-418-screenshot-results`, then merge the previously reviewed follow-up commit with normal Git history. Advance that branch and the existing PR #3 head to the same tested tree. A later rollback uses a reviewed revert of the delivered follow-up changes; no project-state migration is required. Private research and journals remain local and excluded from publication.
