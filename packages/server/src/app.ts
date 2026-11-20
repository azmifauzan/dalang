import fs from 'node:fs';
import path from 'node:path';
import fastifyStatic from '@fastify/static';
import fastifyWebsocket from '@fastify/websocket';
import Fastify, { type FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  ApproveMergeInputSchema,
  AssignTaskProfileInputSchema,
  BriefContentSchema,
  BriefReviseInputSchema,
  ChatMessageInputSchema,
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
  UpdateProfileInputSchema,
  UpdateRoutingRuleInputSchema,
  UpdateSessionInputSchema,
  UpdateSettingsInputSchema,
  UpdateTaskInputSchema,
  type ProviderStatus,
} from '@dalang/shared';
import {
  DalangEventBus,
  ExecutionService,
  LeadService,
  NodeCliRunner,
  ProfileService,
  ProjectService,
  ProviderRegistry,
  SettingsService,
  StatisticsService,
  UpdateCheckService,
  openDatabase,
  type CliRunner,
  type UpdateRegistryFetcher,
} from '@dalang/core';

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1']);

export interface CreateServerOptions {
  dbPath?: string;
  staticDir?: string;
  runner?: CliRunner;
  updateFetcher?: UpdateRegistryFetcher;
  currentVersion?: string;
}

export async function createDalangServer(options: CreateServerOptions = {}): Promise<{
  app: FastifyInstance;
  events: DalangEventBus;
  close: () => Promise<void>;
}> {
  const conn = openDatabase(options.dbPath);
  const runner = options.runner ?? new NodeCliRunner();
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
  const executionService = new ExecutionService(conn.db, registry, leadService, events, {
    getLanguage: () => settingsService.resolvedLanguage(),
  });
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

  app.get('/api/update-status', async (req) => {
    const query = z
      .object({
        force: z.enum(['0', '1', 'true', 'false']).optional(),
      })
      .parse(req.query ?? {});
    const force = query.force === '1' || query.force === 'true';
    return { update: await updateCheckService.getStatus({ force }) };
  });

  // WebSocket live event stream
  app.get('/ws', { websocket: true }, (socket) => {
    const unsubscribe = events.onEvent((event) => {
      if (socket.readyState === socket.OPEN) {
        socket.send(JSON.stringify(event));
      }
    });
    socket.on('close', unsubscribe);
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
    await executionService.stopExecution(req.params.id);
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

  app.post<{ Params: { id: string } }>('/api/projects/:id/chat', async (req) => {
    const body = ChatMessageInputSchema.parse(req.body ?? {});
    return leadService.sendChatMessage(req.params.id, body);
  });

  app.post<{ Params: { id: string; sessionId: string } }>(
    '/api/projects/:id/sessions/:sessionId/messages',
    async (req) => {
      const raw = (req.body ?? {}) as Record<string, unknown>;
      const body = ChatMessageInputSchema.parse({ ...raw, sessionId: req.params.sessionId });
      return leadService.sendChatMessage(req.params.id, body);
    },
  );

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
    return executionService.stopExecution(
      req.params.id,
      body.taskId,
      body.sessionId ?? readSessionId(req),
    );
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
      if (req.url.startsWith('/api/') || req.url.startsWith('/ws')) {
        return reply.status(404).send({ error: 'Not found' });
      }
      return reply.sendFile('index.html');
    });
  }

  return {
    app,
    events,
    close: async () => {
      await executionService.stopAll();
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
} = {}): Promise<{ url: string; close: () => Promise<void> }> {
  const port = opts.port ?? Number(process.env.DALANG_PORT || 4173);
  const { app, close } = await createDalangServer({
    dbPath: opts.dbPath,
    staticDir: opts.staticDir,
    runner: opts.runner,
    updateFetcher: opts.updateFetcher,
    currentVersion: opts.currentVersion,
  });

  // Local-only invariant: always bind to 127.0.0.1
  await app.listen({ host: '127.0.0.1', port });
  const addr = app.server.address();
  const actualPort = typeof addr === 'object' && addr ? addr.port : port;
  // Warm the provider status (installed CLIs, logins, model lists) so the first page load does not wait for it.
  void app
    .inject({ method: 'GET', url: '/api/providers/status', headers: { host: `127.0.0.1:${actualPort}` } })
    .catch(() => undefined);
  return {
    url: `http://127.0.0.1:${actualPort}`,
    close,
  };
}
