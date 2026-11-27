import fs from 'node:fs';
import path from 'node:path';
import fastifyStatic from '@fastify/static';
import fastifyWebsocket from '@fastify/websocket';
import Fastify, { type FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  AllowTaskScopeInputSchema,
  ContinueTaskInputSchema,
  WorkspaceSetupConfigSchema,
  ApproveMergeInputSchema,
  AssignTaskProfileInputSchema,
  BriefContentSchema,
  BriefReviseInputSchema,
  CHAT_BODY_LIMIT,
  ChatMessageInputSchema,
  CreateAutomationInputSchema,
  CreateMcpTokenInputSchema,
  CreateOrOpenProjectInputSchema,
  CreateProfileInputSchema,
  CreateRoutingRuleInputSchema,
  CreateSessionInputSchema,
  CreateTaskInputSchema,
  DALANG_VERSION,
  DiscussMessageInputSchema,
  ProviderIdSchema,
  PushPrInputSchema,
  QuickRunInputSchema,
  RejectTaskInputSchema,
  ReorderRoutingRulesInputSchema,
  ReorderTasksInputSchema,
  RunIntegrationInputSchema,
  StartExecutionInputSchema,
  StopExecutionInputSchema,
  SwitchSessionModeInputSchema,
  TriggerAutomationInputSchema,
  UpdateAutomationInputSchema,
  UpdateProfileInputSchema,
  UpdateRoutingRuleInputSchema,
  UpdateSessionInputSchema,
  UpdateSettingsInputSchema,
  UpdateTaskInputSchema,
  type ProviderStatus,
} from '@dalang/shared';
import {
  AutomationService,
  DalangEventBus,
  ExecutionService,
  ExternalMcpService,
  ExternalMcpTokenService,
  LeadService,
  NodeCliRunner,
  RecordingCliRunner,
  ProfileService,
  ProjectService,
  ProviderRegistry,
  SettingsService,
  StatisticsService,
  UpdateCheckService,
  openDatabase,
  resetDatabaseToDefaults,
  type CliRunner,
  type UpdateRegistryFetcher,
} from '@dalang/core';
import { registerAuth } from './auth.js';

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1']);
const LOOPBACK_IPS = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
const DEFAULT_WS_HEARTBEAT_INTERVAL_MS = 20_000;

function isLoopbackIp(ip: string | undefined): boolean {
  if (!ip) return false;
  return LOOPBACK_IPS.has(ip.trim());
}

export interface CreateServerOptions {
  dbPath?: string;
  staticDir?: string;
  runner?: CliRunner;
  updateFetcher?: UpdateRegistryFetcher;
  currentVersion?: string;
  enableScheduler?: boolean;
  schedulerTickIntervalMs?: number;
  wsHeartbeatIntervalMs?: number;
}

