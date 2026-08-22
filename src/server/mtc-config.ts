import { createRequire } from "node:module";
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import { ConsoleError } from "./errors.js";

let importNonce = 0;

const mtcConfigSchema = z.object({
  host: z.string().trim().min(1).default("127.0.0.1"),
  port: z.number().int().min(1).max(65_535).default(4310),
  webPort: z.number().int().min(1).max(65_535).optional(),
}).default({}).refine(value => value.webPort !== undefined || value.port < 65_535, {
  message: "port 为 65535 时必须显式配置有效的 webPort",
}).refine(value => value.webPort === undefined || value.webPort !== value.port, {
  message: "port 与 webPort 必须使用不同端口",
}).transform(value => ({
  ...value,
  webPort: value.webPort ?? value.port + 1,
}));

export type MtcConfig = z.infer<typeof mtcConfigSchema>;
export type MtcConfigInput = z.input<typeof mtcConfigSchema>;

export const DEFAULT_MTC_CONFIG: MtcConfig = { host: "127.0.0.1", port: 4310, webPort: 4311 };

export async function loadMtcConfig(inputPath?: string, options: { optional?: boolean } = {}): Promise<MtcConfig> {
  const configPath = path.resolve(inputPath || path.join(process.cwd(), "mtc.config.cjs"));
  if (options.optional) {
    const exists = await fs.stat(configPath).then(stat => stat.isFile(), error => {
      if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return false;
      throw error;
    });
    if (!exists) return DEFAULT_MTC_CONFIG;
  }
  let imported: unknown;
  try {
    if (path.extname(configPath) === ".cjs") {
      const configRequire = createRequire(configPath);
      const resolved = configRequire.resolve(configPath);
      delete configRequire.cache[resolved];
      imported = configRequire(resolved);
    } else {
      importNonce += 1;
      imported = await import(`${pathToFileURL(configPath).href}?mtc=${Date.now()}-${importNonce}`);
    }
  } catch (error) {
    throw new ConsoleError("CONFIG_LOAD_FAILED", `读取 MTC 启动配置失败: ${configPath}\n${error instanceof Error ? error.message : String(error)}`);
  }
  const raw = (imported as { default?: unknown }).default ?? imported;
  const parsed = mtcConfigSchema.safeParse(raw);
  if (!parsed.success) {
    throw new ConsoleError("CONFIG_INVALID", `MTC 启动配置校验失败: ${parsed.error.issues.map(issue => `${issue.path.join(".") || "config"}: ${issue.message}`).join("; ")}`);
  }
  return parsed.data;
}
