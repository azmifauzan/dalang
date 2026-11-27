import {
  EFFORT_LEVEL_ORDER,
  splitEffortModel,
  type AgentProfileDTO,
  type EffortLevel,
  type FallbackTarget,
  type PermissionMode,
  type ProviderId,
  type ProviderModelInfo,
  type ProviderStatus,
  type RoutingRuleDTO,
  type TaskComplexity,
  type TaskRole,
  type UsageWindow,
} from '@dalang/shared';
import type { WayangCharacterId } from '../../assets/wayang/WayangFigure.js';
import type { TranslationKey } from '../../i18n/en.js';

export interface ProfileFormState {
  id: string | null;
  name: string;
  provider: ProviderId;
  model: string;
  effort: EffortLevel;
  permissionMode: PermissionMode;
  timeoutSeconds: number;
  idleTimeoutSeconds: number;
  maxParallel: number;
  maxReviewRounds: number;
  fallback: {
    provider: ProviderId | '';
    model: string;
    effort: EffortLevel;
    configDir: string;
  };
  configDir: string;
  rolePrompt: string;
  antigravityKeyringAccess: boolean;
}

export interface RoutingFormState {
  id: string | null;
  role: TaskRole;
  complexity: TaskComplexity | '';
  profileId: string;
  fallback: {
    provider: ProviderId | '';
    model: string;
    effort: EffortLevel;
    configDir: string;
  };
}

export interface CoreRoleSlot {
  key: 'lead' | 'coderLight' | 'coderMedium' | 'coderHeavy' | 'qa' | 'reviewer';
  profileId: string;
  profileName: string;
  cast: WayangCharacterId;
  titleKey: TranslationKey;
  descKey: TranslationKey;
  defaultPermission: PermissionMode;
  defaultEffort: EffortLevel;
  defaultParallel: number;
  defaultTimeoutSeconds: number;
  taskRole: TaskRole;
  sampleComplexity: TaskComplexity | null;
}

export const CORE_ROLE_SLOTS: readonly CoreRoleSlot[] = [
  {
    key: 'lead',
    profileId: 'profile-lead',
    profileName: 'lead',
    cast: 'semar',
    titleKey: 'config.agents.role.leadTitle',
    descKey: 'config.agents.role.leadDesc',
    defaultPermission: 'workspace-write',
    defaultEffort: 'high',
    defaultParallel: 1,
    defaultTimeoutSeconds: 1800,
    taskRole: 'lead',
    sampleComplexity: null,
  },
  {
    key: 'coderLight',
    profileId: 'profile-coder-small',
    profileName: 'executor-light',
    cast: 'bima',
    titleKey: 'config.agents.role.coderSmallTitle',
    descKey: 'config.agents.role.coderSmallDesc',
    defaultPermission: 'workspace-write',
    defaultEffort: 'low',
    defaultParallel: 2,
    defaultTimeoutSeconds: 1800,
    taskRole: 'engineer',
    sampleComplexity: 'low',
  },
  {
    key: 'coderMedium',
    profileId: 'profile-coder-medium',
    profileName: 'executor-medium',
    cast: 'gatotkaca',
    titleKey: 'config.agents.role.coderMediumTitle',
    descKey: 'config.agents.role.coderMediumDesc',
    defaultPermission: 'workspace-write',
    defaultEffort: 'medium',
    defaultParallel: 1,
    defaultTimeoutSeconds: 1800,
    taskRole: 'engineer',
    sampleComplexity: 'medium',
  },
  {
    key: 'coderHeavy',
    profileId: 'profile-coder-heavy',
    profileName: 'executor-heavy',
    cast: 'kresna',
    titleKey: 'config.agents.role.coderHeavyTitle',
    descKey: 'config.agents.role.coderHeavyDesc',
    defaultPermission: 'workspace-write',
    defaultEffort: 'high',
    defaultParallel: 1,
    defaultTimeoutSeconds: 1800,
    taskRole: 'engineer',
    sampleComplexity: 'high',
  },
  {
    key: 'qa',
    profileId: 'profile-qa',
    profileName: 'checker',
    cast: 'srikandi',
    titleKey: 'config.agents.role.qaTitle',
    descKey: 'config.agents.role.qaDesc',
    defaultPermission: 'workspace-write',
    defaultEffort: 'high',
    defaultParallel: 1,
    defaultTimeoutSeconds: 1200,
    taskRole: 'qa',
    sampleComplexity: null,
  },
  {
    key: 'reviewer',
    profileId: 'profile-reviewer',
    profileName: 'reviewer',
    cast: 'arjuna',
    titleKey: 'config.agents.role.reviewerTitle',
    descKey: 'config.agents.role.reviewerDesc',
    defaultPermission: 'read-only',
    defaultEffort: 'high',
    defaultParallel: 1,
    defaultTimeoutSeconds: 1200,
    taskRole: 'reviewer',
    sampleComplexity: null,
  },
] as const;

