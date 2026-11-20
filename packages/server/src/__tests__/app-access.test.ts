import { once } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ReplayCliRunner, type RunCommandOptions } from '@dalang/core';
import { afterEach, expect, it } from 'vitest';
import { createDalangServer } from '../app.js';

const dirs: string[] = [];
const password = 'a long local password';
const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/ZqMAAAAASUVORK5CYII=';
const image = { name: 'screenshot.png', mimeType: 'image/png', data: png };

function tempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dalang-app-'));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

it('keeps login off by default and protects API and live events when enabled', async () => {
  const dbPath = path.join(tempDir(), 'dalang.db');
  const first = await createDalangServer({ dbPath });
  try {
    const { app } = first;
    expect((await app.inject('/api/auth/status')).json()).toMatchObject({ enabled: false, authenticated: true });
    const socket = await app.injectWS('/ws', { headers: { host: 'localhost' } });
    const socketClosed = once(socket, 'close');
    const payload = { enabled: true, password };
    const crossOrigin = await app.inject({ method: 'PUT', url: '/api/auth/settings', payload, headers: { origin: 'http://localhost:9999' } });
    expect(crossOrigin.statusCode).toBe(403);

    const enabled = await app.inject({ method: 'PUT', url: '/api/auth/settings', payload });
    expect(enabled.statusCode).toBe(200);
    expect(enabled.json()).toMatchObject({ enabled: true, authenticated: true });
    const cookie = String(enabled.headers['set-cookie']);
    expect(cookie).toContain('HttpOnly; SameSite=Strict');
    expect((await socketClosed)[0]).toBe(4401);
    expect((await app.inject('/api/projects')).statusCode).toBe(401);
    expect((await app.inject('/api/chat-images/unknown')).statusCode).toBe(401);
    await expect(app.injectWS('/ws', { headers: { host: 'localhost' } })).rejects.toThrow(/401/);
    expect((await app.inject({ method: 'POST', url: '/api/providers/antigravity/update' })).statusCode).toBe(401);
    expect((await app.inject({ method: 'PUT', url: '/api/auth/settings', payload: { enabled: false } })).statusCode).toBe(401);
    expect((await app.inject({ url: '/api/projects', headers: { cookie } })).statusCode).toBe(200);
  } finally {
    await first.close();
  }

  const { app, close } = await createDalangServer({ dbPath });
  try {
    expect((await app.inject('/api/auth/status')).json()).toMatchObject({ enabled: true, authenticated: false });
    const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { password } });
    expect(login.json()).toMatchObject({ enabled: true, authenticated: true });
    const cookie = String(login.headers['set-cookie']).split(';')[0];
    const socket = await app.injectWS('/ws', { headers: { host: 'localhost', cookie } });
    const socketClosed = once(socket, 'close');
    const logout = await app.inject({ method: 'POST', url: '/api/auth/logout', headers: { cookie } });
    expect(logout.json()).toMatchObject({ enabled: true, authenticated: false });
    expect((await socketClosed)[0]).toBe(4401);
    expect((await app.inject({ url: '/api/projects', headers: { cookie } })).statusCode).toBe(401);
    const loginAgain = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { password } });
    const disable = await app.inject({ method: 'PUT', url: '/api/auth/settings', payload: { enabled: false }, headers: {
      cookie: String(loginAgain.headers['set-cookie']).split(';')[0],
    } });
    expect(disable.json()).toMatchObject({ enabled: false, authenticated: true });
    expect((await app.inject('/api/projects')).statusCode).toBe(200);
  } finally {
    await close();
  }
});

