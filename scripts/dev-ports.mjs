import { createServer } from "node:net";

export async function assertPortsAvailable(ports, { host = "127.0.0.1" } = {}) {
  const occupied = [];
  for (const port of ports) {
    try {
      await probePort(port, host);
    } catch (error) {
      if (error && error.code === "EADDRINUSE") {
        occupied.push(port);
        continue;
      }
      throw error;
    }
  }
  if (occupied.length > 0) {
    const webPort = ports.length > 1 ? ports[1] : ports[0];
    throw new Error(`开发服务已在运行或端口被占用: ${occupied.join(", ")}。现有控制台地址: http://${host}:${webPort}/`);
  }
}

export async function waitForPortsAvailable(ports, { timeoutMs = 10_000, intervalMs = 100, host = "127.0.0.1" } = {}) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() <= deadline) {
    try {
      await assertPortsAvailable(ports, { host });
      return;
    } catch (error) {
      lastError = error;
    }
    await new Promise(resolve => setTimeout(resolve, intervalMs));
  }
  const detail = lastError instanceof Error ? lastError.message : String(lastError || "端口仍被占用");
  throw new Error(`等待开发服务端口释放超时: ${detail}`);
}

export async function isConsoleRunning(fetchImpl = globalThis.fetch, port = 4310, host = "127.0.0.1") {
  try {
    const response = await fetchImpl(`http://${formatFetchHost(host)}:${port}/api/health`, {
      signal: AbortSignal.timeout(1_000),
    });
    if (!response.ok) return false;
    const payload = await response.json();
    return payload && payload.ok === true;
  } catch {
    return false;
  }
}

function probePort(port, host) {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(port, host, () => {
      server.close(error => error ? reject(error) : resolve());
    });
  });
}

function formatFetchHost(host) {
  if (["0.0.0.0", "::", "[::]"].includes(host)) return "127.0.0.1";
  return host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
}
