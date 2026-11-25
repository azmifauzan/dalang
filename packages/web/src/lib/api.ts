import type {
  AgentProfileDTO,
  ApproveMergeInput,
  AskMessageContent,
  AuthStatusDTO,
  AutomationDTO,
  AutomationRunDTO,
  BriefContent,
  BriefDTO,
  ChatMessageInput,
  CreateAutomationInput,
  CreatedAutomationDTO,
  CreatedMcpTokenDTO,
  CreateMcpTokenInput,
  CreateOrOpenProjectInput,
  CreateProfileInput,
  CreateRoutingRuleInput,
  CreateSessionInput,
  CreateTaskInput,
  DiscussMessageDTO,
  DiscussMessageInput,
  DiscussRound,
  ExecutionStateDTO,
  GuardStateDTO,
  IntegrationRunDTO,
  McpTokenDTO,
  PlanDTO,
  ProjectSummary,
  ProviderId,
  ProviderRuntimeStateDTO,
  ProviderStatus,
  PushPrInput,
  PushPrResultDTO,
  QuickPlanContract,
  QuickRunInput,
  RejectTaskInput,
  ReorderTasksInput,
  RoutingRuleDTO,
  RunIntegrationInput,
  SessionDetailDTO,
  SessionMode,
  SessionPhase,
  SessionSummaryDTO,
  SessionWorkState,
  SettingsDTO,
  StartExecutionInput,
  StopExecutionInput,
  TaskDiffDTO,
  TaskDTO,
  TaskRunDTO,
  TriggerAutomationInput,
  UpdateAutomationInput,
  UpdateProfileInput,
  UpdateRoutingRuleInput,
  UpdateSessionInput,
  UpdateSettingsInput,
  UpdateStatusDTO,
  UpdateTaskInput,
  UsageStatisticsResponseDTO,
} from '@dalang/shared';

function withSessionQuery(url: string, sessionId?: string | null): string {
  if (!sessionId) return url;
  const sep = url.includes('?') ? '&' : '?';
  return `${url}${sep}sessionId=${encodeURIComponent(sessionId)}`;
}

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
    if (res.status === 401 && url !== '/api/auth/login') {
      window.dispatchEvent(new Event('dalang-auth-required'));
    }
    throw new Error(data.error || `Request failed (${res.status})`);
  }
  return data as T;
}

