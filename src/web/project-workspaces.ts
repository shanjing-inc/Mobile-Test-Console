import type { ProjectWorkspaceId } from "../shared/contracts";

export type WorkspaceView = "projects" | "tests" | ProjectWorkspaceId;

export const PROJECT_WORKSPACE_VIEWS: readonly WorkspaceView[] = [
  "projects",
  "tests",
  "page-parameters",
  "business-scripts",
  "account-profiles",
];

export interface ProjectWorkspaceAccess {
  hasProject: boolean;
  active: boolean;
  executionReady: boolean;
  runtimeReady: boolean;
  declaredWorkspaces: readonly ProjectWorkspaceId[];
}

export function resolveWorkspaceViews(): WorkspaceView[] {
  return [...PROJECT_WORKSPACE_VIEWS];
}

export function reconcileWorkspaceView(
  current: WorkspaceView,
  access: ProjectWorkspaceAccess,
): WorkspaceView {
  return workspaceDisabledReason(current, access) === null ? current : "projects";
}

export function workspaceDisabledReason(view: WorkspaceView, access: ProjectWorkspaceAccess): string | null {
  if (view === "projects") return null;
  if (!access.hasProject) return "请先添加项目并完成接入";
  if (!access.active) return "请先在项目概览中切换为当前运行项目";
  if (!access.executionReady) return "请先在项目概览中完成接入检查";
  if (!access.runtimeReady) return "正在加载当前项目运行配置";
  if (view !== "tests" && !access.declaredWorkspaces.includes(view)) {
    return `请在 mobile-test.config.cjs 的 adapter.workspaces 中声明 ${view}`;
  }
  return null;
}
