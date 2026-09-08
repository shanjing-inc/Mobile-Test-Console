import { useState } from "react";
import type { AccountProfileStorageInfo } from "../shared/contracts";

export function AccountProfileBackupPanel({ storage, pending, onRestore }: {
  storage: AccountProfileStorageInfo;
  pending: boolean;
  onRestore: (backupId: string) => Promise<void>;
}) {
  const [backupId, setBackupId] = useState("");
  const selectedBackupExists = storage.backups.some(item => item.id === backupId);
  return <details>
    <summary>账号自动备份（{storage.backups.length} 份）</summary>
    <p>账号每次修改前自动备份。恢复范围为账号画像和账号录制历史，恢复时保留现有账号画像。</p>
    <div className="account-backup-actions">
      <label className="field"><span>账号自动备份</span><select aria-label="账号自动备份" value={selectedBackupExists ? backupId : ""} disabled={pending} onChange={event => setBackupId(event.target.value)}>
        <option value="">选择恢复时间</option>
        {storage.backups.map(item => <option key={item.id} value={item.id}>{new Date(item.createdAt).toLocaleString()}</option>)}
      </select></label>
      <button type="button" className="secondary-button" disabled={pending || !selectedBackupExists} onClick={() => void onRestore(backupId)}>恢复账号备份</button>
    </div>
    <details><summary>账号存储位置</summary><p>{storage.directory}</p>{storage.id && <p>项目持久标识：{storage.id}</p>}</details>
  </details>;
}