it('validates uploads, passes images to the CLI, and keeps previews until the chat is deleted', async () => {
  let codexImagePath: string | undefined;
  let claudeInput: string | undefined;
  class ImageRunner extends ReplayCliRunner {
    override async run(command: string, args: string[], options: RunCommandOptions) {
      if (args.includes('--image')) {
        codexImagePath = args[args.indexOf('--image') + 1];
        expect(fs.readFileSync(codexImagePath, 'base64')).toBe(png);
      }
      if (options.stdinData) claudeInput = options.stdinData;
      return super.run(command, args, options);
    }
  }
  const runner = new ImageRunner({
    name: 'images', binaries: ['claude', 'codex', 'bwrap'],
    turns: [
      { match: { provider: 'claude-code' }, stdoutLines: ['{"type":"result","result":"I see a screenshot."}'], exitCode: 0 },
      { match: { provider: 'codex' }, stdoutLines: ['{"type":"item.completed","item":{"type":"agent_message","text":"I see it too."}}'], exitCode: 0 },
    ],
  });
  const { app, close } = await createDalangServer({ dbPath: ':memory:', runner });
  try {
    const opened = await app.inject({ method: 'POST', url: '/api/projects', payload: { mode: 'create', name: 'Test repo', path: tempDir() } });
    expect(opened.statusCode).toBe(201);
    const projectId = opened.json().project.id;
    const url = `/api/projects/${projectId}/chat`;
    const invalid = await app.inject({ method: 'POST', url, payload: { message: '', images: [{ ...image, data: 'aGVsbG8=' }] } });
    expect(invalid.statusCode).toBe(400);
    expect((await app.inject(`/api/projects/${projectId}/sessions`)).json().sessions).toEqual([]);

    const added = await app.inject({ method: 'POST', url, payload: { message: '', images: [image] } });
    expect(added.statusCode).toBe(200);
    expect(JSON.parse(claudeInput!).message.content[1]).toEqual({
      type: 'image', source: { type: 'base64', media_type: 'image/png', data: png },
    });
    const { session, messages } = added.json();
    const attachment = messages.find((entry: { type: string }) => entry.type === 'images');
    expect(attachment.content).toEqual({ text: '', images: [{ name: image.name, id: expect.any(String) }] });
    const imagePath = `/api/chat-images/${attachment.content.images[0].id}`;
    const downloaded = await app.inject(imagePath);
    expect(downloaded.headers['content-type']).toBe('image/png');
    expect(downloaded.rawPayload.toString('base64')).toBe(png);

    const followUp = await app.inject({ method: 'POST', url, payload: { sessionId: session.id, provider: 'codex', message: 'Compare', images: [image] } });
    expect(followUp.statusCode).toBe(200);
    expect(codexImagePath).toBeDefined();
    expect(fs.existsSync(codexImagePath!)).toBe(false);
    await app.inject({ method: 'DELETE', url: `/api/projects/${projectId}/sessions/${session.id}` });
    expect((await app.inject(imagePath)).statusCode).toBe(404);
  } finally {
    await close();
  }
});

it('uses the official update command for each installed CLI, with a concurrent update blocked', async () => {
  const updated: string[] = [];
  const updating = Promise.withResolvers<void>();
  const finish = Promise.withResolvers<void>();
  class UpdateRunner extends ReplayCliRunner {
    override async run(command: string, args: string[], options: RunCommandOptions) {
      if (args[0] !== 'update') return super.run(command, args, options);
      expect(args).toEqual(['update']);
      expect(options.cwd).toBe(os.homedir());
      updated.push(path.basename(command));
      updating.resolve();
      await finish.promise;
      return { exitCode: 0, stdout: '', stderr: '', timedOut: false, idleTimedOut: false };
    }
  }
  const runner = new UpdateRunner({ name: 'CLI updates', binaries: ['claude', 'codex', 'agy'], turns: [] });
  const { app, close } = await createDalangServer({ dbPath: ':memory:', runner });
  try {
    const update = (id: string) => app.inject({ method: 'POST', url: `/api/providers/${id}/update` });
    const first = update('claude-code');
    await updating.promise;
    expect((await update('claude-code')).statusCode).toBe(409);
    finish.resolve();
    expect((await first).statusCode).toBe(200);
    expect((await update('codex')).statusCode).toBe(200);
    expect((await update('antigravity')).statusCode).toBe(200);
    expect((await update('other')).statusCode).toBe(400);
    expect(updated).toEqual(['claude', 'codex', 'agy']);
  } finally {
    finish.resolve();
    await close();
  }
});
