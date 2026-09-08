import { useRef, useState } from "react";
import type { AccountProfileStorageInfo } from "../shared/contracts";
import { exportAccountProfiles, importAccountProfiles, restoreAccountProfileBackup } from "./api";

export function AccountProfileBackupPanel({ storage, onChanged, onMessage }: {
  storage?: AccountProfileStorageInfo;
  onChanged: () => Promise<void>;
  onMessage: (message: { kind: "error" | "info"; text: string }) => void;
}) {
  const fileInput = useRef<HTMLInputElement>(null);
  const [pending, setPending] = useState(false);
  const [backupId, setBackupId] = useState("");
  const [importFile, setImportFile] = useState<{ name: string; data: unknown } | null>(null);
  const run = async (operation: () => Promise<void>) => {
    setPending(true);
    try { await operation(); } catch (error) {
      onMessage({ kind: "error", text: error instanceof Error ? error.message : "画像备份操作失败" });
    } finally { setPending(false); }
  };
  const download = () => run(async () => {
    const data = await exportAccountProfiles();
    const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: "application/json" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = `account-profiles-${new Date().toISOString().slice(0, 10)}.json`;
    link.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    onMessage({ kind: "info", text: "画像已导出，请妥善保存到受保护的备份位置" });
  });
  return <section className="section-panel account-backup-panel">
    <div className="section-heading"><h2>画像备份</h2><span className="count-label">{storage?.backups.length ?? 0} 份自动备份</span></div>
    <p>每次修改前自动备份。导入和恢复会保留现有画像，同名且内容不同的画像保存为副本。</p>
    <p>导出文件包含登录凭据，请保存在受保护的位置。更换电脑时可通过导入恢复。</p>
    <div className="account-backup-actions">
      <button type="button" className="secondary-button" disabled={pending} onClick={() => void download()}>导出画像</button>
      <button type="button" className="secondary-button" disabled={pending} onClick={() => fileInput.current?.click()}>选择导入文件</button>
      <input ref={fileInput} type="file" accept=".json,application/json" hidden aria-label="导入画像文件" onChange={event => {
        const file = event.target.files?.[0];
        event.target.value = "";
        if (!file) return;
        setImportFile(null);
        void run(async () => {
          if (file.size > 20 * 1024 * 1024) throw new Error("画像文件应小于 20 MiB");
          let data: unknown;
          try { data = JSON.parse(await file.text()); } catch { throw new Error("请选择有效的画像 JSON 文件"); }
          setImportFile({ name: file.name, data });
        });
      }} />
      <label className="field"><span>自动备份</span><select aria-label="自动备份" value={backupId} disabled={pending} onChange={event => setBackupId(event.target.value)}>
        <option value="">选择恢复时间</option>
        {storage?.backups.map(item => <option key={item.id} value={item.id}>{new Date(item.createdAt).toLocaleString()}</option>)}
      </select></label>
      <button type="button" className="secondary-button" disabled={pending || !backupId} onClick={() => void run(async () => {
        await restoreAccountProfileBackup(backupId);
        await onChanged();
        onMessage({ kind: "info", text: "已合并恢复备份，请核对画像列表" });
      })}>合并恢复</button>
    </div>
    {importFile && <div className="account-backup-actions"><span>{importFile.name}</span>
      <button type="button" className="primary-button" disabled={pending} onClick={() => void run(async () => {
        await importAccountProfiles(importFile.data);
        setImportFile(null);
        await onChanged();
        onMessage({ kind: "info", text: "画像已导入，同名冲突已保留为副本" });
      })}>确认合并导入</button>
      <button type="button" className="secondary-button" disabled={pending} onClick={() => setImportFile(null)}>取消</button>
    </div>}
    {storage && <details><summary>存储位置</summary><p>{storage.directory}</p>{storage.id && <p>项目持久标识：{storage.id}</p>}</details>}
  </section>;
}
