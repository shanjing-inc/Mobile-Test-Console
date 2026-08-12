import type { BusinessScriptDraft, BusinessScriptStep, PublishedBusinessScript } from "../shared/contracts";

export function sortPublishedBusinessScripts(scripts: PublishedBusinessScript[]): PublishedBusinessScript[] {
  return [...scripts].sort((left, right) => (
    left.scriptId.localeCompare(right.scriptId) || right.version - left.version
  ));
}

export function updateBusinessStepAction(
  step: BusinessScriptStep,
  actionType: BusinessScriptStep["actionType"],
): Partial<BusinessScriptStep> {
  return {
    actionType,
    inputBinding: actionType === "input"
      ? step.inputBinding ?? { strategy: "literal", value: "" }
      : step.inputBinding,
  };
}

export function updateBusinessScriptInputBinding(
  draft: BusinessScriptDraft,
  index: number,
  inputBinding: NonNullable<BusinessScriptStep["inputBinding"]>,
): BusinessScriptDraft {
  const previousBinding = draft.steps[index]?.inputBinding;
  const steps = draft.steps.map((step, current) => current === index ? { ...step, inputBinding } : step);
  let variables = draft.variables;
  const previousName = previousBinding?.value.trim() ?? "";
  if (previousBinding && previousBinding.strategy !== "literal" && previousName
    && !steps.some(step => step.inputBinding?.strategy !== "literal" && step.inputBinding?.value.trim() === previousName)) {
    variables = variables.filter(variable => variable.name !== previousName);
  }
  if (inputBinding.strategy === "literal" || !inputBinding.value.trim()) return { ...draft, steps, variables };
  const name = inputBinding.value.trim();
  const declaration = {
    name,
    strategy: inputBinding.strategy,
    sensitive: inputBinding.strategy === "secretRef",
  };
  const existingIndex = variables.findIndex(variable => variable.name === name);
  variables = existingIndex < 0
    ? [...variables, declaration]
    : variables.map((variable, current) => current === existingIndex ? declaration : variable);
  return { ...draft, steps, variables };
}
