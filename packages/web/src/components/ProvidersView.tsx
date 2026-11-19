import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  AgentProfileDTO,
  EffortLevel,
  PermissionMode,
  ProviderId,
  ProviderRuntimeStateDTO,
  RoutingRuleDTO,
  TaskComplexity,
  TaskRole,
} from '@dalang/shared';
import { splitEffortModel } from '@dalang/shared';
import { api } from '../lib/api.js';
import { EmptyPanel, ErrorPanel, LoadingPanel, ModalDialog } from './StateViews.js';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { NativeSelect } from '@/components/ui/native-select';
import { Textarea } from '@/components/ui/textarea';

interface ProfileFormState {
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
  fallbackProfileId: string;
  rolePrompt: string;
  antigravityKeyringAccess: boolean;
}

interface RoutingFormState {
  id: string | null;
  role: TaskRole;
  complexity: TaskComplexity | '';
  profileId: string;
  fallbackProfileId: string;
}

const PROVIDER_OPTIONS: Array<{ value: ProviderId; label: string }> = [
  { value: 'claude-code', label: 'Claude Code (claude)' },
  { value: 'codex', label: 'Codex CLI (codex)' },
  { value: 'antigravity', label: 'Antigravity (agy)' },
];

const EFFORT_OPTIONS: EffortLevel[] = ['low', 'medium', 'high', 'xhigh'];
const PERMISSION_OPTIONS: PermissionMode[] = ['workspace-write', 'read-only', 'accept-edits'];
const ROLE_OPTIONS: TaskRole[] = ['lead', 'planner', 'engineer', 'qa', 'reviewer'];
const COMPLEXITY_OPTIONS: TaskComplexity[] = ['low', 'medium', 'high'];

function formatStatsDuration(ms: number | null): string {
  if (ms === null || ms < 0) return 'n/a';
  if (ms < 1000) return `${ms}ms`;
  const secs = Math.round(ms / 1000);
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  const rem = secs % 60;
  return rem > 0 ? `${mins}m ${rem}s` : `${mins}m`;
}

