import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ProjectCatalogResponse } from "../src/shared/contracts.js";
import { ProjectDeleteConfirmation, ProjectSidebar } from "../src/web/App.js";
import { waitForProjectActivation } from "../src/web/api.js";
import { ProjectCatalogWorkspace } from "../src/web/ProjectCatalogWorkspace.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("项目目录工作区", () => {
  it("展示登记入口、当前项目和接入步骤", () => {
    const markup = renderToStaticMarkup(createElement(ProjectCatalogWorkspace, {
      catalog,
      loading: false,
      onRegister: vi.fn(),
      onSelectDirectory: vi.fn(),
      onSelectConfig: vi.fn(),
      onVerify: vi.fn(),
      onActivate: vi.fn(),
      onPreviewInitialization: vi.fn(),
      onApplyInitialization: vi.fn(),
      onPreviewSetup: vi.fn(),
      onApplySetup: vi.fn(),
      runtimeProjectId: "demo-lynx",
      onCloseAdd: vi.fn(),
      onMessage: vi.fn(),
    }));

    expect(markup).toContain("项目接入中心");
    expect(markup).toContain("当前运行项目");
    expect(markup).toContain("Lynx App");
    expect(markup).toContain("验证接入");
    expect(markup).toContain("项目目录");
    expect(markup).toContain("接入配置");
    expect(markup).toContain("设备环境");
    expect(markup).toContain("Android Platform Tools");
    expect(markup).toContain("配置引导");
    expect(markup).toContain("ANDROID_ADB_PATH");
    expect(markup).toContain("项目能力");
    expect(markup).toContain("能力清单");
    expect(markup).toContain("QA 包准备");
    expect(markup).toContain("qa.bundle.prepare");
    expect(markup).toContain("App 构建");
    expect(markup).toContain("app.install");
    expect(markup).toContain("账号预检");
    expect(markup).toContain("页面参数解析");
    expect(markup).toContain("结果分析");
    expect(markup).toContain("预览初始化配置");
  });

  it("添加项目使用独立页面并隐藏当前项目工作区", () => {
    const markup = renderToStaticMarkup(createElement(ProjectCatalogWorkspace, {
      catalog,
      loading: false,
      onRegister: vi.fn(),
      onSelectDirectory: vi.fn(),
      onSelectConfig: vi.fn(),
      onVerify: vi.fn(),
      onActivate: vi.fn(),
      onPreviewInitialization: vi.fn(),
      onApplyInitialization: vi.fn(),
      onPreviewSetup: vi.fn(),
      onApplySetup: vi.fn(),
      runtimeProjectId: "demo-lynx",
      addingProject: true,
      onCloseAdd: vi.fn(),
      onMessage: vi.fn(),
    }));

    expect(markup).toContain("添加项目");
    expect(markup).toContain("登记新的项目目录");
    expect(markup).toContain("取消添加");
    expect(markup).not.toContain("当前运行项目");
    expect(markup).not.toContain("项目接入状态");
    expect(markup).not.toContain("Demo Lynx");
  });

  it("添加模式下侧栏突出添加入口并取消项目选中态", () => {
    const sidebar = renderToStaticMarkup(createElement(ProjectSidebar, {
      catalog,
      selectedProjectId: "",
      runtimeProjectId: "demo-lynx",
      addingProject: true,
      onSelect: vi.fn(),
      onAdd: vi.fn(),
      onDelete: vi.fn(),
    }));

    expect(sidebar).toContain('aria-pressed="true"');
    expect(sidebar).not.toContain("app-project-item selected");
  });

  it("接入配置展示每个已声明测试入口的具体信息", () => {
    const catalogWithTestEntries = structuredClone(catalog);
    const templateStep = catalogWithTestEntries.projects[0].onboarding.find(step => step.id === "template");
    if (!templateStep) throw new Error("缺少接入配置步骤");
    templateStep.status = "verified";
    templateStep.summary = "配置已加载，声明 2 个测试入口";
    templateStep.issues = [];
    templateStep.testEntries = [
      {
        id: "lynx-suite",
        label: "Lynx 页面套件",
        description: "按优先级或页面范围执行三端 Lynx 确定性测试。",
        runnerId: "sample-lynx-app-runner",
        platforms: ["android", "ios", "harmony"],
        parameterLabels: ["测试套件", "参数环境", "测试账号"],
      },
      {
        id: "platform-oneclick",
        label: "平台 One-click",
        description: "构建、安装并执行当前设备的平台基础自动化测试。",
        runnerId: "sample-platform-oneclick-runner",
        platforms: ["android", "ios", "harmony"],
        parameterLabels: [],
      },
    ];

    const markup = renderToStaticMarkup(createElement(ProjectCatalogWorkspace, {
      catalog: catalogWithTestEntries,
      loading: false,
      onRegister: vi.fn(),
      onSelectDirectory: vi.fn(),
      onSelectConfig: vi.fn(),
      onVerify: vi.fn(),
      onActivate: vi.fn(),
      onPreviewInitialization: vi.fn(),
      onApplyInitialization: vi.fn(),
      onPreviewSetup: vi.fn(),
      onApplySetup: vi.fn(),
      runtimeProjectId: "demo-lynx",
      onCloseAdd: vi.fn(),
      onMessage: vi.fn(),
    }));

    expect(markup).toContain("测试入口清单");
    expect(markup).toContain("Lynx 页面套件");
    expect(markup).toContain("lynx-suite");
    expect(markup).toContain("sample-lynx-app-runner");
    expect(markup).toContain("Android · iOS · HarmonyOS");
    expect(markup).toContain("测试套件 · 参数环境 · 测试账号");
    expect(markup).toContain("平台 One-click");
    expect(markup).toContain("platform-oneclick");
    expect(markup).toContain("sample-platform-oneclick-runner");
    expect(markup).toContain("无需参数");
  });

  it("当前运行项目提供删除入口和页面内确认弹窗", () => {
    const sidebar = renderToStaticMarkup(createElement(ProjectSidebar, {
      catalog,
      selectedProjectId: "demo-lynx",
      runtimeProjectId: "demo-lynx",
      onSelect: vi.fn(),
      onAdd: vi.fn(),
      onDelete: vi.fn(),
    }));
    const confirmation = renderToStaticMarkup(createElement(ProjectDeleteConfirmation, {
      project: catalog.projects[0],
      runtimeProjectId: "demo-lynx",
      pending: false,
      onCancel: vi.fn(),
      onConfirm: vi.fn(),
    }));

    expect(sidebar).toContain('title="删除项目：Demo Lynx"');
    expect(sidebar).toContain('aria-label="删除项目：Demo Lynx"');
    expect(confirmation).toContain('role="dialog"');
    expect(confirmation).toContain("当前控制台继续使用已加载的项目配置");
    expect(confirmation).toContain("项目目录、配置文件和测试数据会保留");
    expect(confirmation).toContain(">取消<");
    expect(confirmation).toContain(">删除<");
  });

  it("平台壳中删除目录历史活动项目时按未加载项目说明", () => {
    const confirmation = renderToStaticMarkup(createElement(ProjectDeleteConfirmation, {
      project: catalog.projects[0],
      runtimeProjectId: "mobile-test-console",
      pending: false,
      onCancel: vi.fn(),
      onConfirm: vi.fn(),
    }));

    expect(confirmation).not.toContain("当前控制台继续使用已加载的项目配置");
  });

  it("目录历史活动项目在平台壳中可切换运行", () => {
    const markup = renderToStaticMarkup(createElement(ProjectCatalogWorkspace, {
      catalog,
      loading: false,
      onRegister: vi.fn(),
      onSelectDirectory: vi.fn(),
      onSelectConfig: vi.fn(),
      onVerify: vi.fn(),
      onActivate: vi.fn(),
      onPreviewInitialization: vi.fn(),
      onApplyInitialization: vi.fn(),
      onPreviewSetup: vi.fn(),
      onApplySetup: vi.fn(),
      runtimeProjectId: "mobile-test-console",
      onCloseAdd: vi.fn(),
      onMessage: vi.fn(),
    }));

    expect(markup).toContain("切换运行项目");
    expect(markup).not.toContain("当前运行项目");
  });

  it("项目切换期间等待 API 重启并确认目标项目生效", async () => {
    const fetchMock = vi.fn()
      .mockRejectedValueOnce(new Error("API 正在重启"))
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ project: { id: "demo-lynx" } }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ project: { id: "next-project" } }),
      });
    vi.stubGlobal("fetch", fetchMock);

    await expect(waitForProjectActivation("next-project", { attempts: 3, delayMs: 50 })).resolves.toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
});

