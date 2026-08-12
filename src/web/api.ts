import type {
  ConsoleSnapshot,
  ProjectConfigSelection,
  ProjectActivationResponse,
  ProjectCatalogResponse,
  ProjectCatalogDetailResponse,
  ProjectSetupApplyResponse,
  ProjectSetupPlan,
  PreviewProjectInitializationRequest,
  ApplyProjectInitializationRequest,
  ApplyProjectSetupRequest,
  RegisterProjectRequest,
  AccountProfileRecordingSummary,
  ArtifactCleanupPlan,
  ArtifactRetentionSnapshot,
  AccountProfileProvider,
  AccountProfileReplay,
  AccountProfileSourceResponse,
  AccountProfileSummary,
  AccountProfilesResponse,
  BusinessScriptDraft,
  BusinessScriptRecording,
  BusinessScriptReplay,
  BusinessScriptsResponse,
  BusinessSuite,
  PublishedBusinessScript,
  SaveBusinessScriptDraftRequest,
  PageParameterProfile,
  PageParameterReplay,
  PageParameterRecording,
  PageParametersResponse,
  RepairJob,
  RepairJobPreviewResponse,
  RepairJobsResponse,
  SavePageParameterProfileRequest,
  StartDeviceResponse,
  InstallDevicePreparationResponse,
  StartTasksRequest,
  StartTasksResponse,
  StartAccountProfileRecordingRequest,
  TaskResultResponse,
  TestTask,
} from "../shared/contracts";

export class ApiError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
  }
}

export function fetchAccountProfiles(): Promise<AccountProfilesResponse> {
  return request<AccountProfilesResponse>("/api/account-profiles");
}

export function fetchAccountProfileSource(profileId: string, provider: AccountProfileProvider): Promise<AccountProfileSourceResponse> {
  const query = new URLSearchParams({ provider });
  return request<AccountProfileSourceResponse>(`/api/account-profiles/${encodeURIComponent(profileId)}/source?${query}`);
}

export function fetchBusinessScripts(): Promise<BusinessScriptsResponse> {
  return request<BusinessScriptsResponse>("/api/business-scripts");
}

export function startBusinessScriptRecording(deviceKey: string, environment: string, appBuild: string): Promise<{ recording: BusinessScriptRecording }> {
  return request<{ recording: BusinessScriptRecording }>("/api/business-script-recordings", { method: "POST", body: JSON.stringify({ deviceKey, environment, appBuild }) });
}

export function fetchBusinessScriptRecording(recordingId: string): Promise<{ recording: BusinessScriptRecording }> {
  return request<{ recording: BusinessScriptRecording }>(`/api/business-script-recordings/${encodeURIComponent(recordingId)}`);
}

export function stopBusinessScriptRecording(recordingId: string): Promise<{ recording: BusinessScriptRecording; draft?: BusinessScriptDraft }> {
  return request<{ recording: BusinessScriptRecording; draft?: BusinessScriptDraft }>(`/api/business-script-recordings/${encodeURIComponent(recordingId)}/stop`, { method: "POST" });
}

export function saveBusinessScriptDraft(draftId: string, body: SaveBusinessScriptDraftRequest): Promise<{ draft: BusinessScriptDraft }> {
  return request<{ draft: BusinessScriptDraft }>(`/api/business-script-drafts/${encodeURIComponent(draftId)}`, { method: "PUT", body: JSON.stringify(body) });
}

export function publishBusinessScriptDraft(draftId: string): Promise<{ script: PublishedBusinessScript }> {
  return request<{ script: PublishedBusinessScript }>(`/api/business-script-drafts/${encodeURIComponent(draftId)}/publish`, { method: "POST" });
}

export function deletePublishedBusinessScriptVersion(scriptId: string, version: number): Promise<{
  script: PublishedBusinessScript;
  removedSuiteReferenceCount: number;
  removedSuiteCount: number;
}> {
  return request(`/api/business-scripts/${encodeURIComponent(scriptId)}/versions/${version}`, { method: "DELETE" });
}

export function saveBusinessSuite(suiteId: string, body: Omit<BusinessSuite, "suiteId" | "updatedAt">): Promise<{ suite: BusinessSuite }> {
  return request<{ suite: BusinessSuite }>(`/api/business-suites/${encodeURIComponent(suiteId)}`, { method: "PUT", body: JSON.stringify(body) });
}

export function replayBusinessScenario(scriptId: string, version: number, scenarioId: string, deviceKey: string): Promise<{ replay: BusinessScriptReplay }> {
  return request<{ replay: BusinessScriptReplay }>(`/api/business-scripts/${encodeURIComponent(scriptId)}/versions/${version}/scenarios/${encodeURIComponent(scenarioId)}/replay`, { method: "POST", body: JSON.stringify({ deviceKey }) });
}

