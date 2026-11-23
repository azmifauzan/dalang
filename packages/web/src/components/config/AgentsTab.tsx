import { useRef, useState, type KeyboardEvent } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type {
  AgentProfileDTO,
  EffortLevel,
  ProviderId,
  ProviderRuntimeStateDTO,
  ProviderStatus,
  RoutingRuleDTO,
} from '@dalang/shared';
import { ProviderIcon } from '../../assets/providers/ProviderIcon.js';
import { useI18n } from '../../i18n/index.js';
import { api } from '../../lib/api.js';
import { EMPTY_FALLBACK, fallbackFromForm, fallbackToForm } from '../FallbackFields.js';
import { ErrorPanel, LoadingPanel } from '../StateViews.js';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { AgentsProvidersPanel } from './AgentsProvidersPanel.js';
import { AgentsRoutingPanel } from './AgentsRoutingPanel.js';
import { AgentsTeamPanel } from './AgentsTeamPanel.js';
import { ProfileEditorModal } from './ProfileEditorModal.js';
import { RoutingEditorModal } from './RoutingEditorModal.js';
import {
  tightestRemaining,
  type CoreRoleSlot,
  type ProfileFormState,
  type RoutingFormState,
} from './agentHelpers.js';

export type AgentsSubTab = 'team' | 'providers' | 'routing';

const SUB_TABS: readonly AgentsSubTab[] = ['team', 'providers', 'routing'];

