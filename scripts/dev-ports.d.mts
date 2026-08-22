export function assertPortsAvailable(ports: number[], options?: { host?: string }): Promise<void>;
export function waitForPortsAvailable(ports: number[], options?: { timeoutMs?: number; intervalMs?: number; host?: string }): Promise<void>;
export function isConsoleRunning(fetchImpl?: typeof fetch, port?: number, host?: string): Promise<boolean>;
