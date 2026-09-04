# Component Guidelines

> How components are built in this project.

---

## Overview

<!--
Document your project's component conventions here.

Questions to answer:
- What component patterns do you use?
- How are props defined?
- How do you handle composition?
- What accessibility standards apply?
-->

(To be filled by the team)

---

## Component Structure

<!-- Standard structure of a component file -->

(To be filled by the team)

---

## Props Conventions

<!-- How props should be defined and typed -->

(To be filled by the team)

---

## Styling Patterns

### Mini-program run-target binding

**Problem**: A test entry with one compatible run target still exposed a checkbox, allowing the user to clear the only executable environment. Collapsed retry rows could also hide an active descendant from the start-button busy check.

**Contract**:

- Filter configured targets through the selected test entry before choosing the interaction mode.
- One visible compatible target is automatically bound through `initializeSelectedTargetKeys()`. `TargetRow` renders a fixed accessible bound indicator and omits the checkbox.
- Two or more visible compatible targets keep explicit checkbox selection.
- Target status and start-button availability derive busy execution resources from raw `snapshot.tasks`, keyed by `target.concurrencyKey`. This includes active retry descendants hidden by the run-list projection.
- The start button disables while any selected target owns a busy concurrency key. `TARGET_BUSY` remains the server-side authority for stale browser snapshots.

```tsx
const autoBoundTarget = visibleTargets.length === 1;
const selectedTargetBusy = hasBusySelectedTarget(
  selectedKeys,
  configuredTargets,
  snapshot?.tasks ?? [],
);

<TargetRow autoBound={autoBoundTarget} />
<button disabled={selectedTargetBusy}>启动测试</button>
```

**Required regression checks**:

- A single target renders its label, platform, runtime, bound indicator, and current state without a checkbox.
- Multiple targets render operable checkboxes; a busy target keeps its checkbox disabled.
- An active retry descendant sharing the selected target's concurrency key disables start even when the run monitor collapses it into the source row.
- Empty selection and terminal retry tasks keep the busy predicate false.

### Viewport-owned application shell

**Problem**: A document-level scrollbar moves the top bar and project sidebar together with long workspace content.

**Contract**: The application shell owns the viewport. The project sidebar and main content are independent scroll containers inside the remaining shell height.

```css
html, body, #root { height: 100%; }
body { overflow: hidden; }

.app-shell {
  height: 100vh;
  height: 100dvh;
  display: grid;
  grid-template-rows: 76px minmax(0, 1fr);
  overflow: hidden;
}

.app-body {
  min-height: 0;
  overflow: hidden;
}

.app-project-sidebar,
.content {
  min-height: 0;
  overflow-y: auto;
  overscroll-behavior: contain;
}
```

The `100vh` declaration supplies the compatibility fallback and `100dvh` follows the dynamic mobile viewport. Every grid or flex child between `.app-shell` and `.content` keeps `min-height: 0`, which allows the content area to shrink within the viewport and activate its own scrollbar.

At `max-width: 640px`, `.app-body` becomes a column flex container. The sidebar uses an automatic bounded height and `.content` uses `flex: 1 1 auto` with `min-height: 0`.

**Required regression checks**:

- The document `scrollHeight` equals `clientHeight` and its `scrollTop` stays at `0` while workspace content scrolls.
- `.content.scrollTop` changes for long workspaces while the top bar and sidebar bounding positions stay stable.
- A `390px` viewport has equal document `scrollWidth` and `clientWidth`.
- `tests/web-layout.test.ts` preserves the CSS height and overflow contract.

### Result overview screenshot disclosure

**Problem**: Requiring users to leave the overview before seeing screenshots separates visual evidence from case and failure summaries.

**Contract**: A terminal result overview renders each test entry with its first screenshot thumbnail by default and provides an accessible show/hide control. Hidden previews are removed from the DOM so large runs do not retain image nodes. Preview images keep `loading="lazy"`, preserve the task-scoped artifact URL, and remain links to the original artifact. Additional screenshots are represented by a count badge and remain available in the screenshot tab.

`TaskDetail` and `ResultPanel` are shared by App and mini-program projects, so both project families use the same entry-and-thumbnail layout.

```tsx
<button aria-expanded={imagesVisible} aria-controls="analysis-run-list">
  {imagesVisible ? "隐藏图片" : "显示图片"}
</button>
{imagesVisible && (
  <RunScreenshotPreview taskId={taskId} run={run} />
)}
```

