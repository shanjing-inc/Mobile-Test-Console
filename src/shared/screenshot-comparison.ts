import type { TaskResult } from "./contracts.js";

export type ScreenshotComparisonPresence = "both" | "left-only" | "right-only";

export interface ScreenshotComparisonItemInput {
  caseId: string;
  label: string;
  targetPage?: string;
  artifactId: string;
}

export interface ScreenshotComparisonPairing {
  key: string;
  caseId: string;
  label: string;
  title: string;
  presence: ScreenshotComparisonPresence;
  left: ScreenshotComparisonItemInput | null;
  right: ScreenshotComparisonItemInput | null;
}

export function screenshotComparisonKey(caseId: string, label: string): string {
  return `${caseId.trim() || "_"}::${label.trim()}`;
}

export function projectDirectoryName(root: string): string {
  const segments = root.replace(/[\\/]+$/, "").split(/[\\/]/);
  return segments.at(-1) || root;
}

export function parseScreenshotComparisonTitle(label: string, targetPage = ""): string {
  const stem = label.replace(/\.(jpe?g|png|webp)$/i, "");
  const matched = stem.match(/^([A-Za-z0-9]+)(?:-(light|dark))?-(pages_.+)$/);
  if (matched) {
    const route = matched[3].replaceAll("_", "/");
    return matched[2] ? `${matched[1]} / ${matched[2]} / ${route}` : `${matched[1]} / ${route}`;
  }
  if (targetPage && targetPage !== stem) return stem ? `${stem} · ${targetPage}` : targetPage;
  return stem || label;
}

export function collectScreenshotComparisonItems(result: Pick<TaskResult, "runs">): ScreenshotComparisonItemInput[] {
  return result.runs.flatMap(run => run.screenshots.map(screenshot => ({
    caseId: run.caseId,
    label: screenshot.label,
    targetPage: run.targetPage,
    artifactId: screenshot.id,
  })));
}

export function pairScreenshotComparisonItems(
  left: ScreenshotComparisonItemInput[],
  right: ScreenshotComparisonItemInput[],
): ScreenshotComparisonPairing[] {
  const rightByKey = groupItems(right, item => screenshotComparisonKey(item.caseId, item.label));
  const usedRight = new Set<ScreenshotComparisonItemInput>();
  const pairs: ScreenshotComparisonPairing[] = [];

  for (const leftItem of left) {
    const key = screenshotComparisonKey(leftItem.caseId, leftItem.label);
    const rightItem = takeUnused(rightByKey.get(key), usedRight) ?? null;
    if (rightItem) usedRight.add(rightItem);
    pairs.push(toPair(key, leftItem, rightItem));
  }

  const unmatchedLeft = pairs.filter(pair => pair.presence === "left-only");
  const unmatchedRight = right.filter(item => !usedRight.has(item));
  const rightByLabel = groupItems(unmatchedRight, item => item.label.trim());

  for (const pair of unmatchedLeft) {
    const leftItem = pair.left!;
    const rightItem = takeUnused(rightByLabel.get(leftItem.label.trim()), usedRight);
    if (!rightItem) continue;
    usedRight.add(rightItem);
    pair.right = rightItem;
    pair.presence = "both";
    pair.key = screenshotComparisonKey(leftItem.caseId || rightItem.caseId, leftItem.label);
  }

  for (const rightItem of right) {
    if (usedRight.has(rightItem)) continue;
    pairs.push(toPair(screenshotComparisonKey(rightItem.caseId, rightItem.label), null, rightItem));
  }

  return pairs.sort(comparePairs);
}

function groupItems(
  items: ScreenshotComparisonItemInput[],
  keyOf: (item: ScreenshotComparisonItemInput) => string,
): Map<string, ScreenshotComparisonItemInput[]> {
  const grouped = new Map<string, ScreenshotComparisonItemInput[]>();
  for (const item of items) {
    const key = keyOf(item);
    const bucket = grouped.get(key);
    if (bucket) bucket.push(item);
    else grouped.set(key, [item]);
  }
  return grouped;
}

function takeUnused(
  bucket: ScreenshotComparisonItemInput[] | undefined,
  used: Set<ScreenshotComparisonItemInput>,
): ScreenshotComparisonItemInput | undefined {
  return bucket?.find(item => !used.has(item));
}

function toPair(
  key: string,
  left: ScreenshotComparisonItemInput | null,
  right: ScreenshotComparisonItemInput | null,
): ScreenshotComparisonPairing {
  const item = left ?? right!;
  return {
    key,
    caseId: left?.caseId || right?.caseId || item.caseId,
    label: item.label,
    title: parseScreenshotComparisonTitle(item.label, item.targetPage),
    presence: left && right ? "both" : left ? "left-only" : "right-only",
    left,
    right,
  };
}

function comparePairs(left: ScreenshotComparisonPairing, right: ScreenshotComparisonPairing): number {
  const presenceRank = { both: 0, "left-only": 1, "right-only": 2 };
  return presenceRank[left.presence] - presenceRank[right.presence]
    || left.title.localeCompare(right.title, "zh")
    || left.key.localeCompare(right.key);
}
