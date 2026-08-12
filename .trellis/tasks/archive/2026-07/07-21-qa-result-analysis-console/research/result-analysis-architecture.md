# QA Result Analysis Architecture Research

## Existing Repository Capabilities

- `packages/lynx/scripts/qa/qa-lynx-test-report.cjs` already normalizes platform summaries into `qa.lynx.test-report.v1`.
- A normalized run contains status, device, page, scenario, screenshots, UI actions, runtime events, API calls, evidence files, and a failure log excerpt.
- The generated HTML already renders screenshot galleries and API request/response previews.
- `qa/history/artifacts/<run-id>/` contains platform summary JSON, screenshots, runtime JSON/JSONL, logs, UI hierarchy, and diagnostics.
- Current `mobile-test-console` stores task status and log tails only. Its project config has no result-provider or artifact-serving contract.
- Current API evidence is intentionally sanitized. Request fields use allowlisted previews; response bodies are available only when existing evidence producers captured a sanitized preview.

## Comparable Patterns

- Playwright Trace Viewer packages a normalized trace plus referenced assets and loads detail panels on demand.
- Allure separates test result metadata from attachments, with typed attachment references resolved by the report server.
- ReportPortal models launches, tests, logs, and attachments as separate resources and keeps large evidence outside list responses.

## Feasible Approaches

### A. Project Result Provider + Console Viewer (Recommended)

- The project config declares a trusted result command and an artifact root.
- The result command receives `task.runId` and returns a normalized JSON report.
- The console validates the report, exposes task-scoped result APIs, and serves referenced assets through path-contained endpoints.
- The Web task detail loads overview, screenshots, API calls, logs, and files on demand.
- This keeps Fanli parsing rules in Fanli and keeps the console reusable.

### B. Serve Existing Static HTML Report

- The console links or embeds the generated `index.html`.
- This is fast to deliver and already displays screenshots and API evidence.
- Navigation, permissions, loading state, and task integration remain separate from the console UI.

### C. Parse Fanli Artifacts Inside the Console

- The console scans platform-specific files directly.
- Initial integration is direct, while project-specific file names and schemas enter the generic console core.
- This conflicts with the current project-adapter boundary.

## Recommendation

Choose Approach A. Reuse the existing Fanli normalizer and HTML concepts while defining a small generic result/attachment contract in `mobile-test-console`.

## Security and Reliability Boundaries

- Resolve every attachment path under the configured artifact root and reject traversal or symlink escapes.
- Allow only known image/text/JSON content types and cap inline text/body sizes.
- Keep request/response evidence sanitized; mask tokens, cookies, authorization headers, passwords, phone numbers, and session identifiers.
- Load result details on demand so task snapshots remain small.
- Treat missing or malformed evidence as partial results and keep the main task record readable.
