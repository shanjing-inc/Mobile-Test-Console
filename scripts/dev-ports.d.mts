export function assertPortsAvailable(ports: number[]): Promise<void>;
export function waitForPortsAvailable(ports: number[], options?: { timeoutMs?: number; intervalMs?: number }): Promise<void>;
export function isConsoleRunning(fetchImpl?: typeof fetch): Promise<boolean>;