The disclosure state survives detail-tab changes for the same task and resets to visible when the selected task changes. The overview reuses the screenshot-tab gallery instead of maintaining a separate artifact renderer.

Keep the preview link beside the detail button so the markup does not nest interactive elements. The preview image defines the row height, preserves its intrinsic aspect ratio, and leaves the chevron in a dedicated trailing column.

```css
.analysis-run-summary.with-preview {
  grid-template-columns: minmax(0, 1fr) auto 24px;
}

.analysis-run-preview { height: 420px; }
.analysis-run-preview img { width: auto; height: 100%; object-fit: contain; }
.analysis-run-chevron { position: absolute; right: 4px; top: 50%; }

@media (max-width: 640px) {
  .analysis-run-preview { height: 330px; }
}
```

**Required regression checks**:

- Each test entry contains its own task-scoped image URL and the overview shows the hide action by default.
- Hiding the gallery changes `aria-expanded` to `false` and removes all `<img>` nodes.
- Entry previews sit beside the entry copy and make the preview image define the cell height. The image is rendered directly without a background block at `420px` high on desktop and `330px` high at a `390px` viewport. The disclosure chevron stays at the far-right edge and the page has no horizontal overflow.

### Screenshot comparison continuous browsing

**Problem**: Full-width rendering enlarges tall mobile screenshots beyond the usable viewport, while rendering only the selected pair makes every page transition depend on the navigation list.

**Contract**: The comparison stage renders every matched pair in one bounded scroll container. Pair sections preserve server order, use proximity scroll snapping, and update the navigation's `aria-current` item from the section offsets as the user scrolls. Navigation clicks and unmodified ArrowUp / ArrowDown key presses smoothly scroll the same container to the requested section. After the result pane filled the viewport, page-list items are buttons and screenshots sit in links, so arrow keys still switch pairs from those targets. Keyboard handling ignores only form fields and editable content (`input`, `select`, `textarea`, `contenteditable`), including the slider range input.

The `SCREENSHOT COMPARE` configuration starts expanded. Its heading keeps the page count visible and exposes an icon disclosure with `aria-expanded` and `aria-controls`; collapsing the controlled region gives the comparison stage more first-screen space without clearing either selection.

Comparison images preserve their intrinsic ratio with automatic width and a viewport-relative maximum height. The original artifact remains available through the image link. Side-by-side and slider modes share the same height limit, and images below the current viewport use native lazy loading.

```tsx
const nextKey = activeComparisonKeyAtOffset(positions, activationOffset);
stream.scrollTo({ top: pairElement.offsetTop, behavior: "smooth" });

<div className="screenshot-compare-pair-stream" onScroll={syncSelectedPairFromScroll}>
  {pairs.map(pair => <ComparisonPairView key={pair.key} pair={pair} />)}
</div>
```

**Required regression checks**:

- Scroll offsets select the first pair whose section top is at or before the activation threshold.
- The comparison container has bounded viewport height, vertical overflow, and proximity scroll snapping.
- Side-by-side and slider images share the viewport-relative maximum height and preserve original-artifact links.
- A real multi-page comparison can scroll from the first pair to the second while navigation `aria-current` follows.
- ArrowUp and ArrowDown select adjacent pairs from the page list and screenshot links, clamp at the first and last pair, and preserve native behavior in form fields.
- The configuration region is expanded by default and its disclosure exposes the controlled-region relationship.

### Result retry actions

Terminal results expose re-test actions at the scope where the evidence is visible. Every result module retries its own `caseRunId`; the overview toolbar retries every failed `caseRunId`. Module actions use a module-level pending key and disable repeated submission for the active request. The source task remains focused while the retry runs.

The browser submits case-run identifiers only. Result parsing, failed-status validation, and `caseId` / target-page projection remain server-owned so the UI does not duplicate the Result Bundle contract.

The run monitor collapses a retry chain to its root source row. The execution layer keeps each retry as an independent task/run for cancellation, artifacts, and audit. While a descendant retry is active, the source row and detail header display `正在重试`; retry, deletion, and retention controls remain disabled. Terminal retry results merge into the source detail in creation order, with passed items replacing their matching source items and unsuccessful items preserving the previous evidence. Deleting the source row after all retries finish removes the complete retry lineage.

### Project onboarding progressive disclosure

