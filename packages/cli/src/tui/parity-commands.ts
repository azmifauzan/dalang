import type {
  AgentProfileDTO,
  EffortLevel,
  ExecutionStateDTO,
  McpAccessLevel,
  PermissionMode,
  ProjectSummary,
  ProviderId,
  SessionDetailDTO,
  SessionSummaryDTO,
  TaskComplexity,
  TaskRole,
} from '@dalang/shared';
import type { RoomApiClient } from './client.js';
import type { ParsedSlashCommand } from './commands.js';

export interface ParityCommandContext {
  client: RoomApiClient;
  activeProjectId: string | null;
  activeProject: ProjectSummary | null;
  activeSessionId: string | null;
  activeSession: SessionSummaryDTO | null;
  detail: SessionDetailDTO | null;
  execution: ExecutionStateDTO | null;
  profiles: AgentProfileDTO[];
  pushNotice: (text: string | string[], opts?: { isError?: boolean; badge?: string | null; author?: string }) => void;
  setPendingConfirmation: (action: { label: string; run: () => Promise<void> }) => void;
  refreshSessionState: (projectId: string, sessionId: string | null) => Promise<void>;
  reloadAfterSetup: () => Promise<void>;
  setActiveProjectId: (id: string | null) => void;
  setActiveSessionId: (id: string | null) => void;
  setDetail: (d: SessionDetailDTO | null) => void;
  setProjects: (p: ProjectSummary[]) => void;
  setSending: (v: boolean) => void;
  setPagerOpen: (v: boolean) => void;
  onOpenPager: (content: string, label: string) => Promise<{ ok: boolean; error?: string }>;
  runWithUnconfinedSupport: (label: string, fn: (allowUnconfined: boolean) => Promise<void>) => Promise<void>;
}

const VALID_PROVIDERS = new Set<string>(['claude-code', 'codex', 'antigravity']);
const VALID_EFFORTS = new Set<string>(['low', 'medium', 'high', 'xhigh']);
const VALID_PERMISSIONS = new Set<string>(['read-only', 'workspace-write', 'accept-edits']);
const VALID_ROLES = new Set<string>(['lead', 'engineer', 'qa', 'reviewer']);
const VALID_COMPLEXITIES = new Set<string>(['low', 'medium', 'high']);

function formatDurationMs(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return '-';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const sec = Math.round(ms / 1000);
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  return `${min}m ${sec % 60}s`;
}

function findProfile(profiles: AgentProfileDTO[], ref: string): AgentProfileDTO | undefined {
  const lower = ref.toLowerCase();
  return profiles.find((p) => p.id === ref || p.name.toLowerCase() === lower);
}

/**
 * Handles R5 Room-Web parity slash commands:
 * `/providers`, `/profile`, `/routing`, `/automation`, `/tokens`, `/session`,
 * `/work`, `/history`, `/stats` (`/statistics`), and `/project` settings subcommands.
 * Returns `true` if handled, `false` to fall through to RoomApp's built-in switch.
 */
