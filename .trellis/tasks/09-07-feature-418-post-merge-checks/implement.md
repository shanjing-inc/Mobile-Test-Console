# Implementation

## Current delivery correction
Operate in the user's existing FEATURE-418 worktree. Apply the missing previously reviewed follow-up, fix the host-dependent Codex test through the implement agent, and have the check agent review the final delta. Run the complete checks under Node 18 and 22 here. Commit only approved code and sanitized task artifacts, merge the earlier reviewed commit with normal Git history, then advance the original branch and existing PR head to the same commit. Preserve local personal logs. The user's current instruction authorizes this direct commit/push delivery.

1. Preserve the 14 reviewed tracked changes and integrate the previously reviewed follow-up in the existing FEATURE-418 worktree.
2. Complete the Trellis implement and check reviews for theme fixtures and deterministic Codex executable regression tests.
3. Verify `pnpm check` with actual Node 18 and Node 22 runtimes in this integration directory.
4. Record reusable contract assertions in the existing spec and audit public task artifacts; keep personal research and journals untracked and local.
5. Commit approved files with a Chinese FEATURE-418 message on `feature/feature-418-screenshot-results`, then merge the previously reviewed follow-up commit through normal Git history.
6. Push the original branch and the existing PR #3 head to the same commit, preserving both histories.

## Verification
Verified in the existing FEATURE-418 worktree on macOS with pnpm 10.28.2:

| Runtime | Full `pnpm check` |
| --- | --- |
| Node 18.20.7 | Passed: 50 test files / 490 tests, lint, schema, open-source scan, typecheck, build, package contents |
| Node 22.23.2 | Passed: 50 test files / 490 tests, lint, schema, open-source scan, typecheck, build, package contents |

The full test suite includes the integration test files. Node versions were verified through `pnpm exec node` and lifecycle subprocess paths. The temporary Node 18 distribution was checked against its official SHA-256 manifest. UI rendering and business E2E flows are outside this documentation/type correction scope; hosted Linux CI is reported separately in PR #3.

## Review
The independent Trellis review in the original directory passed lint, typecheck, 19 focused resolver and repair tests, and diff whitespace checks. All 18 non-task files from the previously reviewed follow-up commit match byte-for-byte, preserving the original 14 changes, theme fixes, scanner coverage, and scheduling specification synchronization. The only additional code delta replaces the host-dependent Codex assertion with eight deterministic resolver cases; production resolution remains unchanged. Public task artifacts were inspected, and the private historical task and personal workspace journals remain untracked.

Existing coverage limitation: App cross-project FIFO and mini-program duplicate rejection are covered; direct mini-program FIFO cases for different tests and matching test IDs across projects are recorded in the specification as future regression coverage.

## Checkpoints
- Before integration: confirm the existing worktree and branch, reviewed 14-file scope, and local personal files.
- After integration: compare the existing files against the previously reviewed commit and inspect newly added files explicitly.
- Before commit: complete `pnpm check` under explicitly selected Node versions, confirm `pnpm exec node --version`, and run `git diff --check` plus `git diff --cached --check`.
- Before push: Trellis review is complete, privacy review includes newly added task artifacts, and only intended files are staged.
- After push: confirm the original remote branch and existing PR #3 head match the local commit, and report the actual CI state without waiting for external jobs.
- Rollback: revert the follow-up commit through the normal review flow; no data migration or project cleanup is needed.