**Problem**: Rendering every failed check, configuration term, and remediation action at once makes first-time project onboarding difficult to follow.

**Contract**: `ProjectCatalogCard` derives the current task from the first unverified `PROJECT_EXECUTION_PREREQUISITE_STEP_IDS` entry. The current-task panel exposes one primary action and opens only that step. Raw tool output, issue strings, capability identifiers, and Provider details stay inside a nested `查看检查详情` disclosure.

```tsx
const nextStep = executionPrerequisites.find(step => step.status !== "verified");

{nextStep && <ProjectOnboardingNextAction step={nextStep} />}
{project.onboarding.map(step => (
  <details key={step.id} open={step.id === nextStep?.id}>
    {/* User goal and expected outcome stay visible here. */}
    <ProjectStepTechnicalDetails step={step} />
  </details>
))}
```

Action labels describe the user's task (`生成基础配置`, `重新检查运行环境`, `生成能力骨架`). Existing preview/apply and verification callbacks remain the write boundary. When every prerequisite is verified, the primary action switches to `运行第一条测试` and navigates through the existing workspace access model.

App, Lynx App, and mini-program projects share the same step structure. Project-family branches provide environment wording, guide paths, and setup actions. At `max-width: 640px`, the current-task controls occupy their own row and primary completion actions fill the available width.

For a mini-program environment step that is still waiting or blocked, the expanded step includes an inline `healthCheck` tutorial before the raw tool details. The tutorial is a complete copyable path for a first-time integrator: it names `mobile-test.config.cjs`, shows the `testing.targets[].healthCheck` object, provides the referenced `qa/mtc/health-check.cjs` script, explains exit-code behavior, identifies supported target placeholders, and points back to `重新检查运行环境`. The generated initialization plan writes the same config field and script path so manual and generated onboarding stay aligned.

```tsx
{miniProgram && step.id === "devices" && step.status !== "verified" && (
  <MiniProgramHealthCheckGuide onMessage={onMessage} />
)}
```

The copy action includes both snippets in one clipboard payload and reports success or failure through the workspace message channel. Code blocks use wrapping and bounded overflow so placeholder strings and local paths cannot expand the document width.

**Required regression checks**:

- The first unverified step supplies the current-task label and primary action.
- Technical tool and capability details remain present in the DOM under `查看检查详情`.
- A fully verified active project exposes `运行第一条测试`; the action opens the tests workspace.
- Mini-program and Lynx App cards render their family-specific environment and guide wording.
- A mini-program target without `healthCheck` renders the configuration object, script path, environment key, exit-code explanation, and an accessible copy action.
- Mini-program initialization writes `qa/mtc/health-check.cjs` and references it from `testing.targets[].healthCheck`.
- A `390px` viewport has equal document `scrollWidth` and `clientWidth`.

### Manual mini-program test-command wizard

The mini-program execution workspace exposes `添加自定义命令` as a single-page quick dialog. The default surface contains only `显示名称`, one-line `命令`, optional `说明`, a collapsed `高级设置`, and stable `取消 / 保存命令` actions. The project overview has no command-creation action.

The command field accepts familiar input such as `pnpm test:e2e:pickup-code-sort`. The shared tokenizer materializes `executable` and ordered `args`; it supports whitespace, single/double quotes, empty quoted arguments, and Windows/UNC backslashes. Compound shell operators and variable expansion render a field-level error while preserving the name and command values.

The editor selects all project targets by default, derives a unique schema-valid ID from the command, and defaults to `通用测试 / 自定义测试`. `高级设置` owns target selection, test kind, business type, project-relative `cwd`, environment rows, parameter definitions, page retry, and AI guidance. Parameter controls create `select`, `page-selection`, and `account-profile` definitions while showing `{{params.<参数ID>}}` usage.

Page tests display all three project integration keys: `MTC_RETRY_TARGET_PAGES`, `MTC_RETRY_CASE_IDS`, and `MTC_RETRY_CASE_RUN_IDS`. The user must check `我已确认项目脚本会读取重试范围` before saving. This gate makes page-scoped retry compatibility an explicit project contract.

`保存命令` calls preview and immediately applies an applicable plan. Validation or apply failure keeps every draft value. Success closes the dialog through the execution workspace callback, refreshes the snapshot, and selects the new entry. A failed apply may expose collapsed `保存详情` with target file, resolved command, working directory, warnings, and complete JSON. AI guidance carries environment names only until the server returns its redacted plan payload.