export async function createDalangServer(options: CreateServerOptions = {}): Promise<{
  app: FastifyInstance;
  events: DalangEventBus;
  automationService: AutomationService;
  close: () => Promise<void>;
}> {
  const conn = openDatabase(options.dbPath);
  // DALANG_RECORD_DIR saves every provider CLI invocation for replay tests and timing (docs/TROUBLESHOOTING.md).
  const recordDir = process.env.DALANG_RECORD_DIR?.trim();
  const runner = options.runner ?? (recordDir ? new RecordingCliRunner(new NodeCliRunner(), recordDir) : new NodeCliRunner());
  const settingsService = new SettingsService(conn.db);
  const updateCheckService = new UpdateCheckService(settingsService, {
    currentVersion: options.currentVersion ?? DALANG_VERSION,
    fetcher: options.updateFetcher,
  });
  const registry = new ProviderRegistry(runner, {
    antigravityKeyringAccess: () => settingsService.antigravityKeyringAccess(),
  });
  const events = new DalangEventBus();

  const projectService = new ProjectService(conn.db);
  const profileService = new ProfileService(conn.db);
  const leadService = new LeadService(conn.db, registry, events, () =>
    settingsService.resolvedLanguage(),
  );
  let serverBaseUrl: string | null = null;
  let mcpEndpointUrl: string | null = null;
  const executionService = new ExecutionService(conn.db, registry, leadService, events, {
    getLanguage: () => settingsService.resolvedLanguage(),
    mcpEndpointUrl: () => mcpEndpointUrl,
  });
  const automationService = new AutomationService(conn.db, leadService, executionService, events, {
    baseUrl: () => serverBaseUrl,
    tickIntervalMs: options.schedulerTickIntervalMs,
  });
  const mcpTokenService = new ExternalMcpTokenService(conn.db, {
    endpointUrl: () => mcpEndpointUrl,
  });
  const externalMcpService = new ExternalMcpService(
    conn.db,
    mcpTokenService,
    projectService,
    leadService,
    executionService,
    automationService,
  );
  const statsService = new StatisticsService(conn.db, () =>
    executionService.getProviderRuntimeStates(),
  );

  let cachedProviderStatuses: ProviderStatus[] | null = null;
  let statusRefreshInFlight: Promise<ProviderStatus[]> | null = null;

  const getProviderStatuses = async (force = false): Promise<ProviderStatus[]> => {
    if (!force && cachedProviderStatuses) return cachedProviderStatuses;
    if (!statusRefreshInFlight) {
      statusRefreshInFlight = registry
        .checkAllStatuses()
        .then((res) => {
          cachedProviderStatuses = res;
          return res;
        })
        .finally(() => {
          statusRefreshInFlight = null;
        });
    }
    return statusRefreshInFlight;
  };

  const app = Fastify({ logger: false });

  app.addHook('onListen', async () => {
    const addr = app.server.address();
    if (typeof addr === 'object' && addr && addr.port) {
      serverBaseUrl = `http://127.0.0.1:${addr.port}`;
      mcpEndpointUrl = `${serverBaseUrl}/mcp`;
    }
    if (options.enableScheduler !== false) {
      automationService.start();
    }
    // Tasks a restart cut short continue once the server and its MCP endpoint are up.
    void executionService.continueInterruptedWork().catch(() => undefined);
  });

  // Binding to 127.0.0.1 is not enough: a web page can still reach it through DNS rebinding,
  // so only loopback host names and loopback origins are served.
  app.addHook('onRequest', async (req, reply) => {
    const hostName = (req.headers.host ?? '').replace(/:\d+$/, '').replace(/^\[|\]$/g, '');
    let originOk = true;
    if (req.headers.origin) {
      try {
        originOk = LOOPBACK_HOSTS.has(new URL(req.headers.origin).hostname.replace(/^\[|\]$/g, ''));
      } catch {
        originOk = false;
      }
    }
    if (!LOOPBACK_HOSTS.has(hostName) || !originOk) {
      return reply.status(403).send({ error: 'Forbidden: DALANG only serves loopback requests.' });
    }
  });

  const auth = registerAuth(app, settingsService);
  await app.register(fastifyWebsocket);

  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof z.ZodError) {
      return reply.status(400).send({
        error: 'Validation error',
        issues: err.issues,
      });
    }
    const statusCode = (err as { statusCode?: number }).statusCode ?? 400;
    const message = err instanceof Error ? err.message : String(err);
    return reply.status(statusCode >= 400 ? statusCode : 400).send({ error: message });
  });

  app.get('/api/health', async () => ({
    ok: true,
    version: options.currentVersion ?? DALANG_VERSION,
  }));

  // Loopback MCP endpoint:
  // - v0.8 run-scoped delegation bearer tokens -> delegate_task / task_status / task_cancel
  // - v0.11 persistent outside-agent bearer tokens -> read-only or full-access project/task tools
  app.all('/mcp', async (req, reply) => {
    if (!isLoopbackIp(req.ip)) {
      return reply
        .status(403)
        .send({ jsonrpc: '2.0', id: null, error: { code: -32001, message: 'Forbidden: /mcp is loopback-only.' } });
    }
    const authHeader = req.headers.authorization;
    const mcpReq = {
      method: req.method,
      authorizationHeader: authHeader,
      body: req.body,
    };

    const res = executionService.getDelegationStore().authenticate(authHeader)
      ? await executionService.handleMcpHttpRequest(mcpReq)
      : (() => {
          const externalScope = externalMcpService.authenticate(authHeader);
          if (externalScope) {
            return externalMcpService.handleHttpRequest(externalScope, mcpReq);
          }
          return Promise.resolve({
            statusCode: 401,
            headers: { 'Cache-Control': 'no-store' },
            body: {
              jsonrpc: '2.0',
              id: null,
              error: {
                code: -32001,
                message: 'Unauthorized: missing, invalid, revoked, or expired MCP bearer token.',
              },
            },
          });
        })();

    const resolved = await res;
    if (resolved.headers) {
      for (const [k, v] of Object.entries(resolved.headers)) {
        reply.header(k, v);
      }
    }
    if (resolved.body === undefined) {
      return reply.status(resolved.statusCode).send();
    }
    return reply.status(resolved.statusCode).send(resolved.body);
  });

  // Signed webhook trigger endpoint (v0.11): captures exact raw bytes for HMAC-SHA256 verification.
  await app.register(async (webhookApp) => {
    webhookApp.removeAllContentTypeParsers();
    webhookApp.addContentTypeParser('*', { parseAs: 'buffer' }, (_req, body, done) => {
      done(null, body);
    });
    webhookApp.post<{ Params: { token: string } }>('/api/webhooks/:token', async (req, reply) => {
      const rawBody = Buffer.isBuffer(req.body)
        ? req.body
        : typeof req.body === 'string'
          ? Buffer.from(req.body, 'utf8')
          : Buffer.alloc(0);
      const header = (name: string) => (typeof req.headers[name] === 'string' ? (req.headers[name] as string) : undefined);
      const result = await automationService.handleWebhook(
        req.params.token,
        rawBody,
        {
          dalang: header('x-dalang-signature-256'),
          hub: header('x-hub-signature-256'),
          timestamp: header('x-dalang-timestamp'),
        },
        {
          event: header('x-dalang-event') ?? header('x-github-event'),
          deliveryId: header('x-dalang-delivery') ?? header('x-github-delivery'),
        },
      );
      return reply.status(202).send(result);
    });
  });

  app.get('/api/update-status', async (req) => {
    const query = z
      .object({
        force: z.enum(['0', '1', 'true', 'false']).optional(),
      })
      .parse(req.query ?? {});
    const force = query.force === '1' || query.force === 'true';
    return { update: await updateCheckService.getStatus({ force }) };
  });

  // WebSocket live event stream with heartbeat liveness checks
  const wsHeartbeatIntervalMs = options.wsHeartbeatIntervalMs ?? DEFAULT_WS_HEARTBEAT_INTERVAL_MS;
  let wsClosing = false;
  let wsHeartbeatTimer: ReturnType<typeof setInterval> | null = null;
  const stopWsHeartbeat = () => {
    if (wsHeartbeatTimer) {
      clearInterval(wsHeartbeatTimer);
      wsHeartbeatTimer = null;
    }
  };
  const openSockets = new Set<{
    socket: {
      readyState: number;
      OPEN: number;
      ping: () => void;
      close: (code?: number) => void;
      terminate: () => void;
    };
    alive: boolean;
    canAccess: () => boolean;
    cleanup: () => void;
  }>();
  const ensureWsHeartbeat = () => {
    if (wsClosing || wsHeartbeatTimer || wsHeartbeatIntervalMs <= 0) return;
    wsHeartbeatTimer = setInterval(() => {
      for (const entry of Array.from(openSockets)) {
        if (!entry.canAccess()) {
          entry.cleanup();
          try {
            entry.socket.close(4401);
          } catch {
            // ignore
          }
          continue;
        }
        if (entry.socket.readyState !== entry.socket.OPEN) {
          entry.cleanup();
          continue;
        }
        if (!entry.alive) {
          entry.cleanup();
          try {
            entry.socket.terminate();
          } catch {
            // ignore
          }
          continue;
        }
        entry.alive = false;
        try {
          entry.socket.ping();
        } catch {
          entry.cleanup();
          try {
            entry.socket.terminate();
          } catch {
            // ignore
          }
        }
      }
    }, wsHeartbeatIntervalMs);
    wsHeartbeatTimer.unref?.();
  };

  app.addHook('onClose', async () => {
    wsClosing = true;
    stopWsHeartbeat();
  });

  app.get('/ws', { websocket: true }, (socket, req) => {
    if (wsClosing) {
      try {
        socket.close(1001);
      } catch {
        // ignore
      }
      return;
    }
    let cleaned = false;
    let unsubscribe = () => {};
    let untrack = () => {};
    const entry = {
      socket,
      alive: true,
      canAccess: () => auth.canAccess(req),
      cleanup: () => {
        if (cleaned) return;
        cleaned = true;
        openSockets.delete(entry);
        unsubscribe();
        untrack();
        if (openSockets.size === 0) {
          stopWsHeartbeat();
        }
      },
    };
    openSockets.add(entry);
    untrack = auth.trackSocket(req, () => {
      entry.cleanup();
      try {
        socket.close(4401);
      } catch {
        // ignore
      }
    });
    unsubscribe = events.onEvent((event) => {
      if (!auth.canAccess(req)) {
        entry.cleanup();
        try {
          socket.close(4401);
        } catch {
          // ignore
        }
        return;
      }
      if (socket.readyState === socket.OPEN) {
        socket.send(JSON.stringify(event));
      }
    });
    ensureWsHeartbeat();

    socket.on('pong', () => {
      entry.alive = true;
    });
    socket.on('close', entry.cleanup);
  });

  // Projects (F-01, F-02)
  app.get('/api/projects', async () => ({
    projects: projectService.listProjects(),
  }));

  app.post('/api/projects', async (req, reply) => {
    const body = CreateOrOpenProjectInputSchema.parse(req.body);
    const project = await projectService.createOrOpen(body);
    return reply.status(201).send({ project });
  });

  app.get<{ Params: { id: string } }>('/api/projects/:id', async (req) => ({
    project: projectService.getProject(req.params.id),
  }));

  app.delete<{ Params: { id: string } }>('/api/projects/:id', async (req) => {
    await Promise.all([
      executionService.stopExecution(req.params.id),
      leadService.stopTurns(req.params.id),
    ]);
    projectService.deleteProject(req.params.id);
    return { ok: true };
  });

  app.patch<{ Params: { id: string } }>('/api/projects/:id/settings', async (req) => {
    const body = z
      .object({
        leadProvider: ProviderIdSchema.optional(),
        leadModel: z.string().nullable().optional(),
        integrationCommand: z.string().trim().nullable().optional(),
        pushAfterMerge: z.boolean().optional(),
        createPrAfterMerge: z.boolean().optional(),
        gitRemote: z.string().trim().nullable().optional(),
      })
      .parse(req.body);
    return { project: projectService.updateSettings(req.params.id, body) };
  });

  // What prepares a task worktree: DALANG proposes, the user decides.
  app.get<{ Params: { id: string } }>('/api/projects/:id/workspace-setup', async (req) => {
    return executionService.getWorkspaceSetup(req.params.id);
  });
  app.put<{ Params: { id: string } }>('/api/projects/:id/workspace-setup', async (req) => {
    return executionService.setWorkspaceSetup(req.params.id, WorkspaceSetupConfigSchema.parse(req.body ?? {}));
  });
  app.delete<{ Params: { id: string } }>('/api/projects/:id/workspace-setup/snapshot', async (req) => {
    return executionService.resetWorkspaceSnapshot(req.params.id);
  });

  app.get<{ Params: { id: string } }>('/api/projects/:id/project-md', async (req) => {
    return projectService.readProjectMd(req.params.id);
  });

  app.put<{ Params: { id: string } }>('/api/projects/:id/project-md', async (req) => {
    const body = z
      .object({
        content: z.string(),
        repairSymlinks: z.boolean().default(true),
      })
      .parse(req.body);
    return projectService.writeProjectMd(req.params.id, body.content, body.repairSymlinks);
  });

  const readSessionId = (req: { query?: unknown; body?: unknown }): string | undefined => {
    const q = req.query as { sessionId?: unknown } | undefined;
    if (typeof q?.sessionId === 'string' && q.sessionId.trim()) return q.sessionId.trim();
    const b = req.body as { sessionId?: unknown } | undefined;
    if (typeof b?.sessionId === 'string' && b.sessionId.trim()) return b.sessionId.trim();
    return undefined;
  };

  // Sessions & Chat (v0.7 Session Modes)
  app.get<{ Params: { id: string } }>('/api/projects/:id/sessions', async (req) => {
    const query = z
      .object({
        includeArchived: z.enum(['0', '1', 'true', 'false']).optional(),
      })
      .parse(req.query ?? {});
    const includeArchived = query.includeArchived === '1' || query.includeArchived === 'true';
    const sessionList = leadService.listSessions(req.params.id, { includeArchived });
    const working = leadService.getWorkingSession(req.params.id);
    return {
      sessions: sessionList,
      workingSessionId: working?.id ?? null,
    };
  });

  app.post<{ Params: { id: string } }>('/api/projects/:id/sessions', async (req, reply) => {
    const body = CreateSessionInputSchema.parse(req.body ?? {});
    const session = leadService.createSession(req.params.id, body);
    return reply.status(201).send({ session });
  });

  app.get<{ Params: { id: string; sessionId: string } }>(
    '/api/projects/:id/sessions/:sessionId',
    async (req) => {
      return leadService.getSessionDetail(req.params.id, req.params.sessionId);
    },
  );

  app.patch<{ Params: { id: string; sessionId: string } }>(
    '/api/projects/:id/sessions/:sessionId',
    async (req) => {
      const body = UpdateSessionInputSchema.parse(req.body ?? {});
      return { session: leadService.updateSession(req.params.id, req.params.sessionId, body) };
    },
  );

  app.delete<{ Params: { id: string; sessionId: string } }>(
    '/api/projects/:id/sessions/:sessionId',
    async (req) => {
      // Stop running work and clean unmerged branches/worktrees without touching merged code.
      await executionService.discardSessionWork(req.params.id, req.params.sessionId);
      leadService.deleteSession(req.params.id, req.params.sessionId);
      return { ok: true };
    },
  );

  app.post<{ Params: { id: string; sessionId: string } }>(
    '/api/projects/:id/sessions/:sessionId/mode',
    async (req) => {
      const body = SwitchSessionModeInputSchema.parse(req.body ?? {});
      return {
        session: leadService.switchSessionMode(req.params.id, req.params.sessionId, body.mode),
      };
    },
  );

  app.post<{ Params: { id: string; sessionId: string } }>(
    '/api/projects/:id/sessions/:sessionId/discard',
    async (req) => {
      return executionService.discardSessionWork(req.params.id, req.params.sessionId);
    },
  );

  app.post<{ Params: { id: string; sessionId: string } }>(
    '/api/projects/:id/sessions/:sessionId/quick/run',
    async (req, reply) => {
      const body = QuickRunInputSchema.parse(req.body ?? {});
      const plan = leadService.approveQuickPlan(req.params.id, req.params.sessionId);
      const execResult = await executionService.startExecution(req.params.id, {
        sessionId: req.params.sessionId,
        allowUnconfined: body.allowUnconfined,
      });
      return reply.status(202).send({
        ...execResult,
        plan,
        session: leadService.getSession(req.params.id, req.params.sessionId),
      });
    },
  );

  app.post<{ Params: { id: string } }>('/api/projects/:id/chat', { bodyLimit: CHAT_BODY_LIMIT }, async (req) => {
    const body = ChatMessageInputSchema.parse(req.body ?? {});
    return leadService.sendChatMessage(req.params.id, body);
  });

  app.post<{ Params: { id: string; sessionId: string } }>(
    '/api/projects/:id/sessions/:sessionId/messages',
    { bodyLimit: CHAT_BODY_LIMIT },
    async (req) => {
      const raw = (req.body ?? {}) as Record<string, unknown>;
      const body = ChatMessageInputSchema.parse({ ...raw, sessionId: req.params.sessionId });
      return leadService.sendChatMessage(req.params.id, body);
    },
  );

  app.get<{ Params: { id: string } }>('/api/chat-images/:id', async (req, reply) => {
    const image = leadService.getChatImage(req.params.id);
    if (!image) return reply.code(404).send({ error: 'Image not found.' });
    return reply.type(image.mimeType)
      .header('Cache-Control', 'private, no-store')
      .header('X-Content-Type-Options', 'nosniff')
      .send(image.data);
  });

  // Discuss (F-03, F-04, F-05)
  app.get<{ Params: { id: string } }>('/api/projects/:id/discuss', async (req) => {
    return leadService.getDiscussState(req.params.id, readSessionId(req));
  });

  app.post<{ Params: { id: string } }>('/api/projects/:id/discuss/message', async (req) => {
    const body = DiscussMessageInputSchema.parse(req.body);
    return leadService.sendDiscussMessage(req.params.id, {
      ...body,
      sessionId: body.sessionId ?? readSessionId(req),
    });
  });

  app.post<{ Params: { id: string } }>('/api/projects/:id/discuss/finish', async (req) => {
    const brief = await leadService.finishDiscussAndWriteBrief(req.params.id, readSessionId(req));
    return { brief };
  });

  // Agree / Briefs (F-06, F-07)
  app.get<{ Params: { id: string } }>('/api/projects/:id/briefs', async (req) => {
    return { briefs: leadService.listBriefs(req.params.id, readSessionId(req)) };
  });

  app.put<{ Params: { id: string; version: string } }>(
    '/api/projects/:id/briefs/:version',
    async (req) => {
      const version = Number(req.params.version);
      const body = BriefContentSchema.parse(req.body);
      return { brief: leadService.updateBrief(req.params.id, version, body, readSessionId(req)) };
    },
  );

  app.post<{ Params: { id: string; version: string } }>(
    '/api/projects/:id/briefs/:version/revise',
    async (req) => {
      const version = Number(req.params.version);
      const body = BriefReviseInputSchema.parse(req.body);
      return {
        brief: await leadService.reviseBrief(req.params.id, version, body.note, readSessionId(req)),
      };
    },
  );

  app.post<{ Params: { id: string; version: string } }>(
    '/api/projects/:id/briefs/:version/approve',
    async (req) => {
      const version = Number(req.params.version);
      return { brief: leadService.approveBrief(req.params.id, version, readSessionId(req)) };
    },
  );

  // List / Plan & Kanban (F-08, F-09, F-10)
  app.get<{ Params: { id: string } }>('/api/projects/:id/plan', async (req) => {
    return { plan: leadService.getPlan(req.params.id, readSessionId(req)) };
  });

  app.post<{ Params: { id: string } }>('/api/projects/:id/plan/generate', async (req) => {
    return { plan: await leadService.generatePlan(req.params.id, readSessionId(req)) };
  });

  app.post<{ Params: { id: string } }>('/api/projects/:id/plan/approve', async (req) => {
    return { plan: leadService.approvePlan(req.params.id, readSessionId(req)) };
  });

  app.post<{ Params: { id: string } }>('/api/projects/:id/tasks', async (req, reply) => {
    const body = CreateTaskInputSchema.parse(req.body);
    const task = leadService.createTask(req.params.id, body, readSessionId(req));
    return reply.status(201).send({ task });
  });

  app.patch<{ Params: { id: string; taskId: string } }>(
    '/api/projects/:id/tasks/:taskId',
    async (req) => {
      const body = UpdateTaskInputSchema.parse(req.body);
      return {
        task: leadService.updateTask(req.params.id, req.params.taskId, body, readSessionId(req)),
      };
    },
  );

  app.delete<{ Params: { id: string; taskId: string } }>(
    '/api/projects/:id/tasks/:taskId',
    async (req) => {
      leadService.deleteTask(req.params.id, req.params.taskId, readSessionId(req));
      return { ok: true };
    },
  );

  app.post<{ Params: { id: string } }>('/api/projects/:id/tasks/reorder', async (req) => {
    const body = ReorderTasksInputSchema.parse(req.body);
    return { plan: leadService.reorderTasks(req.params.id, body, readSessionId(req)) };
  });

  // Assign & Navigate (v0.2 Jalan: F-11, F-12, F-13, F-14, F-15, F-17, F-23)
  app.get<{ Params: { id: string } }>('/api/projects/:id/execution', async (req) => {
    return { execution: await executionService.getExecutionState(req.params.id, readSessionId(req)) };
  });

  app.post<{ Params: { id: string } }>('/api/projects/:id/execution/start', async (req, reply) => {
    const body = StartExecutionInputSchema.parse(req.body ?? {});
    const result = await executionService.startExecution(req.params.id, {
      ...body,
      sessionId: body.sessionId ?? readSessionId(req),
    });
    return reply.status(202).send(result);
  });

  app.post<{ Params: { id: string } }>('/api/projects/:id/execution/stop', async (req) => {
    const body = StopExecutionInputSchema.parse(req.body ?? {});
    const sid = body.sessionId ?? readSessionId(req);
    if (body.taskId) {
      return executionService.stopExecution(req.params.id, body.taskId, sid);
    }
    const [execRes, leadRes] = await Promise.all([
      executionService.stopExecution(req.params.id, undefined, sid),
      leadService.stopTurns(req.params.id, sid),
    ]);
    return { stopped: execRes.stopped || leadRes.stopped };
  });

  app.post<{ Params: { id: string; taskId: string } }>(
    '/api/projects/:id/tasks/:taskId/run',
    async (req, reply) => {
      const body = StartExecutionInputSchema.omit({ taskId: true }).parse(req.body ?? {});
      const result = await executionService.startExecution(req.params.id, {
        ...body,
        taskId: req.params.taskId,
      });
      return reply.status(202).send(result);
    },
  );

  app.post<{ Params: { id: string; taskId: string } }>(
    '/api/projects/:id/tasks/:taskId/steer',
    async (req) => {
      const { runId, message } = z.object({
        runId: z.string().uuid(),
        message: z.string().trim().min(1).max(8000),
      }).parse(req.body);
      await executionService.steerTask(req.params.id, req.params.taskId, runId, message);
      return { accepted: true };
    },
  );

  app.post<{ Params: { id: string; taskId: string } }>(
    '/api/projects/:id/tasks/:taskId/stop',
    async (req) => {
      return executionService.stopExecution(req.params.id, req.params.taskId);
    },
  );

  app.patch<{ Params: { id: string; taskId: string } }>(
    '/api/projects/:id/tasks/:taskId/profile',
    async (req) => {
      const body = AssignTaskProfileInputSchema.parse(req.body);
      return {
        task: executionService.assignTaskProfile(
          req.params.id,
          req.params.taskId,
          body.profileOverride,
        ),
      };
    },
  );

  app.get<{ Params: { id: string; runId: string } }>(
    '/api/projects/:id/runs/:runId/log',
    async (req) => {
      return executionService.getRunLog(req.params.id, req.params.runId);
    },
  );

  app.post<{ Params: { id: string; runId: string } }>(
    '/api/projects/:id/runs/:runId/rollback',
    async (req) => {
      return { run: await executionService.rollbackRun(req.params.id, req.params.runId) };
    },
  );

  // Guard (v0.3 Kawal: F-18, F-19, F-20)
  app.get<{ Params: { id: string } }>('/api/projects/:id/guard', async (req) => {
    return { guard: await executionService.getGuardState(req.params.id, readSessionId(req)) };
  });

  app.get<{ Params: { id: string; taskId: string } }>(
    '/api/projects/:id/tasks/:taskId/diff',
    async (req) => {
      return { diff: await executionService.getTaskDiffForTask(req.params.id, req.params.taskId) };
    },
  );

  app.post<{ Params: { id: string; taskId: string } }>(
    '/api/projects/:id/tasks/:taskId/approve-merge',
    async (req) => {
      const body = ApproveMergeInputSchema.parse(req.body ?? {});
      return executionService.approveMergeTask(req.params.id, req.params.taskId, body);
    },
  );

  // A task that stopped short continues on its branch (U7).
  app.post<{ Params: { id: string; taskId: string } }>(
    '/api/projects/:id/tasks/:taskId/continue',
    async (req) => {
      const body = ContinueTaskInputSchema.parse(req.body ?? {});
      return executionService.continueTask(req.params.id, req.params.taskId, body);
    },
  );

  // A task asked for files outside its scope (R10): the user allows some of them and the task continues.
  app.post<{ Params: { id: string; taskId: string } }>(
    '/api/projects/:id/tasks/:taskId/allow-scope',
    async (req) => {
      const body = AllowTaskScopeInputSchema.parse(req.body ?? {});
      return executionService.allowTaskScope(req.params.id, req.params.taskId, body);
    },
  );

  app.post<{ Params: { id: string; taskId: string } }>(
    '/api/projects/:id/tasks/:taskId/push-pr',
    async (req) => {
      const body = PushPrInputSchema.parse(req.body ?? {});
      return {
        result: await executionService.pushTaskBranchAndPr(req.params.id, req.params.taskId, body),
      };
    },
  );

  app.post<{ Params: { id: string; taskId: string } }>(
    '/api/projects/:id/tasks/:taskId/reject',
    async (req) => {
      const body = RejectTaskInputSchema.parse(req.body ?? {});
      return { task: await executionService.rejectTask(req.params.id, req.params.taskId, body) };
    },
  );

  app.post<{ Params: { id: string } }>('/api/projects/:id/integration/run', async (req) => {
    const body = RunIntegrationInputSchema.parse(req.body ?? {});
    return {
      integrationRun: await executionService.runIntegrationTests(req.params.id, body),
    };
  });

  app.get('/api/settings', async () => ({ settings: settingsService.getAll() }));

  app.patch('/api/settings', async (req) => {
    const body = UpdateSettingsInputSchema.parse(req.body ?? {});
    return { settings: settingsService.update(body) };
  });

  app.post('/api/factory-reset', async (_req, reply) => {
    await automationService.stop();
    await executionService.stopAll();
    for (const project of projectService.listProjects()) {
      projectService.deleteProject(project.id);
    }
    resetDatabaseToDefaults(conn.db, conn.sqlite);
    cachedProviderStatuses = null;
    auth.reset(reply);
    if (options.enableScheduler !== false && serverBaseUrl) {
      automationService.start();
    }
    return { ok: true };
  });

  // Automations (v0.11: scheduled & webhook-triggered runs)
  app.get('/api/automations', async (req) => {
    const query = z
      .object({
        projectId: z.string().min(1).optional(),
      })
      .parse(req.query ?? {});
    return { automations: automationService.listAutomations(query.projectId) };
  });

  app.post('/api/automations', async (req, reply) => {
    const body = CreateAutomationInputSchema.parse(req.body ?? {});
    const automation = automationService.createAutomation(body);
    return reply.status(201).send({ automation });
  });

  app.patch<{ Params: { id: string } }>('/api/automations/:id', async (req) => {
    const body = UpdateAutomationInputSchema.parse(req.body ?? {});
    return { automation: automationService.updateAutomation(req.params.id, body) };
  });

  app.delete<{ Params: { id: string } }>('/api/automations/:id', async (req) => {
    automationService.deleteAutomation(req.params.id);
    return { ok: true };
  });

  app.post<{ Params: { id: string } }>('/api/automations/:id/trigger', async (req, reply) => {
    const body = TriggerAutomationInputSchema.parse(req.body ?? {});
    const run = await automationService.triggerAutomation(req.params.id, 'manual', {
      event: body.event,
      payload: body.payload,
    });
    return reply.status(202).send({ run });
  });

  app.post<{ Params: { id: string } }>('/api/automations/:id/rotate-secret', async (req) => {
    return { automation: automationService.rotateWebhookSecret(req.params.id) };
  });

  app.get<{ Params: { id: string } }>('/api/automations/:id/runs', async (req) => {
    const query = z
      .object({
        limit: z.coerce.number().int().positive().max(100).optional(),
      })
      .parse(req.query ?? {});
    return { runs: automationService.listRuns(req.params.id, query.limit) };
  });

  // External MCP Tokens (v0.11: outside agents over loopback /mcp)
  app.get('/api/mcp-tokens', async () => {
    return {
      tokens: mcpTokenService.listTokens(),
      endpointUrl: mcpEndpointUrl,
    };
  });

  app.post('/api/mcp-tokens', async (req, reply) => {
    const body = CreateMcpTokenInputSchema.parse(req.body ?? {});
    const created = mcpTokenService.createToken(body);
    return reply.status(201).send(created);
  });

  app.post<{ Params: { id: string } }>('/api/mcp-tokens/:id/revoke', async (req) => {
    return { tokenInfo: mcpTokenService.revokeToken(req.params.id) };
  });

  app.delete<{ Params: { id: string } }>('/api/mcp-tokens/:id', async (req) => {
    mcpTokenService.deleteToken(req.params.id);
    return { ok: true };
  });

  // Providers, Profiles & Routing (F-21, F-22, F-10, F-11, F-24)
  app.get('/api/providers/status', async () => {
    return {
      providers: await getProviderStatuses(false),
      providerStates: executionService.getProviderRuntimeStates(),
    };
  });

  app.post('/api/providers/refresh', async () => {
    const providers = await getProviderStatuses(true);
    for (const p of providers) {
      if (p.loggedIn && !registry.isUsageExhausted(p.usage)) {
        registry.clearCooldown(p.id);
      }
      events.emitEvent({ type: 'provider.updated', provider: p.id });
    }
    return {
      providers,
      providerStates: executionService.getProviderRuntimeStates(),
    };
  });

  app.post('/api/providers/update-all', async () => {
    const statuses = await getProviderStatuses(true);
    const { results, providers } = await registry.updateConnectedClis({ statuses });
    cachedProviderStatuses = null;
    await statusRefreshInFlight?.catch(() => undefined);
    const refreshed = providers.length > 0 ? providers : await getProviderStatuses(true);
    for (const item of results) {
      if (item.status === 'updated') {
        events.emitEvent({ type: 'provider.updated', provider: item.provider });
      }
    }
    return {
      results,
      providers: refreshed,
      providerStates: executionService.getProviderRuntimeStates(),
    };
  });

  app.post<{ Params: { provider: string } }>('/api/providers/:provider/update', async (req) => {
    const provider = ProviderIdSchema.parse(req.params.provider);
    await registry.updateCli(provider);
    cachedProviderStatuses = null;
    await statusRefreshInFlight?.catch(() => undefined);
    const providers = await getProviderStatuses(true);
    events.emitEvent({ type: 'provider.updated', provider });
    return { providers, providerStates: executionService.getProviderRuntimeStates() };
  });

  app.post<{ Params: { provider: string } }>(
    '/api/providers/:provider/clear-cooldown',
    async (req) => {
      const provider = ProviderIdSchema.parse(req.params.provider);
      const body = z
        .object({ accountKey: z.string().min(1).optional() })
        .parse(req.body ?? {});
      if (body.accountKey) {
        registry.clearCooldownByAccountKey(body.accountKey);
      } else {
        registry.clearCooldown(provider);
      }
      events.emitEvent({ type: 'provider.updated', provider });
      return {
        ok: true,
        providerStates: executionService.getProviderRuntimeStates(),
      };
    },
  );

  app.get('/api/statistics', async (req) => {
    const query = z
      .object({
        projectId: z.string().min(1).optional(),
        days: z.coerce.number().int().positive().max(3650).optional(),
      })
      .parse(req.query ?? {});
    return { statistics: statsService.getUsageStatistics(query) };
  });

  app.get('/api/profiles', async () => {
    return { profiles: profileService.listProfiles() };
  });

  app.post('/api/profiles', async (req, reply) => {
    const body = CreateProfileInputSchema.parse(req.body);
    const profile = profileService.createProfile(body);
    return reply.status(201).send({ profile });
  });

  app.patch<{ Params: { id: string } }>('/api/profiles/:id', async (req) => {
    const body = UpdateProfileInputSchema.parse(req.body ?? {});
    return { profile: profileService.updateProfile(req.params.id, body) };
  });

  app.delete<{ Params: { id: string } }>('/api/profiles/:id', async (req) => {
    profileService.deleteProfile(req.params.id);
    return { ok: true };
  });

  app.get('/api/routing', async () => {
    return { rules: profileService.listRoutingRules() };
  });

  app.post('/api/routing', async (req, reply) => {
    const body = CreateRoutingRuleInputSchema.parse(req.body);
    const rule = profileService.createRoutingRule(body);
    return reply.status(201).send({ rule });
  });

  app.patch<{ Params: { id: string } }>('/api/routing/:id', async (req) => {
    const body = UpdateRoutingRuleInputSchema.parse(req.body ?? {});
    return { rule: profileService.updateRoutingRule(req.params.id, body) };
  });

  app.delete<{ Params: { id: string } }>('/api/routing/:id', async (req) => {
    profileService.deleteRoutingRule(req.params.id);
    return { ok: true };
  });

  app.post('/api/routing/reorder', async (req) => {
    const body = ReorderRoutingRulesInputSchema.parse(req.body);
    return { rules: profileService.reorderRoutingRules(body.ruleIds) };
  });

  // Static web assets (when built)
  if (options.staticDir && fs.existsSync(options.staticDir)) {
    await app.register(fastifyStatic, {
      root: options.staticDir,
      prefix: '/',
    });

    app.setNotFoundHandler((req, reply) => {
      if (req.url.startsWith('/api/') || req.url.startsWith('/ws') || req.url.startsWith('/mcp')) {
        return reply.status(404).send({ error: 'Not found' });
      }
      return reply.sendFile('index.html');
    });
  }

  return {
    app,
    events,
    automationService,
    close: async () => {
      wsClosing = true;
      stopWsHeartbeat();
      await automationService.stop();
      await Promise.all([executionService.stopAll(), leadService.stopAllTurns()]);
      for (const entry of Array.from(openSockets)) {
        entry.cleanup();
        try {
          entry.socket.close(1001);
        } catch {
          // ignore
        }
      }
      openSockets.clear();
      app.server.closeAllConnections?.();
      await app.close();
      conn.close();
    },
  };
}

