import {
  EFFORT_LEVEL_ORDER,
  type AgentProfileDTO,
  type EffortLevel,
  type FallbackTarget,
  type ProviderId,
  type ProviderModelInfo,
  type ProviderStatus,
  type RoutingRuleDTO,
  type UpdateProfileInput,
  type UpdateRoutingRuleInput,
} from '@dalang/shared';

/**
 * Team setup shared by the terminal wizard and `/config`. It mirrors the web wizard's team step:
 * the six seeded role profiles are edited in place, and the seeded routing rules are kept pointing at
 * them with a fallback CLI.
 */

export type RoleKey = 'lead' | 'coderLight' | 'coderMedium' | 'coderHeavy' | 'qa' | 'reviewer';

export const ROLE_KEYS: readonly RoleKey[] = [
  'lead',
  'coderLight',
  'coderMedium',
  'coderHeavy',
  'qa',
  'reviewer',
];

/** Seeded profile that carries each role. */
export const ROLE_PROFILE_NAME: Record<RoleKey, string> = {
  lead: 'lead',
  coderLight: 'coder-small',
  coderMedium: 'coder-medium',
  coderHeavy: 'coder-heavy',
  qa: 'qa',
  reviewer: 'reviewer',
};

export const ROLE_LABEL: Record<RoleKey, string> = {
  lead: 'Lead (Semar)',
  coderLight: 'Executor, light tasks (Bima)',
  coderMedium: 'Executor, medium tasks (Gatotkaca)',
  coderHeavy: 'Executor, heavy tasks (Kresna)',
  qa: 'Checker (Srikandi)',
  reviewer: 'Reviewer (Arjuna)',
};

export const PROVIDER_ORDER: readonly ProviderId[] = ['claude-code', 'codex', 'antigravity'];

export function providerLabel(id: string): string {
  if (id === 'claude-code') return 'Claude';
  if (id === 'codex') return 'Codex';
  if (id === 'antigravity') return 'Antigravity';
  return id;
}

/**
 * A provider is usable when its CLI is installed and signed in. Antigravity also needs the keyring
 * consent, because a sandboxed run reads its login from the desktop keyring.
 */
export function usableProviderIds(providers: ProviderStatus[], keyringAccess: boolean): Set<ProviderId> {
  return new Set(
    providers
      .filter((p) => p.installed && p.loggedIn && (p.id !== 'antigravity' || keyringAccess))
      .map((p) => p.id),
  );
}

/** How a model is named in a list: a Claude model shows its version ("Claude Opus 5.5"). */
export function modelLabel(m: Pick<ProviderModelInfo, 'displayName' | 'resolvedModel'>): string {
  const claude = /^claude-([a-z]+)-(\d+)-(\d+)$/.exec(m.resolvedModel ?? '');
  if (!claude) return m.displayName;
  return `Claude ${claude[1].charAt(0).toUpperCase()}${claude[1].slice(1)} ${claude[2]}.${claude[3]}`;
}

/**
 * How a saved model value reads in a summary: the alias "opus" a profile stores names the same model
 * as the list ("Claude Opus 5.5"); a value the CLI does not list keeps its own text.
 */
export function modelValueLabel(providers: ProviderStatus[], provider: ProviderId, value: string | null): string {
  if (!value) return 'CLI default';
  const info = modelsOf(providers, provider).find(
    (m) => m.value === value || m.resolvedModel === value || m.variants.some((v) => v.value === value),
  );
  return modelLabel(info ?? { displayName: value, resolvedModel: value });
}

export function modelsOf(providers: ProviderStatus[], provider: ProviderId): ProviderModelInfo[] {
  return providers.find((p) => p.id === provider)?.models ?? [];
}

/** Effort levels a model accepts; every level when the CLI reported none. */
export function effortsFor(
  providers: ProviderStatus[],
  provider: ProviderId,
  model: string,
): readonly EffortLevel[] {
  const info = modelsOf(providers, provider).find((m) => m.value === model);
  return info && info.supportedEffortLevels.length > 0 ? info.supportedEffortLevels : EFFORT_LEVEL_ORDER;
}

export interface RoleEdit {
  provider?: ProviderId;
  model?: string;
  effort?: EffortLevel;
  fallback?: FallbackTarget | null;
}

export interface RoleValue {
  provider: ProviderId;
  model: string;
  effort: EffortLevel;
}

export function roleProfiles(profiles: AgentProfileDTO[]): Record<RoleKey, AgentProfileDTO | null> {
  const byName = (name: string) => profiles.find((p) => p.name === name) ?? null;
  const out = {} as Record<RoleKey, AgentProfileDTO | null>;
  for (const key of ROLE_KEYS) out[key] = byName(ROLE_PROFILE_NAME[key]);
  return out;
}

/** The provider, model, and effort a role will use: the edit, else its profile, moved to a ready provider. */
export function roleValue(
  profile: AgentProfileDTO,
  edit: RoleEdit | undefined,
  usable: ReadonlySet<ProviderId>,
  providers: ProviderStatus[],
  preferAvailable = true,
): RoleValue {
  const e = edit ?? {};
  const readyFallback = PROVIDER_ORDER.find((id) => usable.has(id)) ?? profile.provider;
  const provider = e.provider ?? (!preferAvailable || usable.has(profile.provider) ? profile.provider : readyFallback);
  const model = e.model ?? (provider === profile.provider ? profile.model : '');
  const allowed = effortsFor(providers, provider, model);
  const wanted = e.effort ?? profile.effort;
  const unchanged = !preferAvailable && e.effort === undefined && e.model === undefined && e.provider === undefined;
  const effort = unchanged || allowed.includes(wanted) ? wanted : (allowed[0] as EffortLevel);
  return { provider, model, effort };
}