At `max-width: 640px`, the dialog uses `calc(100vw - 16px)`, collapses multi-column forms and the retry guide to one column, and gives footer actions stable equal-width tracks. At a `390px` viewport the document has no horizontal overflow, long paths and code wrap inside the dialog, the body owns vertical scrolling, and footer actions remain visible while advanced content scrolls.

**Required regression checks**:

- The execution workspace renders `添加自定义命令` for mini-program projects and opens one page containing name, command, optional description, and advanced settings.
- The project overview renders no command-creation action, state, prop chain, or duplicate wizard mount.
- The default draft selects all configured targets and uses `general / 自定义测试`; generated IDs satisfy the config schema and avoid both preset and custom IDs.
- Invalid command syntax and failed saves preserve the name, command, description, advanced values, and selected targets.
- Page entries cannot save until retry consumption is confirmed; general and flow entries skip that confirmation gate.
- Preview performs no test execution or project write; apply refreshes the project test list and selects the created entry.
- AI guidance contains the current MTC contract and target keys while environment values remain absent or `<redacted>`.
- A `390x844` browser viewport has equal document `scrollWidth` and `clientWidth`, readable footer actions, and no overlapping fields.

### Execution-workspace command confirmation

The mini-program execution workspace renders preset and custom entries in one accessible `select`. The visible label contains `预制` or `自定义`, followed by the optional business test type and entry label. `添加自定义命令` opens the shared `ProjectTestEntryWizard`; successful apply refreshes the runtime snapshot, selects the returned entry ID, reconciles target selection, and starts a fresh preview.

`ProjectCatalogWorkspace` may continue to export the shared wizard component, while its rendered project overview keeps onboarding and storage actions only. File ownership does not create a second user entry point.

The existing right-side description column owns command confirmation. One resolved target shows the complete command line, final `cwd`, environment names with `<redacted>` values, and a copy icon. Multiple targets show only the command count and `查看详情`; the current-page modal renders one complete block per target. A Runner-owned entry with an empty command list shows the Runner ID and remains startable.

```tsx
<select id="test-entry-select" aria-label="测试入口">...</select>
<TestCommandPreviewPanel preview={currentPreview} />
{detailsOpen && <TestCommandDetailsDialog commands={currentPreview.commands} />}
```

Preview requests are keyed by the serialized test ID, ordered target keys, and materialized parameters. Every effect cleanup aborts its request, and response state is accepted only when its request key still matches. Mini-program start remains disabled during loading and after parse errors; it becomes available for one-command-per-target responses and successful Runner-owned empty responses.

Command visibility starts with the test entry. When `selectedKeys` is empty, preview uses the intersection of the entry's supported target keys and the snapshot's configured targets. A user selection replaces that fallback range. A single supported target is selected once when its project-and-entry context becomes active; snapshot polling preserves subsequent user changes. Successful task start keeps the actual target selection so the displayed command remains available for repeated runs. Multi-target entries preserve explicit selection, and the start action always requires at least one actual selected target.

At `max-width: 640px`, the form becomes one column, command tokens use `white-space: pre-wrap` plus `overflow-wrap: anywhere`, and the detail dialog uses `calc(100vw - 16px)` with an independently scrolling body.

**Required regression checks**:

- The select has an explicit accessible name and every option exposes its source.
- The project overview contains no `添加测试命令` action while the execution workspace contains one `添加自定义命令` action.
- Single-target markup includes executable, ordered args, `cwd`, and redacted env keys.
- Multi-target summary keeps commands out of the base panel; the modal contains every target command.
- A stale preview response cannot replace state for a newer request key.
- Loading, parse errors, and missing target selection disable start; a successful custom Runner preview stays startable.
- An entry displays its supported command before explicit target selection; one supported target is selected automatically, while multi-target entries remain user-controlled.
- Starting a task preserves target selection and command visibility for the next run.
- Desktop and `390x844` browser runs have no horizontal overflow or overlapping command controls.

---

## Accessibility

<!-- A11y requirements and patterns -->

(To be filled by the team)

---

## Common Mistakes

### Allowing intrinsic content height to expand the shell

Using only `min-height: calc(100vh - <topbar>)` on `.app-body` allows long content to increase the document height. A fixed shell height plus `minmax(0, 1fr)`, `min-height: 0`, and explicit child overflow keeps scrolling inside the intended container.
