import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const styles = fs.readFileSync(path.resolve("src/web/styles.css"), "utf8");

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
});
