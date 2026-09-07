# Design

Keep the runtime identity implementation already merged into main unchanged. Update its consumers: configuration examples, schema required fields, documentation, and fixtures. Resolve expected project roots with realpath in filesystem tests and keep plugin IDs independent of project IDs.

Create the injected theme parameter as a typed SelectParameterDefinition before insertion into the structural parameter array. This preserves the helper's input compatibility while checking the full object and cloning option records. Supply required fixture descriptions and cover repeated injection and option isolation.

Retain the reviewed scanner boundary correction with focused executable tests for actual local paths, harmless route segments, placeholder roots, and existing credential rules. Avoid widening exclusions or adding project-specific data.

Original personal research and journals stay in the source worktree. This task contains generic reproducible contracts and verification records only. Add any durable testing lesson to the existing code specification.

Risks: canonical paths vary by OS; fixture expectations must use the same canonicalization contract. Scanner false negatives need focused negative-case coverage. Build tools must execute under the claimed Node version, including package-manager child processes.

## Compatibility and Rollback
No API signature, persisted state shape, runtime dependency, or business command changes. The generated schema merely matches the already-optional input in the source schema. Existing configured IDs remain accepted as compatibility input, and runtime IDs continue to come from canonical paths. The typed theme variable produces the same JavaScript object shape and preserves independent option records.

The narrower scanner boundary is preferred over excluding entire files or routes, so unrelated path and credential detections keep their coverage. Tests execute the production scanner in a temporary Git repository with synthetic markers and remove that fixture after completion.

The change is one independently revertible follow-up commit against the merged baseline. Reverting the commit restores documentation, schema, fixtures, and scanner behavior without modifying project state. The original worktree's uncommitted files remain untouched for recovery; its private research and journals are excluded from this public branch.
