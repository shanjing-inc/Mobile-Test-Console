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

**Required regression checks**:

- Each test entry contains its own task-scoped image URL and the overview shows the hide action by default.
- Hiding the gallery changes `aria-expanded` to `false` and removes all `<img>` nodes.
- Desktop uses the existing multi-column gallery; a `390px` viewport uses one column without horizontal overflow.

---

## Accessibility

<!-- A11y requirements and patterns -->

(To be filled by the team)

---

## Common Mistakes

### Allowing intrinsic content height to expand the shell

Using only `min-height: calc(100vh - <topbar>)` on `.app-body` allows long content to increase the document height. A fixed shell height plus `minmax(0, 1fr)`, `min-height: 0`, and explicit child overflow keeps scrolling inside the intended container.
