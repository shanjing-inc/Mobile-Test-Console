import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, expect, it, vi } from "vitest";
import { AccountProfileBackupPanel } from "../src/web/AccountProfileBackupPanel.js";
import { exportAccountProfiles, importAccountProfiles, restoreAccountProfileBackup, setApiProjectId } from "../src/web/api.js";

afterEach(() => { vi.unstubAllGlobals(); setApiProjectId(""); });

it("画像备份显示导入导出、凭据说明和恢复时间", () => {
  const html = renderToStaticMarkup(createElement(AccountProfileBackupPanel, {
    storage: { id: "stable-id", directory: "/data/profiles/stable-id", backups: [{ id: "backup", createdAt: "2026-09-08T00:00:00Z" }] },
    onChanged: async () => {}, onMessage: () => {},
  }));
  for (const text of ["导出画像", "选择导入文件", "合并恢复", "登录凭据", "1", "stable-id", "保留现有画像"]) expect(html).toContain(text);
});

it("所有备份请求绑定当前项目，导出禁用缓存，恢复标识编码", async () => {
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