export async function handleParitySlashCommand(
  cmd: ParsedSlashCommand,
  ctx: ParityCommandContext,
): Promise<boolean> {
  const { client, pushNotice, setPendingConfirmation } = ctx;

  // ─── /providers ───────────────────────────────────────────────────────────
  if (cmd.name === 'providers') {
    const sub = cmd.args[0]?.toLowerCase();
    if (sub === 'refresh') {
      const list = await client.refreshProvidersStatus();
      await ctx.reloadAfterSetup();
      pushNotice(
        [
          'Provider CLIs refreshed:',
          ...list.map(
            (p) =>
              `  ${p.displayName} (${p.id}): ${p.installed ? (p.loggedIn ? 'READY' : 'LOGIN NEEDED') : 'MISSING'} · ${p.version || p.binary} · sandbox=${p.sandboxReady ? p.sandboxEngine : 'unavailable'}`,
          ),
        ],
        { badge: 'PROVIDERS' },
      );
      return true;
    }
    if (sub === 'clear-cooldown') {
      const provider = cmd.args[1]?.toLowerCase();
      if (!provider || !VALID_PROVIDERS.has(provider)) {
        pushNotice('Usage: /providers clear-cooldown <claude-code|codex|antigravity>', { isError: true });
        return true;
      }
      await client.clearProviderCooldown(provider as ProviderId);
      await ctx.reloadAfterSetup();
      pushNotice(`Cleared cooldown state for ${provider}.`, { badge: 'PROVIDERS' });
      return true;
    }
    const list = await client.getProvidersStatus();
    pushNotice(
      [
        'Provider CLIs (/providers refresh | /providers clear-cooldown <provider>):',
        ...list.map(
          (p) =>
            `  ${p.displayName} (${p.id}): ${p.installed ? (p.loggedIn ? 'READY' : 'LOGIN NEEDED') : 'MISSING'} · ${p.models.length} models · ${p.authSummary}`,
        ),
      ],
      { badge: 'PROVIDERS' },
    );
    return true;
  }

  // ─── /profile ─────────────────────────────────────────────────────────────
  if (cmd.name === 'profile' || cmd.name === 'profiles') {
    const sub = cmd.args[0]?.toLowerCase();
    const list = await client.listProfiles();

    if (!sub || sub === 'list') {
      pushNotice(
        [
          'Agent profiles (/profile show <name> | add <name> <provider> [model] | set <name> <field> <value> | delete <name>):',
          ...list.map(
            (p) =>
              `  ${p.name} (${p.id}): ${p.provider} / ${p.model || 'CLI default'} · effort=${p.effort} · slots=${p.maxParallel} · rounds=${p.maxReviewRounds} · ${p.permissionMode}${p.configDir ? ` · dir=${p.configDir}` : ''}`,
          ),
        ],
        { badge: 'PROFILES' },
      );
      return true;
    }

    if (sub === 'show') {
      const ref = cmd.args[1];
      const prof = ref ? findProfile(list, ref) : undefined;
      if (!prof) {
        pushNotice(`Profile not found: ${ref ?? '(missing name)'}. Run /profile list.`, { isError: true });
        return true;
      }
      pushNotice(
        [
          `Profile ${prof.name} (${prof.id}):`,
          `  provider: ${prof.provider}`,
          `  model: ${prof.model || '(CLI default)'}`,
          `  effort: ${prof.effort}`,
          `  parallel: ${prof.maxParallel}`,
          `  permission: ${prof.permissionMode}`,
          `  review-rounds: ${prof.maxReviewRounds}`,
          `  timeout: ${Math.round(prof.timeoutMs / 1000)}s`,
          `  idle-timeout: ${Math.round(prof.idleTimeoutMs / 1000)}s`,
          `  config-dir: ${prof.configDir ?? '(default account)'}`,
          `  fallback: ${prof.fallback ? `${prof.fallback.provider} / ${prof.fallback.model || 'default'} (${prof.fallback.effort})` : 'off'}`,
          `  role-prompt: ${prof.rolePrompt || '(none)'}`,
        ],
        { badge: 'PROFILE' },
      );
      return true;
    }

    if (sub === 'add' || sub === 'create') {
      const name = cmd.args[1]?.trim();
      const provider = cmd.args[2]?.toLowerCase();
      const model = cmd.args[3] ?? '';
      if (!name || !provider || !VALID_PROVIDERS.has(provider)) {
        pushNotice('Usage: /profile add <name> <claude-code|codex|antigravity> [model]', { isError: true });
        return true;
      }
      const created = await client.createProfile({
        name,
        provider: provider as ProviderId,
        model,
        effort: 'medium',
        permissionMode: 'workspace-write',
        timeoutMs: 1_800_000,
        idleTimeoutMs: 180_000,
        maxParallel: 1,
        maxReviewRounds: 2,
        fallback: null,
        configDir: null,
        rolePrompt: '',
      });
      await ctx.reloadAfterSetup();
      pushNotice(`Created profile "${created.name}" (${created.provider}). Edit fields with /profile set ${created.name} <field> <value>.`, {
        badge: 'PROFILE',
      });
      return true;
    }

    if (sub === 'set') {
      const ref = cmd.args[1];
      const field = cmd.args[2]?.toLowerCase();
      const value = cmd.args.slice(3).join(' ').trim();
      const prof = ref ? findProfile(list, ref) : undefined;
      if (!prof || !field) {
        pushNotice(
          'Usage: /profile set <name> <provider|model|effort|parallel|config-dir|permission|review-rounds|timeout|idle-timeout|role-prompt|fallback> <value>',
          { isError: true },
        );
        return true;
      }
      let patch: Record<string, unknown> | null = null;
      if (field === 'provider') {
        if (!VALID_PROVIDERS.has(value)) {
          pushNotice('Provider must be claude-code, codex, or antigravity.', { isError: true });
          return true;
        }
        patch = { provider: value as ProviderId };
      } else if (field === 'model') {
        patch = { model: value === 'default' || value === 'none' ? '' : value };
      } else if (field === 'effort') {
        if (!VALID_EFFORTS.has(value)) {
          pushNotice('Effort must be low, medium, high, or xhigh.', { isError: true });
          return true;
        }
        patch = { effort: value as EffortLevel };
      } else if (field === 'parallel' || field === 'max-parallel' || field === 'slots') {
        const n = Number(value);
        if (!Number.isInteger(n) || n < 1 || n > 16) {
          pushNotice('Parallel slots must be an integer between 1 and 16.', { isError: true });
          return true;
        }
        patch = { maxParallel: n };
      } else if (field === 'config-dir' || field === 'account' || field === 'configdir') {
        patch = { configDir: !value || value === 'default' || value === 'none' ? null : value };
      } else if (field === 'permission' || field === 'permission-mode') {
        if (!VALID_PERMISSIONS.has(value)) {
          pushNotice('Permission mode must be read-only, workspace-write, or accept-edits.', { isError: true });
          return true;
        }
        patch = { permissionMode: value as PermissionMode };
      } else if (field === 'review-rounds' || field === 'max-review-rounds') {
        const n = Number(value);
        if (!Number.isInteger(n) || n < 1 || n > 6) {
          pushNotice('Max review rounds must be an integer between 1 and 6.', { isError: true });
          return true;
        }
        patch = { maxReviewRounds: n };
      } else if (field === 'timeout' || field === 'timeout-sec') {
        const sec = Number(value);
        if (!Number.isFinite(sec) || sec < 5 || sec > 7200) {
          pushNotice('Timeout must be between 5 and 7200 seconds.', { isError: true });
          return true;
        }
        patch = { timeoutMs: Math.round(sec * 1000) };
      } else if (field === 'idle-timeout' || field === 'idle-timeout-sec') {
        const sec = Number(value);
        if (!Number.isFinite(sec) || sec < 5 || sec > 1800) {
          pushNotice('Idle timeout must be between 5 and 1800 seconds.', { isError: true });
          return true;
        }
        patch = { idleTimeoutMs: Math.round(sec * 1000) };
      } else if (field === 'role-prompt' || field === 'prompt') {
        patch = { rolePrompt: value === 'clear' || value === 'none' ? '' : value };
      } else if (field === 'fallback') {
        if (!value || value === 'off' || value === 'none') {
          patch = { fallback: null };
        } else {
          const [fbProv, fbModel = '', fbEffort = 'medium'] = value.split(/\s+/);
          if (!VALID_PROVIDERS.has(fbProv)) {
            pushNotice('Fallback usage: /profile set <name> fallback <off|provider [model] [effort]>', { isError: true });
            return true;
          }
          patch = {
            fallback: {
              provider: fbProv as ProviderId,
              model: fbModel === 'default' ? '' : fbModel,
              effort: (VALID_EFFORTS.has(fbEffort) ? fbEffort : 'medium') as EffortLevel,
              configDir: null,
            },
          };
        }
      } else {
        pushNotice(`Unknown profile field "${field}".`, { isError: true });
        return true;
      }

      const updated = await client.updateProfile(prof.id, patch);
      await ctx.reloadAfterSetup();
      pushNotice(`Updated profile "${updated.name}" (${field} saved).`, { badge: 'PROFILE' });
      return true;
    }

    if (sub === 'delete' || sub === 'rm') {
      const confirmedYes = cmd.args.includes('--yes');
      const ref = cmd.args.filter((a) => a !== '--yes')[1];
      const prof = ref ? findProfile(list, ref) : undefined;
      if (!prof) {
        pushNotice(`Profile not found: ${ref ?? '(missing name)'}.`, { isError: true });
        return true;
      }
      const doDelete = async () => {
        await client.deleteProfile(prof.id);
        await ctx.reloadAfterSetup();
        pushNotice(`Deleted profile "${prof.name}".`, { badge: 'PROFILE' });
      };
      if (!confirmedYes) {
        setPendingConfirmation({
          label: `delete profile "${prof.name}" (${prof.id})`,
          run: doDelete,
        });
        return true;
      }
      await doDelete();
      return true;
    }

    pushNotice('Usage: /profile [list|show <name>|add <name> <provider> [model]|set <name> <field> <value>|delete <name>]', {
      isError: true,
    });
    return true;
  }

  // ─── /routing ─────────────────────────────────────────────────────────────
  if (cmd.name === 'routing') {
    const sub = cmd.args[0]?.toLowerCase();
    const [rules, profiles] = await Promise.all([client.listRoutingRules(), client.listProfiles()]);
    const profName = (id: string) => profiles.find((p) => p.id === id)?.name ?? id;

    if (!sub || sub === 'list') {
      pushNotice(
        [
          'Task routing rules (/routing add <role> <low|medium|high|any> <profile> | edit <n|id> <profile> | move <n|id> <up|down> | delete <n|id>):',
          ...(rules.length === 0
            ? ['  (no rules)']
            : rules.map(
                (r, idx) =>
                  `  ${idx + 1}. [${r.id}] ${r.role} / ${r.complexity ?? 'any'} -> ${profName(r.profileId)}${r.fallback ? ` (fallback ${r.fallback.provider})` : ''}`,
              )),
        ],
        { badge: 'ROUTING' },
      );
      return true;
    }

    const resolveRule = (ref?: string) => {
      if (!ref) return null;
      const idx = Number(ref);
      if (Number.isInteger(idx) && idx >= 1 && idx <= rules.length) return { rule: rules[idx - 1], index: idx - 1 };
      const i = rules.findIndex((r) => r.id === ref);
      return i >= 0 ? { rule: rules[i], index: i } : null;
    };

    if (sub === 'add' || sub === 'create') {
      const role = cmd.args[1]?.toLowerCase();
      const compArg = cmd.args[2]?.toLowerCase();
      const profRef = cmd.args[3];
      if (!role || !VALID_ROLES.has(role) || !compArg || !profRef) {
        pushNotice('Usage: /routing add <lead|engineer|qa|reviewer> <low|medium|high|any> <profile>', { isError: true });
        return true;
      }
      const complexity = compArg === 'any' || compArg === '*' ? null : compArg;
      if (complexity !== null && !VALID_COMPLEXITIES.has(complexity)) {
        pushNotice('Complexity must be low, medium, high, or any.', { isError: true });
        return true;
      }
      const prof = findProfile(profiles, profRef);
      if (!prof) {
        pushNotice(`Profile not found: ${profRef}.`, { isError: true });
        return true;
      }
      const created = await client.createRoutingRule({
        role: role as TaskRole,
        complexity: complexity as TaskComplexity | null,
        profileId: prof.id,
        fallback: null,
      });
      await ctx.reloadAfterSetup();
      pushNotice(`Added routing rule [${created.id}]: ${created.role} / ${created.complexity ?? 'any'} -> ${prof.name}.`, {
        badge: 'ROUTING',
      });
      return true;
    }

    if (sub === 'edit' || sub === 'set') {
      const found = resolveRule(cmd.args[1]);
      const profRef = cmd.args[2];
      if (!found || !profRef) {
        pushNotice('Usage: /routing edit <n|id> <profile>', { isError: true });
        return true;
      }
      const prof = findProfile(profiles, profRef);
      if (!prof) {
        pushNotice(`Profile not found: ${profRef}.`, { isError: true });
        return true;
      }
      await client.updateRoutingRule(found.rule.id, { profileId: prof.id });
      await ctx.reloadAfterSetup();
      pushNotice(`Updated routing rule #${found.index + 1} -> ${prof.name}.`, { badge: 'ROUTING' });
      return true;
    }

    if (sub === 'move' || sub === 'reorder') {
      const found = resolveRule(cmd.args[1]);
      const dir = cmd.args[2]?.toLowerCase();
      if (!found || (dir !== 'up' && dir !== 'down')) {
        pushNotice('Usage: /routing move <n|id> <up|down>', { isError: true });
        return true;
      }
      const targetIdx = found.index + (dir === 'up' ? -1 : 1);
      if (targetIdx < 0 || targetIdx >= rules.length) {
        pushNotice(`Rule #${found.index + 1} is already at the ${dir === 'up' ? 'top' : 'bottom'}.`, { badge: 'ROUTING' });
        return true;
      }
      const ids = rules.map((r) => r.id);
      const [moved] = ids.splice(found.index, 1);
      ids.splice(targetIdx, 0, moved);
      await client.reorderRoutingRules(ids);
      await ctx.reloadAfterSetup();
      pushNotice(`Moved routing rule to position #${targetIdx + 1}.`, { badge: 'ROUTING' });
      return true;
    }

    if (sub === 'delete' || sub === 'rm') {
      const confirmedYes = cmd.args.includes('--yes');
      const ref = cmd.args.filter((a) => a !== '--yes')[1];
      const found = resolveRule(ref);
      if (!found) {
        pushNotice(`Routing rule not found: ${ref ?? '(missing)'}.`, { isError: true });
        return true;
      }
      const doDelete = async () => {
        await client.deleteRoutingRule(found.rule.id);
        await ctx.reloadAfterSetup();
        pushNotice(`Deleted routing rule [${found.rule.id}].`, { badge: 'ROUTING' });
      };
      if (!confirmedYes) {
        setPendingConfirmation({
          label: `delete routing rule [${found.rule.id}] (${found.rule.role}/${found.rule.complexity ?? 'any'})`,
          run: doDelete,
        });
        return true;
      }
      await doDelete();
      return true;
    }

    pushNotice('Usage: /routing [list|add <role> <complexity|any> <profile>|edit <n|id> <profile>|move <n|id> <up|down>|delete <n|id>]', {
      isError: true,
    });
    return true;
  }

  // ─── /automation ──────────────────────────────────────────────────────────
  if (cmd.name === 'automation' || cmd.name === 'automations') {
    const sub = cmd.args[0]?.toLowerCase();
    const list = await client.listAutomations();
    const resolveAuto = (ref?: string) => {
      if (!ref) return null;
      const idx = Number(ref);
      if (Number.isInteger(idx) && idx >= 1 && idx <= list.length) return list[idx - 1];
      return list.find((a) => a.id === ref || a.name.toLowerCase() === ref.toLowerCase()) ?? null;
    };

    if (!sub || sub === 'list') {
      pushNotice(
        [
          'Automations (/automation add <schedule|webhook> <name> <cron|-> <title> -- <prompt> | enable/disable/trigger/rotate/runs/delete <n|id>):',
          ...(list.length === 0
            ? ['  (no automations configured)']
            : list.map(
                (a, idx) =>
                  `  ${idx + 1}. ${a.name} [${a.kind}] ${a.enabled ? 'ENABLED' : 'PAUSED'} · ${a.projectName}${a.cronExpr ? ` · cron="${a.cronExpr}"` : ''}${a.webhookUrl ? ` · ${a.webhookUrl}` : ''}${a.lastStatus ? ` · last=${a.lastStatus}` : ''}`,
              )),
        ],
        { badge: 'AUTOMATION' },
      );
      return true;
    }

    if (sub === 'add' || sub === 'create') {
      if (!ctx.activeProjectId) {
        pushNotice('Open or select a project first before creating an automation.', { isError: true });
        return true;
      }
      const kind = cmd.args[1]?.toLowerCase();
      const name = cmd.args[2]?.trim();
      const cronOrDash = cmd.args[3]?.trim();
      const afterDash = cmd.rawArgs.indexOf(' -- ');
      if ((kind !== 'schedule' && kind !== 'webhook') || !name || !cronOrDash || afterDash === -1) {
        pushNotice(
          'Usage: /automation add <schedule|webhook> <name> <5-field-cron-with-underscores|-> <title> -- <prompt>',
          { isError: true },
        );
        return true;
      }
      const before = cmd.rawArgs.slice(0, afterDash).trim().split(/\s+/);
      const title = before.slice(4).join(' ').trim();
      const prompt = cmd.rawArgs.slice(afterDash + 4).trim();
      if (!title || !prompt) {
        pushNotice('Both title (before --) and prompt (after --) are required.', { isError: true });
        return true;
      }
      const cronExpr = kind === 'schedule' ? cronOrDash.replace(/_/g, ' ') : null;
      const created = await client.createAutomation({
        projectId: ctx.activeProjectId,
        name,
        kind,
        enabled: true,
        cronExpr,
        title,
        prompt,
        role: 'engineer',
        complexity: 'low',
        output: 'files',
        filesAllowed: [],
        filesReference: [],
        acceptanceCriteria: ['Goal and acceptance criteria are met'],
        verify: null,
        profileOverride: null,
        allowUnconfined: false,
        autoMerge: false,
      });
      const lines = [`Created ${created.kind} automation "${created.name}" (${created.id}).`];
      if (created.webhookUrl) lines.push(`  Webhook URL: ${created.webhookUrl}`);
      if (created.webhookSecret) {
        lines.push(`  Webhook secret (shown once — save it now): ${created.webhookSecret}`);
      }
      pushNotice(lines, { badge: 'AUTOMATION' });
      return true;
    }

    if (sub === 'enable' || sub === 'disable' || sub === 'pause') {
      const target = resolveAuto(cmd.args[1]);
      if (!target) {
        pushNotice(`Automation not found: ${cmd.args[1] ?? '(missing)'}.`, { isError: true });
        return true;
      }
      const enabled = sub === 'enable';
      await client.updateAutomation(target.id, { enabled });
      pushNotice(`Automation "${target.name}" ${enabled ? 'enabled' : 'paused'}.`, { badge: 'AUTOMATION' });
      return true;
    }

    if (sub === 'trigger' || sub === 'run') {
      const target = resolveAuto(cmd.args[1]);
      if (!target) {
        pushNotice(`Automation not found: ${cmd.args[1] ?? '(missing)'}.`, { isError: true });
        return true;
      }
      const run = await client.triggerAutomation(target.id);
      pushNotice(`Triggered "${target.name}": status=${run.status}${run.detail ? ` · ${run.detail}` : ''}.`, {
        badge: 'AUTOMATION',
      });
      return true;
    }

    if (sub === 'rotate' || sub === 'rotate-secret') {
      const target = resolveAuto(cmd.args[1]);
      if (!target) {
        pushNotice(`Automation not found: ${cmd.args[1] ?? '(missing)'}.`, { isError: true });
        return true;
      }
      const rotated = await client.rotateWebhookSecret(target.id);
      pushNotice(
        [
          `Rotated webhook secret for "${rotated.name}".`,
          ...(rotated.webhookSecret ? [`  New secret (shown once): ${rotated.webhookSecret}`] : []),
        ],
        { badge: 'AUTOMATION' },
      );
      return true;
    }

    if (sub === 'runs') {
      const target = resolveAuto(cmd.args[1]);
      if (!target) {
        pushNotice(`Automation not found: ${cmd.args[1] ?? '(missing)'}.`, { isError: true });
        return true;
      }
      const runs = await client.listAutomationRuns(target.id, 15);
      pushNotice(
        [
          `Recent runs for "${target.name}":`,
          ...(runs.length === 0
            ? ['  (no runs yet)']
            : runs.map((r) => `  - ${r.triggeredAt} [${r.status}] via ${r.triggerSource}${r.detail ? ` · ${r.detail}` : ''}`)),
        ],
        { badge: 'AUTOMATION' },
      );
      return true;
    }

    if (sub === 'delete' || sub === 'rm') {
      const confirmedYes = cmd.args.includes('--yes');
      const ref = cmd.args.filter((a) => a !== '--yes')[1];
      const target = resolveAuto(ref);
      if (!target) {
        pushNotice(`Automation not found: ${ref ?? '(missing)'}.`, { isError: true });
        return true;
      }
      const doDelete = async () => {
        await client.deleteAutomation(target.id);
        pushNotice(`Deleted automation "${target.name}".`, { badge: 'AUTOMATION' });
      };
      if (!confirmedYes) {
        setPendingConfirmation({
          label: `delete automation "${target.name}" (${target.id})`,
          run: doDelete,
        });
        return true;
      }
      await doDelete();
      return true;
    }

    pushNotice('Usage: /automation [list|add|enable|disable|trigger|rotate|runs|delete]', { isError: true });
    return true;
  }

  // ─── /tokens (MCP tokens) ─────────────────────────────────────────────────
  if (cmd.name === 'tokens' || cmd.name === 'token') {
    const sub = cmd.args[0]?.toLowerCase();
    const { tokens, endpointUrl } = await client.listMcpTokens();
    const resolveToken = (ref?: string) => {
      if (!ref) return null;
      const idx = Number(ref);
      if (Number.isInteger(idx) && idx >= 1 && idx <= tokens.length) return tokens[idx - 1];
      return tokens.find((t) => t.id === ref || t.name.toLowerCase() === ref.toLowerCase()) ?? null;
    };

    if (!sub || sub === 'list') {
      pushNotice(
        [
          `Outside-agent MCP tokens (endpoint: ${endpointUrl ?? `${client.baseUrl}/mcp`}):`,
          ...(tokens.length === 0
            ? ['  (no tokens yet — run /tokens create <name> [read-only|full-access] [projectId])']
            : tokens.map(
                (t, idx) =>
                  `  ${idx + 1}. ${t.name} [${t.accessLevel}] ${t.revokedAt ? 'REVOKED' : 'ACTIVE'} · prefix=${t.tokenPrefix}... · scope=${t.projectName ?? 'all projects'}`,
              )),
        ],
        { badge: 'MCP' },
      );
      return true;
    }

    if (sub === 'create' || sub === 'add') {
      const name = cmd.args[1]?.trim();
      const accessArg = (cmd.args[2]?.toLowerCase() ?? 'read-only') as McpAccessLevel;
      const projectId = cmd.args[3] ?? null;
      if (!name || (accessArg !== 'read-only' && accessArg !== 'full-access')) {
        pushNotice('Usage: /tokens create <name> [read-only|full-access] [projectId]', { isError: true });
        return true;
      }
      const created = await client.createMcpToken({
        name,
        accessLevel: accessArg,
        projectId,
      });
      const ep = created.endpointUrl ?? endpointUrl ?? `${client.baseUrl}/mcp`;
      pushNotice(
        [
          `Created MCP token "${created.tokenInfo.name}" [${created.tokenInfo.accessLevel}].`,
          `  Token (shown once — save it now): ${created.token}`,
          `  Claude snippet: claude mcp add --transport http dalang ${ep} --header "Authorization: Bearer ${created.token}"`,
        ],
        { badge: 'MCP' },
      );
      return true;
    }

    if (sub === 'revoke') {
      const confirmedYes = cmd.args.includes('--yes');
      const ref = cmd.args.filter((a) => a !== '--yes')[1];
      const target = resolveToken(ref);
      if (!target) {
        pushNotice(`MCP token not found: ${ref ?? '(missing)'}.`, { isError: true });
        return true;
      }
      const doRevoke = async () => {
        await client.revokeMcpToken(target.id);
        pushNotice(`Revoked MCP token "${target.name}".`, { badge: 'MCP' });
      };
      if (!confirmedYes) {
        setPendingConfirmation({ label: `revoke MCP token "${target.name}"`, run: doRevoke });
        return true;
      }
      await doRevoke();
      return true;
    }

    if (sub === 'delete' || sub === 'rm') {
      const confirmedYes = cmd.args.includes('--yes');
      const ref = cmd.args.filter((a) => a !== '--yes')[1];
      const target = resolveToken(ref);
      if (!target) {
        pushNotice(`MCP token not found: ${ref ?? '(missing)'}.`, { isError: true });
        return true;
      }
      const doDelete = async () => {
        await client.deleteMcpToken(target.id);
        pushNotice(`Deleted MCP token "${target.name}".`, { badge: 'MCP' });
      };
      if (!confirmedYes) {
        setPendingConfirmation({ label: `delete MCP token "${target.name}"`, run: doDelete });
        return true;
      }
      await doDelete();
      return true;
    }

    pushNotice('Usage: /tokens [list|create <name> [read-only|full-access] [projectId]|revoke <n|id>|delete <n|id>]', {
      isError: true,
    });
    return true;
  }

  // ─── /session ─────────────────────────────────────────────────────────────
  if (cmd.name === 'session' || cmd.name === 'sessions') {
    if (!ctx.activeProjectId) {
      pushNotice('Select or open a project first (/project).', { isError: true });
      return true;
    }
    const sub = cmd.args[0]?.toLowerCase();
    if (!sub || sub === 'list') {
      const { sessions } = await client.listSessions(ctx.activeProjectId, true);
      pushNotice(
        [
          'Project sessions (/session rename <title> | archive | unarchive | discard | delete):',
          ...(sessions.length === 0
            ? ['  (no sessions yet)']
            : sessions.slice(0, 20).map(
                (s, idx) =>
                  `  ${idx + 1}. ${s.id === ctx.activeSessionId ? '*' : ' '} [${s.mode}] ${s.title || '(untitled)'} (${s.id.slice(0, 8)})${s.archivedAt ? ' [archived]' : ''}${s.workState === 'working' ? ' [working]' : ''}`,
              )),
        ],
        { badge: 'SESSIONS' },
      );
      return true;
    }
    if (!ctx.activeSessionId) {
      pushNotice('No active session. Send a message or /resume one first.', { isError: true });
      return true;
    }
    if (sub === 'rename') {
      const title = cmd.rawArgs.slice('rename'.length).trim();
      if (!title) {
        pushNotice('Usage: /session rename <new title>', { isError: true });
        return true;
      }
      const updated = await client.updateSession(ctx.activeProjectId, ctx.activeSessionId, { title });
      await ctx.refreshSessionState(ctx.activeProjectId, ctx.activeSessionId);
      pushNotice(`Renamed session to "${updated.title}".`, { badge: 'SESSION' });
      return true;
    }
    if (sub === 'archive' || sub === 'unarchive') {
      const archived = sub === 'archive';
      await client.updateSession(ctx.activeProjectId, ctx.activeSessionId, { archived });
      await ctx.refreshSessionState(ctx.activeProjectId, ctx.activeSessionId);
      pushNotice(archived ? 'Session archived.' : 'Session unarchived.', { badge: 'SESSION' });
      return true;
    }
    if (sub === 'discard') {
      const confirmedYes = cmd.args.includes('--yes');
      const pid = ctx.activeProjectId;
      const sid = ctx.activeSessionId;
      const doDiscard = async () => {
        const res = await client.discardSessionWork(pid, sid);
        await ctx.refreshSessionState(pid, sid);
        pushNotice(`Discarded session work (${res.discardedTasks} task(s) cleaned up).`, { badge: 'SESSION' });
      };
      if (!confirmedYes) {
        setPendingConfirmation({
          label: `discard all unmerged work in session ${sid.slice(0, 8)}`,
          run: doDiscard,
        });
        return true;
      }
      await doDiscard();
      return true;
    }
    if (sub === 'delete' || sub === 'rm') {
      const confirmedYes = cmd.args.includes('--yes');
      const pid = ctx.activeProjectId;
      const sid = ctx.activeSessionId;
      const doDelete = async () => {
        await client.deleteSession(pid, sid);
        ctx.setActiveSessionId(null);
        ctx.setDetail(null);
        await ctx.refreshSessionState(pid, null);
        pushNotice(`Deleted session ${sid.slice(0, 8)}.`, { badge: 'SESSION' });
      };
      if (!confirmedYes) {
        setPendingConfirmation({
          label: `delete session ${sid.slice(0, 8)} and its messages`,
          run: doDelete,
        });
        return true;
      }
      await doDelete();
      return true;
    }
    pushNotice('Usage: /session [list|rename <title>|archive|unarchive|discard|delete]', { isError: true });
    return true;
  }

  // ─── /project settings extensions ─────────────────────────────────────────
  if (cmd.name === 'project' || cmd.name === 'projects') {
    const sub = cmd.args[0]?.toLowerCase();
    const settingSubs = new Set(['settings', 'lead', 'integration', 'push', 'pr', 'remote', 'md', 'delete']);
    if (!sub || !settingSubs.has(sub)) return false;

    if (!ctx.activeProjectId || !ctx.activeProject) {
      pushNotice('No active project. Switch to or open a project first.', { isError: true });
      return true;
    }
    const pid = ctx.activeProjectId;
    const proj = ctx.activeProject;

    if (sub === 'settings') {
      pushNotice(
        [
          `Project settings for "${proj.name}" (${proj.path}):`,
          `  Lead: ${proj.leadProvider} / ${proj.leadModel || '(CLI default)'}`,
          `  Integration command: ${proj.integrationCommand ?? '(auto-detect / none)'}`,
          `  Push after merge: ${proj.pushAfterMerge ? 'on' : 'off'}`,
          `  Create PR after merge: ${proj.createPrAfterMerge ? 'on' : 'off'}`,
          `  Git remote: ${proj.gitRemote ?? '(default origin)'}`,
          'Edit with /project lead|integration|push|pr|remote|md|delete.',
        ],
        { badge: 'PROJECT' },
      );
      return true;
    }

    if (sub === 'lead') {
      const provider = cmd.args[1]?.toLowerCase();
      const modelArg = cmd.args[2];
      if (!provider || !VALID_PROVIDERS.has(provider)) {
        pushNotice('Usage: /project lead <claude-code|codex|antigravity> [model|default]', { isError: true });
        return true;
      }
      const updated = await client.updateProjectSettings(pid, {
        leadProvider: provider as ProviderId,
        ...(modelArg !== undefined ? { leadModel: modelArg === 'default' ? null : modelArg } : {}),
      });
      await ctx.reloadAfterSetup();
      pushNotice(`Updated project Lead to ${updated.leadProvider} / ${updated.leadModel || 'CLI default'}.`, {
        badge: 'PROJECT',
      });
      return true;
    }

    if (sub === 'integration') {
      const value = cmd.rawArgs.slice('integration'.length).trim();
      if (!value) {
        pushNotice('Usage: /project integration <command|off>', { isError: true });
        return true;
      }
      const updated = await client.updateProjectSettings(pid, {
        integrationCommand: value.toLowerCase() === 'off' ? null : value,
      });
      await ctx.reloadAfterSetup();
      pushNotice(`Project integration command set to: ${updated.integrationCommand ?? '(auto/none)'}.`, {
        badge: 'PROJECT',
      });
      return true;
    }

    if (sub === 'push' || sub === 'pr') {
      const val = cmd.args[1]?.toLowerCase();
      if (val !== 'on' && val !== 'off') {
        pushNotice(`Usage: /project ${sub} <on|off>`, { isError: true });
        return true;
      }
      const flag = val === 'on';
      await client.updateProjectSettings(
        pid,
        sub === 'push' ? { pushAfterMerge: flag } : { createPrAfterMerge: flag },
      );
      await ctx.reloadAfterSetup();
      pushNotice(`${sub === 'push' ? 'Push after merge' : 'Create PR after merge'} turned ${val}.`, {
        badge: 'PROJECT',
      });
      return true;
    }

    if (sub === 'remote') {
      const val = cmd.args[1];
      if (!val) {
        pushNotice('Usage: /project remote <remote-name|off>', { isError: true });
        return true;
      }
      const updated = await client.updateProjectSettings(pid, {
        gitRemote: val.toLowerCase() === 'off' ? null : val,
      });
      await ctx.reloadAfterSetup();
      pushNotice(`Project git remote set to: ${updated.gitRemote ?? '(default)'}.`, { badge: 'PROJECT' });
      return true;
    }

    if (sub === 'md') {
      const action = cmd.args[1]?.toLowerCase() ?? 'show';
      const md = await client.getProjectMd(pid);
      if (action === 'repair') {
        const saved = await client.saveProjectMd(pid, md.content, true);
        pushNotice(
          `PROJECT.md symlinks checked/repaired: CLAUDE.md=${saved.symlinksValid.claudeMd ? 'ok' : 'invalid'}, AGENTS.md=${saved.symlinksValid.agentsMd ? 'ok' : 'invalid'}.`,
          { badge: 'PROJECT.MD' },
        );
        return true;
      }
      pushNotice(
        [
          `PROJECT.md (CLAUDE.md=${md.symlinksValid.claudeMd ? 'ok' : 'broken'}, AGENTS.md=${md.symlinksValid.agentsMd ? 'ok' : 'broken'}):`,
          ...md.content.split('\n').slice(0, 25),
        ],
        { badge: 'PROJECT.MD' },
      );
      return true;
    }

    if (sub === 'delete') {
      const confirmedYes = cmd.args.includes('--yes');
      const doDelete = async () => {
        await client.deleteProject(pid);
        const latest = await client.listProjects();
        ctx.setProjects(latest);
        const nextProj = latest[0] ?? null;
        ctx.setActiveProjectId(nextProj?.id ?? null);
        ctx.setActiveSessionId(null);
        ctx.setDetail(null);
        if (nextProj) await ctx.refreshSessionState(nextProj.id, null);
        pushNotice(`Removed project "${proj.name}" from DALANG (files on disk were not deleted).`, {
          badge: 'PROJECT',
        });
      };
      if (!confirmedYes) {
        setPendingConfirmation({
          label: `remove project "${proj.name}" from DALANG (keeps files on disk, deletes DALANG sessions/history)`,
          run: doDelete,
        });
        return true;
      }
      await doDelete();
      return true;
    }
  }

  // ─── /work ────────────────────────────────────────────────────────────────
  if (cmd.name === 'work') {
    if (!ctx.activeProjectId) {
      pushNotice('No active project.', { isError: true });
      return true;
    }
    const pid = ctx.activeProjectId;
    const sub = cmd.args[0]?.toLowerCase();
    const execState = await client.getExecutionState(pid, ctx.activeSessionId ?? undefined);
    const planTasks = ctx.detail?.plan?.tasks ?? [];
    const previews = execState.dispatchPreviews ?? [];
    const resolveTask = (ref?: string) => {
      if (!ref) return null;
      const lower = ref.toLowerCase();
      const fromPlan = planTasks.find((t) => t.id === ref || t.externalId.toLowerCase() === lower);
      if (fromPlan) return { id: fromPlan.id, externalId: fromPlan.externalId, branchName: fromPlan.branchName };
      const fromPreview = previews.find((p) => p.taskId === ref || p.externalId.toLowerCase() === lower);
      if (fromPreview) return { id: fromPreview.taskId, externalId: fromPreview.externalId, branchName: null };
      return null;
    };

    if (!sub || sub === 'status') {
      const lines = [
        `Work status (${execState.queueRunning ? 'queue running' : 'idle'} · ${execState.activeRuns.length} active run(s)):`,
        ...(previews.length === 0
          ? ['  No tasks in the current plan.']
          : previews.map((t) => {
              const run = execState.runs.find((r) => r.taskId === t.taskId);
              const timingStr = run?.durationMs !== null && run?.durationMs !== undefined ? ` · ${formatDurationMs(run.durationMs)}` : '';
              const splitParts: string[] = [];
              if (run?.timing) {
                if (run.timing.setupMs !== null) splitParts.push(`setup ${formatDurationMs(run.timing.setupMs)}`);
                if (run.timing.slotWaitMs !== null && run.timing.slotWaitMs > 0) splitParts.push(`wait ${formatDurationMs(run.timing.slotWaitMs)}`);
                if (run.timing.agentMs !== null) splitParts.push(`agent ${formatDurationMs(run.timing.agentMs)}`);
                if (run.timing.verifyMs !== null) splitParts.push(`verify ${formatDurationMs(run.timing.verifyMs)}`);
                if (run.timing.reviewMs !== null) splitParts.push(`review ${formatDurationMs(run.timing.reviewMs)}`);
              }
              const splitStr = splitParts.length > 0 ? ` [${splitParts.join(', ')}]` : '';
              const slotStr = run?.slotWait ? ` · waiting for slot (${run.slotWait.activeCount}/${run.slotWait.limit})` : '';
              return `  [${t.externalId}] ${t.status} · ${t.title} (${t.complexity}, ${t.resolvedProfileName})${timingStr}${splitStr}${slotStr}`;
            })),
      ];
      pushNotice(lines, { badge: 'WORK' });
      return true;
    }

    if (sub === 'run' || sub === 'retry') {
      const confirmedYes = cmd.args.includes('--yes');
      const taskRef = cmd.args.filter((a) => a !== '--yes')[1];
      const task = resolveTask(taskRef);
      if (!task) {
        pushNotice(`Task not found: ${taskRef ?? '(missing taskId)'}. Run /work status.`, { isError: true });
        return true;
      }
      const doRun = async () => {
        ctx.setSending(true);
        try {
          await ctx.runWithUnconfinedSupport(`${sub} [${task.externalId}]`, async (allowUnconfined) => {
            await client.runTask(pid, task.id, { allowUnconfined, resumeSession: false });
          });
          await ctx.refreshSessionState(pid, ctx.activeSessionId);
          pushNotice(`Started [${task.externalId}].`, { badge: 'WORK' });
        } finally {
          ctx.setSending(false);
        }
      };
      if (sub === 'retry' && task.branchName && !confirmedYes) {
        setPendingConfirmation({
          label: `retry [${task.externalId}] from scratch (deletes branch & worktree — use /continue ${task.externalId} to keep existing work)`,
          run: doRun,
        });
        return true;
      }
      await doRun();
      return true;
    }

    if (sub === 'assign') {
      const task = resolveTask(cmd.args[1]);
      const profRef = cmd.args[2];
      if (!task || !profRef) {
        pushNotice('Usage: /work assign <taskId> <profileName|auto>', { isError: true });
        return true;
      }
      const override =
        profRef.toLowerCase() === 'auto' || profRef.toLowerCase() === 'none'
          ? null
          : findProfile(ctx.profiles, profRef)?.id ?? null;
      if (profRef.toLowerCase() !== 'auto' && profRef.toLowerCase() !== 'none' && !override) {
        pushNotice(`Profile not found: ${profRef}.`, { isError: true });
        return true;
      }
      await client.assignTaskProfile(pid, task.id, override);
      await ctx.refreshSessionState(pid, ctx.activeSessionId);
      pushNotice(`Assigned [${task.externalId}] to ${override ? profRef : 'automatic routing'}.`, { badge: 'WORK' });
      return true;
    }

    if (sub === 'rollback') {
      const confirmedYes = cmd.args.includes('--yes');
      const runId = cmd.args.filter((a) => a !== '--yes')[1];
      if (!runId) {
        pushNotice('Usage: /work rollback <runId>', { isError: true });
        return true;
      }
      const doRollback = async () => {
        await client.rollbackRun(pid, runId);
        await ctx.refreshSessionState(pid, ctx.activeSessionId);
        pushNotice(`Rolled back run ${runId}.`, { badge: 'WORK' });
      };
      if (!confirmedYes) {
        setPendingConfirmation({
          label: `rollback run ${runId} (reverts branch/worktree state)`,
          run: doRollback,
        });
        return true;
      }
      await doRollback();
      return true;
    }

    if (sub === 'push-pr') {
      const task = resolveTask(cmd.args[1]);
      if (!task) {
        pushNotice('Usage: /work push-pr <taskId>', { isError: true });
        return true;
      }
      const res = await client.pushTaskPr(pid, task.id, { createPr: true });
      pushNotice(
        [
          `Push/PR for [${task.externalId}]: pushed=${res.pushed ? 'yes' : 'no'}${res.prUrl ? ` · PR: ${res.prUrl}` : ''}`,
          ...(res.message ? [`  ${res.message}`] : []),
        ],
        { badge: 'PR', isError: !res.pushed },
      );
      return true;
    }

    pushNotice('Usage: /work [status|run <taskId>|retry <taskId>|assign <taskId> <profile|auto>|rollback <runId>|push-pr <taskId>]', {
      isError: true,
    });
    return true;
  }

  // ─── /history ─────────────────────────────────────────────────────────────
  if (cmd.name === 'history') {
    if (!ctx.activeProjectId) {
      pushNotice('No active project.', { isError: true });
      return true;
    }
    const pid = ctx.activeProjectId;
    const sub = cmd.args[0]?.toLowerCase();

    if (sub === 'log') {
      const runId = cmd.args[1];
      if (!runId) {
        pushNotice('Usage: /history log <runId>', { isError: true });
        return true;
      }
      const log = await client.getRunLog(pid, runId);
      ctx.setPagerOpen(true);
      try {
        const res = await ctx.onOpenPager(log.content || '(empty log)', `dalang-run-${runId}`);
        if (!res.ok) {
          pushNotice(
            [`Run log ${runId} (last 30 lines):`, ...log.content.split('\n').slice(-30)],
            { badge: 'LOG' },
          );
        } else {
          pushNotice(`Closed run log ${runId}.`, { badge: 'LOG' });
        }
      } finally {
        ctx.setPagerOpen(false);
      }
      return true;
    }

    if (sub === 'sessions') {
      const { sessions } = await client.listSessions(pid, true);
      pushNotice(
        [
          'Session history:',
          ...(sessions.length === 0
            ? ['  (no sessions)']
            : sessions.slice(0, 20).map(
                (s) => `  - [${s.mode}] ${s.title || '(untitled)'} (${s.id.slice(0, 8)}) · ${s.updatedAt}${s.archivedAt ? ' [archived]' : ''}`,
              )),
        ],
        { badge: 'HISTORY' },
      );
      return true;
    }

    const execState = await client.getExecutionState(pid, ctx.activeSessionId ?? undefined);
    const runs = execState.runs.slice(0, 20);
    pushNotice(
      [
        'Run history (/history log <runId> | /history sessions):',
        ...(runs.length === 0
          ? ['  (no runs recorded for this session/project)']
          : runs.map(
              (r) =>
                `  - ${r.id} [${r.kind}] ${r.status} · ${r.profileName} (${r.provider}) · ${formatDurationMs(r.durationMs)} · ${r.startedAt}`,
            )),
      ],
      { badge: 'HISTORY' },
    );
    return true;
  }

  // ─── /stats & /statistics ─────────────────────────────────────────────────
  if (cmd.name === 'stats' || cmd.name === 'statistics') {
    const daysArg = cmd.args[0] ? Number(cmd.args[0]) : undefined;
    const days = daysArg && Number.isFinite(daysArg) && daysArg > 0 ? Math.round(daysArg) : undefined;
    const stats = await client.getUsageStatistics({ days });
    const t = stats.totals;
    const lines = [
      `Usage statistics (${stats.windowDays ? `${stats.windowDays}d` : 'all time'}):`,
      `  Total runs: ${t.totalRuns} (completed=${t.completedRuns}, failed=${t.failedRuns}) · duration=${formatDurationMs(t.totalDurationMs)}`,
      `  Tokens: in=${t.inputTokens.toLocaleString()} out=${t.outputTokens.toLocaleString()} total=${t.totalTokens.toLocaleString()} · est. cost=$${t.estimatedCostUsd.toFixed(4)}`,
    ];
    if (stats.providers.length > 0) {
      lines.push('  By provider:');
      for (const p of stats.providers) {
        lines.push(`    - ${p.displayName} (${p.provider}): ${p.totalRuns} runs · ${p.totalTokens.toLocaleString()} tok · $${p.estimatedCostUsd.toFixed(4)}`);
      }
    }
    if (stats.projects.length > 0) {
      lines.push('  By project:');
      for (const p of stats.projects.slice(0, 8)) {
        const timingParts: string[] = [];
        const pt = (p as { timing?: { setupMs?: number; slotWaitMs?: number; agentMs?: number; verifyMs?: number; reviewMs?: number } }).timing;
        if (pt) {
          if (pt.setupMs) timingParts.push(`setup ${formatDurationMs(pt.setupMs)}`);
          if (pt.slotWaitMs) timingParts.push(`wait ${formatDurationMs(pt.slotWaitMs)}`);
          if (pt.agentMs) timingParts.push(`agent ${formatDurationMs(pt.agentMs)}`);
          if (pt.verifyMs) timingParts.push(`verify ${formatDurationMs(pt.verifyMs)}`);
          if (pt.reviewMs) timingParts.push(`review ${formatDurationMs(pt.reviewMs)}`);
        }
        lines.push(
          `    - ${p.projectName}: ${p.totalRuns} runs · ${formatDurationMs(p.totalDurationMs)}${timingParts.length ? ` (${timingParts.join(', ')})` : ''}`,
        );
      }
    }
    pushNotice(lines, { badge: 'STATS' });
    return true;
  }

  return false;
}
