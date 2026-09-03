import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

const PROJECT_SLUG_MAX_LENGTH = 48;

export async function canonicalProjectRoot(input: string): Promise<string> {
  const absolute = path.resolve(input);
  try {
    return await fs.realpath(absolute);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return absolute;
    throw error;
  }
}

export function projectIdFromRoot(root: string): string {
  const absolute = path.resolve(root);
  const slug = path.basename(absolute)
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, PROJECT_SLUG_MAX_LENGTH)
    .replace(/-+$/gu, "") || "project";
  const fingerprint = createHash("sha1").update(absolute).digest("hex").slice(0, 8);
  return `${slug}-${fingerprint}`;
}

export async function resolveProjectIdentity(input: string): Promise<{ id: string; root: string }> {
  const root = await canonicalProjectRoot(input);
  return { id: projectIdFromRoot(root), root };
}
