# Quality Guidelines

> Code quality standards for backend development.

---

## Overview

<!--
Document your project's quality standards here.

Questions to answer:
- What patterns are forbidden?
- What linting rules do you enforce?
- What are your testing requirements?
- What code review standards apply?
-->

(To be filled by the team)

---

## Forbidden Patterns

<!-- Patterns that should never be used and why -->

(To be filled by the team)

---

## Required Patterns

<!-- Patterns that must always be used -->

(To be filled by the team)

---

## Testing Requirements

<!-- What level of testing is expected -->

CLI-discovery unit tests control both environment variables and filesystem existence. Restore spies and environment stubs after every test so command-running integration tests still exercise the real filesystem.

For `resolveCodexExecutable(configured: string)`, assert these cases independently of applications installed on the host:

- Explicit non-bare commands pass through after trimming.
- An existing `CODEX_CLI_PATH` takes priority over bundled applications.
- Existing ChatGPT and Codex bundles are selected in that order; nonexistent candidates are skipped.
- When every candidate is absent, the result is the bare `codex` command.

Use synthetic existence results (for example, `vi.spyOn(fs, "existsSync")`) and `vi.stubEnv()` with teardown. An unconditional assertion of a bundled macOS path depends on the local workstation and fails on Linux CI.

---

## Code Review Checklist

<!-- What reviewers should check -->

(To be filled by the team)
