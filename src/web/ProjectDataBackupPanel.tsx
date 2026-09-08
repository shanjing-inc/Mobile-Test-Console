import { useRef, useState } from "react";
import { PROJECT_DATA_IMPORT_MAX_BYTES, type AccountProfileStorageInfo } from "../shared/contracts";
import { AccountProfileBackupPanel } from "./AccountProfileBackupPanel";
import { exportProjectData, importProjectData, restoreAccountProfileBackup } from "./api";

export function ProjectDataBackupPanel({ storage, onChanged, onMessage }: {
  storage?: AccountProfileStorageInfo;
  onChanged: () => Promise<boolean | void>;
  onMessage: (message: { kind: "error" | "info"; text: string }) => void;
}) {
  const fileInput = useRef<HTMLInputElement>(null);
  const [pending, setPending] = useState(false);
  const [importFile, setImportFile] = useState<{ name: string; data: unknown } | null>(null);
  const maxMiB = PROJECT_DATA_IMPORT_MAX_BYTES / 1024 / 1024;
  const run = async (operation: () => Promise<void>) => {
    setPending(true);
    try { await operation(); } catch (error) {
      onMessage({ kind: "error", text: error instanceof Error ? error.message : "项目数据备份操作失败" });
    } finally { setPending(false); }
  };
  const merge = async (operation: () => Promise<unknown>, message: string, onMerged?: () => void) => {
    try {
      await operation();
    } catch (error) {
      // 部分写入失败时刷新已完成的数据，并保留原始错误与待导入文件供重试。
      await onChanged().catch(() => {});
      throw error;
    }
    onMerged?.();
    const refreshed = await onChanged().catch(() => false);
    onMessage(refreshed === false
      ? { kind: "error", text: `${message}；列表刷新失败，请刷新页面核对数据` }
      : { kind: "info", text: `${message}，同名冲突已保留为副本` });
  };
  const download = () => run(async () => {
    const data = await exportProjectData();
    const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: "application/json" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = `project-data-${new Date().toISOString().slice(0, 10)}.json`;
    link.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    onMessage({ kind: "info", text: "项目数据已导出，请妥善保存到受保护的备份位置" });
  });
  return <section className="section-panel account-backup-panel project-data-backup-panel" aria-label="项目数据备份">
    <div className="section-heading"><h2>项目数据备份</h2></div>
    <p>一起导出当前项目的账号画像、页面参数、页面启动参数、操作与断言，以及账号和页面的录制历史。</p>
    <p>导入会合并到当前项目，保留现有数据，同名且内容不同的画像保存为副本。支持旧版账号画像导出文件，旧文件恢复其中的账号数据。</p>
    <p>导出文件包含登录凭据和页面参数，请保存在受保护的位置。导入文件最大 {maxMiB} MiB。</p>
    <div className="account-backup-actions">
      <button type="button" className="secondary-button" disabled={pending} onClick={() => void download()}>导出项目数据</button>
      <button type="button" className="secondary-button" disabled={pending} onClick={() => fileInput.current?.click()}>选择导入文件</button>
      <input ref={fileInput} type="file" accept=".json,application/json" hidden disabled={pending} aria-label="导入项目数据文件" onChange={event => {
        const file = event.target.files?.[0];
        event.target.value = "";
        if (!file) return;
        setImportFile(null);
        void run(async () => {
          if (file.size > PROJECT_DATA_IMPORT_MAX_BYTES) throw new Error(`项目数据文件最大 ${maxMiB} MiB`);
          let data: unknown;
          try { data = JSON.parse(await file.text()); } catch { throw new Error("请选择有效的项目数据或旧版账号画像 JSON 文件"); }
          setImportFile({ name: file.name, data });
        });
      }} />
    </div>
    {importFile && <div className="account-backup-actions"><span>{importFile.name}</span>
      <button type="button" className="primary-button" disabled={pending} onClick={() => void run(() => merge(
        () => importProjectData(importFile.data), "文件中的项目数据已导入", () => setImportFile(null),
      ))}>确认合并导入</button>
      <button type="button" className="secondary-button" disabled={pending} onClick={() => setImportFile(null)}>取消</button>
    </div>}
    {storage && <AccountProfileBackupPanel storage={storage} pending={pending} onRestore={backupId => run(() => merge(
      () => restoreAccountProfileBackup(backupId), "账号自动备份已合并恢复",
    ))} />}
  </section>;
}
