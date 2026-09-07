# Implementation

1. Apply the reviewed 14-file tracked diff to the new worktree and keep the source worktree intact.
2. Run the Trellis implement agent for the theme type/fixture fixes and focused regression tests.
3. Install frozen dependencies and verify pnpm check with actual Node 18 and Node 22 runtimes.
4. Run the Trellis check agent over the complete diff and resolve findings within scope.
5. Record reusable contract assertions in the existing spec and audit public task artifacts.
6. Commit the approved changes with a Chinese FEATURE-418 message, push the dedicated branch and create a PR against main.

## Verification
Verified locally on macOS with pnpm 10.28.2:

| Runtime | Full `pnpm check` | `pnpm test:integrations` |
| --- | --- | --- |
| Node 18.20.7 | Passed: 49 test files / 483 tests, lint, schema, open-source scan, typecheck, build, package contents | Passed: 3 files / 13 tests |
| Node 22.23.2 | Passed: 49 test files / 483 tests, lint, schema, open-source scan, typecheck, build, package contents | Passed: 3 files / 13 tests |

Both package checks include 100 expected publishable files. Node versions were verified through `pnpm exec node` and lifecycle subprocess paths. The temporary Node 18 distribution was checked against its official SHA-256 manifest. UI rendering and business E2E flows are outside this documentation/type correction scope; hosted Linux CI is reported separately in the PR.

## Review
The independent Trellis review passed lint, typecheck, 92 focused tests, schema validation, open-source checks, and diff whitespace checks. It synchronized the existing scheduling specification with the shared FIFO implementation and runtime-local duplicate detection. No production scheduling code changed.

Existing coverage limitation: App cross-project FIFO and mini-program duplicate rejection are covered; direct mini-program FIFO cases for different tests and matching test IDs across projects are recorded in the specification as future regression coverage.

## Checkpoints
- Before migration: `git diff --binary | git apply --check` succeeds against the new baseline.
- After migration: compare the expected tracked file list and preserve the source diff.
- Before commit: `pnpm install --frozen-lockfile`, `pnpm check`, `pnpm test:integrations`, and `git diff --check`; run commands under explicitly selected Node versions and confirm `pnpm exec node --version` first.
- Before push: Trellis review is complete, privacy review includes newly added task artifacts, and only intended files are staged.
- After push: confirm the remote branch head matches the local commit, create the pull request against main, and report the actual CI state without waiting for external jobs.
- Rollback: revert the follow-up commit through the normal review flow; no data migration or project cleanup is needed.