/**
 * The backup CLI a role keeps: its saved one while it is usable and differs from the primary,
 * otherwise another ready CLI, otherwise none.
 */
export function roleFallback(
  profile: AgentProfileDTO,
  primary: ProviderId,
  usable: ReadonlySet<ProviderId>,
  rules: RoutingRuleDTO[],
): FallbackTarget | null {
  const saved =
    profile.fallback ?? rules.find((r) => r.profileId === profile.id && r.fallback !== null)?.fallback ?? null;
  if (saved && usable.has(saved.provider) && saved.provider !== primary) return saved;
  const suggested = PROVIDER_ORDER.find((id) => usable.has(id) && id !== primary);
  return suggested ? { provider: suggested, model: '', effort: 'high', configDir: null } : null;
}

export interface TeamPlan {
  profileUpdates: Array<{ id: string; body: UpdateProfileInput }>;
  ruleUpdates: Array<{ id: string; body: UpdateRoutingRuleInput }>;
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** What has to be written so the profiles and routing rules match the edits. Only changed rows appear. */
export function planTeamChanges(input: {
  profiles: AgentProfileDTO[];
  rules: RoutingRuleDTO[];
  providers: ProviderStatus[];
  usable: ReadonlySet<ProviderId>;
  edits: Record<string, RoleEdit>;
  suggestFallbacks?: boolean;
}): TeamPlan {
  const { profiles, rules, providers, usable, edits, suggestFallbacks = true } = input;
  const roles = roleProfiles(profiles);
  const fallbackByProfile = new Map<string, FallbackTarget | null>();
  const plan: TeamPlan = { profileUpdates: [], ruleUpdates: [] };

  for (const key of ROLE_KEYS) {
    const prof = roles[key];
    if (!prof) continue;
    const v = roleValue(prof, edits[prof.id], usable, providers, suggestFallbacks);
    const fallback = edits[prof.id]?.fallback !== undefined
      ? edits[prof.id].fallback!
      : suggestFallbacks ? roleFallback(prof, v.provider, usable, rules) : prof.fallback;
    fallbackByProfile.set(prof.id, fallback);
    if (
      v.provider !== prof.provider ||
      v.model !== prof.model ||
      v.effort !== prof.effort ||
      !same(fallback, prof.fallback)
    ) {
      plan.profileUpdates.push({ id: prof.id, body: { ...v, fallback } });
    }
  }

  // Keep each seeded routing rule on its role's profile, with that profile's fallback.
  for (const rule of rules) {
    let nextPrimary = rule.profileId;
    if (rule.role === 'lead' && roles.lead) {
      nextPrimary = roles.lead.id;
    } else if (rule.role === 'engineer') {
      const primary =
        rule.complexity === 'low'
          ? roles.coderLight
          : rule.complexity === 'medium'
            ? (roles.coderMedium ?? roles.coderHeavy)
            : roles.coderHeavy;
      if (primary) nextPrimary = primary.id;
    } else if (rule.role === 'qa') {
      const primary = roles.qa ?? roles.reviewer;
      if (primary) nextPrimary = primary.id;
    } else if (rule.role === 'reviewer' && roles.reviewer) {
      nextPrimary = roles.reviewer.id;
    }
    const nextFallback = fallbackByProfile.has(nextPrimary) ? fallbackByProfile.get(nextPrimary)! : rule.fallback;
    if (nextPrimary !== rule.profileId || !same(nextFallback, rule.fallback)) {
      plan.ruleUpdates.push({ id: rule.id, body: { profileId: nextPrimary, fallback: nextFallback } });
    }
  }
  return plan;
}

/** Whether a coder and the reviewer sit on different providers, so the review is independent. */
export function isCrossProvider(
  profiles: AgentProfileDTO[],
  providers: ProviderStatus[],
  usable: ReadonlySet<ProviderId>,
  edits: Record<string, RoleEdit>,
  preferAvailable = true,
): boolean {
  const roles = roleProfiles(profiles);
  if (!roles.reviewer) return false;
  const reviewer = roleValue(roles.reviewer, edits[roles.reviewer.id], usable, providers, preferAvailable).provider;
  return [roles.coderLight, roles.coderMedium, roles.coderHeavy].some(
    (p) => p && roleValue(p, edits[p.id], usable, providers, preferAvailable).provider !== reviewer,
  );
}

/** Command that signs in or installs a provider CLI, shown when a provider is not ready. */
export function fixCommandForProvider(p: Pick<ProviderStatus, 'id' | 'installed'>): string {
  if (p.id === 'claude-code') return p.installed ? 'claude auth login' : 'npm install -g @anthropic-ai/claude-code';
  if (p.id === 'codex') return p.installed ? 'codex login' : 'npm install -g @openai/codex';
  return p.installed ? 'agy' : 'https://antigravity.google/cli';
}

/** Writes a plan: profiles first, then the routing rules that point at them. Stops at the first failure. */
export async function applyTeamPlan(
  client: {
    updateProfile: (id: string, body: UpdateProfileInput) => Promise<unknown>;
    updateRoutingRule: (id: string, body: UpdateRoutingRuleInput) => Promise<unknown>;
  },
  plan: TeamPlan,
): Promise<void> {
  for (const u of plan.profileUpdates) await client.updateProfile(u.id, u.body);
  for (const u of plan.ruleUpdates) await client.updateRoutingRule(u.id, u.body);
}
