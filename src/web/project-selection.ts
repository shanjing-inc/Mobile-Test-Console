export const SELECTED_PROJECT_SESSION_KEY = "mobile-test-console.selected-project-id";

export function readSelectedProjectId(storage?: Pick<Storage, "getItem">): string {
  try {
    const target = storage ?? (typeof window === "undefined" ? undefined : window.sessionStorage);
    return target?.getItem(SELECTED_PROJECT_SESSION_KEY)?.trim() ?? "";
  } catch {
    return "";
  }
}

export function saveSelectedProjectId(
  projectId: string,
  storage?: Pick<Storage, "setItem" | "removeItem">,
): void {
  try {
    const target = storage ?? (typeof window === "undefined" ? undefined : window.sessionStorage);
    if (!target) return;
    if (projectId) target.setItem(SELECTED_PROJECT_SESSION_KEY, projectId);
    else target.removeItem(SELECTED_PROJECT_SESSION_KEY);
  } catch {
    // Browsers may disable session storage for restricted contexts.
  }
}