export function replayBusinessSuite(suiteId: string, deviceKey: string): Promise<{ replays: BusinessScriptReplay[] }> {
  return request<{ replays: BusinessScriptReplay[] }>(`/api/business-suites/${encodeURIComponent(suiteId)}/replay`, { method: "POST", body: JSON.stringify({ deviceKey }) });
}

export function startAccountProfileRecording(body: StartAccountProfileRecordingRequest): Promise<{ recording: AccountProfileRecordingSummary }> {
  return request<{ recording: AccountProfileRecordingSummary }>("/api/account-profile-recordings", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

export function fetchAccountProfileRecording(recordingId: string): Promise<{ recording: AccountProfileRecordingSummary }> {
  return request<{ recording: AccountProfileRecordingSummary }>(`/api/account-profile-recordings/${encodeURIComponent(recordingId)}`);
}

export function stopAccountProfileRecording(recordingId: string): Promise<{ recording: AccountProfileRecordingSummary; profile?: AccountProfileSummary }> {
  return request<{ recording: AccountProfileRecordingSummary; profile?: AccountProfileSummary }>(`/api/account-profile-recordings/${encodeURIComponent(recordingId)}/stop`, { method: "POST" });
}

export function terminateAccountProfileRecording(recordingId: string): Promise<{ recording: AccountProfileRecordingSummary }> {
  return request<{ recording: AccountProfileRecordingSummary }>(`/api/account-profile-recordings/${encodeURIComponent(recordingId)}/terminate`, { method: "POST" });
}

export function replayAccountProfile(profileId: string, provider: AccountProfileProvider, deviceKey: string): Promise<{ replay: AccountProfileReplay }> {
  return request<{ replay: AccountProfileReplay }>(`/api/account-profiles/${encodeURIComponent(profileId)}/replay`, {
    method: "POST",
    body: JSON.stringify({ deviceKey, provider }),
  });
}

export function deleteAccountProfile(profileId: string): Promise<{ ok: true }> {
  return request<{ ok: true }>(`/api/account-profiles/${encodeURIComponent(profileId)}`, { method: "DELETE" });
}

async function request<T>(input: RequestInfo | URL, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers);
  if (init?.body != null && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }
  const response = await fetch(input, {
    ...init,
    headers,
  });
  const payload = await response.json().catch(() => null) as { error?: { code?: string; message?: string } } | T | null;
  if (!response.ok) {
    const error = payload && typeof payload === "object" && "error" in payload ? payload.error : undefined;
    throw new ApiError(String(error?.code || "REQUEST_FAILED"), String(error?.message || `请求失败: ${response.status}`));
  }
  return payload as T;
}

export function fetchSnapshot(refresh = false): Promise<ConsoleSnapshot> {
  return request<ConsoleSnapshot>(refresh ? "/api/snapshot?refresh=1" : "/api/snapshot");
}

export function fetchProjectCatalog(): Promise<ProjectCatalogResponse> {
  return request<ProjectCatalogResponse>("/api/projects");
}

export function fetchProjectCatalogDetail(projectId: string): Promise<ProjectCatalogDetailResponse> {
  return request<ProjectCatalogDetailResponse>(`/api/projects/${encodeURIComponent(projectId)}/detail`);
}

export function fetchArtifactRetention(): Promise<ArtifactRetentionSnapshot> {
  return request<ArtifactRetentionSnapshot>("/api/artifact-retention");
}

export function previewArtifactCleanup(): Promise<ArtifactCleanupPlan> {
  return request<ArtifactCleanupPlan>("/api/artifact-retention/preview", { method: "POST" });
}

export function inventoryArtifactCleanup(): Promise<ArtifactCleanupPlan> {
  return request<ArtifactCleanupPlan>("/api/artifact-retention/inventory", { method: "POST" });
}

export function applyArtifactCleanup(runIds?: string[]): Promise<ArtifactCleanupPlan> {
  return request<ArtifactCleanupPlan>("/api/artifact-retention/apply", {
    method: "POST",
    body: JSON.stringify(runIds ? { runIds } : {}),
  });
}

export function selectProjectCatalogDirectory(): Promise<ProjectConfigSelection> {
  return request<ProjectConfigSelection>("/api/projects/select-directory", { method: "POST" });
}

export function selectProjectConfigFile(): Promise<ProjectConfigSelection> {
  return request<ProjectConfigSelection>("/api/projects/select-config", { method: "POST" });
}

export function registerProject(body: RegisterProjectRequest): Promise<ProjectCatalogResponse> {
  return request<ProjectCatalogResponse>("/api/projects", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

export function previewProjectInitialization(body: PreviewProjectInitializationRequest): Promise<ProjectSetupPlan> {
  return request<ProjectSetupPlan>("/api/projects/setup/preview", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

export function applyProjectInitialization(body: ApplyProjectInitializationRequest): Promise<ProjectSetupApplyResponse> {
  return request<ProjectSetupApplyResponse>("/api/projects/setup/apply", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

export function previewProjectSetup(
  projectId: string,
  step: ApplyProjectSetupRequest["step"],
): Promise<ProjectSetupPlan> {
  return request<ProjectSetupPlan>(`/api/projects/${encodeURIComponent(projectId)}/setup/preview`, {
    method: "POST",
    body: JSON.stringify({ step }),
  });
}

export function applyProjectSetup(
  projectId: string,
  body: ApplyProjectSetupRequest,
): Promise<ProjectSetupApplyResponse> {
  return request<ProjectSetupApplyResponse>(`/api/projects/${encodeURIComponent(projectId)}/setup/apply`, {
    method: "POST",
    body: JSON.stringify(body),
  });
}

export function deleteProject(projectId: string): Promise<ProjectCatalogResponse> {
  return request<ProjectCatalogResponse>(`/api/projects/${encodeURIComponent(projectId)}`, { method: "DELETE" });
}

export function verifyProjectOnboarding(projectId: string): Promise<ProjectCatalogResponse> {
  return request<ProjectCatalogResponse>(`/api/projects/${encodeURIComponent(projectId)}/onboarding/verify`, {
    method: "POST",
  });
}

export function activateProject(projectId: string): Promise<ProjectActivationResponse> {
  return request<ProjectActivationResponse>(`/api/projects/${encodeURIComponent(projectId)}/activate`, {
    method: "POST",
  });
}

export async function waitForProjectActivation(
  projectId: string,
  options: { attempts?: number; delayMs?: number } = {},
): Promise<boolean> {
  const attempts = Math.max(1, options.attempts ?? 180);
  const delayMs = Math.max(50, options.delayMs ?? 500);
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const response = await fetch("/api/snapshot", { cache: "no-store" });
      if (response.ok) {
        const payload = await response.json().catch(() => null) as { project?: { id?: string } } | null;
        if (payload?.project?.id === projectId) return true;
      }
    } catch {
      // API 重启期间连接失败属于预期状态，继续轮询。
    }
    await new Promise(resolve => globalThis.setTimeout(resolve, delayMs));
  }
  return false;
}

export function startTasks(body: StartTasksRequest): Promise<StartTasksResponse> {
  return request<StartTasksResponse>("/api/tasks", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

export function startDevice(deviceKey: string): Promise<StartDeviceResponse> {
  return request<StartDeviceResponse>("/api/devices/start", {
    method: "POST",
    body: JSON.stringify({ deviceKey }),
  });
}

export function installDevicePreparation(deviceKey: string, preparationId: string): Promise<InstallDevicePreparationResponse> {
  return request<InstallDevicePreparationResponse>("/api/devices/preparations/install", {
    method: "POST",
    body: JSON.stringify({ deviceKey, preparationId }),
  });
}

export function stopTask(taskId: string): Promise<{ task: TestTask }> {
  return request<{ task: TestTask }>(`/api/tasks/${encodeURIComponent(taskId)}/stop`, { method: "POST" });
}

export function deleteTask(taskId: string): Promise<{ task: TestTask }> {
  return request<{ task: TestTask }>(`/api/tasks/${encodeURIComponent(taskId)}`, { method: "DELETE" });
}

export function setTaskRetained(taskId: string, retained: boolean): Promise<{ task: TestTask }> {
  return request<{ task: TestTask }>(`/api/tasks/${encodeURIComponent(taskId)}/retention`, {
    method: "PUT",
    body: JSON.stringify({ retained }),
  });
}

export function fetchRepairs(): Promise<RepairJobsResponse> {
  return request<RepairJobsResponse>("/api/repairs");
}

export function createRepairJob(taskId: string, caseRunId?: string, projectDirectory?: string): Promise<{ job: RepairJob }> {
  return request<{ job: RepairJob }>(`/api/tasks/${encodeURIComponent(taskId)}/repairs`, {
    method: "POST",
    body: JSON.stringify({ ...(caseRunId ? { caseRunId } : {}), ...(projectDirectory ? { projectDirectory } : {}) }),
  });
}

export function fetchRepairJobPreview(taskId: string, caseRunId?: string): Promise<RepairJobPreviewResponse> {
  return request<RepairJobPreviewResponse>(`/api/tasks/${encodeURIComponent(taskId)}/repairs/preview`, {
    method: "POST",
    body: JSON.stringify({ ...(caseRunId ? { caseRunId } : {}) }),
  });
}

export function selectRepairProjectDirectory(): Promise<{ projectDirectory: string }> {
  return request<{ projectDirectory: string }>("/api/repairs/select-project-directory", { method: "POST" });
}

export function cancelRepairJob(repairJobId: string): Promise<{ job: RepairJob }> {
  return request<{ job: RepairJob }>(`/api/repairs/${encodeURIComponent(repairJobId)}/cancel`, { method: "POST" });
}

export function retryRepairTest(repairJobId: string): Promise<{ job: RepairJob }> {
  return request<{ job: RepairJob }>(`/api/repairs/${encodeURIComponent(repairJobId)}/retry-test`, { method: "POST" });
}

export function openRepairTask(repairJobId: string): Promise<{ job: RepairJob }> {
  return request<{ job: RepairJob }>(`/api/repairs/${encodeURIComponent(repairJobId)}/open-task`, { method: "POST" });
}

export function fetchTaskResult(taskId: string, refresh = false): Promise<TaskResultResponse> {
  const suffix = refresh ? "?refresh=1" : "";
  return request<TaskResultResponse>(`/api/tasks/${encodeURIComponent(taskId)}/result${suffix}`);
}

export function taskArtifactUrl(taskId: string, artifactId: string): string {
  return `/api/tasks/${encodeURIComponent(taskId)}/artifacts/${encodeURIComponent(artifactId)}`;
}

export function fetchPageParameters(): Promise<PageParametersResponse> {
  return request<PageParametersResponse>("/api/page-parameters");
}

export function startPageParameterRecording(deviceKey: string, environment: string): Promise<{ recording: PageParameterRecording }> {
  return request<{ recording: PageParameterRecording }>("/api/page-parameter-recordings", {
    method: "POST",
    body: JSON.stringify({ deviceKey, environment }),
  });
}

export function fetchPageParameterRecording(recordingId: string): Promise<{ recording: PageParameterRecording }> {
  return request<{ recording: PageParameterRecording }>(`/api/page-parameter-recordings/${encodeURIComponent(recordingId)}`);
}

export function stopPageParameterRecording(recordingId: string): Promise<{ recording: PageParameterRecording }> {
  return request<{ recording: PageParameterRecording }>(`/api/page-parameter-recordings/${encodeURIComponent(recordingId)}/stop`, { method: "POST" });
}

export function replayPageParameterProfile(pageId: string, profileId: string, deviceKey: string): Promise<{ replay: PageParameterReplay }> {
  return request<{ replay: PageParameterReplay }>(`/api/page-parameters/${encodeURIComponent(pageId)}/profiles/${encodeURIComponent(profileId)}/replay`, {
    method: "POST",
    body: JSON.stringify({ deviceKey }),
  });
}

export function savePageParameterProfile(pageId: string, profileId: string, body: SavePageParameterProfileRequest): Promise<{ profile: PageParameterProfile }> {
  return request<{ profile: PageParameterProfile }>(`/api/page-parameters/${encodeURIComponent(pageId)}/profiles/${encodeURIComponent(profileId)}`, {
    method: "PUT",
    body: JSON.stringify(body),
  });
}

export function setDefaultPageParameterProfile(pageId: string, profileId: string, isDefault = true): Promise<{ profile: PageParameterProfile }> {
  return request<{ profile: PageParameterProfile }>(`/api/page-parameters/${encodeURIComponent(pageId)}/profiles/${encodeURIComponent(profileId)}/default`, {
    method: "POST",
    ...(isDefault ? {} : { body: JSON.stringify({ isDefault: false }) }),
  });
}

export function clearDefaultPageParameterProfile(pageId: string, profileId: string): Promise<{ profile: PageParameterProfile }> {
  return request<{ profile: PageParameterProfile }>(`/api/page-parameters/${encodeURIComponent(pageId)}/profiles/${encodeURIComponent(profileId)}/default`, {
    method: "DELETE",
  });
}

export function deletePageParameterProfile(pageId: string, profileId: string): Promise<{ ok: true }> {
  return request<{ ok: true }>(`/api/page-parameters/${encodeURIComponent(pageId)}/profiles/${encodeURIComponent(profileId)}`, { method: "DELETE" });
}
