import type {
  AgentProfileDTO,
  BriefContent,
  BriefDTO,
  CreateOrOpenProjectInput,
  CreateTaskInput,
  DiscussMessageDTO,
  DiscussMessageInput,
  DiscussRound,
  ExecutionStateDTO,
  PlanDTO,
  ProjectSummary,
  ProviderId,
  ProviderStatus,
  ReorderTasksInput,
  RoutingRuleDTO,
  SettingsDTO,
  StartExecutionInput,
  TaskDTO,
  TaskRunDTO,
  UpdateTaskInput,
} from '@dalang/shared';

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    ...init,
    headers: {
      ...(init?.body ? { 'Content-Type': 'application/json' } : {}),
      ...init?.headers,
    },
  });

  const data = (await res.json().catch(() => ({}))) as { error?: string };
  if (!res.ok) {
    throw new Error(data.error || `Request failed (${res.status})`);
  }
  return data as T;
}

export const api = {
  // Projects
  listProjects: () => request<{ projects: ProjectSummary[] }>('/api/projects'),
  createOrOpenProject: (body: CreateOrOpenProjectInput) =>
    request<{ project: ProjectSummary }>('/api/projects', {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  getProject: (id: string) => request<{ project: ProjectSummary }>(`/api/projects/${id}`),
  deleteProject: (id: string) =>
    request<{ ok: boolean }>(`/api/projects/${id}`, { method: 'DELETE' }),
  updateProjectSettings: (
    id: string,
    body: { leadProvider?: ProviderId; leadModel?: string | null },
  ) =>
    request<{ project: ProjectSummary }>(`/api/projects/${id}/settings`, {
      method: 'PATCH',
      body: JSON.stringify(body),
    }),

  // PROJECT.md & symlinks
  getProjectMd: (id: string) =>
    request<{ content: string; symlinksValid: { claudeMd: boolean; agentsMd: boolean } }>(
      `/api/projects/${id}/project-md`,
    ),
  saveProjectMd: (id: string, content: string, repairSymlinks = true) =>
    request<{ content: string; symlinksValid: { claudeMd: boolean; agentsMd: boolean } }>(
      `/api/projects/${id}/project-md`,
      {
        method: 'PUT',
        body: JSON.stringify({ content, repairSymlinks }),
      },
    ),

  // Discuss
  getDiscussState: (id: string) =>
    request<{
      session: {
        id: string;
        provider: ProviderId;
        model: string | null;
        cliSessionId: string | null;
      } | null;
      messages: DiscussMessageDTO[];
      currentRound: number;
    }>(`/api/projects/${id}/discuss`),
  sendDiscussMessage: (id: string, body: DiscussMessageInput) =>
    request<{ round: DiscussRound; messages: DiscussMessageDTO[] }>(
      `/api/projects/${id}/discuss/message`,
      {
        method: 'POST',
        body: JSON.stringify(body),
      },
    ),
  finishDiscuss: (id: string) =>
    request<{ brief: BriefDTO }>(`/api/projects/${id}/discuss/finish`, {
      method: 'POST',
    }),

  // Agree / Briefs
  listBriefs: (id: string) => request<{ briefs: BriefDTO[] }>(`/api/projects/${id}/briefs`),
  updateBrief: (id: string, version: number, body: BriefContent) =>
    request<{ brief: BriefDTO }>(`/api/projects/${id}/briefs/${version}`, {
      method: 'PUT',
      body: JSON.stringify(body),
    }),
  reviseBrief: (id: string, version: number, note: string) =>
    request<{ brief: BriefDTO }>(`/api/projects/${id}/briefs/${version}/revise`, {
      method: 'POST',
      body: JSON.stringify({ note }),
    }),
  approveBrief: (id: string, version: number) =>
    request<{ brief: BriefDTO }>(`/api/projects/${id}/briefs/${version}/approve`, {
      method: 'POST',
    }),

  // List / Plan & Tasks
  getPlan: (id: string) => request<{ plan: PlanDTO | null }>(`/api/projects/${id}/plan`),
  generatePlan: (id: string) =>
    request<{ plan: PlanDTO }>(`/api/projects/${id}/plan/generate`, { method: 'POST' }),
  approvePlan: (id: string) =>
    request<{ plan: PlanDTO }>(`/api/projects/${id}/plan/approve`, { method: 'POST' }),
  createTask: (id: string, body: CreateTaskInput) =>
    request<{ task: TaskDTO }>(`/api/projects/${id}/tasks`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  updateTask: (id: string, taskId: string, body: UpdateTaskInput) =>
    request<{ task: TaskDTO }>(`/api/projects/${id}/tasks/${taskId}`, {
      method: 'PATCH',
      body: JSON.stringify(body),
    }),
  deleteTask: (id: string, taskId: string) =>
    request<{ ok: boolean }>(`/api/projects/${id}/tasks/${taskId}`, { method: 'DELETE' }),
  reorderTasks: (id: string, body: ReorderTasksInput) =>
    request<{ plan: PlanDTO }>(`/api/projects/${id}/tasks/reorder`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),

  // Assign & Navigate (v0.2 Jalan)
  listRoutingRules: () => request<{ rules: RoutingRuleDTO[] }>('/api/routing'),
  getExecutionState: (id: string) =>
    request<{ execution: ExecutionStateDTO }>(`/api/projects/${id}/execution`),
  startExecution: (id: string, body: Partial<StartExecutionInput> = {}) =>
    request<{ started: boolean; run: TaskRunDTO | null; queueMode: boolean }>(
      `/api/projects/${id}/execution/start`,
      {
        method: 'POST',
        body: JSON.stringify(body),
      },
    ),
  stopExecution: (id: string) =>
    request<{ stopped: boolean }>(`/api/projects/${id}/execution/stop`, {
      method: 'POST',
    }),
  runTask: (
    id: string,
    taskId: string,
    body: { allowUnconfined?: boolean; resumeSession?: boolean } = {},
  ) =>
    request<{ started: boolean; run: TaskRunDTO | null; queueMode: boolean }>(
      `/api/projects/${id}/tasks/${taskId}/run`,
      {
        method: 'POST',
        body: JSON.stringify(body),
      },
    ),
  assignTaskProfile: (id: string, taskId: string, profileOverride: string | null) =>
    request<{ task: TaskDTO }>(`/api/projects/${id}/tasks/${taskId}/profile`, {
      method: 'PATCH',
      body: JSON.stringify({ profileOverride }),
    }),
  getRunLog: (id: string, runId: string) =>
    request<{ runId: string; logPath: string; content: string }>(
      `/api/projects/${id}/runs/${runId}/log`,
    ),
  rollbackRun: (id: string, runId: string) =>
    request<{ run: TaskRunDTO }>(`/api/projects/${id}/runs/${runId}/rollback`, {
      method: 'POST',
    }),

  // Providers & Profiles
  getProvidersStatus: () => request<{ providers: ProviderStatus[] }>('/api/providers/status'),
  refreshProvidersStatus: () =>
    request<{ providers: ProviderStatus[] }>('/api/providers/refresh', { method: 'POST' }),
  getSettings: () => request<{ settings: SettingsDTO }>('/api/settings'),
  updateSettings: (body: Partial<SettingsDTO>) =>
    request<{ settings: SettingsDTO }>('/api/settings', {
      method: 'PATCH',
      body: JSON.stringify(body),
    }),
  listProfiles: () => request<{ profiles: AgentProfileDTO[] }>('/api/profiles'),
};
