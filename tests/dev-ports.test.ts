import { createServer } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { assertPortsAvailable, isConsoleRunning } from "../scripts/dev-ports.mjs";

const servers: ReturnType<typeof createServer>[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => server.close(() => resolve()))));
});

describe("开发服务端口检查", () => {
  it("端口空闲时通过检查", async () => {
    await expect(assertPortsAvailable([0])).resolves.toBeUndefined();
  });

  it("端口占用时在项目准备前返回明确错误", async () => {
    const server = createServer();
    servers.push(server);
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("测试端口解析失败");

    await expect(assertPortsAvailable([address.port])).rejects.toThrow(`端口被占用: ${address.port}`);
  });

  it("健康检查成功时识别现有控制台", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }));

    await expect(isConsoleRunning(fetchMock)).resolves.toBe(true);
  });

  it("异常响应或连接失败时拒绝复用端口", async () => {
    const failedResponse = vi.fn(async () => new Response(JSON.stringify({ ok: false }), {
      status: 503,
      headers: { "Content-Type": "application/json" },
    }));
    const refused = vi.fn(async () => { throw new Error("ECONNREFUSED"); });

    await expect(isConsoleRunning(failedResponse)).resolves.toBe(false);
    await expect(isConsoleRunning(refused)).resolves.toBe(false);
  });
});