export function ProvidersView() {
  const qc = useQueryClient();
  const providersQuery = useQuery({
    queryKey: ['providers-status'],
    queryFn: () => api.getProvidersStatus(),
  });

  const profilesQuery = useQuery({
    queryKey: ['profiles'],
    queryFn: () => api.listProfiles(),
  });

  const routingQuery = useQuery({
    queryKey: ['routing'],
    queryFn: () => api.listRoutingRules(),
  });

  const refreshMutation = useMutation({
    mutationFn: () => api.refreshProvidersStatus(),
    onSuccess: (data) => {
      qc.setQueryData(['providers-status'], data);
    },
  });

  const [statsDays, setStatsDays] = useState<string>('30');
  const [statsProjectId, setStatsProjectId] = useState<string>('');

  const settingsQuery = useQuery({
    queryKey: ['settings'],
    queryFn: () => api.getSettings(),
  });

  const projectsQuery = useQuery({
    queryKey: ['projects'],
    queryFn: () => api.listProjects(),
  });

  const statsQuery = useQuery({
    queryKey: ['statistics', statsProjectId, statsDays],
    queryFn: () =>
      api.getUsageStatistics({
        projectId: statsProjectId || undefined,
        days: statsDays ? Number(statsDays) : undefined,
      }),
  });

  const clearCooldownMutation = useMutation({
    mutationFn: (provider: ProviderId) => api.clearProviderCooldown(provider),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['providers-status'] });
      qc.invalidateQueries({ queryKey: ['statistics'] });
    },
  });

  const keyringAccess = settingsQuery.data?.settings.antigravityKeyringAccess ?? false;
  const providers = providersQuery.data?.providers ?? [];
  const providerStates: ProviderRuntimeStateDTO[] = providersQuery.data?.providerStates ?? [];
  const profiles = profilesQuery.data?.profiles ?? [];
  const rules = routingQuery.data?.rules ?? [];
  const projects = projectsQuery.data?.projects ?? [];
  const statistics = statsQuery.data?.statistics ?? null;

  const [profileModalOpen, setProfileModalOpen] = useState(false);
  const [profileForm, setProfileForm] = useState<ProfileFormState>({
    id: null,
    name: '',
    provider: 'claude-code',
    model: '',
    effort: 'medium',
    permissionMode: 'workspace-write',
    timeoutSeconds: 1800,
    idleTimeoutSeconds: 180,
    maxParallel: 1,
    maxReviewRounds: 2,
    fallbackProfileId: '',
    rolePrompt: '',
    antigravityKeyringAccess: keyringAccess,
  });
  const [profileFeedback, setProfileFeedback] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);
  const [profileModalError, setProfileModalError] = useState<string | null>(null);

  const [routingModalOpen, setRoutingModalOpen] = useState(false);
  const [routingForm, setRoutingForm] = useState<RoutingFormState>({
    id: null,
    role: 'engineer',
    complexity: '',
    profileId: '',
    fallbackProfileId: '',
  });
  const [routingFeedback, setRoutingFeedback] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);
  const [routingModalError, setRoutingModalError] = useState<string | null>(null);

  const modelSuggestions = useMemo(() => {
    const provider = providers.find((p) => p.id === profileForm.provider);
    return provider?.models ?? [];
  }, [providers, profileForm.provider]);

  // Antigravity model ids end in their level (gemini-4-neon-high). The model list shows the base name and the
  // effort field picks the level, so there is one control per setting.
  const isAgy = profileForm.provider === 'antigravity';
  const agyLevels = useMemo(() => {
    const byBase = new Map<string, EffortLevel[]>();
    for (const m of modelSuggestions) {
      const parts = splitEffortModel(m);
      if (!parts) continue;
      byBase.set(parts.base, [...(byBase.get(parts.base) ?? []), parts.level]);
    }
    for (const [base, levels] of byBase) {
      byBase.set(base, EFFORT_OPTIONS.filter((l) => levels.includes(l)));
    }
    return byBase;
  }, [modelSuggestions]);
  const modelChoices = isAgy
    ? [...new Set(modelSuggestions.map((m) => splitEffortModel(m)?.base ?? m))]
    : modelSuggestions;
  const currentSplit = isAgy ? splitEffortModel(profileForm.model) : null;
  const modelSelectValue = currentSplit ? currentSplit.base : profileForm.model;
  const effortChoices = currentSplit ? (agyLevels.get(currentSplit.base) ?? EFFORT_OPTIONS) : EFFORT_OPTIONS;
  const effortLocked = isAgy && profileForm.model !== '' && !currentSplit;

  const changeModel = (value: string) =>
    setProfileForm((f) => {
      const levels = isAgy ? agyLevels.get(value) : undefined;
      if (!levels || levels.length === 0) return { ...f, model: value };
      const level = levels.includes(f.effort) ? f.effort : levels.includes('high') ? 'high' : levels[0];
      return { ...f, model: `${value}-${level}`, effort: level };
    });
  const changeEffort = (level: EffortLevel) =>
    setProfileForm((f) => {
      const parts = isAgy ? splitEffortModel(f.model) : null;
      return { ...f, effort: level, model: parts ? `${parts.base}-${level}` : f.model };
    });

  const invalidateConfigCaches = () => {
    qc.invalidateQueries({ queryKey: ['profiles'] });
    qc.invalidateQueries({ queryKey: ['routing'] });
    qc.invalidateQueries({ queryKey: ['execution'] });
    qc.invalidateQueries({ queryKey: ['guard'] });
  };

  const saveProfileMutation = useMutation({
    mutationFn: async (form: ProfileFormState) => {
      const payload = {
        name: form.name.trim(),
        provider: form.provider,
        model: form.model.trim(),
        effort: form.effort,
        permissionMode: form.permissionMode,
        timeoutMs: Math.round(form.timeoutSeconds * 1000),
        idleTimeoutMs: Math.round(form.idleTimeoutSeconds * 1000),
        maxParallel: form.maxParallel,
        maxReviewRounds: form.maxReviewRounds,
        fallbackProfileId: form.fallbackProfileId || null,
        rolePrompt: form.rolePrompt,
      };
      const saved = form.id
        ? await api.updateProfile(form.id, payload)
        : await api.createProfile(payload);
      if (form.provider === 'antigravity' && form.antigravityKeyringAccess !== keyringAccess) {
        const updatedSettings = await api.updateSettings({
          antigravityKeyringAccess: form.antigravityKeyringAccess,
        });
        qc.setQueryData(['settings'], updatedSettings);
      }
      return saved.profile;
    },
    onSuccess: (saved) => {
      setProfileModalOpen(false);
      setProfileModalError(null);
      setProfileFeedback({ kind: 'ok', text: `Saved profile "${saved.name}".` });
      invalidateConfigCaches();
    },
    onError: (err) => {
      setProfileModalError((err as Error).message);
    },
  });

  const deleteProfileMutation = useMutation({
    mutationFn: (profileId: string) => api.deleteProfile(profileId),
    onSuccess: () => {
      setProfileFeedback({ kind: 'ok', text: 'Profile deleted.' });
      invalidateConfigCaches();
    },
    onError: (err) => {
      setProfileFeedback({ kind: 'err', text: (err as Error).message });
    },
  });

  const saveRoutingMutation = useMutation({
    mutationFn: async (form: RoutingFormState) => {
      const payload = {
        role: form.role,
        complexity: form.complexity === '' ? null : form.complexity,
        profileId: form.profileId,
        fallbackProfileId: form.fallbackProfileId ? form.fallbackProfileId : null,
      };
      const saved = form.id
        ? await api.updateRoutingRule(form.id, payload)
        : await api.createRoutingRule(payload);
      return saved.rule;
    },
    onSuccess: () => {
      setRoutingModalOpen(false);
      setRoutingModalError(null);
      setRoutingFeedback({ kind: 'ok', text: 'Routing rule saved.' });
      invalidateConfigCaches();
    },
    onError: (err) => {
      setRoutingModalError((err as Error).message);
    },
  });

  const deleteRoutingMutation = useMutation({
    mutationFn: (ruleId: string) => api.deleteRoutingRule(ruleId),
    onSuccess: () => {
      setRoutingFeedback({ kind: 'ok', text: 'Routing rule removed.' });
      invalidateConfigCaches();
    },
    onError: (err) => {
      setRoutingFeedback({ kind: 'err', text: (err as Error).message });
    },
  });

  const reorderRoutingMutation = useMutation({
    mutationFn: (ruleIds: string[]) => api.reorderRoutingRules(ruleIds),
    onSuccess: (data) => {
      qc.setQueryData(['routing'], data);
      invalidateConfigCaches();
    },
    onError: (err) => {
      setRoutingFeedback({ kind: 'err', text: (err as Error).message });
    },
  });

  const openCreateProfileModal = (presetProvider: ProviderId = 'claude-code') => {
    setProfileModalError(null);
    setProfileForm({
      id: null,
      name: '',
      provider: presetProvider,
      model: '',
      effort: 'medium',
      permissionMode: 'workspace-write',
      timeoutSeconds: 1800,
      idleTimeoutSeconds: 180,
      maxParallel: 1,
      maxReviewRounds: 2,
      fallbackProfileId: '',
      rolePrompt: '',
      antigravityKeyringAccess: keyringAccess,
    });
    setProfileModalOpen(true);
  };

  const openEditProfileModal = (prof: AgentProfileDTO) => {
    setProfileModalError(null);
    setProfileForm({
      id: prof.id,
      name: prof.name,
      provider: prof.provider,
      model: prof.model,
      effort: prof.effort,
      permissionMode: prof.permissionMode,
      timeoutSeconds: Math.max(5, Math.round(prof.timeoutMs / 1000)),
      idleTimeoutSeconds: Math.max(5, Math.round(prof.idleTimeoutMs / 1000)),
      maxParallel: prof.maxParallel,
      maxReviewRounds: prof.maxReviewRounds ?? 2,
      fallbackProfileId: prof.fallbackProfileId ?? '',
      rolePrompt: prof.rolePrompt,
      antigravityKeyringAccess: keyringAccess,
    });
    setProfileModalOpen(true);
  };

  const openAntigravityProfileConfig = () => {
    const existing = profiles.find((prof) => prof.provider === 'antigravity');
    if (existing) {
      openEditProfileModal(existing);
    } else {
      openCreateProfileModal('antigravity');
    }
  };

  const openCreateRoutingModal = () => {
    setRoutingModalError(null);
    setRoutingForm({
      id: null,
      role: 'engineer',
      complexity: '',
      profileId: profiles[0]?.id ?? '',
      fallbackProfileId: '',
    });
    setRoutingModalOpen(true);
  };

  const openEditRoutingModal = (rule: RoutingRuleDTO) => {
    setRoutingModalError(null);
    setRoutingForm({
      id: rule.id,
      role: rule.role,
      complexity: rule.complexity ?? '',
      profileId: rule.profileId,
      fallbackProfileId: rule.fallbackProfileId ?? '',
    });
    setRoutingModalOpen(true);
  };

  const moveRule = (index: number, delta: -1 | 1) => {
    const targetIndex = index + delta;
    if (targetIndex < 0 || targetIndex >= rules.length) return;
    const ids = rules.map((r) => r.id);
    const [moved] = ids.splice(index, 1);
    ids.splice(targetIndex, 0, moved);
    reorderRoutingMutation.mutate(ids);
  };

  return (
    <div className="space-y-8">
      {/* Provider Status Section (F-22) */}
      <section aria-labelledby="providers-heading" className="space-y-4">
        <div
          className="flex flex-wrap items-center justify-between gap-4 rounded-md border p-4"
          style={{
            backgroundColor: 'var(--bg-surface)',
            borderColor: 'var(--border-subtle)',
          }}
        >
          <div>
            <h1 id="providers-heading" className="text-lg font-semibold">
              Provider Status & Quotas
            </h1>
            <p className="mt-1 text-sm" style={{ color: 'var(--text-secondary)' }}>
              Checks official local CLI binaries, login state, bubblewrap sandbox readiness, and live quota windows.
            </p>
          </div>
          <Button
            type="button"
            onClick={() => refreshMutation.mutate()}
            disabled={refreshMutation.isPending}
          >
            {refreshMutation.isPending ? 'Checking CLIs...' : 'Refresh CLI status'}
          </Button>
        </div>

        {providersQuery.isLoading && (
          <LoadingPanel label="Probing claude, codex, agy, and bwrap on this machine..." />
        )}

        {providersQuery.isError && (
          <ErrorPanel
            title="Failed to check providers"
            detail={providersQuery.error.message}
            onRetry={() => providersQuery.refetch()}
          />
        )}

        {!providersQuery.isLoading && !providersQuery.isError && (
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
            {providers.map((p) => {
              const runtime = providerStates.find((ps) => ps.provider === p.id);
              return (
              <article
                key={p.id}
                className="flex flex-col justify-between rounded-md border p-5"
                style={{
                  backgroundColor: 'var(--bg-surface)',
                  borderColor:
                    runtime?.inCooldown || runtime?.quotaExhausted
                      ? 'var(--error)'
                      : 'var(--border-subtle)',
                }}
              >
                <div>
                  <div className="flex items-start justify-between gap-2">
                    <div>
                      <h2 className="text-base font-semibold">{p.displayName}</h2>
                      <p className="font-mono-token text-xs" style={{ color: 'var(--text-secondary)' }}>
                        {p.binaryPath || p.binary}
                      </p>
                    </div>
                    <Badge

                      style={{
                        color: p.installed && p.loggedIn ? 'var(--pass)' : 'var(--error)',
                        borderColor: p.installed && p.loggedIn ? 'var(--pass)' : 'var(--error)',
                      }}
                    >
                      {!p.installed ? 'MISSING' : p.loggedIn ? 'READY' : 'LOGIN NEEDED'}
                    </Badge>
                  </div>

                  <dl className="mt-4 space-y-2 text-sm">
                    <div className="flex justify-between gap-2">
                      <dt style={{ color: 'var(--text-secondary)' }}>Version</dt>
                      <dd className="font-mono-token text-xs">{p.version || 'N/A'}</dd>
                    </div>
                    <div className="flex justify-between gap-2">
                      <dt style={{ color: 'var(--text-secondary)' }}>Auth</dt>
                      <dd className="text-right text-xs">{p.authSummary}</dd>
                    </div>
                    <div className="flex justify-between gap-2">
                      <dt style={{ color: 'var(--text-secondary)' }}>bwrap sandbox</dt>
                      <dd
                        className="text-xs font-semibold"
                        style={{ color: p.sandboxReady ? 'var(--pass)' : 'var(--error)' }}
                      >
                        {p.sandboxReady ? 'Available' : 'Unavailable'}
                      </dd>
                    </div>
                    {runtime && (
                      <div className="flex justify-between gap-2">
                        <dt style={{ color: 'var(--text-secondary)' }}>Parallel pool</dt>
                        <dd className="font-mono-token text-xs font-semibold">
                          {runtime.activeCount} / {runtime.maxParallel} active
                        </dd>
                      </div>
                    )}
                  </dl>

                  {runtime && (runtime.inCooldown || runtime.quotaExhausted) && (
                    <div
                      className="mt-3 flex flex-wrap items-center justify-between gap-2 rounded-[4px] border px-2.5 py-2 text-xs"
                      style={{
                        backgroundColor: 'var(--error-tint)',
                        borderColor: 'var(--error)',
                        color: 'var(--error)',
                      }}
                    >
                      <span>
                        {runtime.inCooldown
                          ? `Cooldown: ${runtime.cooldownReason ?? 'rate limited'}`
                          : runtime.quotaReason ?? 'Quota exhausted'}
                      </span>
                      {runtime.inCooldown && (
                        <Button
                          type="button"
                          variant="outline"
                          disabled={clearCooldownMutation.isPending}
                          onClick={() => clearCooldownMutation.mutate(p.id)}
                        >
                          Clear cooldown
                        </Button>
                      )}
                    </div>
                  )}

                  {!p.sandboxReady && (
                    <p className="mt-3 text-xs" style={{ color: 'var(--error)' }}>
                      Without bwrap, a run is not confined to the project folder.
                    </p>
                  )}
                  {p.id === 'antigravity' && p.sandboxReady && (
                    <p className="mt-3 text-xs" style={{ color: 'var(--text-secondary)' }}>
                      agy signs in through the desktop keyring, so a sandboxed agy run can read every secret stored there (needs xdg-dbus-proxy and a desktop session). It is off by default.
                    </p>
                  )}
                  {p.id === 'antigravity' && p.sandboxReady && (
                    <div className="mt-3 flex flex-wrap items-center justify-between gap-2 rounded-[4px] border border-border px-2.5 py-2 text-xs">
                      <span style={{ color: 'var(--text-secondary)' }}>
                        Desktop keyring access: {keyringAccess ? 'Enabled' : 'Disabled (default)'}
                      </span>
                      <Button
                        type="button"
                        variant="outline"
                        onClick={openAntigravityProfileConfig}
                      >
                        Configure in profile
                      </Button>
                    </div>
                  )}

                  {/* Usage / Quota windows */}
                  <div
                    className="mt-4 border-t pt-3"
                    style={{ borderColor: 'var(--border-subtle)' }}
                  >
                    <h3 className="text-xs font-semibold uppercase tracking-wide" style={{ color: 'var(--text-secondary)' }}>
                      Usage windows
                    </h3>
                    {p.usage.available && p.usage.windows.length > 0 ? (
                      <ul className="mt-2 space-y-2">
                        {p.usage.windows.map((w, i) => (
                          <li key={`${w.group}-${w.window}-${i}`} className="text-xs">
                            <div className="flex justify-between gap-2">
                              <span className="truncate font-medium">{w.label}</span>
                              <span className="font-mono-token shrink-0">
                                {w.remainingPercent !== null
                                  ? `${w.remainingPercent}% left`
                                  : w.usedPercent !== null
                                    ? `${w.usedPercent}% used`
                                    : 'unknown'}
                              </span>
                            </div>
                            {w.remainingPercent !== null && (
                              <div
                                className="mt-1 h-2 w-full overflow-hidden rounded"
                                style={{ backgroundColor: 'var(--bg-well)' }}
                              >
                                <div
                                  className="h-full"
                                  style={{
                                    width: `${w.remainingPercent}%`,
                                    backgroundColor:
                                      w.remainingPercent > 20 ? 'var(--pass)' : 'var(--error)',
                                  }}
                                />
                              </div>
                            )}
                          </li>
                        ))}
                      </ul>
                    ) : (
                      <p className="mt-2 text-xs" style={{ color: 'var(--text-secondary)' }}>
                        {p.usage.error || 'Quota check unavailable for this CLI.'}
                      </p>
                    )}
                  </div>
                </div>

                {p.models.length > 0 && (
                  <div
                    className="mt-4 border-t pt-3 text-xs"
                    style={{ borderColor: 'var(--border-subtle)', color: 'var(--text-secondary)' }}
                  >
                    Suggested models: <span className="font-mono-token">{p.models.slice(0, 4).join(', ')}</span>
                  </div>
                )}
              </article>
              );
            })}
          </div>
        )}
      </section>

      {/* Agent Profiles Section (F-21) */}
      <section aria-labelledby="profiles-heading" className="space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div>
            <h2 id="profiles-heading" className="text-lg font-semibold">
              Agent Profiles
            </h2>
            <p className="text-sm" style={{ color: 'var(--text-secondary)' }}>
              Configure provider, model, permission confinement, review retries, and timeouts per role.
            </p>
          </div>
          <Button type="button" onClick={() => openCreateProfileModal()}>
            New profile
          </Button>
        </div>

        {profileFeedback && (
          <div
            role={profileFeedback.kind === 'err' ? 'alert' : 'status'}
            className="rounded-md border px-3 py-2 text-sm"
            style={
              profileFeedback.kind === 'err'
                ? {
                    backgroundColor: 'var(--error-tint)',
                    borderColor: 'var(--error)',
                    color: 'var(--error)',
                  }
                : {
                    backgroundColor: 'var(--pass-tint)',
                    borderColor: 'var(--pass)',
                    color: 'var(--pass)',
                  }
            }
          >
            {profileFeedback.text}
          </div>
        )}

        {profilesQuery.isLoading && <LoadingPanel label="Loading agent profiles..." />}
        {profilesQuery.isError && (
          <ErrorPanel
            title="Could not load profiles"
            detail={profilesQuery.error.message}
            onRetry={() => profilesQuery.refetch()}
          />
        )}

        {!profilesQuery.isLoading && !profilesQuery.isError && profiles.length === 0 && (
          <EmptyPanel
            title="No profiles found"
            description="Create an agent profile to assign roles across coders and reviewers."
            action={
              <Button type="button" onClick={() => openCreateProfileModal()}>
                Create profile
              </Button>
            }
          />
        )}

        {profiles.length > 0 && (
          <>
            {/* Mobile cards */}
            <div className="space-y-3 md:hidden">
              {profiles.map((prof) => (
                <div
                  key={prof.id}
                  className="rounded-md border p-4"
                  style={{ borderColor: 'var(--border-subtle)', backgroundColor: 'var(--bg-surface)' }}
                >
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="flex items-center gap-2">
                      <span className="font-semibold">{prof.name}</span>
                      {prof.isDefault && <Badge>Default</Badge>}
                    </div>
                    <Badge>{prof.provider}</Badge>
                  </div>
                  <div className="mt-2 grid grid-cols-2 gap-1.5 text-xs" style={{ color: 'var(--text-secondary)' }}>
                    <span>Model: {prof.model || 'CLI default'}</span>
                    <span>Effort: {prof.effort}</span>
                    <span>Mode: {prof.permissionMode}</span>
                    <span>Review rounds: {prof.maxReviewRounds}</span>
                    <span>Parallel: {prof.maxParallel}</span>
                    <span>Fallback: {profiles.find((p) => p.id === prof.fallbackProfileId)?.name ?? 'none'}</span>
                    <span>Timeout: {Math.round(prof.timeoutMs / 1000)}s</span>
                  </div>
                  <div className="mt-3 flex flex-wrap gap-2">
                    <Button type="button" variant="outline" onClick={() => openEditProfileModal(prof)}>
                      Edit
                    </Button>
                    <Button
                      type="button"
                      variant="destructive"
                      disabled={deleteProfileMutation.isPending}
                      onClick={() => deleteProfileMutation.mutate(prof.id)}
                    >
                      Delete
                    </Button>
                  </div>
                </div>
              ))}
            </div>

            {/* Desktop hairline table */}
            <div
              className="hidden overflow-x-auto rounded-md border md:block"
              style={{ borderColor: 'var(--border-subtle)', backgroundColor: 'var(--bg-surface)' }}
            >
              <table className="w-full border-collapse text-left text-sm">
                <thead>
                  <tr
                    className="border-b"
                    style={{ borderColor: 'var(--border-subtle)', backgroundColor: 'var(--bg-well)' }}
                  >
                    <th className="px-4 py-3 font-semibold">Profile</th>
                    <th className="px-4 py-3 font-semibold">Provider</th>
                    <th className="px-4 py-3 font-semibold">Model</th>
                    <th className="px-4 py-3 font-semibold">Effort</th>
                    <th className="px-4 py-3 font-semibold">Permission</th>
                    <th className="px-4 py-3 font-semibold">Rounds / Limits</th>
                    <th className="px-4 py-3 text-right font-semibold">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {profiles.map((prof) => (
                    <tr key={prof.id} className="border-b last:border-b-0" style={{ borderColor: 'var(--border-subtle)' }}>
                      <td className="px-4 py-3 font-semibold">
                        <div className="flex flex-wrap items-center gap-2">
                          <span>{prof.name}</span>
                          {prof.isDefault && <Badge>Default</Badge>}
                        </div>
                      </td>
                      <td className="px-4 py-3 font-mono-token text-xs">{prof.provider}</td>
                      <td className="px-4 py-3 font-mono-token text-xs">{prof.model || 'CLI default'}</td>
                      <td className="px-4 py-3">{prof.effort}</td>
                      <td className="px-4 py-3 font-mono-token text-xs">{prof.permissionMode}</td>
                      <td className="px-4 py-3 font-mono-token text-xs">
                        {prof.maxReviewRounds} rounds / {prof.maxParallel}x / {Math.round(prof.timeoutMs / 1000)}s
                      </td>
                      <td className="px-4 py-3 text-right">
                        <div className="inline-flex flex-wrap justify-end gap-2">
                          <Button type="button" variant="outline" onClick={() => openEditProfileModal(prof)}>
                            Edit
                          </Button>
                          <Button
                            type="button"
                            variant="destructive"
                            disabled={deleteProfileMutation.isPending}
                            onClick={() => deleteProfileMutation.mutate(prof.id)}
                          >
                            Delete
                          </Button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </section>

      {/* Routing Rules Section (F-21) */}
      <section aria-labelledby="routing-heading" className="space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div>
            <h2 id="routing-heading" className="text-lg font-semibold">
              Routing Rules
            </h2>
            <p className="text-sm" style={{ color: 'var(--text-secondary)' }}>
              Ordered rules match role and complexity first; top matching rule selects the primary and backup profile.
            </p>
          </div>
          <Button
            type="button"
            disabled={profiles.length === 0}
            onClick={openCreateRoutingModal}
          >
            New routing rule
          </Button>
        </div>

        {routingFeedback && (
          <div
            role={routingFeedback.kind === 'err' ? 'alert' : 'status'}
            className="rounded-md border px-3 py-2 text-sm"
            style={
              routingFeedback.kind === 'err'
                ? {
                    backgroundColor: 'var(--error-tint)',
                    borderColor: 'var(--error)',
                    color: 'var(--error)',
                  }
                : {
                    backgroundColor: 'var(--pass-tint)',
                    borderColor: 'var(--pass)',
                    color: 'var(--pass)',
                  }
            }
          >
            {routingFeedback.text}
          </div>
        )}

        {routingQuery.isLoading && <LoadingPanel label="Loading routing rules..." />}
        {routingQuery.isError && (
          <ErrorPanel
            title="Could not load routing rules"
            detail={(routingQuery.error as Error).message}
            onRetry={() => routingQuery.refetch()}
          />
        )}

        {!routingQuery.isLoading && !routingQuery.isError && rules.length === 0 && (
          <EmptyPanel
            title="No routing rules configured"
            description="Add a routing rule to bind task roles and complexity tiers to specific agent profiles."
            action={
              profiles.length > 0 ? (
                <Button type="button" onClick={openCreateRoutingModal}>
                  Add routing rule
                </Button>
              ) : undefined
            }
          />
        )}

        {rules.length > 0 && (
          <>
            {/* Mobile routing cards */}
            <div className="space-y-3 md:hidden">
              {rules.map((rule, index) => (
                <div
                  key={rule.id}
                  className="rounded-md border p-4"
                  style={{ borderColor: 'var(--border-subtle)', backgroundColor: 'var(--bg-surface)' }}
                >
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="font-mono-token text-xs font-semibold">
                      #{index + 1} {rule.role} ({rule.complexity ?? 'any'})
                    </span>
                    <Badge>{rule.profileName}</Badge>
                  </div>
                  <p className="mt-1.5 text-xs" style={{ color: 'var(--text-secondary)' }}>
                    Fallback: {rule.fallbackProfileName ?? 'None'}
                  </p>
                  <div className="mt-3 flex flex-wrap gap-2">
                    <Button
                      type="button"
                      variant="outline"
                      disabled={index === 0 || reorderRoutingMutation.isPending}
                      onClick={() => moveRule(index, -1)}
                    >
                      Up
                    </Button>
                    <Button
                      type="button"
                      variant="outline"
                      disabled={index === rules.length - 1 || reorderRoutingMutation.isPending}
                      onClick={() => moveRule(index, 1)}
                    >
                      Down
                    </Button>
                    <Button type="button" variant="outline" onClick={() => openEditRoutingModal(rule)}>
                      Edit
                    </Button>
                    <Button
                      type="button"
                      variant="destructive"
                      disabled={deleteRoutingMutation.isPending}
                      onClick={() => deleteRoutingMutation.mutate(rule.id)}
                    >
                      Delete
                    </Button>
                  </div>
                </div>
              ))}
            </div>

            {/* Desktop routing table */}
            <div
              className="hidden overflow-x-auto rounded-md border md:block"
              style={{ borderColor: 'var(--border-subtle)', backgroundColor: 'var(--bg-surface)' }}
            >
              <table className="w-full border-collapse text-left text-sm">
                <thead>
                  <tr
                    className="border-b"
                    style={{ borderColor: 'var(--border-subtle)', backgroundColor: 'var(--bg-well)' }}
                  >
                    <th className="px-4 py-3 font-semibold">Priority</th>
                    <th className="px-4 py-3 font-semibold">Role</th>
                    <th className="px-4 py-3 font-semibold">Complexity</th>
                    <th className="px-4 py-3 font-semibold">Primary profile</th>
                    <th className="px-4 py-3 font-semibold">Fallback profile</th>
                    <th className="px-4 py-3 text-right font-semibold">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {rules.map((rule, index) => (
                    <tr key={rule.id} className="border-b last:border-b-0" style={{ borderColor: 'var(--border-subtle)' }}>
                      <td className="px-4 py-3 font-mono-token text-xs font-semibold">#{index + 1}</td>
                      <td className="px-4 py-3 font-mono-token text-xs">{rule.role}</td>
                      <td className="px-4 py-3 font-mono-token text-xs">{rule.complexity ?? 'any'}</td>
                      <td className="px-4 py-3 font-semibold">{rule.profileName}</td>
                      <td className="px-4 py-3 text-xs" style={{ color: 'var(--text-secondary)' }}>
                        {rule.fallbackProfileName ?? 'None'}
                      </td>
                      <td className="px-4 py-3 text-right">
                        <div className="inline-flex flex-wrap justify-end gap-2">
                          <Button
                            type="button"
                            variant="outline"
                            aria-label={`Move rule ${index + 1} up`}
                            disabled={index === 0 || reorderRoutingMutation.isPending}
                            onClick={() => moveRule(index, -1)}
                          >
                            Up
                          </Button>
                          <Button
                            type="button"
                            variant="outline"
                            aria-label={`Move rule ${index + 1} down`}
                            disabled={index === rules.length - 1 || reorderRoutingMutation.isPending}
                            onClick={() => moveRule(index, 1)}
                          >
                            Down
                          </Button>
                          <Button type="button" variant="outline" onClick={() => openEditRoutingModal(rule)}>
                            Edit
                          </Button>
                          <Button
                            type="button"
                            variant="destructive"
                            disabled={deleteRoutingMutation.isPending}
                            onClick={() => deleteRoutingMutation.mutate(rule.id)}
                          >
                            Delete
                          </Button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </section>

      {/* Usage Statistics & Limit Events Section (F-24) */}
      <section aria-labelledby="stats-heading" className="space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div>
            <h2 id="stats-heading" className="text-lg font-semibold">
              Usage Statistics & Limit Events
            </h2>
            <p className="text-sm" style={{ color: 'var(--text-secondary)' }}>
              Per-provider run counts, total and average durations, quota fallbacks, and limit/error events.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <div>
              <Label htmlFor="stats-project-filter" className="sr-only">
                Filter statistics by project
              </Label>
              <NativeSelect
                id="stats-project-filter"
                value={statsProjectId}
                onChange={(e) => setStatsProjectId(e.target.value)}
                className="w-auto"
              >
                <option value="">All projects</option>
                {projects.map((proj) => (
                  <option key={proj.id} value={proj.id}>
                    {proj.name}
                  </option>
                ))}
              </NativeSelect>
            </div>
            <div>
              <Label htmlFor="stats-days-filter" className="sr-only">
                Statistics time window
              </Label>
              <NativeSelect
                id="stats-days-filter"
                value={statsDays}
                onChange={(e) => setStatsDays(e.target.value)}
                className="w-auto"
              >
                <option value="1">Last 24 hours</option>
                <option value="7">Last 7 days</option>
                <option value="30">Last 30 days</option>
                <option value="">All time</option>
              </NativeSelect>
            </div>
          </div>
        </div>

        {statsQuery.isLoading && <LoadingPanel label="Loading usage statistics..." />}

        {statsQuery.isError && (
          <ErrorPanel
            title="Could not load usage statistics"
            detail={statsQuery.error.message}
            onRetry={() => statsQuery.refetch()}
          />
        )}

        {statistics && (
          <div className="space-y-4">
            {/* Totals strip */}
            <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
              <div
                className="rounded-md border p-3"
                style={{ backgroundColor: 'var(--bg-surface)', borderColor: 'var(--border-subtle)' }}
              >
                <div className="text-xs" style={{ color: 'var(--text-secondary)' }}>Total runs</div>
                <div className="mt-1 font-mono-token text-lg font-semibold">
                  {statistics.totals.totalRuns}
                </div>
              </div>
              <div
                className="rounded-md border p-3"
                style={{ backgroundColor: 'var(--bg-surface)', borderColor: 'var(--border-subtle)' }}
              >
                <div className="text-xs" style={{ color: 'var(--text-secondary)' }}>Completed / Failed</div>
                <div className="mt-1 font-mono-token text-lg font-semibold">
                  <span style={{ color: 'var(--pass)' }}>{statistics.totals.completedRuns}</span>
                  {' / '}
                  <span style={{ color: statistics.totals.failedRuns > 0 ? 'var(--error)' : 'inherit' }}>
                    {statistics.totals.failedRuns}
                  </span>
                </div>
              </div>
              <div
                className="rounded-md border p-3"
                style={{ backgroundColor: 'var(--bg-surface)', borderColor: 'var(--border-subtle)' }}
              >
                <div className="text-xs" style={{ color: 'var(--text-secondary)' }}>Quota fallbacks</div>
                <div className="mt-1 font-mono-token text-lg font-semibold">
                  {statistics.totals.fallbackRuns}
                </div>
              </div>
              <div
                className="rounded-md border p-3"
                style={{ backgroundColor: 'var(--bg-surface)', borderColor: 'var(--border-subtle)' }}
              >
                <div className="text-xs" style={{ color: 'var(--text-secondary)' }}>Total runtime</div>
                <div className="mt-1 font-mono-token text-lg font-semibold">
                  {formatStatsDuration(statistics.totals.totalDurationMs)}
                </div>
              </div>
              <div
                className="rounded-md border p-3"
                style={{ backgroundColor: 'var(--bg-surface)', borderColor: 'var(--border-subtle)' }}
              >
                <div className="text-xs" style={{ color: 'var(--text-secondary)' }}>Rate limit hits</div>
                <div
                  className="mt-1 font-mono-token text-lg font-semibold"
                  style={{ color: statistics.totals.rateLimitEvents > 0 ? 'var(--error)' : 'inherit' }}
                >
                  {statistics.totals.rateLimitEvents}
                </div>
              </div>
            </div>

            {/* Per-provider statistics table */}
            <div
              className="overflow-x-auto rounded-md border"
              style={{ borderColor: 'var(--border-subtle)', backgroundColor: 'var(--bg-surface)' }}
            >
              <table className="w-full border-collapse text-left text-sm">
                <thead>
                  <tr
                    className="border-b"
                    style={{ borderColor: 'var(--border-subtle)', backgroundColor: 'var(--bg-well)' }}
                  >
                    <th className="px-4 py-3 font-semibold">Provider</th>
                    <th className="px-4 py-3 font-semibold">Runs (E / F / R)</th>
                    <th className="px-4 py-3 font-semibold">Outcomes</th>
                    <th className="px-4 py-3 font-semibold">Avg / Total Duration</th>
                    <th className="px-4 py-3 font-semibold">Limits & Errors</th>
                    <th className="px-4 py-3 font-semibold">Live Pool</th>
                  </tr>
                </thead>
                <tbody>
                  {statistics.providers.map((ps) => (
                    <tr
                      key={ps.provider}
                      className="border-b last:border-b-0"
                      style={{ borderColor: 'var(--border-subtle)' }}
                    >
                      <td className="px-4 py-3">
                        <div className="font-semibold">{ps.displayName}</div>
                        <div className="font-mono-token text-xs" style={{ color: 'var(--text-secondary)' }}>
                          {ps.provider}
                        </div>
                      </td>
                      <td className="px-4 py-3 font-mono-token text-xs">
                        <div className="font-semibold text-sm">{ps.totalRuns}</div>
                        <div style={{ color: 'var(--text-secondary)' }}>
                          {ps.byKind.execute} / {ps.byKind.fix} / {ps.byKind.review}
                        </div>
                      </td>
                      <td className="px-4 py-3 font-mono-token text-xs">
                        <div>
                          {ps.completedRuns} ok · {ps.failedRuns} fail · {ps.stoppedRuns} stop
                        </div>
                        <div style={{ color: 'var(--text-secondary)' }}>
                          {ps.fallbackRuns} fallback · {ps.rolledBackRuns} rollback
                        </div>
                      </td>
                      <td className="px-4 py-3 font-mono-token text-xs">
                        <div>Avg: {formatStatsDuration(ps.avgDurationMs)}</div>
                        <div style={{ color: 'var(--text-secondary)' }}>
                          Total: {formatStatsDuration(ps.totalDurationMs)}
                        </div>
                      </td>
                      <td className="px-4 py-3 font-mono-token text-xs">
                        <div>
                          429: {ps.rateLimitEvents} · timeout: {ps.timeoutEvents} · auth: {ps.loginExpiredEvents}
                        </div>
                        <div style={{ color: 'var(--text-secondary)' }}>
                          reroute: {ps.quotaFallbackEvents} · err: {ps.errorEvents}
                        </div>
                      </td>
                      <td className="px-4 py-3 text-xs">
                        <Badge>
                          {ps.activeRuns}/{ps.maxParallel} active
                        </Badge>
                        {ps.inCooldown && (
                          <p className="mt-1 font-medium" style={{ color: 'var(--error)' }}>
                            Cooldown active
                          </p>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {/* Project breakdown & recent limit events */}
            <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
              <div
                className="rounded-md border p-4"
                style={{ backgroundColor: 'var(--bg-surface)', borderColor: 'var(--border-subtle)' }}
              >
                <h3 className="text-sm font-semibold">Per-project usage ({statistics.projects.length})</h3>
                {statistics.projects.length === 0 ? (
                  <p className="mt-2 text-xs" style={{ color: 'var(--text-secondary)' }}>
                    No runs recorded in this filter window.
                  </p>
                ) : (
                  <ul className="mt-3 space-y-2 text-xs">
                    {statistics.projects.map((proj) => (
                      <li
                        key={proj.projectId}
                        className="flex flex-wrap items-center justify-between gap-2 border-b pb-2 last:border-b-0 last:pb-0"
                        style={{ borderColor: 'var(--border-subtle)' }}
                      >
                        <span className="font-medium">{proj.projectName}</span>
                        <span className="font-mono-token" style={{ color: 'var(--text-secondary)' }}>
                          {proj.totalRuns} runs · {proj.completedRuns} ok · {proj.failedRuns} fail ·{' '}
                          {proj.fallbackRuns} fallback · {formatStatsDuration(proj.totalDurationMs)}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>

              <div
                className="rounded-md border p-4"
                style={{ backgroundColor: 'var(--bg-surface)', borderColor: 'var(--border-subtle)' }}
              >
                <h3 className="text-sm font-semibold">
                  Recent limit & fallback events ({statistics.recentEvents.length})
                </h3>
                {statistics.recentEvents.length === 0 ? (
                  <p className="mt-2 text-xs" style={{ color: 'var(--text-secondary)' }}>
                    No rate-limit, timeout, auth, or fallback events recorded.
                  </p>
                ) : (
                  <ul className="mt-3 max-h-56 space-y-2 overflow-y-auto text-xs">
                    {statistics.recentEvents.slice(0, 15).map((ev) => (
                      <li
                        key={ev.id}
                        className="border-b pb-2 last:border-b-0 last:pb-0"
                        style={{ borderColor: 'var(--border-subtle)' }}
                      >
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <span className="flex items-center gap-1.5">
                            <Badge>{ev.provider}</Badge>
                            <Badge>{ev.type}</Badge>
                          </span>
                          <span className="font-mono-token" style={{ color: 'var(--text-secondary)' }}>
                            {new Date(ev.createdAt).toLocaleString()}
                          </span>
                        </div>
                        {ev.detail && (
                          <p className="mt-1 break-words" style={{ color: 'var(--text-secondary)' }}>
                            {ev.detail}
                          </p>
                        )}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </div>
          </div>
        )}
      </section>

      {/* Profile Editor Modal */}
      <ModalDialog
        open={profileModalOpen}
        title={profileForm.id ? `Edit profile: ${profileForm.name}` : 'New agent profile'}
        onClose={() => setProfileModalOpen(false)}
      >
        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            saveProfileMutation.mutate(profileForm);
          }}
        >
          {profileModalError && (
            <div
              role="alert"
              className="rounded-md border px-3 py-2 text-sm"
              style={{
                backgroundColor: 'var(--error-tint)',
                borderColor: 'var(--error)',
                color: 'var(--error)',
              }}
            >
              {profileModalError}
            </div>
          )}

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="prof-name">Profile name</Label>
              <Input
                id="prof-name"
                required
                value={profileForm.name}
                onChange={(e) => setProfileForm((f) => ({ ...f, name: e.target.value }))}
                placeholder="e.g. qa-codex"
              />
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="prof-provider">Provider</Label>
              <NativeSelect
                id="prof-provider"
                value={profileForm.provider}
                onChange={(e) =>
                  setProfileForm((f) => ({ ...f, provider: e.target.value as ProviderId, model: '' }))
                }
              >
                {PROVIDER_OPTIONS.map((opt) => (
                  <option key={opt.value} value={opt.value}>
                    {opt.label}
                  </option>
                ))}
              </NativeSelect>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="prof-model">Model</Label>
              <NativeSelect
                id="prof-model"
                value={modelSelectValue}
                onChange={(e) => changeModel(e.target.value)}
              >
                <option value="">CLI default</option>
                {modelSelectValue && !modelChoices.includes(modelSelectValue) && (
                  <option value={modelSelectValue}>{modelSelectValue} (not in provider list)</option>
                )}
                {modelChoices.map((m) => (
                  <option key={m} value={m}>
                    {m}
                  </option>
                ))}
              </NativeSelect>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="prof-fallback">Fallback profile</Label>
              <NativeSelect
                id="prof-fallback"
                value={profileForm.fallbackProfileId}
                onChange={(e) => setProfileForm((f) => ({ ...f, fallbackProfileId: e.target.value }))}
              >
                <option value="">None</option>
                {profiles
                  .filter((p) => p.id !== profileForm.id)
                  .map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name} ({p.provider})
                    </option>
                  ))}
              </NativeSelect>
              <p className="text-xs" style={{ color: 'var(--text-secondary)' }}>
                Used when this profile hits a limit, expires, or times out, unless a routing rule names its own fallback.
              </p>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="prof-effort">Reasoning effort</Label>
              <NativeSelect
                id="prof-effort"
                disabled={effortLocked}
                value={profileForm.effort}
                onChange={(e) => changeEffort(e.target.value as EffortLevel)}
              >
                {effortChoices.map((eff) => (
                  <option key={eff} value={eff}>
                    {eff}
                  </option>
                ))}
              </NativeSelect>
              {effortLocked && (
                <p className="text-xs" style={{ color: 'var(--text-secondary)' }}>
                  This model has no effort levels.
                </p>
              )}
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="prof-permission">Permission mode</Label>
              <NativeSelect
                id="prof-permission"
                value={profileForm.permissionMode}
                onChange={(e) =>
                  setProfileForm((f) => ({
                    ...f,
                    permissionMode: e.target.value as PermissionMode,
                  }))
                }
              >
                {PERMISSION_OPTIONS.map((perm) => (
                  <option key={perm} value={perm}>
                    {perm}
                  </option>
                ))}
              </NativeSelect>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="prof-rounds">Max review rounds (1 to 3)</Label>
              <Input
                id="prof-rounds"
                type="number"
                min={1}
                max={3}
                value={profileForm.maxReviewRounds}
                onChange={(e) =>
                  setProfileForm((f) => ({
                    ...f,
                    maxReviewRounds: Math.min(3, Math.max(1, Number(e.target.value) || 2)),
                  }))
                }
              />
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="prof-parallel">Max parallel tasks</Label>
              <Input
                id="prof-parallel"
                type="number"
                min={1}
                max={16}
                value={profileForm.maxParallel}
                onChange={(e) =>
                  setProfileForm((f) => ({
                    ...f,
                    maxParallel: Math.min(16, Math.max(1, Number(e.target.value) || 1)),
                  }))
                }
              />
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="prof-timeout">Run timeout (seconds)</Label>
              <Input
                id="prof-timeout"
                type="number"
                min={5}
                max={7200}
                value={profileForm.timeoutSeconds}
                onChange={(e) =>
                  setProfileForm((f) => ({
                    ...f,
                    timeoutSeconds: Math.min(7200, Math.max(5, Number(e.target.value) || 1800)),
                  }))
                }
              />
            </div>

            <div className="space-y-1.5 sm:col-span-2">
              <Label htmlFor="prof-idle-timeout">Idle output timeout (seconds)</Label>
              <Input
                id="prof-idle-timeout"
                type="number"
                min={5}
                max={3600}
                value={profileForm.idleTimeoutSeconds}
                onChange={(e) =>
                  setProfileForm((f) => ({
                    ...f,
                    idleTimeoutSeconds: Math.min(3600, Math.max(5, Number(e.target.value) || 180)),
                  }))
                }
              />
            </div>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="prof-role-prompt">Role instructions (system / prompt prefix)</Label>
            <Textarea
              id="prof-role-prompt"
              value={profileForm.rolePrompt}
              onChange={(e) => setProfileForm((f) => ({ ...f, rolePrompt: e.target.value }))}
              placeholder="Optional role instructions prepended to turns run under this profile."
            />
          </div>

          {profileForm.provider === 'antigravity' && (
            <div className="rounded-[6px] border border-border p-3 space-y-2">
              <div className="flex min-h-11 items-start gap-2">
                <input
                  id="prof-agy-keyring"
                  type="checkbox"
                  className="mt-1 size-4 accent-[var(--primary)]"
                  checked={profileForm.antigravityKeyringAccess}
                  onChange={(e) =>
                    setProfileForm((f) => ({ ...f, antigravityKeyringAccess: e.target.checked }))
                  }
                />
                <Label htmlFor="prof-agy-keyring" className="text-sm font-normal leading-snug">
                  Allow Antigravity to read the desktop keyring
                </Label>
              </div>
              <p className="text-xs" style={{ color: 'var(--text-secondary)' }}>
                agy authenticates via the desktop keyring (needs xdg-dbus-proxy). Leaving this off routes Antigravity
                tasks to the configured fallback profile.
              </p>
            </div>
          )}

          <div className="flex flex-wrap justify-end gap-2 pt-2">
            <Button type="button" variant="outline" onClick={() => setProfileModalOpen(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={saveProfileMutation.isPending}>
              {saveProfileMutation.isPending ? 'Saving...' : 'Save profile'}
            </Button>
          </div>
        </form>
      </ModalDialog>

      {/* Routing Rule Editor Modal */}
      <ModalDialog
        open={routingModalOpen}
        title={routingForm.id ? 'Edit routing rule' : 'New routing rule'}
        onClose={() => setRoutingModalOpen(false)}
      >
        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            saveRoutingMutation.mutate(routingForm);
          }}
        >
          {routingModalError && (
            <div
              role="alert"
              className="rounded-md border px-3 py-2 text-sm"
              style={{
                backgroundColor: 'var(--error-tint)',
                borderColor: 'var(--error)',
                color: 'var(--error)',
              }}
            >
              {routingModalError}
            </div>
          )}

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="route-role">Role</Label>
              <NativeSelect
                id="route-role"
                value={routingForm.role}
                onChange={(e) => setRoutingForm((f) => ({ ...f, role: e.target.value as TaskRole }))}
              >
                {ROLE_OPTIONS.map((r) => (
                  <option key={r} value={r}>
                    {r}
                  </option>
                ))}
              </NativeSelect>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="route-complexity">Complexity filter</Label>
              <NativeSelect
                id="route-complexity"
                value={routingForm.complexity}
                onChange={(e) =>
                  setRoutingForm((f) => ({
                    ...f,
                    complexity: e.target.value as TaskComplexity | '',
                  }))
                }
              >
                <option value="">Any complexity</option>
                {COMPLEXITY_OPTIONS.map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </NativeSelect>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="route-primary">Primary profile</Label>
              <NativeSelect
                id="route-primary"
                value={routingForm.profileId}
                onChange={(e) => setRoutingForm((f) => ({ ...f, profileId: e.target.value }))}
              >
                {profiles.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name} ({p.provider})
                  </option>
                ))}
              </NativeSelect>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="route-fallback">Fallback profile (optional)</Label>
              <NativeSelect
                id="route-fallback"
                value={routingForm.fallbackProfileId}
                onChange={(e) =>
                  setRoutingForm((f) => ({ ...f, fallbackProfileId: e.target.value }))
                }
              >
                <option value="">None</option>
                {profiles.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name} ({p.provider})
                  </option>
                ))}
              </NativeSelect>
            </div>
          </div>

          <div className="flex flex-wrap justify-end gap-2 pt-2">
            <Button type="button" variant="outline" onClick={() => setRoutingModalOpen(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={saveRoutingMutation.isPending}>
              {saveRoutingMutation.isPending ? 'Saving...' : 'Save rule'}
            </Button>
          </div>
        </form>
      </ModalDialog>
    </div>
  );
}