export async function startDalangServer(opts: {
  port?: number;
  dbPath?: string;
  staticDir?: string;
  runner?: CliRunner;
  updateFetcher?: UpdateRegistryFetcher;
  currentVersion?: string;
  enableScheduler?: boolean;
  schedulerTickIntervalMs?: number;
  wsHeartbeatIntervalMs?: number;
} = {}): Promise<{ url: string; automationService: AutomationService; close: () => Promise<void> }> {
  const port = opts.port ?? Number(process.env.DALANG_PORT || 4173);
  const { app, automationService, close } = await createDalangServer({
    dbPath: opts.dbPath,
    staticDir: opts.staticDir,
    runner: opts.runner,
    updateFetcher: opts.updateFetcher,
    currentVersion: opts.currentVersion,
    enableScheduler: opts.enableScheduler,
    schedulerTickIntervalMs: opts.schedulerTickIntervalMs,
    wsHeartbeatIntervalMs: opts.wsHeartbeatIntervalMs,
  });

  // Docker forwards a host loopback port to the container interface. The Host/Origin guard still applies.
  await app.listen({ host: process.env.DALANG_CONTAINER === '1' ? '0.0.0.0' : '127.0.0.1', port });
  const addr = app.server.address();
  const actualPort = typeof addr === 'object' && addr ? addr.port : port;
  // Warm the provider status (installed CLIs, logins, model lists) so the first page load does not wait for it.
  void app
    .inject({ method: 'GET', url: '/api/providers/status', headers: { host: `127.0.0.1:${actualPort}` } })
    .catch(() => undefined);
  return {
    url: `http://127.0.0.1:${actualPort}`,
    automationService,
    close,
  };
}
