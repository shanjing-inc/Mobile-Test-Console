export function activeComparisonKeyAtOffset(
  positions: Array<{ key: string; top: number }>,
  offset: number,
): string {
  let activeKey = positions[0]?.key ?? "";
  for (const position of positions) {
    if (position.top > offset) break;
    activeKey = position.key;
  }
  return activeKey;
}

export function adjacentComparisonKey(
  keys: string[],
  currentKey: string,
  direction: -1 | 1,
): string {
  if (keys.length === 0) return "";
  const currentIndex = keys.indexOf(currentKey);
  if (currentIndex < 0) return keys[0] ?? "";
  const nextIndex = Math.min(keys.length - 1, Math.max(0, currentIndex + direction));
  return keys[nextIndex] ?? "";
}

const COMPARISON_SHORTCUT_FORM_SELECTOR = "input, select, textarea, [contenteditable]:not([contenteditable='false'])";

export function shouldHandleComparisonShortcut(
  event: Pick<KeyboardEvent, "key" | "altKey" | "ctrlKey" | "metaKey" | "shiftKey">,
  target: { closest(selector: string): unknown; isContentEditable?: boolean } | null,
): boolean {
  if ((event.key !== "ArrowDown" && event.key !== "ArrowUp") || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) {
    return false;
  }
  if (target?.isContentEditable) return false;
  return !target?.closest(COMPARISON_SHORTCUT_FORM_SELECTOR);
}
