import type {
  AgentProfileDTO,
  AuthStatusDTO,
  BriefDTO,
  ChatMessageInput,
  CreateOrOpenProjectInput,
  DiscussMessageDTO,
  ExecutionStateDTO,
  GuardStateDTO,
  PlanDTO,
  ProjectSummary,
  ProviderCliUpdateResultDTO,
  ProviderId,
  ProviderStatus,
  RoomRouteInfo,
  RoutingRuleDTO,
  SessionDetailDTO,
  SessionMode,
  SessionSummaryDTO,
  SettingsDTO,
  TaskDiffDTO,
  TaskDTO,
  UpdateProfileInput,
  UpdateRoutingRuleInput,
  UpdateSettingsInput,
  UpdateStatusDTO,
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
  ): Promise<{ task: TaskDTO; mergeCommitSha: string }> {
    return this.request(
      `/api/projects/${encodeURIComponent(projectId)}/tasks/${encodeURIComponent(taskId)}/approve-merge`,
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

  connectEvents(
    onEvent: (event: ServerEvent) => void,
    onStatus?: (connected: boolean) => void,
  ): () => void {
    const wsUrl = this.baseUrl.replace(/^http/, 'ws') + '/ws';
    let closed = false;
    let socket: WebSocket | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

    const connect = () => {
      if (closed) return;
      try {
        const WsCtor = globalThis.WebSocket as unknown as new (
          url: string,
          opts?: unknown,
        ) => WebSocket;
        socket = this.cookieHeader
          ? new WsCtor(wsUrl, { headers: { Cookie: this.cookieHeader } })
          : new WsCtor(wsUrl);
      } catch {
        scheduleReconnect();
        return;
      }

      socket.addEventListener('open', () => {
        onStatus?.(true);
      });
      socket.addEventListener('message', (msg) => {
        try {
          const text = typeof msg.data === 'string' ? msg.data : String(msg.data);
          const parsed = JSON.parse(text) as ServerEvent;
          if (parsed && typeof parsed.type === 'string') {
            onEvent(parsed);
          }
        } catch {
          // ignore malformed frames
        }
      });
      socket.addEventListener('close', () => {
        onStatus?.(false);
        if (!closed) scheduleReconnect();
      });
      socket.addEventListener('error', () => {
        onStatus?.(false);
      });
    };

    const scheduleReconnect = () => {
      if (closed || reconnectTimer) return;
      reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        connect();
      }, 1500);
      reconnectTimer.unref?.();
    };

    connect();

    return () => {
      closed = true;
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
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
