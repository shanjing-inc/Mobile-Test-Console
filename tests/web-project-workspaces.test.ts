import { describe, expect, it } from "vitest";
import {
  reconcileWorkspaceView,
  resolveWorkspaceViews,
  workspaceDisabledReason,
  type ProjectWorkspaceAccess,
} from "../src/web/project-workspaces.js";

const readyAccess: ProjectWorkspaceAccess = {
  hasProject: true,
  active: true,
  executionReady: true,
  runtimeReady: true,
  declaredWorkspaces: ["account-profiles", "page-parameters"],
};

describe("项目工作台注册", () => {
  it("始终按固定顺序展示五个项目入口", () => {
    expect(resolveWorkspaceViews()).toEqual([
      "projects",
      "tests",
      "page-parameters",
      "business-scripts",
      "account-profiles",
    ]);
  });

  it("接入中保留全部入口并将受限入口导航回项目概览", () => {
    const onboardingAccess = { ...readyAccess, executionReady: false };
    expect(workspaceDisabledReason("tests", onboardingAccess)).toBe("请先在项目概览中完成接入检查");
    expect(reconcileWorkspaceView("tests", onboardingAccess)).toBe("projects");
    expect(workspaceDisabledReason("projects", onboardingAccess)).toBeNull();
  });

  it("接入完成后按配置声明开放项目工具", () => {
    expect(workspaceDisabledReason("tests", readyAccess)).toBeNull();
    expect(workspaceDisabledReason("account-profiles", readyAccess)).toBeNull();
    expect(workspaceDisabledReason("business-scripts", readyAccess))
      .toContain("adapter.workspaces");
    expect(reconcileWorkspaceView("business-scripts", readyAccess)).toBe("projects");
  });

  it("小程序只开放项目概览与测试套件工作区", () => {
    expect(resolveWorkspaceViews("mini-program")).toEqual(["projects", "tests"]);
    expect(workspaceDisabledReason("page-parameters", { ...readyAccess, family: "mini-program" }))
      .toBe("小程序项目使用测试套件与结果报告工作区");
  });
});
