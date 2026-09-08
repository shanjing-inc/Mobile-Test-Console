import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

let root: string;

beforeAll(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "mtc-open-source-"));
  await fs.mkdir(path.join(root, "scripts"));
  await fs.mkdir(path.join(root, "docs"));
  await fs.mkdir(path.join(root, "src"));
  await fs.copyFile(new URL("../scripts/check-open-source.mjs", import.meta.url), path.join(root, "scripts/check-open-source.mjs"));
  await fs.copyFile(new URL("../package.json", import.meta.url), path.join(root, "package.json"));
  execFileSync("git", ["init", "--quiet"], { cwd: root });
});

afterAll(async () => {
  if (root) await fs.rm(root, { recursive: true, force: true });
});

async function scan(content: string) {
  await fs.writeFile(path.join(root, "docs/fixture.md"), content);
  return spawnSync(process.execPath, [path.join(root, "scripts/check-open-source.mjs")], {
    cwd: root,
    encoding: "utf8",
  });
}

describe.each([
  { directory: "Users", label: "macOS 本机绝对路径" },
  { directory: "home", label: "Linux 本机绝对路径" },
])("open-source path scanner: $directory", ({ directory, label }) => {
  it.each(["", "path=", "\"", "`", "(", "file://"])("detects absolute paths after %j", async prefix => {
    const result = await scan(`${prefix}/${directory}/developer-fixture/workspace/project`);
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(1);
    expect(result.stderr.trim()).toBe(`- docs/fixture.md 包含${label}`);
  });

  it.each(["pages", "v2", "route.", "route_", "route-"])("accepts route-like segments after %s", async prefix => {
    const result = await scan(`${prefix}/${directory}/profile/index`);
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
  });

  it.each(["demo", "example", "user"])("accepts the %s placeholder root", async username => {
    const result = await scan(`/${directory}/${username}/workspace/project`);
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
  });
});

describe("open-source credential scanner", () => {
  const credentials = [
    { label: "AWS access key", value: "AKIA" + "0".repeat(16) },
    { label: "GitHub token", value: "ghp_" + "a".repeat(20) },
    { label: "npm token", value: "npm_" + "a".repeat(20) },
    ...["", "RSA ", "EC ", "OPENSSH "].map(kind => ({
      label: "private key",
      value: ["-----BEGIN", `${kind}PRIVATE KEY-----`].join(" "),
    })),
  ];

  it.each(credentials)("detects a synthetic $label marker", async ({ label, value }) => {
    const result = await scan(`credential=${value}`);
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(1);
    expect(result.stderr.trim()).toBe(`- docs/fixture.md 包含${label}`);
  });
});
