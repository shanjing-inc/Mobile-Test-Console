# FEATURE-418 Screenshot reader

## Goal
Let users inspect consecutive page screenshots inside the selected run, using a readable viewport-sized image, page directory, keyboard navigation, and continuous scrolling. Deliver the approved first increment in the existing FEATURE-418 worktree and branch, and update the existing PR.

## Background and verified facts
The user's screenshot shows the terminal run detail below the run monitor. Three columns of horizontal cards make tall mini-program images narrow, with substantial empty space. `ScreenshotResult` in `src/web/App.tsx` flattens each result run's screenshots into anchors that open separate browser tabs. `LiveScreenshotResult` uses the same gallery shape for active runs. The `.screenshot-item img` rule in `src/web/styles.css` uses a 16/10 aspect ratio with contain fitting. The images exist and load; this task improves their browsing experience.

`ScreenshotComparisonWorkspace.tsx` already provides a bounded scrolling stage, an independently scrolling page directory, selected-page tracking from section offsets, ArrowUp/ArrowDown navigation, and natural-ratio images constrained by available space. Helpers in `screenshot-comparison-scroll.ts` handle adjacent keys, boundaries and editable controls. Existing artifact URLs are task/project scoped through `taskArtifactUrl()`. Result scoping in `ResultPanel` filters a selected test run before passing screenshots to the gallery, and that filter must continue to apply.

The user approved the proposed first increment and explicitly requires continued development in the original 418 directory. The existing PR includes previously verified fixes. Personal historical task files and local journals remain outside the public change set.

## Requirements
- Default to a single-column page stream beside a compact page directory; retain a thumbnail overview toggle for quick visual scanning.
- Preserve artifact order and distinct entries for multiple screenshots belonging to one page or role. Use stable run/artifact identity rather than array positions.
- Show a useful title or page path and existing role/theme metadata when reliably available; keep the original artifact label accessible. Avoid inferring unsupported page identities from arbitrary filenames.
- Support previous/next buttons, directory clicks, ArrowUp/ArrowDown and natural vertical scrolling. The current page count and selected directory item stay synchronized. Shortcuts operate inside the reader and leave form editing unchanged.
- Fit whole images within the available area at their natural ratio. A focus action opens an opaque viewport-filling reading surface, removes surrounding run controls from the reading area, and provides an obvious exit plus Escape support. Selection and reading position survive entering/exiting focus and switching between overview and reader.
- Handle empty/loading/unreadable screenshots visibly; appended live screenshots preserve the current selected item. Keep original-image access as a secondary action.

## Out of scope
Image zoom/pan, search and role/theme filtering, image-diff algorithms, backend contracts, test execution, business adapters and dependency upgrades are later increments. Existing comparison behavior stays compatible.

## Acceptance
- [ ] Terminal and live screenshot entries use the reader while retaining task/project artifact URLs and selected-run scope.
- [ ] Directory, buttons, arrows and scrolling choose the same item; first/last boundaries are stable.
- [ ] Focus mode fills the viewport, exits via button/Escape, restores prior focus and preserves selection; controls have accessible names.
- [ ] Desktop and 390px layouts preserve aspect ratio without document horizontal overflow. Thumbnails open the corresponding reader page.
- [ ] Empty and failed-image states work, identity collisions retain distinct artifacts, and live appends do not jump the reader.
- [ ] Relevant unit tests, full pnpm check and real browser interaction/visual checks pass before commit and push from the existing branch.
