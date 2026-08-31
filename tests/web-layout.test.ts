import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const styles = fs.readFileSync(path.resolve("src/web/styles.css"), "utf8");
const appSource = fs.readFileSync(path.resolve("src/web/App.tsx"), "utf8");
const projectCatalogSource = fs.readFileSync(path.resolve("src/web/ProjectCatalogWorkspace.tsx"), "utf8");

function rule(selector: string): string {
  const escapedSelector = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = styles.match(new RegExp(`(?:^|\\n)${escapedSelector}\\s*\\{([^}]*)\\}`));
  expect(match, `缺少 ${selector} 样式规则`).not.toBeNull();
  return match?.[1] ?? "";
}

describe("控制台视口布局", () => {
  it("固定应用外框并让主内容独立滚动", () => {
    expect(rule("html, body, #root")).toContain("height: 100%");
    expect(rule("body")).toContain("overflow: hidden");

    const shellRule = rule(".app-shell");
    expect(shellRule).toContain("height: 100dvh");
    expect(shellRule).toContain("grid-template-rows: 76px minmax(0, 1fr)");
    expect(shellRule).toContain("overflow: hidden");

    const bodyRule = rule(".app-body");
    expect(bodyRule).toContain("min-height: 0");
    expect(bodyRule).toContain("overflow: hidden");

    const sidebarRule = rule(".app-project-sidebar");
    expect(sidebarRule).toContain("min-height: 0");
    expect(sidebarRule).toContain("overflow-y: auto");

    const contentRule = rule(".content");
    expect(contentRule).toContain("min-height: 0");
    expect(contentRule).toContain("overflow-y: auto");
  });

  it("在窄屏下保留固定外框和内容区滚动", () => {
    const mobileStyles = styles.slice(styles.indexOf("@media (max-width: 640px)"));
    expect(mobileStyles).toContain(".app-shell { grid-template-rows: 68px minmax(0, 1fr); }");
    expect(mobileStyles).toContain(".app-body { display: flex; flex-direction: column; min-height: 0; }");
    expect(mobileStyles).toContain(".content { flex: 1 1 auto; min-height: 0;");
  });

  it("测试条目截图与单元格等高并将箭头固定在最右侧", () => {
    expect(rule(".analysis-run-summary.with-preview")).toContain("grid-template-columns: minmax(0, 1fr) auto auto 24px");
    expect(rule(".analysis-run-preview")).toContain("height: 420px");
    expect(rule(".analysis-run-preview img")).toContain("height: 100%");
    expect(rule(".analysis-run-preview img")).not.toContain("background");
    expect(rule(".analysis-run-chevron")).toContain("right: 4px");

    const mobileStyles = styles.slice(styles.indexOf("@media (max-width: 640px)"));
    expect(mobileStyles).toContain(".analysis-run-summary.with-preview { grid-template-columns: minmax(0, 1fr) auto auto 18px;");
    expect(mobileStyles).toContain(".analysis-run-preview { height: 330px;");
  });

  it("详情标签栏在窄屏固定刷新入口并允许标签横向浏览", () => {
    const tabsRule = rule(".detail-tabs");
    expect(tabsRule).toContain("position: relative");

    const refreshRule = rule(".detail-tabs .detail-refresh");
    expect(refreshRule).toContain("position: absolute");
    expect(refreshRule).toContain("right: 0");
  });

  it("运行状态列表支持可访问的整体折叠", () => {
    expect(appSource).toContain('const [runListCollapsed, setRunListCollapsed] = useState(false)');
    expect(appSource).toContain('const [runListExpanded, setRunListExpanded] = useState(false)');
    expect(appSource).toContain('aria-controls="run-monitor-list"');
    expect(appSource).toContain('aria-expanded={!runListCollapsed}');
    expect(appSource).toContain('(runListExpanded ? tasks : tasks.slice(0, 5)).map');
    expect(appSource).toContain('tasks.length > 5 && <button className="run-list-more"');
    expect(rule(".run-list-toggle.collapsed svg")).toContain("transform: rotate(-90deg)");
    expect(rule(".run-list-more[aria-expanded=\"true\"] svg")).toContain("transform: rotate(180deg)");
  });

  it("小程序自定义命令使用单页快速表单和窄屏固定操作区", () => {
    expect(projectCatalogSource).toContain('id="project-test-entry-title">添加自定义命令');
    expect(projectCatalogSource).toContain("员工取件码排序验证");
    expect(projectCatalogSource).toContain("pnpm test:e2e:pickup-code-sort");
    expect(projectCatalogSource).toContain("说明（可选）");
    expect(projectCatalogSource).toContain("高级设置");
    expect(projectCatalogSource).toContain("默认选择项目声明的全部目标");
    expect(projectCatalogSource).toContain("保存命令");
    expect(projectCatalogSource).toContain("previewProjectTestEntry(projectId");
    expect(projectCatalogSource).toContain("applyProjectTestEntry(projectId");
    expect(projectCatalogSource).toContain("response.targets.map(target => target.key)");
    expect(projectCatalogSource).not.toContain("testEntrySteps");
    expect(projectCatalogSource).not.toContain("setStep(");
    expect(projectCatalogSource).toContain("MTC_RETRY_TARGET_PAGES");
    expect(projectCatalogSource).toContain("MTC_RETRY_CASE_IDS");
    expect(projectCatalogSource).toContain("我已确认项目脚本会读取重试范围");
    expect(projectCatalogSource).toContain('{{params.<参数ID>}}');
    expect(projectCatalogSource).toContain("AI 操作引导");
    expect(projectCatalogSource).not.toContain("scanTestCommandCandidates");
    expect(rule(".project-test-entry-dialog")).toContain("grid-template-rows: auto minmax(0, 1fr) auto");
    expect(rule(".project-test-entry-dialog")).toContain("max-height: min(820px, calc(100dvh - 32px))");
    expect(rule(".project-test-entry-body")).toContain("overflow-y: auto");
    const mobileStyles = styles.slice(styles.indexOf("@media (max-width: 640px)"));
    expect(mobileStyles).toContain(".project-test-entry-dialog { width: calc(100vw - 16px);");
    expect(mobileStyles).toContain(".project-test-entry-form.two-columns, .project-test-entry-form.three-columns { grid-template-columns: 1fr;");
    expect(mobileStyles).toContain(".project-test-entry-footer { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr));");
  });

  it("执行页展示来源与命令详情并约束长命令的窄屏宽度", () => {
    expect(appSource).toContain("添加自定义命令");
    expect(appSource).toContain("onClick={() => setTestEntryWizardOpen(true)}");
    expect(appSource).toContain("{testEntryWizardOpen && snapshot?.project.id && <ProjectTestEntryWizard");
    expect(projectCatalogSource).not.toContain("testEntryProjectId");
    expect(projectCatalogSource).not.toContain("onAddTestEntry");
    expect(projectCatalogSource).not.toContain("<ProjectTestEntryWizard");
    expect(appSource).toContain('htmlFor="test-entry-select"');
    expect(appSource).toContain('id="test-entry-select"');
    expect(appSource).toContain("previewTestCommands(request, controller.signal)");
    expect(appSource).toContain("current.requestKey === commandPreviewRequestKey");
    expect(appSource).toContain("initializeSelectedTargetKeys(previous, selectedTest, snapshot?.targets ?? [])");
    expect(appSource).toContain('initializedTargetSelectionContext.current = ""');
    expect(appSource).toContain("当前展示入口支持的命令；启动前请选择运行目标。");
    const startHandler = appSource.slice(appSource.indexOf("const handleStart = async"), appSource.indexOf("const handlePageSelectionMessage"));
    expect(startHandler).not.toContain("setSelectedKeys([])");
    expect(appSource).toContain("测试命令详情");
    expect(appSource).toContain('test.source === "custom" ? "自定义" : "预制"');
    expect(rule(".test-command-line")).toContain("white-space: pre-wrap");
    expect(rule(".test-command-line")).toContain("overflow-wrap: anywhere");
    expect(rule(".test-command-details-dialog")).toContain("max-height: min(760px, calc(100dvh - 32px))");
    expect(rule(".test-command-details-body")).toContain("overflow-y: auto");
    const mobileStyles = styles.slice(styles.indexOf("@media (max-width: 640px)"));
    expect(mobileStyles).toContain(".test-command-details-dialog { width: calc(100vw - 16px);");
    expect(mobileStyles).toContain(".test-command-preview-multiple { align-items: stretch; flex-direction: column;");
  });
});
