import type {
  AgentProfileDTO,
  AuthStatusDTO,
  AutomationDTO,
  AutomationRunDTO,
  BriefDTO,
  ChatMessageInput,
  CreateAutomationInput,
  CreatedAutomationDTO,
  CreatedMcpTokenDTO,
  CreateMcpTokenInput,
  CreateOrOpenProjectInput,
  CreateProfileInput,
  CreateRoutingRuleInput,
  DiscussMessageDTO,
  ExecutionStateDTO,
  GuardStateDTO,
  McpTokenDTO,
  PlanDTO,
  ProjectSummary,
  ProviderCliUpdateResultDTO,
  ProviderId,
  ProviderStatus,
  PushPrInput,
  PushPrResultDTO,
  RoomRouteInfo,
  RoutingRuleDTO,
  SessionDetailDTO,
  SessionMode,
  SessionSummaryDTO,
  SettingsDTO,
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
  UsageStatisticsResponseDTO,
  WorkspaceSetupConfig,
  WorkspaceSetupDTO,
} from '@dalang/shared';

export interface ServerEvent {
  type: string;
  projectId?: string;
  sessionId?: string;
  taskId?: string;
  runId?: string;
  phase?: string;
  provider?: string;
  profileName?: string;
  line?: string;
  /** `lead.text`: reply text written since the previous event; `reset` starts a new attempt. */
  text?: string;
  reset?: boolean;
  status?: string;
  round?: number;
  ok?: boolean;
  error?: string;
  [key: string]: unknown;
}

export interface ConnectEventsOptions {
  baseDelayMs?: number;
  maxDelayMs?: number;
  onAuthRequired?: () => void;
}

export interface ChatResponseDTO {
  session: SessionSummaryDTO;
  mode: SessionMode;
  messages: DiscussMessageDTO[];
  plan?: PlanDTO | null;
  routedTo?: RoomRouteInfo;
}