export function AgentsTab({
  providers,
  providerStates,
  profiles,
  rules,
  keyringAccess,
  providersLoading,
  providersError,
  onRetryProviders,
  profilesLoading,
  profilesError,
  onRetryProfiles,
  routingLoading,
  routingError,
  onRetryRouting,
  onOpenSecurity,
}: {
  providers: ProviderStatus[];
  providerStates: ProviderRuntimeStateDTO[];
  profiles: AgentProfileDTO[];
  rules: RoutingRuleDTO[];
  keyringAccess: boolean;
  providersLoading: boolean;
  providersError: Error | null;
  onRetryProviders: () => void;
  profilesLoading: boolean;
  profilesError: Error | null;
  onRetryProfiles: () => void;
  routingLoading: boolean;
  routingError: Error | null;
  onRetryRouting: () => void;
  onOpenSecurity: () => void;
}) {
  const qc = useQueryClient();
  const { t } = useI18n();
  const [subTab, setSubTab] = useState<AgentsSubTab>('team');
  const tabRefs = useRef<Record<AgentsSubTab, HTMLButtonElement | null>>({
    team: null,
    providers: null,
    routing: null,
  });

  // Feedback banners
  const [banner, setBanner] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);
  const [savedNoticeId, setSavedNoticeId] = useState<string | null>(null);
  const [inlineError, setInlineError] = useState<{ id: string; text: string } | null>(null);

  // Profile modal state
  const [profileModalOpen, setProfileModalOpen] = useState(false);
  const [profileModalAdvanced, setProfileModalAdvanced] = useState(false);
  const [profileModalError, setProfileModalError] = useState<string | null>(null);
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
    fallback: EMPTY_FALLBACK,
    configDir: '',
    rolePrompt: '',
    antigravityKeyringAccess: keyringAccess,
  });

  // Routing modal state
  const [routingModalOpen, setRoutingModalOpen] = useState(false);
  const [routingModalError, setRoutingModalError] = useState<string | null>(null);
  const [routingForm, setRoutingForm] = useState<RoutingFormState>({
    id: null,
    role: 'engineer',
    complexity: '',
    profileId: '',
    fallback: EMPTY_FALLBACK,
  });

  const invalidateConfigCaches = () => {
    qc.invalidateQueries({ queryKey: ['profiles'] });
    qc.invalidateQueries({ queryKey: ['routing'] });
    qc.invalidateQueries({ queryKey: ['execution'] });
    qc.invalidateQueries({ queryKey: ['guard'] });
  };

  const refreshMutation = useMutation({
    mutationFn: () => api.refreshProvidersStatus(),
    onSuccess: (data) => {
      qc.setQueryData(['providers-status'], data);
    },
  });

  const updateCliMutation = useMutation({
    mutationFn: api.updateProviderCli,
    onSuccess: (data) => qc.setQueryData(['providers-status'], data),
  });

  const clearCooldownMutation = useMutation({
    mutationFn: (provider: ProviderId) => api.clearProviderCooldown(provider),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['providers-status'] });
      qc.invalidateQueries({ queryKey: ['statistics'] });
    },
  });

  const quickSaveMutation = useMutation({
    mutationFn: ({
      profileId,
      patch,
    }: {
      profileId: string;
      patch: { provider: ProviderId; model: string; effort: EffortLevel };
    }) => api.updateProfile(profileId, patch),
    onMutate: () => {
      setInlineError(null);
    },
    onSuccess: (_res, vars) => {
      setSavedNoticeId(vars.profileId);
      setTimeout(() => {
        setSavedNoticeId((prev) => (prev === vars.profileId ? null : prev));
      }, 2400);
      invalidateConfigCaches();
    },
    onError: (err, vars) => {
      setInlineError({ id: vars.profileId, text: (err as Error).message });
    },
  });

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
        fallback: fallbackFromForm(form.fallback),
        configDir: form.configDir.trim() || null,
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
      setBanner({ kind: 'ok', text: t('config.team.savedMsg', { name: saved.name }) });
      invalidateConfigCaches();
    },
    onError: (err) => setProfileModalError((err as Error).message),
  });

  const deleteProfileMutation = useMutation({
    mutationFn: (profileId: string) => api.deleteProfile(profileId),
    onSuccess: () => {
      setBanner({ kind: 'ok', text: t('config.team.deletedMsg') });
      invalidateConfigCaches();
    },
    onError: (err) => setBanner({ kind: 'err', text: (err as Error).message }),
  });

  const saveRoutingMutation = useMutation({
    mutationFn: async (form: RoutingFormState) => {
      const payload = {
        role: form.role,
        complexity: form.complexity === '' ? null : form.complexity,
        profileId: form.profileId,
        fallback: fallbackFromForm(form.fallback),
      };
      const saved = form.id
        ? await api.updateRoutingRule(form.id, payload)
        : await api.createRoutingRule(payload);
      return saved.rule;
    },
    onSuccess: () => {
      setRoutingModalOpen(false);
      setRoutingModalError(null);
      setBanner({ kind: 'ok', text: t('config.routing.savedMsg') });
      invalidateConfigCaches();
    },
    onError: (err) => setRoutingModalError((err as Error).message),
  });

  const deleteRoutingMutation = useMutation({
    mutationFn: (ruleId: string) => api.deleteRoutingRule(ruleId),
    onSuccess: () => {
      setBanner({ kind: 'ok', text: t('config.routing.deletedMsg') });
      invalidateConfigCaches();
    },
    onError: (err) => setBanner({ kind: 'err', text: (err as Error).message }),
  });

  const reorderRoutingMutation = useMutation({
    mutationFn: (ruleIds: string[]) => api.reorderRoutingRules(ruleIds),
    onSuccess: (data) => {
      qc.setQueryData(['routing'], data);
      invalidateConfigCaches();
    },
    onError: (err) => setBanner({ kind: 'err', text: (err as Error).message }),
  });

  const openCreateProfileModal = (showAdvanced = false, slotPreset?: CoreRoleSlot) => {
    setProfileModalError(null);
    setProfileModalAdvanced(showAdvanced);
    const defaultProvider: ProviderId =
      providers.find((p) => p.installed && p.loggedIn)?.id ?? 'claude-code';
    setProfileForm({
      id: null,
      name: slotPreset?.profileName ?? '',
      provider: defaultProvider,
      model: '',
      effort: slotPreset?.defaultEffort ?? 'medium',
      permissionMode: slotPreset?.defaultPermission ?? 'workspace-write',
      timeoutSeconds: slotPreset?.defaultTimeoutSeconds ?? 1800,
      idleTimeoutSeconds: 180,
      maxParallel: slotPreset?.defaultParallel ?? 1,
      maxReviewRounds: 2,
      fallback: EMPTY_FALLBACK,
      configDir: '',
      rolePrompt: '',
      antigravityKeyringAccess: keyringAccess,
    });
    setProfileModalOpen(true);
  };

  const openEditProfileModal = (prof: AgentProfileDTO, showAdvanced = false) => {
    setProfileModalError(null);
    setProfileModalAdvanced(showAdvanced);
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
      fallback: fallbackToForm(prof.fallback),
      configDir: prof.configDir ?? '',
      rolePrompt: prof.rolePrompt,
      antigravityKeyringAccess: keyringAccess,
    });
    setProfileModalOpen(true);
  };

  const openCreateRoutingModal = () => {
    setRoutingModalError(null);
    setRoutingForm({
      id: null,
      role: 'engineer',
      complexity: '',
      profileId: profiles[0]?.id ?? '',
      fallback: EMPTY_FALLBACK,
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
      fallback: fallbackToForm(rule.fallback),
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

  const readyCliCount = providers.filter(
    (p) => p.installed && p.loggedIn && (p.id !== 'antigravity' || keyringAccess),
  ).length;

  const selectSubTab = (next: AgentsSubTab) => {
    setBanner(null);
    setSubTab(next);
    tabRefs.current[next]?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  };

  const handleTabKeyDown = (e: KeyboardEvent<HTMLButtonElement>, current: AgentsSubTab) => {
    const idx = SUB_TABS.indexOf(current);
    let next: AgentsSubTab | null = null;
    if (e.key === 'ArrowRight') next = SUB_TABS[(idx + 1) % SUB_TABS.length];
    else if (e.key === 'ArrowLeft') next = SUB_TABS[(idx - 1 + SUB_TABS.length) % SUB_TABS.length];
    else if (e.key === 'Home') next = SUB_TABS[0];
    else if (e.key === 'End') next = SUB_TABS[SUB_TABS.length - 1];
    if (!next) return;
    e.preventDefault();
    selectSubTab(next);
    tabRefs.current[next]?.focus();
  };

  const subTabMeta: Array<{ id: AgentsSubTab; label: string; count: string }> = [
    { id: 'team', label: t('config.agents.subtab.team'), count: String(profiles.length) },
    {
      id: 'providers',
      label: t('config.agents.subtab.providers'),
      count: providers.length > 0 ? `${readyCliCount}/${providers.length}` : '0',
    },
    { id: 'routing', label: t('config.agents.subtab.routing'), count: String(rules.length) },
  ];

  return (
    <section className="space-y-5">
      {/* Clean page header on warm canvas */}
      <header
        className="flex flex-wrap items-end justify-between gap-4 border-b pb-4"
        style={{ borderColor: 'var(--border-subtle)' }}
      >
        <div className="min-w-0 max-w-2xl">
          <h1 className="text-2xl font-semibold tracking-tight">{t('config.agents.title')}</h1>
          <p className="mt-1 text-sm" style={{ color: 'var(--text-secondary)' }}>
            {t('config.agents.hubSubtitle')}
          </p>
        </div>
        <Button
          type="button"
          variant="outline"
          onClick={() => refreshMutation.mutate()}
          disabled={refreshMutation.isPending}
        >
          {refreshMutation.isPending ? t('config.agents.checking') : t('config.agents.refresh')}
        </Button>
      </header>

      {/* Always-visible live CLI health strip */}
      {!providersLoading && !providersError && providers.length > 0 && (
        <div
          aria-label={t('config.agents.cliStripAria')}
          className="grid grid-cols-1 gap-2.5 sm:grid-cols-3"
        >
          {providers.map((p) => {
            const runtime = providerStates.find((ps) => ps.provider === p.id);
            const ready = p.installed && p.loggedIn;
            const keyringOff = p.id === 'antigravity' && ready && !keyringAccess;
            const tightest = ready && p.usage.available ? tightestRemaining(p.usage.windows) : null;
            const isError = Boolean(runtime?.inCooldown || runtime?.quotaExhausted || !ready);
            const statusText = runtime?.inCooldown
              ? t('work.stageCooldown')
              : runtime?.quotaExhausted
                ? t('common.quotaExhausted')
                : !p.installed
                  ? t('config.agents.statusMissing')
                  : !p.loggedIn
                    ? t('config.agents.statusLogin')
                    : keyringOff
                      ? t('config.agents.statusKeyringOff')
                      : t('config.agents.statusReady');
            const badgeStyle = isError
              ? {
                  color: 'var(--error)',
                  borderColor: 'var(--error)',
                  backgroundColor: 'var(--error-tint)',
                }
              : keyringOff
                ? {
                    color: 'var(--accent)',
                    borderColor: 'var(--accent)',
                    backgroundColor: 'var(--accent-tint)',
                  }
                : {
                    color: 'var(--pass)',
                    borderColor: 'var(--pass)',
                    backgroundColor: 'var(--pass-tint)',
                  };

            return (
              <button
                key={p.id}
                type="button"
                onClick={() => selectSubTab('providers')}
                className="flex min-h-11 cursor-pointer items-center justify-between gap-2 rounded-[6px] border px-3.5 py-2.5 text-left transition-colors duration-150 hover:bg-muted"
                style={{
                  backgroundColor: 'var(--bg-surface)',
                  borderColor:
                    subTab === 'providers'
                      ? 'var(--border-control)'
                      : isError
                        ? 'var(--error)'
                        : keyringOff
                          ? 'var(--accent)'
                          : 'var(--border-subtle)',
                }}
              >
                <span className="flex min-w-0 items-center gap-2">
                  <ProviderIcon id={p.id} size={18} />
                  <span className="truncate text-sm font-medium">{p.displayName}</span>
                </span>
                <span className="flex shrink-0 items-center gap-2">
                  {tightest !== null && (
                    <span
                      className="font-mono-token text-xs font-semibold"
                      style={{ color: tightest <= 20 ? 'var(--error)' : 'var(--text-secondary)' }}
                    >
                      {tightest}%
                    </span>
                  )}
                  <Badge style={badgeStyle}>{statusText}</Badge>
                </span>
              </button>
            );
          })}
        </div>
      )}

      {/* Accessible single-row sub-tab bar (underline indicator via border, never color-only) */}
      <div
        role="tablist"
        aria-label={t('config.agents.subtabsAria')}
        className="flex flex-nowrap items-center gap-1 overflow-x-auto border-b"
        style={{ borderColor: 'var(--border-subtle)' }}
      >
        {subTabMeta.map((item) => {
          const active = subTab === item.id;
          return (
            <button
              key={item.id}
              ref={(el) => {
                tabRefs.current[item.id] = el;
              }}
              id={`agents-tab-${item.id}`}
              type="button"
              role="tab"
              aria-selected={active}
              tabIndex={active ? 0 : -1}
              onClick={() => selectSubTab(item.id)}
              onKeyDown={(e) => handleTabKeyDown(e, item.id)}
              className="relative flex min-h-11 shrink-0 cursor-pointer items-center gap-1.5 rounded-t-[6px] px-2.5 py-2 text-xs font-medium whitespace-nowrap transition-colors duration-150 focus-visible:-outline-offset-2 sm:gap-2 sm:px-4 sm:text-sm"
              style={{
                color: active ? 'var(--accent)' : 'var(--text-secondary)',
                borderBottom: active ? '2px solid var(--accent)' : '2px solid transparent',
              }}
            >
              <span>{item.label}</span>
              <span
                className="rounded-[4px] border px-1.5 py-0.5 font-mono-token text-[11px]"
                style={{
                  borderColor: active ? 'var(--accent)' : 'var(--border-subtle)',
                  backgroundColor: active ? 'var(--accent-tint)' : 'var(--bg-well)',
                  color: active ? 'var(--accent)' : 'var(--text-secondary)',
                }}
              >
                {item.count}
              </span>
            </button>
          );
        })}
      </div>

      {/* Shared status banner */}
      {banner && (
        <div
          role={banner.kind === 'err' ? 'alert' : 'status'}
          className="flex flex-wrap items-center justify-between gap-2 rounded-[6px] border px-3.5 py-2.5 text-sm"
          style={
            banner.kind === 'err'
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
          <span>{banner.text}</span>
          <button
            type="button"
            onClick={() => setBanner(null)}
            className="inline-flex min-h-11 cursor-pointer items-center text-xs font-semibold underline underline-offset-2"
          >
            {t('common.close')}
          </button>
        </div>
      )}

      {/* SUB-TAB 1: TEAM & ROLES */}
      {subTab === 'team' && (
        <div role="tabpanel" aria-labelledby="agents-tab-team">
          {profilesLoading && <LoadingPanel label={t('config.team.loading')} />}
          {profilesError && (
            <ErrorPanel
              title={t('config.team.loadError')}
              detail={profilesError.message}
              onRetry={onRetryProfiles}
            />
          )}
          {!profilesLoading && !profilesError && (
            <AgentsTeamPanel
              profiles={profiles}
              providers={providers}
              providerStates={providerStates}
              rules={rules}
              keyringAccess={keyringAccess}
              savingId={
                quickSaveMutation.isPending ? (quickSaveMutation.variables?.profileId ?? null) : null
              }
              savedNoticeId={savedNoticeId}
              inlineError={inlineError}
              deletingId={
                deleteProfileMutation.isPending ? (deleteProfileMutation.variables ?? null) : null
              }
              onQuickSave={(profileId, patch) => quickSaveMutation.mutate({ profileId, patch })}
              onOpenCreateProfile={(showAdvanced) => openCreateProfileModal(showAdvanced)}
              onOpenEditProfile={(prof) => openEditProfileModal(prof)}
              onCreateMissingRole={(slot) => openCreateProfileModal(false, slot)}
              onDeleteProfile={(id) => deleteProfileMutation.mutate(id)}
              onOpenProviders={() => setSubTab('providers')}
              onOpenSecurity={onOpenSecurity}
            />
          )}
        </div>
      )}

      {/* SUB-TAB 2: CLIS & QUOTAS */}
      {subTab === 'providers' && (
        <div role="tabpanel" aria-labelledby="agents-tab-providers">
          {providersLoading && <LoadingPanel label={t('config.agents.loading')} />}
          {providersError && (
            <ErrorPanel
              title={t('config.agents.loadError')}
              detail={providersError.message}
              onRetry={onRetryProviders}
            />
          )}
          {!providersLoading && !providersError && (
            <AgentsProvidersPanel
              providers={providers}
              providerStates={providerStates}
              profiles={profiles}
              keyringAccess={keyringAccess}
              updatingProviderId={
                updateCliMutation.isPending ? (updateCliMutation.variables ?? null) : null
              }
              updateSuccessProviderId={
                updateCliMutation.isSuccess ? (updateCliMutation.variables ?? null) : null
              }
              updateErrorProviderId={
                updateCliMutation.isError ? (updateCliMutation.variables ?? null) : null
              }
              updateErrorMessage={
                updateCliMutation.isError ? updateCliMutation.error.message : null
              }
              clearingCooldown={clearCooldownMutation.isPending}
              onUpdateCli={(id) => updateCliMutation.mutate(id)}
              onClearCooldown={(id) => clearCooldownMutation.mutate(id)}
              onOpenTeam={() => setSubTab('team')}
              onOpenSecurity={onOpenSecurity}
              onEditAccountProfile={(prof) => openEditProfileModal(prof, true)}
              onAddSeparateAccount={() => openCreateProfileModal(true)}
            />
          )}
        </div>
      )}

      {/* SUB-TAB 3: TASK ROUTING */}
      {subTab === 'routing' && (
        <div role="tabpanel" aria-labelledby="agents-tab-routing">
          {routingLoading && <LoadingPanel label={t('config.routing.loading')} />}
          {routingError && (
            <ErrorPanel
              title={t('config.routing.loadError')}
              detail={routingError.message}
              onRetry={onRetryRouting}
            />
          )}
          {!routingLoading && !routingError && (
            <AgentsRoutingPanel
              rules={rules}
              profiles={profiles}
              reordering={reorderRoutingMutation.isPending}
              deletingId={
                deleteRoutingMutation.isPending ? (deleteRoutingMutation.variables ?? null) : null
              }
              onCreateRule={openCreateRoutingModal}
              onEditRule={openEditRoutingModal}
              onDeleteRule={(id) => deleteRoutingMutation.mutate(id)}
              onMoveRule={moveRule}
            />
          )}
        </div>
      )}

      {/* Modals */}
      <ProfileEditorModal
        open={profileModalOpen}
        form={profileForm}
        onChange={setProfileForm}
        providers={providers}
        keyringAccess={keyringAccess}
        error={profileModalError}
        saving={saveProfileMutation.isPending}
        initialShowAdvanced={profileModalAdvanced}
        onClose={() => setProfileModalOpen(false)}
        onSubmit={(form) => saveProfileMutation.mutate(form)}
      />

      <RoutingEditorModal
        open={routingModalOpen}
        form={routingForm}
        onChange={setRoutingForm}
        profiles={profiles}
        providers={providers}
        error={routingModalError}
        saving={saveRoutingMutation.isPending}
        onClose={() => setRoutingModalOpen(false)}
        onSubmit={(form) => saveRoutingMutation.mutate(form)}
      />
    </section>
  );
}
