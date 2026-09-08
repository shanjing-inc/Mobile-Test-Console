import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import type { LoadedProjectConfig } from "./config.js";
import { ConsoleError } from "./errors.js";

export interface AccountProfileStorage {
  id: string;
  directory: string;
  legacyDirectories: string[];
}

const identitySchema = z.object({
  schemaVersion: z.literal("mobile-test-console.project-identity.v1"),
  storageId: z.string().uuid(),
}).strict();

export async function resolveAccountProfileStorage(input: {
  configPath: string;
  storageId?: string;
  stateDir: string;
  configuredProjectId?: string;
  userDataDir?: string;
}): Promise<AccountProfileStorage> {
  const userDataDir = input.userDataDir ?? path.join(os.homedir(), ".mobile-test-console");
  const configDirectory = await fs.realpath(path.dirname(input.configPath));
  const indexDirectory = path.join(userDataDir, "account-profile-identities");
  const indexPath = path.join(indexDirectory, `${createHash("sha256").update(configDirectory).digest("hex")}.json`);
  let id = input.storageId;
  if (!id) {
    const identityPath = path.join(path.dirname(input.configPath), "mobile-test.identity.json");
    try {
      id = identitySchema.parse(JSON.parse(await fs.readFile(identityPath, "utf8"))).storageId;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw new ConsoleError("ACCOUNT_STORAGE_IDENTITY_INVALID", `项目持久标识读取失败，请保留并检查 ${identityPath}`, 409);
      }
      const temporary = `${identityPath}.${randomUUID()}.tmp`;
      let nextId: string;
      try {
        nextId = identitySchema.parse(JSON.parse(await fs.readFile(indexPath, "utf8"))).storageId;
      } catch (indexError) {
        if ((indexError as NodeJS.ErrnoException).code !== "ENOENT") {
          throw new ConsoleError("ACCOUNT_STORAGE_IDENTITY_INVALID", `本机项目标识索引读取失败，请保留并检查 ${indexPath}`, 409);
        }
        nextId = randomUUID();
      }
      try {
        await fs.writeFile(temporary, `${JSON.stringify({ schemaVersion: "mobile-test-console.project-identity.v1", storageId: nextId }, null, 2)}\n`, { flag: "wx", mode: 0o600 });
        // 硬链接以排他方式发布完整文件，多个进程首次加载时沿用同一标识。
        await fs.link(temporary, identityPath).catch(error => {
          if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        });
        id = identitySchema.parse(JSON.parse(await fs.readFile(identityPath, "utf8"))).storageId;
      } finally {
        await fs.rm(temporary, { force: true });
      }
    }
  }
  id = z.string().uuid().parse(id);
  await fs.mkdir(indexDirectory, { recursive: true, mode: 0o700 });
  const indexContent = `${JSON.stringify({ schemaVersion: "mobile-test-console.project-identity.v1", storageId: id }, null, 2)}\n`;
  const existingIndex = await fs.readFile(indexPath, "utf8").catch(error => {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return "";
  });
  if (existingIndex !== indexContent) {
    const temporaryIndex = `${indexPath}.${randomUUID()}.tmp`;
    try {
      await fs.writeFile(temporaryIndex, indexContent, { flag: "wx", mode: 0o600 });
      await fs.rename(temporaryIndex, indexPath);
    } finally { await fs.rm(temporaryIndex, { force: true }); }
  }
  return {
    id,
    directory: path.join(userDataDir, "account-profiles", id),
    legacyDirectories: [...new Set([
      input.stateDir,
      ...(input.configuredProjectId ? [path.join(userDataDir, input.configuredProjectId)] : []),
    ])],
  };
}

export function accountProfileStatePath(config: LoadedProjectConfig): string {
  return path.join(config.accountProfileStorage?.directory ?? config.stateDir, "account-profiles.json");
}
