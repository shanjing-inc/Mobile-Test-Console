import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const styles = fs.readFileSync(path.resolve("src/web/styles.css"), "utf8");
const appSource = fs.readFileSync(path.resolve("src/web/App.tsx"), "utf8");

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
});
