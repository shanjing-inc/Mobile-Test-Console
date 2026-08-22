import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_MTC_CONFIG, loadMtcConfig } from "../src/server/mtc-config.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true })));
});

describe("MTC 启动配置", () => {
  it("配置文件缺失时可以使用默认端口", async () => {
    const missingPath = path.join(os.tmpdir(), `mtc-missing-${Date.now()}`, "mtc.config.cjs");
    await expect(loadMtcConfig(missingPath, { optional: true })).resolves.toEqual(DEFAULT_MTC_CONFIG);
  });

  it("读取自定义端口并派生页面端口", async () => {
    const configPath = await writeConfig(`module.exports = { host: "0.0.0.0", port: 4500 };`);
    await expect(loadMtcConfig(configPath)).resolves.toEqual({ host: "0.0.0.0", port: 4500, webPort: 4501 });
  });

  it("拒绝非法端口", async () => {
    const configPath = await writeConfig(`module.exports = { port: 65535 };`);
    await expect(loadMtcConfig(configPath)).rejects.toMatchObject({ code: "CONFIG_INVALID" });
  });

  it("拒绝 API 与页面使用同一端口", async () => {
    const configPath = await writeConfig(`module.exports = { port: 4500, webPort: 4500 };`);
    await expect(loadMtcConfig(configPath)).rejects.toMatchObject({ code: "CONFIG_INVALID" });
  });

  it("显式配置文件缺失时返回读取错误", async () => {
    const missingPath = path.join(os.tmpdir(), `mtc-explicit-missing-${Date.now()}`, "mtc.config.cjs");
    await expect(loadMtcConfig(missingPath)).rejects.toMatchObject({ code: "CONFIG_LOAD_FAILED" });
  });
});

async function writeConfig(content: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mtc-startup-config-"));
  tempDirs.push(dir);
  const configPath = path.join(dir, "mtc.config.cjs");
  await fs.writeFile(configPath, content);
  return configPath;
}
