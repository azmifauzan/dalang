import { describe, expect, it, vi } from 'vitest';
import { PARITY_INVENTORY } from '@dalang/core';
import { parseSlashCommand, SLASH_COMMANDS } from '../tui/commands.js';
import { handleParitySlashCommand, type ParityCommandContext } from '../tui/parity-commands.js';

describe('Room & Web parity commands (R5b / R5d)', () => {
  it('registers every room command referenced by PARITY_INVENTORY in SLASH_COMMANDS', () => {
    const registered = new Set(SLASH_COMMANDS.map((c) => c.name));
    const missing: string[] = [];
    for (const item of PARITY_INVENTORY) {
      if (item.status !== 'parity') continue;
      for (const cmd of item.roomCommands ?? []) {
        if (!registered.has(cmd)) missing.push(`${item.id} -> /${cmd}`);
      }
    }
    expect(missing).toEqual([]);
  });

  it('exercises profile advanced fields, routing, automations, MCP tokens, project/session/work/history/stats commands', async () => {
    const notices: string[][] = [];
    const confirmations: Array<{ label: string; run: () => Promise<void> }> = [];
    const profiles = [
      {
        id: 'p-exec',
        name: 'executor-light',
        provider: 'codex' as const,
        model: 'gpt-5-codex',
        effort: 'medium' as const,
        permissionMode: 'workspace-write' as const,
        timeoutMs: 1_800_000,
        idleTimeoutMs: 180_000,
        maxParallel: 1,
        maxReviewRounds: 2,
        fallback: null,
        configDir: null,
        rolePrompt: '',
        isDefault: true,
        createdAt: '2026-01-01T00:00:00Z',
      },
    ];

    const client = {
      baseUrl: 'http://127.0.0.1:4173',
      listProfiles: vi.fn(async () => profiles),
      createProfile: vi.fn(async (body) => ({ ...profiles[0], id: 'p-new', ...body })),
      updateProfile: vi.fn(async (_id, body) => ({ ...profiles[0], ...body })),
      deleteProfile: vi.fn(async () => ({ ok: true })),
      listRoutingRules: vi.fn(async () => [
        { id: 'r-1', role: 'engineer' as const, complexity: 'low' as const, profileId: 'p-exec', priority: 1, fallback: null },
        { id: 'r-2', role: 'reviewer' as const, complexity: null, profileId: 'p-exec', priority: 2, fallback: null },
      ]),
      createRoutingRule: vi.fn(async (body) => ({ id: 'r-3', priority: 3, ...body })),
      updateRoutingRule: vi.fn(async (id, body) => ({ id, role: 'engineer' as const, complexity: 'low' as const, profileId: 'p-exec', priority: 1, fallback: null, ...body })),
      reorderRoutingRules: vi.fn(async () => []),
      deleteRoutingRule: vi.fn(async () => ({ ok: true })),
      listAutomations: vi.fn(async () => []),
      createAutomation: vi.fn(async (body) => ({
        id: 'auto-1',
        projectName: 'demo',
        webhookUrl: body.kind === 'webhook' ? 'http://127.0.0.1:4173/api/webhooks/auto-1' : null,
        webhookSecret: body.kind === 'webhook' ? 'whsec_secret_once' : null,
        nextRunAt: null,
        lastTriggeredAt: null,
        lastStatus: null,
        lastError: null,
        createdAt: '2026-01-01T00:00:00Z',
        updatedAt: '2026-01-01T00:00:00Z',
        ...body,
      })),
      listMcpTokens: vi.fn(async () => ({ tokens: [], endpointUrl: 'http://127.0.0.1:4173/mcp' })),
      createMcpToken: vi.fn(async (body) => ({
        token: 'dlm_raw_once',
        endpointUrl: 'http://127.0.0.1:4173/mcp',
        tokenInfo: {
          id: 'tok-1',
          name: body.name,
          accessLevel: body.accessLevel,
          tokenPrefix: 'dlm_raw_',
          projectId: body.projectId ?? null,
          projectName: null,
          revokedAt: null,
          lastUsedAt: null,
          createdAt: '2026-01-01T00:00:00Z',
        },
      })),
      updateProjectSettings: vi.fn(async (_id, patch) => ({
        id: 'proj-1',
        name: 'demo',
        path: '/tmp/demo',
        leadProvider: 'codex' as const,
        leadModel: null,
        integrationCommand: patch.integrationCommand ?? null,
        pushAfterMerge: patch.pushAfterMerge ?? false,
        createPrAfterMerge: patch.createPrAfterMerge ?? false,
        gitRemote: patch.gitRemote ?? null,
        workingSessionId: null,
        createdAt: '2026-01-01T00:00:00Z',
      })),
      getUsageStatistics: vi.fn(async () => ({
        windowDays: 30,
        projectId: null,
        generatedAt: '2026-01-01T00:00:00Z',
        totals: { totalRuns: 4, completedRuns: 3, failedRuns: 1, fallbackRuns: 0, rateLimitEvents: 0, inputTokens: 1000, outputTokens: 500, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 1500, cacheHitRate: null, estimatedCostUsd: 0.05, totalDurationMs: 12_000 },
        providers: [{ provider: 'codex' as const, displayName: 'Codex CLI', totalRuns: 4, completedRuns: 3, failedRuns: 1, stoppedRuns: 0, runningRuns: 0, rolledBackRuns: 0, fallbackRuns: 0, byKind: { lead: 0, execute: 4, fix: 0, review: 0 }, inputTokens: 1000, outputTokens: 500, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 1500, cacheHitRate: null, estimatedCostUsd: 0.05, totalDurationMs: 12_000, avgDurationMs: 3000, rateLimitEvents: 0, timeoutEvents: 0, loginExpiredEvents: 0, errorEvents: 0, quotaFallbackEvents: 0, lastEventAt: null, lastEventDetail: null, activeRuns: 0, maxParallel: 1, inCooldown: false, cooldownReason: null, cooldownUntil: null, quotaExhausted: false, quotaReason: null }],
        models: [],
        projects: [{ projectId: 'proj-1', projectName: 'demo', totalRuns: 4, completedRuns: 3, failedRuns: 1, fallbackRuns: 0, totalTokens: 1500, estimatedCostUsd: 0.05, totalDurationMs: 12_000 }],
        recentEvents: [],
      })),
    };

    const ctx: ParityCommandContext = {
      client: client as unknown as ParityCommandContext['client'],
      activeProjectId: 'proj-1',
      activeProject: {
        id: 'proj-1',
        name: 'demo',
        path: '/tmp/demo',
        mainBranch: 'main',
        leadProvider: 'codex',
        leadModel: null,
        integrationCommand: null,
        pushAfterMerge: false,
        createPrAfterMerge: false,
        gitRemote: null,
        hasProjectMd: true,
        symlinksValid: { claudeMd: true, agentsMd: true },
        latestBriefStatus: 'none',
        latestBriefVersion: null,
        taskCount: 0,
        planStatus: 'none',
        sessionCount: 1,
        workingSessionId: null,
        workingSessionTitle: null,
        createdAt: '2026-01-01T00:00:00Z',
        updatedAt: '2026-01-01T00:00:00Z',
      },
      activeSessionId: 'sess-1',
      activeSession: null,
      detail: null,
      execution: null,
      profiles,
      pushNotice: (t) => notices.push(Array.isArray(t) ? t : [t]),
      setPendingConfirmation: (a) => confirmations.push(a),
      refreshSessionState: vi.fn(async () => {}),
      reloadAfterSetup: vi.fn(async () => {}),
      setActiveProjectId: vi.fn(),
      setActiveSessionId: vi.fn(),
      setDetail: vi.fn(),
      setProjects: vi.fn(),
      setSending: vi.fn(),
      setPagerOpen: vi.fn(),
      onOpenPager: vi.fn(async () => ({ ok: true })),
      runWithUnconfinedSupport: vi.fn(async (_l, fn) => fn(false)),
    };

    expect(await handleParitySlashCommand(parseSlashCommand('/profile set executor-light parallel 3')!, ctx)).toBe(true);
    expect(client.updateProfile).toHaveBeenCalledWith('p-exec', { maxParallel: 3 });

    expect(await handleParitySlashCommand(parseSlashCommand('/profile delete executor-light')!, ctx)).toBe(true);
    expect(confirmations.length).toBe(1);
    expect(confirmations[0].label).toContain('delete profile');

    expect(await handleParitySlashCommand(parseSlashCommand('/routing move 2 up')!, ctx)).toBe(true);
    expect(client.reorderRoutingRules).toHaveBeenCalledWith(['r-2', 'r-1']);

    expect(
      await handleParitySlashCommand(
        parseSlashCommand('/automation add webhook deploy-hook - Run checks -- Verify deployment health')!,
        ctx,
      ),
    ).toBe(true);
    expect(notices.flat().join('\n')).toContain('whsec_secret_once');

    expect(await handleParitySlashCommand(parseSlashCommand('/tokens create ci-bot read-only')!, ctx)).toBe(true);
    expect(notices.flat().join('\n')).toContain('dlm_raw_once');

    expect(await handleParitySlashCommand(parseSlashCommand('/project integration pnpm test')!, ctx)).toBe(true);
    expect(client.updateProjectSettings).toHaveBeenCalledWith('proj-1', { integrationCommand: 'pnpm test' });

    expect(await handleParitySlashCommand(parseSlashCommand('/stats 7')!, ctx)).toBe(true);
    expect(client.getUsageStatistics).toHaveBeenCalledWith({ days: 7 });
    expect(notices.flat().join('\n')).toContain('Usage statistics (30d)');
  });
});
