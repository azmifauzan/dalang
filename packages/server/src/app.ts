import fs from 'node:fs';
import path from 'node:path';
import fastifyStatic from '@fastify/static';
import fastifyWebsocket from '@fastify/websocket';
import Fastify, { type FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  AssignTaskProfileInputSchema,
  BriefContentSchema,
  BriefReviseInputSchema,
  CreateOrOpenProjectInputSchema,
  CreateTaskInputSchema,
  DiscussMessageInputSchema,
  ProviderIdSchema,
  ReorderTasksInputSchema,
  StartExecutionInputSchema,
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
  openDatabase,
  type CliRunner,
} from '@dalang/core';

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1']);

export interface CreateServerOptions {
  dbPath?: string;
  staticDir?: string;
  runner?: CliRunner;
}

export async function createDalangServer(options: CreateServerOptions = {}): Promise<{
  app: FastifyInstance;
  events: DalangEventBus;
  close: () => Promise<void>;
}> {
  const conn = openDatabase(options.dbPath);
  const runner = options.runner ?? new NodeCliRunner();
  const settingsService = new SettingsService(conn.db);
  const registry = new ProviderRegistry(runner, {
    antigravityKeyringAccess: () => settingsService.antigravityKeyringAccess(),
  });
  const events = new DalangEventBus();

  const projectService = new ProjectService(conn.db);
  const profileService = new ProfileService(conn.db);
  const leadService = new LeadService(conn.db, registry, events);
  const executionService = new ExecutionService(conn.db, registry, leadService, events);

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

  app.get('/api/health', async () => ({ ok: true, version: '0.2.1' }));

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

  // Discuss (F-03, F-04, F-05)
  app.get<{ Params: { id: string } }>('/api/projects/:id/discuss', async (req) => {
    return leadService.getDiscussState(req.params.id);
  });

  app.post<{ Params: { id: string } }>('/api/projects/:id/discuss/message', async (req) => {
    const body = DiscussMessageInputSchema.parse(req.body);
    return leadService.sendDiscussMessage(req.params.id, body);
  });

  app.post<{ Params: { id: string } }>('/api/projects/:id/discuss/finish', async (req) => {
    const brief = await leadService.finishDiscussAndWriteBrief(req.params.id);
    return { brief };
  });

  // Agree / Briefs (F-06, F-07)
  app.get<{ Params: { id: string } }>('/api/projects/:id/briefs', async (req) => {
    return { briefs: leadService.listBriefs(req.params.id) };
  });

  app.put<{ Params: { id: string; version: string } }>(
    '/api/projects/:id/briefs/:version',
    async (req) => {
      const version = Number(req.params.version);
      const body = BriefContentSchema.parse(req.body);
      return { brief: leadService.updateBrief(req.params.id, version, body) };
    },
  );

  app.post<{ Params: { id: string; version: string } }>(
    '/api/projects/:id/briefs/:version/revise',
    async (req) => {
      const version = Number(req.params.version);
      const body = BriefReviseInputSchema.parse(req.body);
      return { brief: await leadService.reviseBrief(req.params.id, version, body.note) };
    },
  );

  app.post<{ Params: { id: string; version: string } }>(
    '/api/projects/:id/briefs/:version/approve',
    async (req) => {
      const version = Number(req.params.version);
      return { brief: leadService.approveBrief(req.params.id, version) };
    },
  );

  // List / Plan & Kanban (F-08, F-09, F-10)
  app.get<{ Params: { id: string } }>('/api/projects/:id/plan', async (req) => {
    return { plan: leadService.getPlan(req.params.id) };
  });

  app.post<{ Params: { id: string } }>('/api/projects/:id/plan/generate', async (req) => {
    return { plan: await leadService.generatePlan(req.params.id) };
  });

  app.post<{ Params: { id: string } }>('/api/projects/:id/plan/approve', async (req) => {
    return { plan: leadService.approvePlan(req.params.id) };
  });

  app.post<{ Params: { id: string } }>('/api/projects/:id/tasks', async (req, reply) => {
    const body = CreateTaskInputSchema.parse(req.body);
    const task = leadService.createTask(req.params.id, body);
    return reply.status(201).send({ task });
  });

  app.patch<{ Params: { id: string; taskId: string } }>(
    '/api/projects/:id/tasks/:taskId',
    async (req) => {
      const body = UpdateTaskInputSchema.parse(req.body);
      return { task: leadService.updateTask(req.params.id, req.params.taskId, body) };
    },
  );

  app.delete<{ Params: { id: string; taskId: string } }>(
    '/api/projects/:id/tasks/:taskId',
    async (req) => {
      leadService.deleteTask(req.params.id, req.params.taskId);
      return { ok: true };
    },
  );

  app.post<{ Params: { id: string } }>('/api/projects/:id/tasks/reorder', async (req) => {
    const body = ReorderTasksInputSchema.parse(req.body);
    return { plan: leadService.reorderTasks(req.params.id, body) };
  });

  // Assign & Navigate (v0.2 Jalan: F-11, F-12, F-13, F-14, F-15, F-17, F-23)
  app.get<{ Params: { id: string } }>('/api/projects/:id/execution', async (req) => {
    return { execution: await executionService.getExecutionState(req.params.id) };
  });

  app.post<{ Params: { id: string } }>('/api/projects/:id/execution/start', async (req, reply) => {
    const body = StartExecutionInputSchema.parse(req.body ?? {});
    const result = await executionService.startExecution(req.params.id, body);
    return reply.status(202).send(result);
  });

  app.post<{ Params: { id: string } }>('/api/projects/:id/execution/stop', async (req) => {
    return executionService.stopExecution(req.params.id);
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

  app.get('/api/settings', async () => ({ settings: settingsService.getAll() }));

  app.patch('/api/settings', async (req) => {
    const body = UpdateSettingsInputSchema.parse(req.body ?? {});
    return { settings: settingsService.update(body) };
  });

  // Providers & Profiles (F-22, F-10, F-11 support)
  app.get('/api/providers/status', async () => {
    return { providers: await getProviderStatuses(false) };
  });

  app.post('/api/providers/refresh', async () => {
    return { providers: await getProviderStatuses(true) };
  });

  app.get('/api/profiles', async () => {
    return { profiles: profileService.listProfiles() };
  });

  app.get('/api/routing', async () => {
    return { rules: profileService.listRoutingRules() };
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
} = {}): Promise<{ url: string; close: () => Promise<void> }> {
  const port = opts.port ?? Number(process.env.DALANG_PORT || 4173);
  const { app, close } = await createDalangServer({
    dbPath: opts.dbPath,
    staticDir: opts.staticDir,
  });

  // Local-only invariant: always bind to 127.0.0.1
  await app.listen({ host: '127.0.0.1', port });
  const addr = app.server.address();
  const actualPort = typeof addr === 'object' && addr ? addr.port : port;
  return {
    url: `http://127.0.0.1:${actualPort}`,
    close,
  };
}
