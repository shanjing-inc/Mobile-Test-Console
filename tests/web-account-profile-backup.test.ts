import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, expect, it, vi } from "vitest";
import { AccountProfileBackupPanel } from "../src/web/AccountProfileBackupPanel.js";
import { ProjectDataBackupPanel } from "../src/web/ProjectDataBackupPanel.js";
import { AccountProfilesWorkspace } from "../src/web/AccountProfilesWorkspace.js";
import { PageParametersWorkspace } from "../src/web/PageParametersWorkspace.js";
import {
  ApiError, exportAccountProfiles, exportProjectData, importAccountProfiles,
  importProjectData, restoreAccountProfileBackup, setApiProjectId,
} from "../src/web/api.js";

const storage = { id: "stable-id", directory: "/data/profiles/stable-id", backups: [{ id: "backup", createdAt: "2026-09-08T00:00:00Z" }] };
const callbacks = { onChanged: async () => {}, onMessage: () => {} };

afterEach(() => { vi.unstubAllGlobals(); setApiProjectId(""); });

it("项目备份静态界面说明完整范围、旧账号文件兼容与导入上限", () => {
  const html = renderToStaticMarkup(createElement(ProjectDataBackupPanel, { storage, ...callbacks }));
  for (const text of ["导出项目数据", "选择导入文件", "账号画像", "页面参数", "页面启动参数", "操作与断言", "账号和页面的录制历史", "登录凭据", "40", "MiB", "旧版账号画像导出文件", "保留现有数据"]) expect(html).toContain(text);
  expect(html).toContain('aria-label="导入项目数据文件"');
  expect(html).not.toContain("确认合并导入");
});

it("账号自动恢复明确账号范围，静态界面等待选择备份时间", () => {
  const html = renderToStaticMarkup(createElement(AccountProfileBackupPanel, {
    storage, pending: false, onRestore: async () => {},
  }));
  for (const text of ["账号自动备份", "恢复账号备份", "账号录制历史", "stable-id", "保留现有账号画像"]) expect(html).toContain(text);
  expect(html).toMatch(/disabled="">恢复账号备份/);
  expect(html).not.toContain("导出项目数据");
});

it("页面使用共享备份面板时隐藏账号本地备份恢复", () => {
  const html = renderToStaticMarkup(createElement(ProjectDataBackupPanel, callbacks));
  expect(html).toContain("导出项目数据");
  expect(html).not.toContain("恢复账号备份");
  expect(html).not.toContain("账号存储位置");
});

it.each([AccountProfilesWorkspace, PageParametersWorkspace])("两个工作区各提供一个统一项目备份入口：%s", Workspace => {
  const html = renderToStaticMarkup(createElement(Workspace, { devices: [], onMessage: () => {} }));
  expect(html.match(/>导出项目数据</g)).toHaveLength(1);
  expect(html.match(/aria-label="项目数据备份"/g)).toHaveLength(1);
});

it("项目备份请求绑定当前项目，导出禁用缓存，统一和旧版导入原样发送", async () => {
  const fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ ok: true }) });
  vi.stubGlobal("fetch", fetch);
  setApiProjectId("project-a");
  await exportProjectData();
  const legacy = { schemaVersion: "mobile-test-console.account-profile-state.v1", profiles: [], recordings: [] };
  const backup = {
    schemaVersion: "mobile-test-console.project-data-backup.v1", exportedAt: "2026-09-08T00:00:00Z",
    project: { name: "Source project" }, accountProfiles: legacy,
    pageParameters: { schemaVersion: "mobile-test-console.page-parameter-state.v1", profiles: [], recordings: [] },
  };
  await importProjectData(backup);
  await importProjectData(legacy);
  expect(fetch.mock.calls.map(call => call[0])).toEqual([
    "/api/project-data/export", "/api/project-data/import", "/api/project-data/import",
  ]);
  for (const [, init] of fetch.mock.calls) expect(init.headers.get("x-mtc-project-id")).toBe("project-a");
  expect(fetch.mock.calls[0][1].cache).toBe("no-store");
  for (const index of [1, 2]) expect(fetch.mock.calls[index][1].method).toBe("POST");
  expect(JSON.parse(fetch.mock.calls[1][1].body)).toEqual(backup);
  expect(JSON.parse(fetch.mock.calls[2][1].body)).toEqual(legacy);
});

it("项目导入保留服务端部分失败消息供界面提示重试", async () => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
    ok: false, status: 500,
    json: async () => ({ error: { code: "PROJECT_DATA_IMPORT_PARTIAL", message: "账号数据已导入；页面写入失败，请重试同一文件" } }),
  }));
  await expect(importProjectData({})).rejects.toEqual(new ApiError("PROJECT_DATA_IMPORT_PARTIAL", "账号数据已导入；页面写入失败，请重试同一文件"));
});

it("原账号备份请求保留项目绑定、缓存策略和恢复标识编码", async () => {
  const fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ ok: true }) });
  vi.stubGlobal("fetch", fetch);
  setApiProjectId("project-a");
  await exportAccountProfiles();
  const payload = { schemaVersion: "mobile-test-console.account-profile-state.v1", profiles: [], recordings: [] };
  await importAccountProfiles(payload);
  await restoreAccountProfileBackup("invalid/path");
  expect(fetch.mock.calls.map(call => call[0])).toEqual([
    "/api/account-profiles/export", "/api/account-profiles/import", "/api/account-profiles/backups/invalid%2Fpath/restore",
  ]);
  for (const [, init] of fetch.mock.calls) expect(init.headers.get("x-mtc-project-id")).toBe("project-a");
  expect(fetch.mock.calls[0][1].cache).toBe("no-store");
  expect(JSON.parse(fetch.mock.calls[1][1].body)).toEqual(payload);
  expect(fetch.mock.calls[2][1].method).toBe("POST");
});