export const PROVIDER_OPTIONS: Array<{ value: ProviderId; label: string }> = [
  { value: 'claude-code', label: 'Claude Code (claude)' },
  { value: 'codex', label: 'Codex CLI (codex)' },
  { value: 'antigravity', label: 'Antigravity CLI (agy)' },
];

export const EFFORT_OPTIONS: EffortLevel[] = [...EFFORT_LEVEL_ORDER];
export const PERMISSION_OPTIONS: PermissionMode[] = ['workspace-write', 'read-only', 'accept-edits'];
export const ROLE_OPTIONS: TaskRole[] = ['lead', 'planner', 'engineer', 'qa', 'reviewer'];
export const COMPLEXITY_OPTIONS: TaskComplexity[] = ['low', 'medium', 'high'];

export function findCoreProfile(profiles: AgentProfileDTO[], slot: CoreRoleSlot): AgentProfileDTO | null {
  return (
    profiles.find((p) => p.id === slot.profileId) ??
    profiles.find((p) => p.name === slot.profileName) ??
    null
  );
}

export function isProviderUsable(provider: ProviderStatus | undefined, keyringAccess: boolean): boolean {
  if (!provider) return false;
  if (!provider.installed || !provider.loggedIn) return false;
  if (provider.id === 'antigravity' && !keyringAccess) return false;
  return true;
}

export function configDirEnvHint(provider: ProviderId): string {
  if (provider === 'claude-code') return 'CLAUDE_CONFIG_DIR';
  if (provider === 'codex') return 'CODEX_HOME';
  return 'AGY_CONFIG_DIR';
}

export function accountLoginCommand(provider: ProviderId, rawDir: string): string {
  const cleaned = rawDir.trim();
  if (provider === 'claude-code') {
    const dir = cleaned || '$HOME/.claude-work';
    return `CLAUDE_CONFIG_DIR="${dir}" claude auth login`;
  }
  if (provider === 'codex') {
    const dir = cleaned || '$HOME/.codex-work';
    return `CODEX_HOME="${dir}" codex login`;
  }
  const dir = cleaned || '$HOME/.agy-work';
  return `AGY_CONFIG_DIR="${dir}" XDG_CONFIG_HOME="${dir}" agy`;
}

export function providerSetupCommand(provider: ProviderStatus): string {
  if (provider.id === 'claude-code') {
    return provider.installed ? 'claude auth login' : 'npm install -g @anthropic-ai/claude-code';
  }
  if (provider.id === 'codex') {
    return provider.installed ? 'codex login' : 'npm install -g @openai/codex';
  }
  return provider.installed ? 'agy' : 'https://antigravity.google/cli';
}

export function matchProviderModel(
  models: ProviderModelInfo[],
  savedModel: string,
  isAgy: boolean,
): { modelInfo: ProviderModelInfo | null; activeVariantValue: string | null } {
  const trimmed = savedModel.trim();
  if (!trimmed) return { modelInfo: null, activeVariantValue: null };

  if (isAgy) {
    const split = splitEffortModel(trimmed);
    const base = split ? split.base : trimmed;
    const found = models.find((m) => m.id === base || m.value === base) ?? null;
    return { modelInfo: found, activeVariantValue: null };
  }

  for (const m of models) {
    if (m.id === trimmed || m.value === trimmed || m.resolvedModel === trimmed) {
      return { modelInfo: m, activeVariantValue: null };
    }
    const variant = m.variants.find((v) => v.value === trimmed);
    if (variant) {
      return { modelInfo: m, activeVariantValue: variant.value };
    }
  }
  return { modelInfo: null, activeVariantValue: null };
}

export function remainingPercent(w: UsageWindow): number | null {
  if (w.remainingPercent !== null) return w.remainingPercent;
  return w.usedPercent !== null ? Math.max(0, 100 - w.usedPercent) : null;
}

export function tightestRemaining(windows: UsageWindow[]): number | null {
  const values = windows.map(remainingPercent).filter((v): v is number => v !== null);
  return values.length > 0 ? Math.min(...values) : null;
}