const catalog: ProjectCatalogResponse = {
  schemaVersion: "mobile-test-console.project-catalog.v1",
  activeProjectId: "demo-lynx",
  projects: [{
    id: "demo-lynx",
    name: "Demo Lynx",
    root: "/tmp/demo-lynx",
    configPath: "/tmp/demo-lynx/mobile-test.config.cjs",
    integrationType: "lynx-app",
    platforms: ["android", "ios"],
    active: true,
    createdAt: "2026-08-07T00:00:00.000Z",
    updatedAt: "2026-08-07T00:00:00.000Z",
    onboarding: [
      { id: "project", status: "verified", summary: "项目目录已登记", issues: [], checkedAt: "2026-08-07T00:00:00.000Z" },
      { id: "template", status: "waiting", summary: "等待项目写入接入配置", issues: ["缺少配置文件"], checkedAt: "2026-08-07T00:00:00.000Z" },
      { id: "devices", status: "blocked", summary: "设备工具链需要处理", issues: ["Android Platform Tools：adb 不可用"], checkedAt: "2026-08-07T00:00:00.000Z", tools: [{ id: "android-adb", label: "Android Platform Tools", executable: "adb", status: "blocked", path: "", version: "", detail: "找不到 adb", guidance: ["设置 ANDROID_ADB_PATH=/path/to/adb"] }] },
      { id: "capabilities", status: "verified", summary: "已检测到 6 项项目能力", issues: [], checkedAt: "2026-08-07T00:00:00.000Z", capabilities: [
        { id: "qa.bundle.prepare", label: "QA 包准备", status: "ready", detail: "准备项目测试所需的 QA 包和资源。", guidance: [] },
        { id: "app.build", label: "App 构建", status: "ready", detail: "构建目标平台可安装的 QA App 包。", guidance: [] },
        { id: "app.install", label: "App 安装", status: "ready", detail: "将 QA App 安装到选定设备。", guidance: [] },
        { id: "account.preflight", label: "账号预检", status: "ready", detail: "测试执行前检查账号状态。", guidance: [] },
        { id: "page-parameters.resolve", label: "页面参数解析", status: "ready", detail: "解析页面路由和参数画像。", guidance: [] },
        { id: "result.analysis", label: "结果分析", status: "ready", detail: "生成结构化测试结果和证据。", guidance: [] },
      ] },
    ],
  }],
};
