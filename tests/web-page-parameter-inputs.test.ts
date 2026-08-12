import { describe, expect, it } from "vitest";
import type { PageScenarioTarget } from "../src/shared/contracts.js";
import {
  buildPageInputActions,
  mergePageInputActions,
  pageInputTargets,
} from "../src/web/page-parameter-inputs.js";

const targets: PageScenarioTarget[] = [
  { id: "login.username", label: "账号", actions: ["input"] },
  { id: "login.password", label: "密码", actions: ["input"] },
  { id: "login.submit", label: "登录", actions: ["submit", "tap"] },
];

describe("页面输入动作", () => {
  it("从语义目标中筛选可输入项", () => {
    expect(pageInputTargets(targets).map(target => target.id)).toEqual([
      "login.username",
      "login.password",
    ]);
  });

  it("忽略空值并按目标声明顺序生成输入动作", () => {
    expect(buildPageInputActions(pageInputTargets(targets), {
      "login.password": " secret ",
    })).toEqual([
      { type: "input", target: "login.password", value: " secret " },
    ]);
  });

  it("保存时把输入动作放在提交动作之前", () => {
    expect(mergePageInputActions(pageInputTargets(targets), {
      "login.username": "13800138000",
      "login.password": "secret",
    }, [
      { type: "input", target: "legacy.input", value: "旧值" },
      { type: "submit", target: "login.submit" },
    ])).toEqual([
      { type: "input", target: "login.username", value: "13800138000" },
      { type: "input", target: "login.password", value: "secret" },
      { type: "submit", target: "login.submit" },
    ]);
  });
});
