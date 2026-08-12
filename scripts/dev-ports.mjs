import { createServer } from "node:net";

export async function assertPortsAvailable(ports) {
  const occupied = [];
  for (const port of ports) {
    try {
      await probePort(port);
    } catch (error) {
      if (error && error.code === "EADDRINUSE") {
        occupied.push(port);
        continue;
      }
      throw error;
    }
  }
  if (occupied.length > 0) {
    throw new Error(`开发服务已在运行或端口被占用: ${occupied.join(", ")}。现有控制台地址: http://127.0.0.1:4311/`);
  }
}

export async function isConsoleRunning(fetchImpl = globalThis.fetch) {
  try {
    const response = await fetchImpl("http://127.0.0.1:4310/api/health", {
      signal: AbortSignal.timeout(1_000),
    });
    if (!response.ok) return false;
    const payload = await response.json();
    return payload && payload.ok === true;
  } catch {
    return false;
  }
}

function probePort(port) {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      server.close(error => error ? reject(error) : resolve());
    });
  });
}
