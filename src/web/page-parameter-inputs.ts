import type { PageScenarioAction, PageScenarioTarget } from "../shared/contracts";

export function pageInputTargets(targets: PageScenarioTarget[] = []): PageScenarioTarget[] {
  return targets.filter(target => target.actions.includes("input"));
}

export function buildPageInputActions(
  targets: PageScenarioTarget[],
  values: Record<string, string>,
): PageScenarioAction[] {
  return targets.flatMap(target => {
    const value = String(values[target.id] ?? "");
    return value.trim() ? [{ type: "input" as const, target: target.id, value }] : [];
  });
}

export function mergePageInputActions(
  targets: PageScenarioTarget[],
  values: Record<string, string>,
  actions: PageScenarioAction[],
): PageScenarioAction[] {
  return [
    ...buildPageInputActions(targets, values),
    ...actions.filter(action => action.type !== "input"),
  ];
}