export function formatSecondsHuman(seconds: number, lang: 'en' | 'id'): string {
  if (seconds >= 3600 && seconds % 3600 === 0) {
    const hours = seconds / 3600;
    return lang === 'id' ? `${hours} jam` : `${hours}h`;
  }
  if (seconds >= 60 && seconds % 60 === 0) {
    const mins = seconds / 60;
    return lang === 'id' ? `${mins} mnt` : `${mins} min`;
  }
  return lang === 'id' ? `${seconds} dtk` : `${seconds}s`;
}

export interface SimulatedRoute {
  matchedRule: RoutingRuleDTO | null;
  matchedRuleIndex: number;
  primary: AgentProfileDTO | null;
  fallback: FallbackTarget | null;
  fallbackSource: 'rule' | 'profile' | 'lead' | 'none';
}

function sameFallbackTarget(
  primary: AgentProfileDTO,
  target: FallbackTarget | null | undefined,
): FallbackTarget | null {
  if (!target) return null;
  const configDir =
    target.configDir ?? (target.provider === primary.provider ? primary.configDir : null);
  if (
    primary.provider === target.provider &&
    primary.model === target.model &&
    primary.effort === target.effort &&
    configDir === primary.configDir
  ) {
    return null;
  }
  return { ...target, configDir };
}

/** Client-side mirror of ProfileService.resolveProfileForTask for instant route previews. */
export function simulateTaskRoute({
  role,
  complexity,
  profiles,
  rules,
}: {
  role: TaskRole;
  complexity: TaskComplexity;
  profiles: AgentProfileDTO[];
  rules: RoutingRuleDTO[];
}): SimulatedRoute {
  if (profiles.length === 0) {
    return {
      matchedRule: null,
      matchedRuleIndex: -1,
      primary: null,
      fallback: null,
      fallbackSource: 'none',
    };
  }

  const byId = new Map(profiles.map((p) => [p.id, p]));
  const lead = byId.get('profile-lead') ?? profiles.find((p) => p.name === 'lead') ?? null;
  const leadTarget: FallbackTarget | null = lead
    ? { provider: lead.provider, model: lead.model, effort: lead.effort, configDir: lead.configDir }
    : null;

  for (let i = 0; i < rules.length; i++) {
    const rule = rules[i];
    if (rule.role !== role) continue;
    if (rule.complexity !== null && rule.complexity !== complexity) continue;

    const primary = byId.get(rule.profileId) ?? null;
    if (!primary) continue;

    const fromRule = sameFallbackTarget(primary, rule.fallback);
    if (fromRule) {
      return {
        matchedRule: rule,
        matchedRuleIndex: i + 1,
        primary,
        fallback: fromRule,
        fallbackSource: 'rule',
      };
    }

    const fromProfile = sameFallbackTarget(primary, primary.fallback);
    if (fromProfile) {
      return {
        matchedRule: rule,
        matchedRuleIndex: i + 1,
        primary,
        fallback: fromProfile,
        fallbackSource: 'profile',
      };
    }

    const fromLead = sameFallbackTarget(primary, leadTarget);
    if (fromLead) {
      return {
        matchedRule: rule,
        matchedRuleIndex: i + 1,
        primary,
        fallback: fromLead,
        fallbackSource: 'lead',
      };
    }

    return {
      matchedRule: rule,
      matchedRuleIndex: i + 1,
      primary,
      fallback: null,
      fallbackSource: 'none',
    };
  }

  const primary = profiles[0];
  const fromProfile = sameFallbackTarget(primary, primary.fallback);
  if (fromProfile) {
    return {
      matchedRule: null,
      matchedRuleIndex: -1,
      primary,
      fallback: fromProfile,
      fallbackSource: 'profile',
    };
  }

  const fromLead = sameFallbackTarget(primary, leadTarget);
  return {
    matchedRule: null,
    matchedRuleIndex: -1,
    primary,
    fallback: fromLead,
    fallbackSource: fromLead ? 'lead' : 'none',
  };
}

export function effectiveFallbackForProfile(
  profile: AgentProfileDTO,
  rules: RoutingRuleDTO[],
): { target: FallbackTarget | null; source: 'rule' | 'profile' | 'none' } {
  const ruleWithFallback = rules.find((r) => r.profileId === profile.id && r.fallback !== null);
  if (ruleWithFallback?.fallback) {
    return { target: ruleWithFallback.fallback, source: 'rule' };
  }
  if (profile.fallback) {
    return { target: profile.fallback, source: 'profile' };
  }
  return { target: null, source: 'none' };
}
