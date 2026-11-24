import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { SettingsService } from '@dalang/core';
import type { AuthStatusDTO } from '@dalang/shared';
import { z } from 'zod';

const SESSION_DURATION = 24 * 60 * 60;
const COOKIE = 'dalang_session';
const PASSWORD = z.string().min(12).max(256);

const authInput = z.discriminatedUnion('enabled', [
  z.object({ enabled: z.literal(true), password: PASSWORD }),
  z.object({ enabled: z.literal(false) }),
]);

function readToken(req: FastifyRequest): string | undefined {
  return req.headers.cookie?.split(';').map((piece) => piece.trim())
    .find((piece) => piece.startsWith(`${COOKIE}=`))?.slice(COOKIE.length + 1);
}

function setCookie(reply: FastifyReply, token: string, maxAge: number): void {
  const secure = reply.request.protocol === 'https' ? '; Secure' : '';
  reply.header('Set-Cookie', `${COOKIE}=${token}; Path=/; Max-Age=${maxAge}; HttpOnly; SameSite=Strict${secure}`);
}

export function registerAuth(app: FastifyInstance, settings: SettingsService) {
  const sessions = new Map<string, number>();
  let nextLoginAt = 0;

  function canAccess(token: string | undefined): boolean {
    return !settings.loginPasswordHash() || Boolean(token && (sessions.get(token) ?? 0) > Date.now());
  }

  function status(token?: string): AuthStatusDTO {
    return {
      enabled: Boolean(settings.loginPasswordHash()),
      authenticated: canAccess(token),
      language: settings.language(),
    };
  }

  function newSession(reply: FastifyReply): string {
    const now = Date.now();
    for (const [token, expiry] of sessions) if (expiry <= now) sessions.delete(token);
    if (sessions.size >= 64) sessions.delete(sessions.keys().next().value!);
    const token = randomBytes(32).toString('hex');
    sessions.set(token, now + SESSION_DURATION * 1000);
    setCookie(reply, token, SESSION_DURATION);
    return token;
  }

  const sockets = new Set<{ token: string | undefined; close: () => void }>();
  function closeRevokedSockets(): void {
    for (const socket of sockets) {
      if (!canAccess(socket.token)) socket.close();
    }
  }

  async function authorize(req: FastifyRequest, reply: FastifyReply) {
    const route = req.routeOptions.url;
    if (!route || (!route.startsWith('/api/') && route !== '/ws')) return;
    const enabled = Boolean(settings.loginPasswordHash());
    if (enabled || route.startsWith('/api/auth/')) reply.header('Cache-Control', 'no-store');
    const restrictedOrigin =
      enabled ||
      route.startsWith('/api/auth/') ||
      route.startsWith('/api/mcp-tokens') ||
      route.startsWith('/api/automations') ||
      route === '/api/providers/:provider/update' ||
      route === '/api/factory-reset';
    if (restrictedOrigin && req.headers.origin && req.headers.origin !== `${req.protocol}://${req.headers.host}`) {
      return reply.code(403).send({ error: 'Forbidden: use the DALANG page to make this request.' });
    }
    if (
      route === '/api/health' ||
      route === '/api/auth/status' ||
      route === '/api/auth/login' ||
      route === '/api/webhooks/:token'
    ) {
      return;
    }
    if (!canAccess(readToken(req))) {
      return reply.code(401).send({ error: 'Sign in to DALANG to continue.' });
    }
  }

  app.addHook('onRequest', authorize);
  app.addHook('preHandler', async (req, reply) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') return authorize(req, reply);
  });

  app.get('/api/auth/status', async (req) => status(readToken(req)));

  app.post('/api/auth/login', async (req, reply) => {
    const { password } = z.object({ password: z.string().min(1).max(256) }).parse(req.body);
    const stored = settings.loginPasswordHash();
    if (!stored) return status();
    if (Date.now() < nextLoginAt) {
      return reply.code(429).header('Retry-After', '1').send({ error: 'Wait a moment before trying again.' });
    }
    nextLoginAt = Date.now() + 1000;
    const [salt, hash] = stored.split(':');
    const expected = Buffer.from(hash, 'hex');
    const actual = scryptSync(password, salt, 64);
    if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
      return reply.code(401).send({ error: 'Incorrect password.' });
    }
    nextLoginAt = 0;
    return status(newSession(reply));
  });

  app.put('/api/auth/settings', async (req, reply) => {
    const input = authInput.parse(req.body);
    let token: string | undefined;
    if (input.enabled) {
      if (settings.loginPasswordHash()) {
        return reply.code(409).send({ error: 'Login is already enabled.' });
      }
      const salt = randomBytes(16).toString('hex');
      const hash = scryptSync(input.password, salt, 64).toString('hex');
      settings.setLoginPasswordHash(`${salt}:${hash}`);
      token = newSession(reply);
    } else {
      settings.setLoginPasswordHash(null);
      sessions.clear();
      setCookie(reply, '', 0);
    }
    closeRevokedSockets();
    return status(token);
  });

  app.post('/api/auth/logout', async (req, reply) => {
    const token = readToken(req);
    if (token) sessions.delete(token);
    setCookie(reply, '', 0);
    closeRevokedSockets();
    return status();
  });

  return {
    canAccess: (req: FastifyRequest) => canAccess(readToken(req)),
    trackSocket(req: FastifyRequest, close: () => void) {
      const socket = { token: readToken(req), close };
      sockets.add(socket);
      return () => sockets.delete(socket);
    },
    reset(reply?: FastifyReply) {
      sessions.clear();
      if (reply) setCookie(reply, '', 0);
      closeRevokedSockets();
    },
  };
}
