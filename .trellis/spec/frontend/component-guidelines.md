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

### Result retry actions

Terminal results expose re-test actions at the scope where the evidence is visible. Every result module retries its own `caseRunId`; the overview toolbar retries every failed `caseRunId`. Module actions use a module-level pending key and disable repeated submission for the active request. The source task remains focused while the retry runs.

The browser submits case-run identifiers only. Result parsing, failed-status validation, and `caseId` / target-page projection remain server-owned so the UI does not duplicate the Result Bundle contract.

The run monitor collapses a retry chain to its root source row. The execution layer keeps each retry as an independent task/run for cancellation, artifacts, and audit. While a descendant retry is active, the source row and detail header display `正在重试`; retry, deletion, and retention controls remain disabled. Terminal retry results merge into the source detail in creation order, with passed items replacing their matching source items and unsuccessful items preserving the previous evidence. Deleting the source row after all retries finish removes the complete retry lineage.

---

## Accessibility

<!-- A11y requirements and patterns -->

(To be filled by the team)

---

## Common Mistakes

### Allowing intrinsic content height to expand the shell

Using only `min-height: calc(100vh - <topbar>)` on `.app-body` allows long content to increase the document height. A fixed shell height plus `minmax(0, 1fr)`, `min-height: 0`, and explicit child overflow keeps scrolling inside the intended container.
