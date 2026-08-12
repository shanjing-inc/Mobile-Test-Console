import type { PageParameterObservation, PageParameterPage } from "../shared/contracts";

export function resolveObservationPageId(pages: PageParameterPage[], observation: PageParameterObservation): string {
  const candidates = [observation.pageId, observation.bundle]
    .map(value => String(value || "").trim())
    .filter(Boolean);
  const normalized = candidates.map(value => value.replace(/\.bundle$/i, ""));
  return pages.find(page => candidates.includes(page.pageId)
    || candidates.includes(page.bundle)
    || normalized.includes(page.pageId.replace(/\.bundle$/i, ""))
    || normalized.includes(page.bundle.replace(/\.bundle$/i, "")))?.pageId ?? "";
}

export function latestPageObservations(
  pages: PageParameterPage[],
  observations: PageParameterObservation[],
): Map<string, PageParameterObservation> {
  const latest = new Map<string, PageParameterObservation>();
  for (const observation of observations) {
    const pageId = resolveObservationPageId(pages, observation);
    if (!pageId) continue;
    const previous = latest.get(pageId);
    if (!previous || previous.capturedAt <= observation.capturedAt) latest.set(pageId, observation);
  }
  return latest;
}
