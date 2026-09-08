import { z } from "zod";
import type { ProjectDataBackup } from "../shared/contracts.js";
import type { LoadedProjectConfig } from "./config.js";
import type { AccountProfileService } from "./account-profiles.js";
import type { PageParameterService } from "./page-parameters.js";
import { parseAccountProfileState } from "./account-profile-state-schema.js";
import { parsePageParameterState } from "./page-parameter-state-schema.js";
import { ConsoleError } from "./errors.js";

const backupSchema = z.object({
  schemaVersion: z.literal("mobile-test-console.project-data-backup.v1"),
  exportedAt: z.string().datetime({ offset: true }),
  project: z.object({ name: z.string() }),
  accountProfiles: z.unknown(),
  pageParameters: z.unknown(),
});

export async function exportProjectData(
  config: Pick<LoadedProjectConfig, "project">,
  accounts: Pick<AccountProfileService, "exportData">,
  pages: Pick<PageParameterService, "exportData">,
): Promise<ProjectDataBackup> {
  const [accountProfiles, pageParameters] = await Promise.all([accounts.exportData(), pages.exportData()]);
  return {
    schemaVersion: "mobile-test-console.project-data-backup.v1",
    exportedAt: new Date().toISOString(),
    project: { name: config.project.name },
    accountProfiles: portableState(accountProfiles),
    pageParameters: portableState(pageParameters),
  };
}

export async function importProjectData(
  value: unknown,
  accounts: Pick<AccountProfileService, "importData">,
  pages: Pick<PageParameterService, "importData">,
): Promise<void> {
  const incoming = parseImport(value);
  await accounts.importData(incoming.accountProfiles);
  if (incoming.pageParameters) {
    try { await pages.importData(incoming.pageParameters); } catch {
      // 两份存储分别提交；保留并发修改，通过幂等合并完成重试。
      throw new ConsoleError("PROJECT_DATA_IMPORT_PARTIAL", "账号画像已导入，页面参数尚未完全导入。请排除存储故障后重试同一备份文件。", 500);
    }
  }
}

function parseImport(value: unknown) {
  try {
    if (value && typeof value === "object" && "schemaVersion" in value
      && value.schemaVersion === "mobile-test-console.account-profile-state.v1") {
      return { accountProfiles: portableState(parseAccountProfileState(value)) };
    }
    const parsed = backupSchema.safeParse(value);
    if (!parsed.success) throw new Error("invalid backup");
    // 在第一次持久写入前校验整包；只传输可迁移字段，保留目标存储身份。
    return {
      accountProfiles: portableState(parseAccountProfileState(parsed.data.accountProfiles)),
      pageParameters: portableState(parsePageParameterState(parsed.data.pageParameters)),
    };
  } catch {
    throw new ConsoleError("PROJECT_DATA_BACKUP_INVALID", "项目数据备份格式无效，请选择完整的项目备份或旧版账号画像文件。", 400);
  }
}

function portableState<S extends string, P, R>(state: { schemaVersion: S; profiles: P[]; recordings: R[] }) {
  return { schemaVersion: state.schemaVersion, profiles: state.profiles, recordings: state.recordings };
}
