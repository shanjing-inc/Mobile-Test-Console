import type {
  ConsoleSnapshot,
  StartTasksRequest,
  StartTasksResponse,
  TestTask,
} from "../shared/contracts";

export class ApiError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
  }
}

async function request<T>(input: RequestInfo | URL, init?: RequestInit): Promise<T> {
  const response = await fetch(input, {
    ...init,
    headers: { "Content-Type": "application/json", ...(init?.headers || {}) },
  });
  const payload = await response.json().catch(() => null) as { error?: { code?: string; message?: string } } | T | null;
  if (!response.ok) {
    const error = payload && typeof payload === "object" && "error" in payload ? payload.error : undefined;
    throw new ApiError(String(error?.code || "REQUEST_FAILED"), String(error?.message || `请求失败: ${response.status}`));
  }
  return payload as T;
}

export function fetchSnapshot(): Promise<ConsoleSnapshot> {
  return request<ConsoleSnapshot>("/api/snapshot");
}

export function startTasks(body: StartTasksRequest): Promise<StartTasksResponse> {
  return request<StartTasksResponse>("/api/tasks", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

export function stopTask(taskId: string): Promise<{ task: TestTask }> {
  return request<{ task: TestTask }>(`/api/tasks/${encodeURIComponent(taskId)}/stop`, { method: "POST" });
}