export async function probeServerHealth(
  port: number,
  timeoutMs = 1500,
): Promise<{ ok: boolean; version?: string } | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  timer.unref?.();
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/health`, {
      signal: controller.signal,
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { ok?: boolean; version?: string };
    return data?.ok ? { ok: true, version: data.version } : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export class RoomApiClient {
  readonly baseUrl: string;
  private cookieHeader: string | null = null;

  constructor(portOrBaseUrl: number | string) {
    this.baseUrl =
      typeof portOrBaseUrl === 'number'
        ? `http://127.0.0.1:${portOrBaseUrl}`
        : portOrBaseUrl.replace(/\/+$/, '');
  }

  private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const headers: Record<string, string> = {
      ...(init.headers as Record<string, string> | undefined),
    };
    if (init.body !== undefined && !headers['Content-Type']) {
      headers['Content-Type'] = 'application/json';
    }
    if (this.cookieHeader) {
      headers['Cookie'] = this.cookieHeader;
    }

    const res = await fetch(`${this.baseUrl}${path}`, {
      ...init,
      headers,
    });

    const setCookie = res.headers.get('set-cookie');
    if (setCookie) {
      const firstPart = setCookie.split(';')[0]?.trim();
      if (firstPart) this.cookieHeader = firstPart;
    }

    const text = await res.text();
    let payload: unknown = null;
    if (text) {
      try {
        payload = JSON.parse(text);
      } catch {
        payload = text;
      }
    }

    if (!res.ok) {
      const errMsg =
        payload && typeof payload === 'object' && 'error' in payload && typeof (payload as { error?: unknown }).error === 'string'
          ? (payload as { error: string }).error
          : `HTTP ${res.status}`;
      const err = new Error(errMsg) as Error & { statusCode?: number };
      err.statusCode = res.status;
      throw err;
    }

    return payload as T;
  }

  authStatus(): Promise<AuthStatusDTO> {
    return this.request('/api/auth/status');
  }

  login(password: string): Promise<AuthStatusDTO> {
    return this.request('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ password }),
    });
  }

  async listProjects(): Promise<ProjectSummary[]> {
    const res = await this.request<{ projects: ProjectSummary[] }>('/api/projects');
    return res.projects;
  }

  async createOrOpenProject(input: CreateOrOpenProjectInput): Promise<ProjectSummary> {
    const res = await this.request<{ project: ProjectSummary }>('/api/projects', {
      method: 'POST',
      body: JSON.stringify(input),
    });
    return res.project;
  }

  async listSessions(projectId: string, includeArchived = false): Promise<{ sessions: SessionSummaryDTO[]; workingSessionId: string | null }> {
    return this.request(`/api/projects/${encodeURIComponent(projectId)}/sessions${includeArchived ? '?includeArchived=1' : ''}`);
  }

  async createSession(projectId: string, mode: SessionMode = 'ask'): Promise<SessionSummaryDTO> {
    const res = await this.request<{ session: SessionSummaryDTO }>(
      `/api/projects/${encodeURIComponent(projectId)}/sessions`,
      { method: 'POST', body: JSON.stringify({ mode }) },
    );
    return res.session;
  }

  getSessionDetail(projectId: string, sessionId: string): Promise<SessionDetailDTO> {
    return this.request(
      `/api/projects/${encodeURIComponent(projectId)}/sessions/${encodeURIComponent(sessionId)}`,
    );
  }

  switchSessionMode(projectId: string, sessionId: string, mode: SessionMode): Promise<{ session: SessionSummaryDTO }> {
    return this.request(
      `/api/projects/${encodeURIComponent(projectId)}/sessions/${encodeURIComponent(sessionId)}/mode`,
      { method: 'POST', body: JSON.stringify({ mode }) },
    );
  }

  sendChatMessage(projectId: string, input: ChatMessageInput): Promise<ChatResponseDTO> {
    return this.request(`/api/projects/${encodeURIComponent(projectId)}/chat`, {
      method: 'POST',
      body: JSON.stringify(input),
    });
  }

  answerQuestion(
    projectId: string,
    sessionId: string,
    input: { questionId: string; selectedLabels: string[]; customAnswer?: string },
  ): Promise<ChatResponseDTO & { answerText: string }> {
    return this.request(
      `/api/projects/${encodeURIComponent(projectId)}/sessions/${encodeURIComponent(sessionId)}/question/answer`,
      { method: 'POST', body: JSON.stringify(input) },
    );
  }

  getTriagePreview(): Promise<{ preview: import('@dalang/shared').TriageContextPreviewDTO }> {
    return this.request('/api/triage/preview');
  }

  startTriage(
    projectId: string,
    input: { confirmed: true; note?: string; provider?: ProviderId; model?: string },
  ): Promise<ChatResponseDTO & { preview: import('@dalang/shared').TriageContextPreviewDTO }> {
    return this.request(`/api/projects/${encodeURIComponent(projectId)}/triage`, {
      method: 'POST',
      body: JSON.stringify(input),
    });
  }

  approveQuickAndRun(
    projectId: string,
    sessionId: string,
    allowUnconfined = false,
  ): Promise<{ started: boolean; plan: PlanDTO; session: SessionSummaryDTO }> {
    return this.request(
      `/api/projects/${encodeURIComponent(projectId)}/sessions/${encodeURIComponent(sessionId)}/quick/run`,
      { method: 'POST', body: JSON.stringify({ allowUnconfined }) },
    );
  }

  async finishDiscuss(projectId: string, sessionId: string): Promise<BriefDTO> {
    const res = await this.request<{ brief: BriefDTO }>(
      `/api/projects/${encodeURIComponent(projectId)}/discuss/finish?sessionId=${encodeURIComponent(sessionId)}`,
      { method: 'POST', body: JSON.stringify({}) },
    );
    return res.brief;
  }

  async approveBrief(projectId: string, version: number, sessionId: string): Promise<BriefDTO> {
    const res = await this.request<{ brief: BriefDTO }>(
      `/api/projects/${encodeURIComponent(projectId)}/briefs/${version}/approve?sessionId=${encodeURIComponent(sessionId)}`,
      { method: 'POST', body: JSON.stringify({}) },
    );
    return res.brief;
  }

  async reviseBrief(projectId: string, version: number, note: string, sessionId: string): Promise<BriefDTO> {
    const res = await this.request<{ brief: BriefDTO }>(
      `/api/projects/${encodeURIComponent(projectId)}/briefs/${version}/revise?sessionId=${encodeURIComponent(sessionId)}`,
      { method: 'POST', body: JSON.stringify({ note }) },
    );
    return res.brief;
  }

  async generatePlan(projectId: string, sessionId: string): Promise<PlanDTO> {
    const res = await this.request<{ plan: PlanDTO }>(
      `/api/projects/${encodeURIComponent(projectId)}/plan/generate?sessionId=${encodeURIComponent(sessionId)}`,
      { method: 'POST', body: JSON.stringify({}) },
    );
    return res.plan;
  }

  async approvePlan(projectId: string, sessionId: string): Promise<PlanDTO> {
    const res = await this.request<{ plan: PlanDTO }>(
      `/api/projects/${encodeURIComponent(projectId)}/plan/approve?sessionId=${encodeURIComponent(sessionId)}`,
      { method: 'POST', body: JSON.stringify({}) },
    );
    return res.plan;
  }

  startExecution(
    projectId: string,
    sessionId: string,
    allowUnconfined = false,
  ): Promise<{ started: boolean }> {
    return this.request(`/api/projects/${encodeURIComponent(projectId)}/execution/start`, {
      method: 'POST',
      body: JSON.stringify({ sessionId, allowUnconfined }),
    });
  }

  stopExecution(projectId: string, opts: { sessionId?: string; taskId?: string } = {}): Promise<{ stopped: boolean }> {
    return this.request(`/api/projects/${encodeURIComponent(projectId)}/execution/stop`, {
      method: 'POST',
      body: JSON.stringify(opts),
    });
  }

  async getExecutionState(projectId: string, sessionId?: string): Promise<ExecutionStateDTO> {
    const qs = sessionId ? `?sessionId=${encodeURIComponent(sessionId)}` : '';
    const res = await this.request<{ execution: ExecutionStateDTO }>(
      `/api/projects/${encodeURIComponent(projectId)}/execution${qs}`,
    );
    return res.execution;
  }

  async getGuardState(projectId: string, sessionId?: string): Promise<GuardStateDTO> {
    const qs = sessionId ? `?sessionId=${encodeURIComponent(sessionId)}` : '';
    const res = await this.request<{ guard: GuardStateDTO }>(
      `/api/projects/${encodeURIComponent(projectId)}/guard${qs}`,
    );
    return res.guard;
  }

  async getTaskDiff(projectId: string, taskId: string): Promise<TaskDiffDTO> {
    const res = await this.request<{ diff: TaskDiffDTO }>(
      `/api/projects/${encodeURIComponent(projectId)}/tasks/${encodeURIComponent(taskId)}/diff`,
    );
    return res.diff;
  }

  approveMergeTask(
    projectId: string,
    taskId: string,
    opts: { allowUnconfined?: boolean; allowFailedReview?: boolean; runIntegration?: boolean } = {},
  ): Promise<{ task: TaskDTO; mergeCommitSha: string | null; answerPath?: string | null }> {
    return this.request(
      `/api/projects/${encodeURIComponent(projectId)}/tasks/${encodeURIComponent(taskId)}/approve-merge`,
      { method: 'POST', body: JSON.stringify(opts) },
    );
  }

  runIntegration(
    projectId: string,
    opts: { command?: string; sessionId?: string; allowUnconfined?: boolean; bypassSandbox?: boolean } = {},
  ): Promise<{ integrationRun: import('@dalang/shared').IntegrationRunDTO }> {
    return this.request(`/api/projects/${encodeURIComponent(projectId)}/integration/run`, {
      method: 'POST',
      body: JSON.stringify(opts),
    });
  }

  getWorkspaceSetup(projectId: string): Promise<WorkspaceSetupDTO> {
    return this.request(`/api/projects/${encodeURIComponent(projectId)}/workspace-setup`);
  }

  setWorkspaceSetup(projectId: string, config: WorkspaceSetupConfig): Promise<WorkspaceSetupDTO> {
    return this.request(`/api/projects/${encodeURIComponent(projectId)}/workspace-setup`, {
      method: 'PUT',
      body: JSON.stringify(config),
    });
  }

  resetWorkspaceSnapshot(projectId: string): Promise<WorkspaceSetupDTO> {
    return this.request(`/api/projects/${encodeURIComponent(projectId)}/workspace-setup/snapshot`, { method: 'DELETE' });
  }

  continueTask(projectId: string, taskId: string, opts: { allowUnconfined?: boolean } = {}): Promise<{ task: TaskDTO }> {
    return this.request(
      `/api/projects/${encodeURIComponent(projectId)}/tasks/${encodeURIComponent(taskId)}/continue`,
      { method: 'POST', body: JSON.stringify(opts) },
    );
  }

  allowTaskScope(
    projectId: string,
    taskId: string,
    opts: { files: string[]; allowUnconfined?: boolean },
  ): Promise<{ task: TaskDTO }> {
    return this.request(
      `/api/projects/${encodeURIComponent(projectId)}/tasks/${encodeURIComponent(taskId)}/allow-scope`,
      { method: 'POST', body: JSON.stringify(opts) },
    );
  }

  async rejectTask(
    projectId: string,
    taskId: string,
    opts: { note?: string; requeue?: boolean } = {},
  ): Promise<TaskDTO> {
    const res = await this.request<{ task: TaskDTO }>(
      `/api/projects/${encodeURIComponent(projectId)}/tasks/${encodeURIComponent(taskId)}/reject`,
      { method: 'POST', body: JSON.stringify(opts) },
    );
    return res.task;
  }

  async getProvidersStatus(): Promise<ProviderStatus[]> {
    const res = await this.request<{ providers: ProviderStatus[] }>('/api/providers/status');
    return res.providers;
  }

  /** Asks the CLIs again for their limits (the same call the web usage bar makes on its interval). */
  async refreshProvidersStatus(): Promise<ProviderStatus[]> {
    const res = await this.request<{ providers: ProviderStatus[] }>('/api/providers/refresh', {
      method: 'POST',
    });
    return res.providers;
  }

  async getUpdateStatus(force = false): Promise<UpdateStatusDTO> {
    const res = await this.request<{ update: UpdateStatusDTO }>(
      `/api/update-status${force ? '?force=1' : ''}`,
    );
    return res.update;
  }

  async updateProviderCli(provider: ProviderId): Promise<{ providers: ProviderStatus[] }> {
    return this.request(`/api/providers/${encodeURIComponent(provider)}/update`, {
      method: 'POST',
    });
  }

  async updateAllConnectedClis(): Promise<{
    results: ProviderCliUpdateResultDTO[];
    providers: ProviderStatus[];
  }> {
    return this.request('/api/providers/update-all', {
      method: 'POST',
    });
  }

  async updateSettings(body: UpdateSettingsInput): Promise<SettingsDTO> {
    const res = await this.request<{ settings: SettingsDTO }>('/api/settings', {
      method: 'PATCH',
      body: JSON.stringify(body),
    });
    return res.settings;
  }

  async updateProfile(profileId: string, body: UpdateProfileInput): Promise<AgentProfileDTO> {
    const res = await this.request<{ profile: AgentProfileDTO }>(
      `/api/profiles/${encodeURIComponent(profileId)}`,
      { method: 'PATCH', body: JSON.stringify(body) },
    );
    return res.profile;
  }

  async listRoutingRules(): Promise<RoutingRuleDTO[]> {
    const res = await this.request<{ rules: RoutingRuleDTO[] }>('/api/routing');
    return res.rules;
  }

  async updateRoutingRule(ruleId: string, body: UpdateRoutingRuleInput): Promise<RoutingRuleDTO> {
    const res = await this.request<{ rule: RoutingRuleDTO }>(`/api/routing/${encodeURIComponent(ruleId)}`, {
      method: 'PATCH',
      body: JSON.stringify(body),
    });
    return res.rule;
  }

  async getSettings(): Promise<SettingsDTO> {
    const res = await this.request<{ settings: SettingsDTO }>('/api/settings');
    return res.settings;
  }

  async listProfiles(): Promise<AgentProfileDTO[]> {
    const res = await this.request<{ profiles: AgentProfileDTO[] }>('/api/profiles');
    return res.profiles;
  }

  async createProfile(body: CreateProfileInput): Promise<AgentProfileDTO> {
    const res = await this.request<{ profile: AgentProfileDTO }>('/api/profiles', {
      method: 'POST',
      body: JSON.stringify(body),
    });
    return res.profile;
  }

  async deleteProfile(profileId: string): Promise<{ ok: boolean }> {
    return this.request(`/api/profiles/${encodeURIComponent(profileId)}`, { method: 'DELETE' });
  }

  async createRoutingRule(body: CreateRoutingRuleInput): Promise<RoutingRuleDTO> {
    const res = await this.request<{ rule: RoutingRuleDTO }>('/api/routing', {
      method: 'POST',
      body: JSON.stringify(body),
    });
    return res.rule;
  }

  async deleteRoutingRule(ruleId: string): Promise<{ ok: boolean }> {
    return this.request(`/api/routing/${encodeURIComponent(ruleId)}`, { method: 'DELETE' });
  }

  async reorderRoutingRules(ruleIds: string[]): Promise<RoutingRuleDTO[]> {
    const res = await this.request<{ rules: RoutingRuleDTO[] }>('/api/routing/reorder', {
      method: 'POST',
      body: JSON.stringify({ ruleIds }),
    });
    return res.rules;
  }

  async clearProviderCooldown(provider: ProviderId): Promise<{ ok: boolean }> {
    return this.request(`/api/providers/${encodeURIComponent(provider)}/clear-cooldown`, {
      method: 'POST',
    });
  }

  async updateProjectSettings(
    projectId: string,
    body: {
      leadProvider?: ProviderId;
      leadModel?: string | null;
      integrationCommand?: string | null;
      pushAfterMerge?: boolean;
      createPrAfterMerge?: boolean;
      gitRemote?: string | null;
    },
  ): Promise<ProjectSummary> {
    const res = await this.request<{ project: ProjectSummary }>(
      `/api/projects/${encodeURIComponent(projectId)}/settings`,
      { method: 'PATCH', body: JSON.stringify(body) },
    );
    return res.project;
  }

  deleteProject(projectId: string): Promise<{ ok: boolean }> {
    return this.request(`/api/projects/${encodeURIComponent(projectId)}`, { method: 'DELETE' });
  }

  getProjectMd(projectId: string): Promise<{ content: string; symlinksValid: { claudeMd: boolean; agentsMd: boolean } }> {
    return this.request(`/api/projects/${encodeURIComponent(projectId)}/project-md`);
  }

  saveProjectMd(
    projectId: string,
    content: string,
    repairSymlinks = true,
  ): Promise<{ content: string; symlinksValid: { claudeMd: boolean; agentsMd: boolean } }> {
    return this.request(`/api/projects/${encodeURIComponent(projectId)}/project-md`, {
      method: 'PUT',
      body: JSON.stringify({ content, repairSymlinks }),
    });
  }

  async updateSession(projectId: string, sessionId: string, body: UpdateSessionInput): Promise<SessionSummaryDTO> {
    const res = await this.request<{ session: SessionSummaryDTO }>(
      `/api/projects/${encodeURIComponent(projectId)}/sessions/${encodeURIComponent(sessionId)}`,
      { method: 'PATCH', body: JSON.stringify(body) },
    );
    return res.session;
  }

  deleteSession(projectId: string, sessionId: string): Promise<{ ok: boolean }> {
    return this.request(
      `/api/projects/${encodeURIComponent(projectId)}/sessions/${encodeURIComponent(sessionId)}`,
      { method: 'DELETE' },
    );
  }

  discardSessionWork(projectId: string, sessionId: string): Promise<{ session: SessionSummaryDTO; discardedTasks: number }> {
    return this.request(
      `/api/projects/${encodeURIComponent(projectId)}/sessions/${encodeURIComponent(sessionId)}/discard`,
      { method: 'POST' },
    );
  }

  runTask(
    projectId: string,
    taskId: string,
    body: { allowUnconfined?: boolean; resumeSession?: boolean } = {},
  ): Promise<{ started: boolean; run: TaskRunDTO | null; queueMode: boolean }> {
    return this.request(
      `/api/projects/${encodeURIComponent(projectId)}/tasks/${encodeURIComponent(taskId)}/run`,
      { method: 'POST', body: JSON.stringify(body) },
    );
  }

  async assignTaskProfile(projectId: string, taskId: string, profileOverride: string | null): Promise<TaskDTO> {
    const res = await this.request<{ task: TaskDTO }>(
      `/api/projects/${encodeURIComponent(projectId)}/tasks/${encodeURIComponent(taskId)}/profile`,
      { method: 'PATCH', body: JSON.stringify({ profileOverride }) },
    );
    return res.task;
  }

  getRunLog(projectId: string, runId: string): Promise<{ runId: string; logPath: string; content: string }> {
    return this.request(
      `/api/projects/${encodeURIComponent(projectId)}/runs/${encodeURIComponent(runId)}/log`,
    );
  }

  async rollbackRun(projectId: string, runId: string): Promise<TaskRunDTO> {
    const res = await this.request<{ run: TaskRunDTO }>(
      `/api/projects/${encodeURIComponent(projectId)}/runs/${encodeURIComponent(runId)}/rollback`,
      { method: 'POST' },
    );
    return res.run;
  }

  async pushTaskPr(projectId: string, taskId: string, body: Partial<PushPrInput> = {}): Promise<PushPrResultDTO> {
    const res = await this.request<{ result: PushPrResultDTO }>(
      `/api/projects/${encodeURIComponent(projectId)}/tasks/${encodeURIComponent(taskId)}/push-pr`,
      { method: 'POST', body: JSON.stringify(body) },
    );
    return res.result;
  }

  async listAutomations(projectId?: string): Promise<AutomationDTO[]> {
    const qs = projectId ? `?projectId=${encodeURIComponent(projectId)}` : '';
    const res = await this.request<{ automations: AutomationDTO[] }>(`/api/automations${qs}`);
    return res.automations;
  }

  async createAutomation(body: CreateAutomationInput): Promise<CreatedAutomationDTO> {
    const res = await this.request<{ automation: CreatedAutomationDTO }>('/api/automations', {
      method: 'POST',
      body: JSON.stringify(body),
    });
    return res.automation;
  }

  async updateAutomation(id: string, body: UpdateAutomationInput): Promise<AutomationDTO> {
    const res = await this.request<{ automation: AutomationDTO }>(`/api/automations/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body: JSON.stringify(body),
    });
    return res.automation;
  }

  deleteAutomation(id: string): Promise<{ ok: boolean }> {
    return this.request(`/api/automations/${encodeURIComponent(id)}`, { method: 'DELETE' });
  }

  async triggerAutomation(id: string, body: TriggerAutomationInput = {}): Promise<AutomationRunDTO> {
    const res = await this.request<{ run: AutomationRunDTO }>(
      `/api/automations/${encodeURIComponent(id)}/trigger`,
      { method: 'POST', body: JSON.stringify(body) },
    );
    return res.run;
  }

  async rotateWebhookSecret(id: string): Promise<CreatedAutomationDTO> {
    const res = await this.request<{ automation: CreatedAutomationDTO }>(
      `/api/automations/${encodeURIComponent(id)}/rotate-secret`,
      { method: 'POST' },
    );
    return res.automation;
  }

  async listAutomationRuns(id: string, limit = 20): Promise<AutomationRunDTO[]> {
    const res = await this.request<{ runs: AutomationRunDTO[] }>(
      `/api/automations/${encodeURIComponent(id)}/runs?limit=${limit}`,
    );
    return res.runs;
  }

  listMcpTokens(): Promise<{ tokens: McpTokenDTO[]; endpointUrl: string | null }> {
    return this.request('/api/mcp-tokens');
  }

  createMcpToken(body: CreateMcpTokenInput): Promise<CreatedMcpTokenDTO> {
    return this.request('/api/mcp-tokens', {
      method: 'POST',
      body: JSON.stringify(body),
    });
  }

  revokeMcpToken(id: string): Promise<{ tokenInfo: McpTokenDTO }> {
    return this.request(`/api/mcp-tokens/${encodeURIComponent(id)}/revoke`, { method: 'POST' });
  }

  deleteMcpToken(id: string): Promise<{ ok: boolean }> {
    return this.request(`/api/mcp-tokens/${encodeURIComponent(id)}`, { method: 'DELETE' });
  }

  async getUsageStatistics(params: { projectId?: string; days?: number } = {}): Promise<UsageStatisticsResponseDTO> {
    const search = new URLSearchParams();
    if (params.projectId) search.set('projectId', params.projectId);
    if (params.days !== undefined) search.set('days', String(params.days));
    const qs = search.toString();
    const res = await this.request<{ statistics: UsageStatisticsResponseDTO }>(
      `/api/statistics${qs ? `?${qs}` : ''}`,
    );
    return res.statistics;
  }

  connectEvents(
    onEvent: (event: ServerEvent) => void,
    onStatus?: (connected: boolean) => void,
    options?: ConnectEventsOptions,
  ): () => void {
    const wsUrl = this.baseUrl.replace(/^http/, 'ws') + '/ws';
    const baseDelayMs = Math.max(10, options?.baseDelayMs ?? 500);
    const maxDelayMs = Math.max(baseDelayMs, options?.maxDelayMs ?? 10_000);
    let closed = false;
    let socket: WebSocket | null = null;
    let detachSocket: (() => void) | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let reconnectAttempt = 0;

    const clearReconnectTimer = () => {
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
    };

    const scheduleReconnect = () => {
      if (closed || reconnectTimer) return;
      const delay = Math.min(maxDelayMs, baseDelayMs * 2 ** Math.min(reconnectAttempt, 10));
      reconnectAttempt += 1;
      reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        connect();
      }, delay);
      reconnectTimer.unref?.();
    };

    const connect = () => {
      if (closed) return;
      clearReconnectTimer();
      detachSocket?.();
      detachSocket = null;

      let current: WebSocket;
      try {
        const WsCtor = globalThis.WebSocket as unknown as new (
          url: string,
          opts?: unknown,
        ) => WebSocket;
        current = this.cookieHeader
          ? new WsCtor(wsUrl, { headers: { Cookie: this.cookieHeader } })
          : new WsCtor(wsUrl);
      } catch {
        socket = null;
        onStatus?.(false);
        scheduleReconnect();
        return;
      }

      socket = current;

      const onOpen = () => {
        if (closed || current !== socket) return;
        reconnectAttempt = 0;
        onStatus?.(true);
      };

      const onMessage = (msg: { data: unknown }) => {
        if (closed || current !== socket) return;
        try {
          const text = typeof msg.data === 'string' ? msg.data : String(msg.data);
          const parsed = JSON.parse(text) as ServerEvent;
          if (parsed && typeof parsed.type === 'string') {
            onEvent(parsed);
          }
        } catch {
          // ignore malformed frames
        }
      };

      const onClose = (ev: { code?: number }) => {
        if (closed || current !== socket) return;
        detachSocket?.();
        detachSocket = null;
        socket = null;
        onStatus?.(false);
        if (ev.code === 4401) {
          options?.onAuthRequired?.();
          return;
        }
        scheduleReconnect();
      };

      const onError = () => {
        if (closed || current !== socket) return;
        onStatus?.(false);
      };

      current.addEventListener('open', onOpen);
      current.addEventListener('message', onMessage);
      current.addEventListener('close', onClose);
      current.addEventListener('error', onError);

      detachSocket = () => {
        current.removeEventListener('open', onOpen);
        current.removeEventListener('message', onMessage);
        current.removeEventListener('close', onClose);
        current.removeEventListener('error', onError);
      };
    };

    connect();

    return () => {
      closed = true;
      clearReconnectTimer();
      detachSocket?.();
      detachSocket = null;
      if (socket) {
        try {
          socket.close();
        } catch {
          // ignore
        }
        socket = null;
      }
    };
  }
}