export const api = {
  authStatus: () => request<AuthStatusDTO>('/api/auth/status'),
  login: (password: string) => request<AuthStatusDTO>('/api/auth/login', {
    method: 'POST', body: JSON.stringify({ password }),
  }),
  setLogin: (body: { enabled: true; password: string } | { enabled: false }) =>
    request<AuthStatusDTO>('/api/auth/settings', { method: 'PUT', body: JSON.stringify(body) }),
  logout: () => request<AuthStatusDTO>('/api/auth/logout', { method: 'POST' }),
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
    body: {
      leadProvider?: ProviderId;
      leadModel?: string | null;
      integrationCommand?: string | null;
      pushAfterMerge?: boolean;
      createPrAfterMerge?: boolean;
      gitRemote?: string | null;
    },
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

  // Sessions & Chat (v0.7 Session Modes)
  listSessions: (projectId: string, includeArchived = false) =>
    request<{ sessions: SessionSummaryDTO[]; workingSessionId: string | null }>(
      `/api/projects/${projectId}/sessions${includeArchived ? '?includeArchived=1' : ''}`,
    ),
  createSession: (projectId: string, body: Partial<CreateSessionInput> = {}) =>
    request<{ session: SessionSummaryDTO }>(`/api/projects/${projectId}/sessions`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  getSessionDetail: (projectId: string, sessionId: string) =>
    request<SessionDetailDTO>(`/api/projects/${projectId}/sessions/${sessionId}`),
  updateSession: (projectId: string, sessionId: string, body: UpdateSessionInput) =>
    request<{ session: SessionSummaryDTO }>(`/api/projects/${projectId}/sessions/${sessionId}`, {
      method: 'PATCH',
      body: JSON.stringify(body),
    }),
  deleteSession: (projectId: string, sessionId: string) =>
    request<{ ok: boolean }>(`/api/projects/${projectId}/sessions/${sessionId}`, {
      method: 'DELETE',
    }),
  switchSessionMode: (projectId: string, sessionId: string, mode: SessionMode) =>
    request<{ session: SessionSummaryDTO }>(
      `/api/projects/${projectId}/sessions/${sessionId}/mode`,
      {
        method: 'POST',
        body: JSON.stringify({ mode }),
      },
    ),
  discardSessionWork: (projectId: string, sessionId: string) =>
    request<{ session: SessionSummaryDTO; discardedTasks: number }>(
      `/api/projects/${projectId}/sessions/${sessionId}/discard`,
      { method: 'POST' },
    ),
  runQuickSession: (projectId: string, sessionId: string, body: Partial<QuickRunInput> = {}) =>
    request<{
      started: boolean;
      run: TaskRunDTO | null;
      runs?: TaskRunDTO[];
      queueMode: boolean;
      plan: PlanDTO;
      session: SessionSummaryDTO;
    }>(`/api/projects/${projectId}/sessions/${sessionId}/quick/run`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  sendChatMessage: (projectId: string, body: ChatMessageInput) =>
    request<{
      session: SessionSummaryDTO;
      mode: SessionMode;
      askReply?: AskMessageContent;
      quickPlan?: QuickPlanContract;
      plan?: PlanDTO | null;
      round?: DiscussRound;
      messages: DiscussMessageDTO[];
    }>(`/api/projects/${projectId}/chat`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),

  // Discuss
  getDiscussState: (id: string, sessionId?: string | null) =>
    request<{
      session: {
        id: string;
        title?: string;
        mode?: SessionMode;
        workState?: SessionWorkState;
        phase?: SessionPhase;
        provider: ProviderId;
        model: string | null;
        cliSessionId: string | null;
      } | null;
      messages: DiscussMessageDTO[];
      currentRound: number;
    }>(withSessionQuery(`/api/projects/${id}/discuss`, sessionId)),
  sendDiscussMessage: (id: string, body: DiscussMessageInput) =>
    request<{ round: DiscussRound; messages: DiscussMessageDTO[]; sessionId?: string }>(
      `/api/projects/${id}/discuss/message`,
      {
        method: 'POST',
        body: JSON.stringify(body),
      },
    ),
  finishDiscuss: (id: string, sessionId?: string | null) =>
    request<{ brief: BriefDTO }>(withSessionQuery(`/api/projects/${id}/discuss/finish`, sessionId), {
      method: 'POST',
    }),

  // Agree / Briefs
  listBriefs: (id: string, sessionId?: string | null) =>
    request<{ briefs: BriefDTO[] }>(withSessionQuery(`/api/projects/${id}/briefs`, sessionId)),
  updateBrief: (id: string, version: number, body: BriefContent, sessionId?: string | null) =>
    request<{ brief: BriefDTO }>(
      withSessionQuery(`/api/projects/${id}/briefs/${version}`, sessionId),
      {
        method: 'PUT',
        body: JSON.stringify(body),
      },
    ),
  reviseBrief: (id: string, version: number, note: string, sessionId?: string | null) =>
    request<{ brief: BriefDTO }>(
      withSessionQuery(`/api/projects/${id}/briefs/${version}/revise`, sessionId),
      {
        method: 'POST',
        body: JSON.stringify({ note }),
      },
    ),
  approveBrief: (id: string, version: number, sessionId?: string | null) =>
    request<{ brief: BriefDTO }>(
      withSessionQuery(`/api/projects/${id}/briefs/${version}/approve`, sessionId),
      {
        method: 'POST',
      },
    ),

  // List / Plan & Tasks
  getPlan: (id: string, sessionId?: string | null) =>
    request<{ plan: PlanDTO | null }>(withSessionQuery(`/api/projects/${id}/plan`, sessionId)),
  generatePlan: (id: string, sessionId?: string | null) =>
    request<{ plan: PlanDTO }>(withSessionQuery(`/api/projects/${id}/plan/generate`, sessionId), {
      method: 'POST',
    }),
  approvePlan: (id: string, sessionId?: string | null) =>
    request<{ plan: PlanDTO }>(withSessionQuery(`/api/projects/${id}/plan/approve`, sessionId), {
      method: 'POST',
    }),
  createTask: (id: string, body: CreateTaskInput, sessionId?: string | null) =>
    request<{ task: TaskDTO }>(withSessionQuery(`/api/projects/${id}/tasks`, sessionId), {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  updateTask: (id: string, taskId: string, body: UpdateTaskInput, sessionId?: string | null) =>
    request<{ task: TaskDTO }>(
      withSessionQuery(`/api/projects/${id}/tasks/${taskId}`, sessionId),
      {
        method: 'PATCH',
        body: JSON.stringify(body),
      },
    ),
  deleteTask: (id: string, taskId: string, sessionId?: string | null) =>
    request<{ ok: boolean }>(withSessionQuery(`/api/projects/${id}/tasks/${taskId}`, sessionId), {
      method: 'DELETE',
    }),
  reorderTasks: (id: string, body: ReorderTasksInput, sessionId?: string | null) =>
    request<{ plan: PlanDTO }>(withSessionQuery(`/api/projects/${id}/tasks/reorder`, sessionId), {
      method: 'POST',
      body: JSON.stringify(body),
    }),

  // Assign & Navigate (v0.2 Jalan, v0.4 Paralel)
  listRoutingRules: () => request<{ rules: RoutingRuleDTO[] }>('/api/routing'),
  getExecutionState: (id: string, sessionId?: string | null) =>
    request<{ execution: ExecutionStateDTO }>(
      withSessionQuery(`/api/projects/${id}/execution`, sessionId),
    ),
  startExecution: (id: string, body: Partial<StartExecutionInput> = {}) =>
    request<{ started: boolean; run: TaskRunDTO | null; runs?: TaskRunDTO[]; queueMode: boolean }>(
      `/api/projects/${id}/execution/start`,
      {
        method: 'POST',
        body: JSON.stringify(body),
      },
    ),
  stopExecution: (id: string, body: StopExecutionInput = {}) =>
    request<{ stopped: boolean }>(`/api/projects/${id}/execution/stop`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  stopTask: (id: string, taskId: string) =>
    request<{ stopped: boolean }>(`/api/projects/${id}/tasks/${taskId}/stop`, {
      method: 'POST',
    }),
  steerTask: (id: string, taskId: string, runId: string, message: string) =>
    request<{ accepted: boolean }>(`/api/projects/${id}/tasks/${taskId}/steer`, {
      method: 'POST',
      body: JSON.stringify({ runId, message }),
    }),
  runTask: (
    id: string,
    taskId: string,
    body: { allowUnconfined?: boolean; resumeSession?: boolean } = {},
  ) =>
    request<{ started: boolean; run: TaskRunDTO | null; runs?: TaskRunDTO[]; queueMode: boolean }>(
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

  // Guard (v0.3 Kawal)
  getGuardState: (id: string, sessionId?: string | null) =>
    request<{ guard: GuardStateDTO }>(withSessionQuery(`/api/projects/${id}/guard`, sessionId)),
  getTaskDiff: (id: string, taskId: string) =>
    request<{ diff: TaskDiffDTO }>(`/api/projects/${id}/tasks/${taskId}/diff`),
  approveMergeTask: (id: string, taskId: string, body: Partial<ApproveMergeInput> = {}) =>
    request<{
      task: TaskDTO;
      mergeCommitSha: string | null;
      answer?: string | null;
      answerPath?: string | null;
      integrationRun: IntegrationRunDTO | null;
      pushPrResult?: PushPrResultDTO | null;
    }>(`/api/projects/${id}/tasks/${taskId}/approve-merge`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  pushTaskPr: (id: string, taskId: string, body: Partial<PushPrInput> = {}) =>
    request<{ result: PushPrResultDTO }>(`/api/projects/${id}/tasks/${taskId}/push-pr`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  rejectTask: (id: string, taskId: string, body: Partial<RejectTaskInput> = {}) =>
    request<{ task: TaskDTO }>(`/api/projects/${id}/tasks/${taskId}/reject`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  runIntegration: (id: string, body: Partial<RunIntegrationInput> = {}) =>
    request<{ integrationRun: IntegrationRunDTO }>(`/api/projects/${id}/integration/run`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),

  // Providers, Profiles & Routing
  getProvidersStatus: () =>
    request<{ providers: ProviderStatus[]; providerStates?: ProviderRuntimeStateDTO[] }>(
      '/api/providers/status',
    ),
  refreshProvidersStatus: () =>
    request<{ providers: ProviderStatus[]; providerStates?: ProviderRuntimeStateDTO[] }>(
      '/api/providers/refresh',
      { method: 'POST' },
    ),
  clearProviderCooldown: (provider: ProviderId) =>
    request<{ ok: boolean; providerStates: ProviderRuntimeStateDTO[] }>(
      `/api/providers/${provider}/clear-cooldown`,
      { method: 'POST' },
    ),
  getUsageStatistics: (params: { projectId?: string; days?: number } = {}) => {
    const search = new URLSearchParams();
    if (params.projectId) search.set('projectId', params.projectId);
    if (params.days !== undefined) search.set('days', String(params.days));
    const qs = search.toString();
    return request<{ statistics: UsageStatisticsResponseDTO }>(
      `/api/statistics${qs ? `?${qs}` : ''}`,
    );
  },
  getSettings: () => request<{ settings: SettingsDTO }>('/api/settings'),
  updateProviderCli: (provider: ProviderId) =>
    request<{ providers: ProviderStatus[]; providerStates: ProviderRuntimeStateDTO[] }>(
      `/api/providers/${provider}/update`, { method: 'POST' },
    ),
  updateSettings: (body: UpdateSettingsInput) =>
    request<{ settings: SettingsDTO }>('/api/settings', {
      method: 'PATCH',
      body: JSON.stringify(body),
    }),
  factoryReset: () =>
    request<{ ok: boolean }>('/api/factory-reset', { method: 'POST' }),
  getHealth: () => request<{ ok: boolean; version: string }>('/api/health'),
  getUpdateStatus: (force = false) =>
    request<{ update: UpdateStatusDTO }>(`/api/update-status${force ? '?force=1' : ''}`),
  listProfiles: () => request<{ profiles: AgentProfileDTO[] }>('/api/profiles'),
  createProfile: (body: CreateProfileInput) =>
    request<{ profile: AgentProfileDTO }>('/api/profiles', {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  updateProfile: (profileId: string, body: UpdateProfileInput) =>
    request<{ profile: AgentProfileDTO }>(`/api/profiles/${profileId}`, {
      method: 'PATCH',
      body: JSON.stringify(body),
    }),
  deleteProfile: (profileId: string) =>
    request<{ ok: boolean }>(`/api/profiles/${profileId}`, { method: 'DELETE' }),
  createRoutingRule: (body: CreateRoutingRuleInput) =>
    request<{ rule: RoutingRuleDTO }>('/api/routing', {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  updateRoutingRule: (ruleId: string, body: UpdateRoutingRuleInput) =>
    request<{ rule: RoutingRuleDTO }>(`/api/routing/${ruleId}`, {
      method: 'PATCH',
      body: JSON.stringify(body),
    }),
  deleteRoutingRule: (ruleId: string) =>
    request<{ ok: boolean }>(`/api/routing/${ruleId}`, { method: 'DELETE' }),
  reorderRoutingRules: (ruleIds: string[]) =>
    request<{ rules: RoutingRuleDTO[] }>('/api/routing/reorder', {
      method: 'POST',
      body: JSON.stringify({ ruleIds }),
    }),

  // v0.11 Automation & Outside-Agent MCP Tokens
  listAutomations: (projectId?: string) =>
    request<{ automations: AutomationDTO[] }>(
      `/api/automations${projectId ? `?projectId=${encodeURIComponent(projectId)}` : ''}`,
    ),
  createAutomation: (body: CreateAutomationInput) =>
    request<{ automation: CreatedAutomationDTO }>('/api/automations', {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  updateAutomation: (id: string, body: UpdateAutomationInput) =>
    request<{ automation: AutomationDTO }>(`/api/automations/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(body),
    }),
  deleteAutomation: (id: string) =>
    request<{ ok: boolean }>(`/api/automations/${id}`, { method: 'DELETE' }),
  triggerAutomation: (id: string, body: TriggerAutomationInput = {}) =>
    request<{ run: AutomationRunDTO }>(`/api/automations/${id}/trigger`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  rotateWebhookSecret: (id: string) =>
    request<{ automation: CreatedAutomationDTO }>(`/api/automations/${id}/rotate-secret`, {
      method: 'POST',
    }),
  listAutomationRuns: (id: string, limit = 20) =>
    request<{ runs: AutomationRunDTO[] }>(`/api/automations/${id}/runs?limit=${limit}`),

  listMcpTokens: () =>
    request<{ tokens: McpTokenDTO[]; endpointUrl: string | null }>('/api/mcp-tokens'),
  createMcpToken: (body: CreateMcpTokenInput) =>
    request<CreatedMcpTokenDTO>('/api/mcp-tokens', {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  revokeMcpToken: (id: string) =>
    request<{ tokenInfo: McpTokenDTO }>(`/api/mcp-tokens/${id}/revoke`, { method: 'POST' }),
  deleteMcpToken: (id: string) =>
    request<{ ok: boolean }>(`/api/mcp-tokens/${id}`, { method: 'DELETE' }),
};
