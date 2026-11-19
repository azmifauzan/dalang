import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  DALANG_VERSION,
  EFFORT_LEVEL_ORDER,
  splitEffortModel,
  type AgentProfileDTO,
  type EffortLevel,
  type PermissionMode,
  type ProviderId,
  type ProviderModelInfo,
  type ProviderRuntimeStateDTO,
  type RoutingRuleDTO,
  type TaskComplexity,
  type TaskRole,
  type UpdateStatusDTO,
} from '@dalang/shared';
import { GununganDetailed } from '../assets/wayang/Gunungan.js';
import { FallbackFields, describeFallback, EMPTY_FALLBACK, fallbackFromForm, fallbackToForm, type FallbackForm } from './FallbackFields.js';
import { WayangFigure, castDisplayName, characterForProfile } from '../assets/wayang/WayangFigure.js';
import { useI18n } from '../i18n/index.js';
import { providerBadgeStyle, providerDisplayShort } from '../lib/activity.js';
import { api } from '../lib/api.js';
import { useTheme, type ThemePreference } from '../lib/theme.js';
import type { ConfigTabId } from './Sidebar.js';
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
  fallback: FallbackForm;
  configDir: string;
  rolePrompt: string;
  antigravityKeyringAccess: boolean;
}

interface RoutingFormState {
  id: string | null;
  role: TaskRole;
  complexity: TaskComplexity | '';
  profileId: string;
  fallback: FallbackForm;
}

const PROVIDER_OPTIONS: Array<{ value: ProviderId; label: string }> = [
  { value: 'claude-code', label: 'Claude Code (claude)' },
  { value: 'codex', label: 'Codex CLI (codex)' },
  { value: 'antigravity', label: 'Antigravity (agy)' },
];

const EFFORT_OPTIONS: EffortLevel[] = [...EFFORT_LEVEL_ORDER];
const PERMISSION_OPTIONS: PermissionMode[] = ['workspace-write', 'read-only', 'accept-edits'];
const ROLE_OPTIONS: TaskRole[] = ['lead', 'planner', 'engineer', 'qa', 'reviewer'];
const COMPLEXITY_OPTIONS: TaskComplexity[] = ['low', 'medium', 'high'];

function configDirEnvHint(provider: ProviderId): string {
  if (provider === 'claude-code') return 'CLAUDE_CONFIG_DIR';
  if (provider === 'codex') return 'CODEX_HOME';
  return 'AGY_CONFIG_DIR';
}

function matchProviderModel(
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

export function ConfigView({
  tab,
  updateStatus,
  onReopenWizard,
}: {
  tab: ConfigTabId;
  updateStatus: UpdateStatusDTO | null;
  onReopenWizard: () => void;
}) {
  const qc = useQueryClient();
  const { lang, setLang, t, te } = useI18n();
  const { preference, systemTheme, setPreference } = useTheme();
  const [copiedCmd, setCopiedCmd] = useState<string | null>(null);

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
  const settingsQuery = useQuery({
    queryKey: ['settings'],
    queryFn: () => api.getSettings(),
  });

  const refreshMutation = useMutation({
    mutationFn: () => api.refreshProvidersStatus(),
    onSuccess: (data) => {
      qc.setQueryData(['providers-status'], data);
    },
  });

  const clearCooldownMutation = useMutation({
    mutationFn: (provider: ProviderId) => api.clearProviderCooldown(provider),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['providers-status'] });
      qc.invalidateQueries({ queryKey: ['statistics'] });
    },
  });

  const updateSettingsMutation = useMutation({
    mutationFn: api.updateSettings,
    onSuccess: (data) => {
      qc.setQueryData(['settings'], data);
      qc.invalidateQueries({ queryKey: ['update-status'] });
      qc.invalidateQueries({ queryKey: ['execution'] });
    },
  });

  const forceUpdateCheckMutation = useMutation({
    mutationFn: () => api.getUpdateStatus(true),
    onSuccess: (data) => {
      qc.setQueryData(['update-status'], data);
    },
  });

  const keyringAccess = settingsQuery.data?.settings.antigravityKeyringAccess ?? false;
  const checkForUpdates = settingsQuery.data?.settings.checkForUpdates ?? true;
  const providers = providersQuery.data?.providers ?? [];
  const providerStates: ProviderRuntimeStateDTO[] = providersQuery.data?.providerStates ?? [];
  const profiles = profilesQuery.data?.profiles ?? [];
  const rules = routingQuery.data?.rules ?? [];

  // Profile modal state
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
    fallback: EMPTY_FALLBACK,
    configDir: '',
    rolePrompt: '',
    antigravityKeyringAccess: keyringAccess,
  });
  const [profileFeedback, setProfileFeedback] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);
  const [profileModalError, setProfileModalError] = useState<string | null>(null);

  // Routing modal state
  const [routingModalOpen, setRoutingModalOpen] = useState(false);
  const [routingForm, setRoutingForm] = useState<RoutingFormState>({
    id: null,
    role: 'engineer',
    complexity: '',
    profileId: '',
    fallback: EMPTY_FALLBACK,
  });
  const [routingFeedback, setRoutingFeedback] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);
  const [routingModalError, setRoutingModalError] = useState<string | null>(null);

  const providerModels = useMemo(() => {
    const provider = providers.find((p) => p.id === profileForm.provider);
    return provider?.models ?? [];
  }, [providers, profileForm.provider]);

  const isAgy = profileForm.provider === 'antigravity';
  const matchedModel = useMemo(
    () => matchProviderModel(providerModels, profileForm.model, isAgy),
    [providerModels, profileForm.model, isAgy],
  );
  const selectedModelInfo = matchedModel.modelInfo;
  const activeVariantValue = matchedModel.activeVariantValue;
  const currentSplit = isAgy ? splitEffortModel(profileForm.model) : null;
  const modelSelectValue = selectedModelInfo
    ? selectedModelInfo.id
    : currentSplit
      ? currentSplit.base
      : profileForm.model;
  const savedModelUnavailable = Boolean(
    profileForm.model.trim() && providerModels.length > 0 && !selectedModelInfo,
  );
  const effortChoices: EffortLevel[] = selectedModelInfo
    ? selectedModelInfo.supportedEffortLevels.length > 0
      ? selectedModelInfo.supportedEffortLevels
      : []
    : EFFORT_OPTIONS;
  const effortLocked = Boolean(selectedModelInfo && selectedModelInfo.supportedEffortLevels.length === 0);

  const changeModel = (selectedId: string) =>
    setProfileForm((f) => {
      if (!selectedId) return { ...f, model: '' };
      const info = providerModels.find((m) => m.id === selectedId);
      if (!info) return { ...f, model: selectedId };
      const nextEffort: EffortLevel =
        info.defaultEffort ??
        (info.supportedEffortLevels.includes(f.effort)
          ? f.effort
          : info.supportedEffortLevels[0] ?? f.effort);
      if (isAgy && info.supportedEffortLevels.length > 0) {
        return { ...f, model: `${info.id}-${nextEffort}`, effort: nextEffort };
      }
      return { ...f, model: info.value, effort: nextEffort };
    });

  const toggleVariant = (variantValue: string, enabled: boolean) =>
    setProfileForm((f) => {
      if (!selectedModelInfo) return f;
      return { ...f, model: enabled ? variantValue : selectedModelInfo.value };
    });

  const changeEffort = (level: EffortLevel) =>
    setProfileForm((f) => {
      if (isAgy && selectedModelInfo && selectedModelInfo.supportedEffortLevels.length > 0) {
        return { ...f, effort: level, model: `${selectedModelInfo.id}-${level}` };
      }
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
      setProfileFeedback({ kind: 'ok', text: t('config.team.savedMsg', { name: saved.name }) });
      invalidateConfigCaches();
    },
    onError: (err) => setProfileModalError((err as Error).message),
  });

  const deleteProfileMutation = useMutation({
    mutationFn: (profileId: string) => api.deleteProfile(profileId),
    onSuccess: () => {
      setProfileFeedback({ kind: 'ok', text: t('config.team.deletedMsg') });
      invalidateConfigCaches();
    },
    onError: (err) => setProfileFeedback({ kind: 'err', text: (err as Error).message }),
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
      setRoutingFeedback({ kind: 'ok', text: t('config.routing.savedMsg') });
      invalidateConfigCaches();
    },
    onError: (err) => setRoutingModalError((err as Error).message),
  });

  const deleteRoutingMutation = useMutation({
    mutationFn: (ruleId: string) => api.deleteRoutingRule(ruleId),
    onSuccess: () => {
      setRoutingFeedback({ kind: 'ok', text: t('config.routing.deletedMsg') });
      invalidateConfigCaches();
    },
    onError: (err) => setRoutingFeedback({ kind: 'err', text: (err as Error).message }),
  });

  const reorderRoutingMutation = useMutation({
    mutationFn: (ruleIds: string[]) => api.reorderRoutingRules(ruleIds),
    onSuccess: (data) => {
      qc.setQueryData(['routing'], data);
      invalidateConfigCaches();
    },
    onError: (err) => setRoutingFeedback({ kind: 'err', text: (err as Error).message }),
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
      fallback: EMPTY_FALLBACK,
      configDir: '',
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

  const copyCommand = async (cmd: string) => {
    try {
      await navigator.clipboard.writeText(cmd);
      setCopiedCmd(cmd);
      setTimeout(() => setCopiedCmd(null), 1800);
    } catch {
      // Clipboard optional in non-secure contexts
    }
  };

  const sandboxProvider = providers[0];
  const extraAccountProfiles = profiles.filter((p) => Boolean(p.configDir));

  return (
    <div className="space-y-6">
      {/* TAB 1: GENERAL */}
      {tab === 'general' && (
        <section className="space-y-5">
          <div
            className="rounded-[8px] border p-5"
            style={{ backgroundColor: 'var(--bg-surface)', borderColor: 'var(--border-subtle)' }}
          >
            <h1 className="text-xl font-semibold tracking-tight">{t('config.general.title')}</h1>
            <p className="mt-1 text-sm" style={{ color: 'var(--text-secondary)' }}>
              {t('config.general.subtitle')}
            </p>
          </div>

          <div
            className="space-y-6 rounded-[8px] border p-5"
            style={{ backgroundColor: 'var(--bg-surface)', borderColor: 'var(--border-subtle)' }}
          >
            {/* Language */}
            <div className="space-y-2">
              <h2 className="text-base font-semibold">{t('config.general.languageTitle')}</h2>
              <p className="text-sm" style={{ color: 'var(--text-secondary)' }}>
                {t('config.general.languageDesc')}
              </p>
              <div className="flex flex-wrap gap-2 pt-1" role="group" aria-label={t('config.general.languageTitle')}>
                <Button
                  type="button"
                  variant={lang === 'id' ? 'default' : 'outline'}
                  aria-pressed={lang === 'id'}
                  onClick={() => setLang('id')}
                >
                  Bahasa Indonesia (ID)
                </Button>
                <Button
                  type="button"
                  variant={lang === 'en' ? 'default' : 'outline'}
                  aria-pressed={lang === 'en'}
                  onClick={() => setLang('en')}
                >
                  English (EN)
                </Button>
              </div>
            </div>

            {/* Theme */}
            <div className="space-y-2 border-t pt-5" style={{ borderColor: 'var(--border-subtle)' }}>
              <h2 className="text-base font-semibold">{t('config.general.themeTitle')}</h2>
              <p className="text-sm" style={{ color: 'var(--text-secondary)' }}>
                {t('config.general.themeDesc')}
              </p>
              <div className="flex flex-wrap gap-2 pt-1" role="group" aria-label={t('config.general.themeTitle')}>
                {(
                  [
                    { id: 'light', label: t('nav.themeLight') },
                    { id: 'dark', label: t('nav.themeDark') },
                    {
                      id: 'system',
                      label: t('config.general.systemCurrent', {
                        resolved:
                          systemTheme === 'dark' ? t('nav.themeDark') : t('nav.themeLight'),
                      }),
                    },
                  ] as Array<{ id: ThemePreference; label: string }>
                ).map((opt) => (
                  <Button
                    key={opt.id}
                    type="button"
                    variant={preference === opt.id ? 'default' : 'outline'}
                    aria-pressed={preference === opt.id}
                    onClick={() => setPreference(opt.id)}
                  >
                    {opt.label}
                  </Button>
                ))}
              </div>
            </div>

            {/* Check for updates */}
            <div className="space-y-2 border-t pt-5" style={{ borderColor: 'var(--border-subtle)' }}>
              <h2 className="text-base font-semibold">{t('config.general.updatesTitle')}</h2>
              <p className="text-sm" style={{ color: 'var(--text-secondary)' }}>
                {t('config.general.updatesDesc')}
              </p>
              <label className="flex min-h-[44px] cursor-pointer items-center gap-3 pt-1 text-sm">
                <input
                  type="checkbox"
                  className="h-4 w-4 accent-[var(--primary)]"
                  checked={checkForUpdates}
                  disabled={updateSettingsMutation.isPending}
                  onChange={(e) =>
                    updateSettingsMutation.mutate({ checkForUpdates: e.target.checked })
                  }
                />
                <span>{t('config.general.updatesToggle')}</span>
              </label>
            </div>

            {/* Reopen wizard */}
            <div className="space-y-2 border-t pt-5" style={{ borderColor: 'var(--border-subtle)' }}>
              <h2 className="text-base font-semibold">{t('config.general.wizardTitle')}</h2>
              <p className="text-sm" style={{ color: 'var(--text-secondary)' }}>
                {t('config.general.wizardDesc')}
              </p>
              <div className="pt-1">
                <Button type="button" variant="outline" onClick={onReopenWizard}>
                  {t('config.general.reopenWizard')}
                </Button>
              </div>
            </div>
          </div>
        </section>
      )}

      {/* TAB 2: AGENTS */}
      {tab === 'agents' && (
        <section className="space-y-5">
          <div
            className="flex flex-wrap items-center justify-between gap-4 rounded-[8px] border p-5"
            style={{ backgroundColor: 'var(--bg-surface)', borderColor: 'var(--border-subtle)' }}
          >
            <div>
              <h1 className="text-xl font-semibold tracking-tight">{t('config.agents.title')}</h1>
              <p className="mt-1 text-sm" style={{ color: 'var(--text-secondary)' }}>
                {t('config.agents.subtitle')}
              </p>
            </div>
            <Button
              type="button"
              onClick={() => refreshMutation.mutate()}
              disabled={refreshMutation.isPending}
            >
              {refreshMutation.isPending ? t('config.agents.checking') : t('config.agents.refresh')}
            </Button>
          </div>

          {providersQuery.isLoading && <LoadingPanel label={t('config.agents.loading')} />}
          {providersQuery.isError && (
            <ErrorPanel
              title={t('config.agents.loadError')}
              detail={providersQuery.error.message}
              onRetry={() => providersQuery.refetch()}
            />
          )}

          {!providersQuery.isLoading && !providersQuery.isError && (
            <div className="grid grid-cols-1 gap-4 xl:grid-cols-3">
              {providers.map((p) => {
                const runtime = providerStates.find((ps) => ps.provider === p.id);
                return (
                  <article
                    key={p.id}
                    className="flex flex-col justify-between rounded-[8px] border p-5"
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
                          {!p.installed
                            ? t('config.agents.statusMissing')
                            : p.loggedIn
                              ? t('config.agents.statusReady')
                              : t('config.agents.statusLogin')}
                        </Badge>
                      </div>

                      <dl className="mt-4 space-y-2 text-sm">
                        <div className="flex justify-between gap-2">
                          <dt style={{ color: 'var(--text-secondary)' }}>{t('config.agents.version')}</dt>
                          <dd className="font-mono-token text-xs">{p.version || 'N/A'}</dd>
                        </div>
                        <div className="flex justify-between gap-2">
                          <dt style={{ color: 'var(--text-secondary)' }}>{t('config.agents.auth')}</dt>
                          <dd className="text-right text-xs">{p.authSummary}</dd>
                        </div>
                        <div className="flex justify-between gap-2">
                          <dt style={{ color: 'var(--text-secondary)' }}>{t('config.agents.sandbox')}</dt>
                          <dd
                            className="text-xs font-semibold"
                            style={{ color: p.sandboxReady ? 'var(--pass)' : 'var(--error)' }}
                          >
                            {p.sandboxReady
                              ? p.sandboxEngine === 'sandbox-exec'
                                ? 'sandbox-exec (macOS)'
                                : 'bwrap (Linux)'
                              : t('config.agents.sandboxUnavailable')}
                          </dd>
                        </div>
                        {runtime && (
                          <div className="flex justify-between gap-2">
                            <dt style={{ color: 'var(--text-secondary)' }}>
                              {t('config.agents.parallelPool')}
                            </dt>
                            <dd className="font-mono-token text-xs font-semibold">
                              {t('work.slotsActive', {
                                active: runtime.activeCount,
                                max: runtime.maxParallel,
                              })}
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
                              : runtime.quotaReason ?? t('common.quotaExhausted')}
                          </span>
                          {runtime.inCooldown && (
                            <Button
                              type="button"
                              variant="outline"
                              disabled={clearCooldownMutation.isPending}
                              onClick={() => clearCooldownMutation.mutate(p.id)}
                            >
                              {t('config.agents.clearCooldown')}
                            </Button>
                          )}
                        </div>
                      )}

                      <div className="mt-4 border-t pt-3" style={{ borderColor: 'var(--border-subtle)' }}>
                        <h3
                          className="text-xs font-semibold uppercase tracking-wide"
                          style={{ color: 'var(--text-secondary)' }}
                        >
                          {t('config.agents.usageWindows')}
                        </h3>
                        {p.usage.available && p.usage.windows.length > 0 ? (
                          <ul className="mt-2 space-y-2">
                            {p.usage.windows.map((w, i) => (
                              <li key={`${w.group}-${w.window}-${i}`} className="text-xs">
                                <div className="flex justify-between gap-2">
                                  <span className="truncate font-medium">{w.label}</span>
                                  <span className="shrink-0 font-mono-token">
                                    {w.remainingPercent !== null
                                      ? `${w.remainingPercent}%`
                                      : w.usedPercent !== null
                                        ? `${w.usedPercent}%`
                                        : 'n/a'}
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
                            {p.usage.error || t('config.agents.quotaUnavailable')}
                          </p>
                        )}
                      </div>
                    </div>

                    {p.models.length > 0 && (
                      <div
                        className="mt-4 border-t pt-3 text-xs"
                        style={{ borderColor: 'var(--border-subtle)', color: 'var(--text-secondary)' }}
                      >
                        {t('config.agents.availableModels', { count: p.models.length })}{' '}
                        <span className="font-mono-token">
                          {p.models
                            .slice(0, 5)
                            .map((m) => m.displayName)
                            .join(', ')}
                        </span>
                      </div>
                    )}
                  </article>
                );
              })}
            </div>
          )}

          {/* Extra accounts summary */}
          <div
            className="rounded-[8px] border p-5"
            style={{ backgroundColor: 'var(--bg-surface)', borderColor: 'var(--border-subtle)' }}
          >
            <h2 className="text-base font-semibold">{t('config.agents.extraAccountsTitle')}</h2>
            <p className="mt-1 text-sm" style={{ color: 'var(--text-secondary)' }}>
              {t('config.agents.extraAccountsDesc')}
            </p>
            {extraAccountProfiles.length === 0 ? (
              <p className="mt-3 text-xs" style={{ color: 'var(--text-secondary)' }}>
                {t('config.agents.noExtraAccounts')}
              </p>
            ) : (
              <ul className="mt-3 space-y-2 text-xs">
                {extraAccountProfiles.map((prof) => (
                  <li
                    key={prof.id}
                    className="flex flex-wrap items-center justify-between gap-2 rounded-[6px] border px-3 py-2"
                    style={{ borderColor: 'var(--border-subtle)', backgroundColor: 'var(--bg-well)' }}
                  >
                    <span className="font-medium">
                      {prof.name} ({prof.provider})
                    </span>
                    <span className="font-mono-token" style={{ color: 'var(--text-secondary)' }}>
                      {configDirEnvHint(prof.provider)}={prof.configDir}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </section>
      )}

      {/* TAB 3: TEAM (Agent Profiles as sungging Wayang cards) */}
      {tab === 'team' && (
        <section className="space-y-5">
          <div
            className="flex flex-wrap items-center justify-between gap-4 rounded-[8px] border p-5"
            style={{ backgroundColor: 'var(--bg-surface)', borderColor: 'var(--border-subtle)' }}
          >
            <div>
              <h1 className="text-xl font-semibold tracking-tight">{t('config.team.title')}</h1>
              <p className="mt-1 text-sm" style={{ color: 'var(--text-secondary)' }}>
                {t('config.team.subtitle')}
              </p>
            </div>
            <Button type="button" onClick={() => openCreateProfileModal()}>
              {t('config.team.newProfile')}
            </Button>
          </div>

          {profileFeedback && (
            <div
              role={profileFeedback.kind === 'err' ? 'alert' : 'status'}
              className="rounded-[6px] border px-3 py-2 text-sm"
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

          {profilesQuery.isLoading && <LoadingPanel label={t('config.team.loading')} />}
          {profilesQuery.isError && (
            <ErrorPanel
              title={t('config.team.loadError')}
              detail={profilesQuery.error.message}
              onRetry={() => profilesQuery.refetch()}
            />
          )}

          {!profilesQuery.isLoading && !profilesQuery.isError && profiles.length === 0 && (
            <EmptyPanel
              title={t('config.team.emptyTitle')}
              description={t('config.team.emptyDesc')}
              action={
                <Button type="button" onClick={() => openCreateProfileModal()}>
                  {t('config.team.newProfile')}
                </Button>
              }
            />
          )}

          {profiles.length > 0 && (
            <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
              {profiles.map((prof) => {
                const cast = characterForProfile(prof.name);
                const fallbackName = describeFallback(prof.fallback, t('common.cliDefault')) ?? t('common.none');
                return (
                  <article
                    key={prof.id}
                    className="flex gap-4 rounded-[8px] border p-4"
                    style={{
                      backgroundColor: 'var(--bg-surface)',
                      borderColor: 'var(--border-subtle)',
                    }}
                  >
                    <div
                      className="flex h-24 w-24 shrink-0 items-center justify-center rounded-[6px] border p-1"
                      style={{
                        backgroundColor: 'var(--bg-well)',
                        borderColor: 'var(--border-subtle)',
                      }}
                    >
                      <WayangFigure character={cast} variant="sungging" size={84} />
                    </div>

                    <div className="min-w-0 flex-1 space-y-2">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <div className="flex flex-wrap items-center gap-1.5">
                          <h2 className="text-base font-semibold">{prof.name}</h2>
                          <Badge>{castDisplayName(cast)}</Badge>
                          {prof.isDefault && <Badge>{t('common.default')}</Badge>}
                          {prof.configDir && (
                            <Badge title={prof.configDir}>{t('config.team.customAccount')}</Badge>
                          )}
                        </div>
                        <Badge style={providerBadgeStyle(prof.provider)}>
                          {providerDisplayShort(prof.provider)}
                        </Badge>
                      </div>

                      <dl
                        className="grid grid-cols-2 gap-x-3 gap-y-1 text-xs"
                        style={{ color: 'var(--text-secondary)' }}
                      >
                        <div>
                          {t('config.team.fieldModel')}:{' '}
                          <span className="font-mono-token text-foreground">
                            {prof.model || t('common.cliDefault')}
                          </span>
                        </div>
                        <div>
                          {t('config.team.fieldEffort')}: <span className="font-mono-token text-foreground">{prof.effort}</span>
                        </div>
                        <div>
                          {t('config.team.fieldFallback')}: <span className="text-foreground">{fallbackName}</span>
                        </div>
                        <div>
                          {t('config.team.limitsLabel')}:{' '}
                          <span className="font-mono-token text-foreground">
                            {prof.maxParallel}x · {prof.maxReviewRounds}r · {Math.round(prof.timeoutMs / 1000)}s
                          </span>
                        </div>
                      </dl>

                      <div className="flex flex-wrap gap-2 pt-1">
                        <Button
                          type="button"
                          variant="outline"
                          onClick={() => openEditProfileModal(prof)}
                        >
                          {t('common.edit')}
                        </Button>
                        <Button
                          type="button"
                          variant="destructive"
                          disabled={deleteProfileMutation.isPending}
                          onClick={() => deleteProfileMutation.mutate(prof.id)}
                        >
                          {t('common.delete')}
                        </Button>
                      </div>
                    </div>
                  </article>
                );
              })}
            </div>
          )}
        </section>
      )}

      {/* TAB 4: TASK ROUTING (Plain sentences + editor behind them) */}
      {tab === 'routing' && (
        <section className="space-y-5">
          <div
            className="flex flex-wrap items-center justify-between gap-4 rounded-[8px] border p-5"
            style={{ backgroundColor: 'var(--bg-surface)', borderColor: 'var(--border-subtle)' }}
          >
            <div>
              <h1 className="text-xl font-semibold tracking-tight">{t('config.routing.title')}</h1>
              <p className="mt-1 text-sm" style={{ color: 'var(--text-secondary)' }}>
                {t('config.routing.subtitle')}
              </p>
            </div>
            <Button
              type="button"
              disabled={profiles.length === 0}
              onClick={openCreateRoutingModal}
            >
              {t('config.routing.newRule')}
            </Button>
          </div>

          {routingFeedback && (
            <div
              role={routingFeedback.kind === 'err' ? 'alert' : 'status'}
              className="rounded-[6px] border px-3 py-2 text-sm"
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

          {routingQuery.isLoading && <LoadingPanel label={t('config.routing.loading')} />}
          {routingQuery.isError && (
            <ErrorPanel
              title={t('config.routing.loadError')}
              detail={routingQuery.error.message}
              onRetry={() => routingQuery.refetch()}
            />
          )}

          {!routingQuery.isLoading && !routingQuery.isError && rules.length === 0 && (
            <EmptyPanel
              title={t('config.routing.emptyTitle')}
              description={t('config.routing.emptyDesc')}
              action={
                profiles.length > 0 ? (
                  <Button type="button" onClick={openCreateRoutingModal}>
                    {t('config.routing.newRule')}
                  </Button>
                ) : undefined
              }
            />
          )}

          {rules.length > 0 && (
            <ol className="space-y-3">
              {rules.map((rule, index) => {
                const primaryProf = profiles.find((p) => p.id === rule.profileId);
                const primaryCast = castDisplayName(characterForProfile(rule.profileName, rule.role, false, rule.complexity));
                const fallbackText = describeFallback(rule.fallback, t('common.cliDefault'));
                const fallbackPart = fallbackText
                  ? t('config.routing.fallbackPart', { fallbackCast: castDisplayName('gatotkaca'), target: fallbackText })
                  : '';
                const sentence = rule.complexity
                  ? t('config.routing.sentence', {
                      complexity: te(rule.complexity).toLowerCase(),
                      role: te(rule.role).toLowerCase(),
                      primaryCast,
                      primaryProfile: rule.profileName,
                      primaryProvider: providerDisplayShort(primaryProf?.provider),
                      fallbackPart,
                    })
                  : t('config.routing.sentenceAny', {
                      role: te(rule.role).toLowerCase(),
                      primaryCast,
                      primaryProfile: rule.profileName,
                      primaryProvider: providerDisplayShort(primaryProf?.provider),
                      fallbackPart,
                    });

                return (
                  <li
                    key={rule.id}
                    className="flex flex-wrap items-center justify-between gap-3 rounded-[8px] border p-4"
                    style={{
                      backgroundColor: 'var(--bg-surface)',
                      borderColor: 'var(--border-subtle)',
                    }}
                  >
                    <div className="min-w-0 flex-1 space-y-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <Badge>#{index + 1}</Badge>
                        {primaryProf && (
                          <Badge style={providerBadgeStyle(primaryProf.provider)}>
                            {providerDisplayShort(primaryProf.provider)}
                          </Badge>
                        )}
                      </div>
                      <p className="text-sm font-medium">{sentence}</p>
                    </div>

                    <div className="flex flex-wrap items-center gap-2">
                      <Button
                        type="button"
                        variant="outline"
                        aria-label={t('config.routing.moveUp', { n: index + 1 })}
                        disabled={index === 0 || reorderRoutingMutation.isPending}
                        onClick={() => moveRule(index, -1)}
                      >
                        {t('common.up')}
                      </Button>
                      <Button
                        type="button"
                        variant="outline"
                        aria-label={t('config.routing.moveDown', { n: index + 1 })}
                        disabled={index === rules.length - 1 || reorderRoutingMutation.isPending}
                        onClick={() => moveRule(index, 1)}
                      >
                        {t('common.down')}
                      </Button>
                      <Button
                        type="button"
                        variant="outline"
                        onClick={() => openEditRoutingModal(rule)}
                      >
                        {t('common.edit')}
                      </Button>
                      <Button
                        type="button"
                        variant="destructive"
                        disabled={deleteRoutingMutation.isPending}
                        onClick={() => deleteRoutingMutation.mutate(rule.id)}
                      >
                        {t('common.delete')}
                      </Button>
                    </div>
                  </li>
                );
              })}
            </ol>
          )}
        </section>
      )}

      {/* TAB 5: SECURITY */}
      {tab === 'security' && (
        <section className="space-y-5">
          <div
            className="rounded-[8px] border p-5"
            style={{ backgroundColor: 'var(--bg-surface)', borderColor: 'var(--border-subtle)' }}
          >
            <h1 className="text-xl font-semibold tracking-tight">{t('config.security.title')}</h1>
            <p className="mt-1 text-sm" style={{ color: 'var(--text-secondary)' }}>
              {t('config.security.subtitle')}
            </p>
          </div>

          <div
            className="space-y-6 rounded-[8px] border p-5"
            style={{ backgroundColor: 'var(--bg-surface)', borderColor: 'var(--border-subtle)' }}
          >
            {/* Sandbox state */}
            <div className="space-y-2">
              <div className="flex flex-wrap items-center gap-2">
                <h2 className="text-base font-semibold">{t('config.security.sandboxTitle')}</h2>
                <Badge
                  style={{
                    color: sandboxProvider?.sandboxReady ? 'var(--pass)' : 'var(--error)',
                    borderColor: sandboxProvider?.sandboxReady ? 'var(--pass)' : 'var(--error)',
                  }}
                >
                  {sandboxProvider?.sandboxReady
                    ? sandboxProvider.sandboxEngine
                    : t('config.agents.sandboxUnavailable')}
                </Badge>
              </div>
              <p className="text-sm" style={{ color: 'var(--text-secondary)' }}>
                {sandboxProvider?.sandboxReady
                  ? t('config.security.sandboxReadyDesc', { engine: sandboxProvider.sandboxEngine })
                  : t('config.security.sandboxMissingDesc')}
              </p>
              {!sandboxProvider?.sandboxReady && (
                <p className="font-mono-token text-xs" style={{ color: 'var(--text-secondary)' }}>
                  {t('config.security.sandboxLinuxFix')}
                </p>
              )}
            </div>

            {/* Antigravity keyring */}
            <div className="space-y-2 border-t pt-5" style={{ borderColor: 'var(--border-subtle)' }}>
              <h2 className="text-base font-semibold">{t('config.security.agyTitle')}</h2>
              <p className="text-sm" style={{ color: 'var(--text-secondary)' }}>
                {t('config.security.agyDesc')}
              </p>
              <label className="flex min-h-[44px] cursor-pointer items-center gap-3 pt-1 text-sm font-medium">
                <input
                  id="security-agy-keyring"
                  type="checkbox"
                  className="h-4 w-4 accent-[var(--primary)]"
                  checked={keyringAccess}
                  disabled={updateSettingsMutation.isPending}
                  onChange={(e) =>
                    updateSettingsMutation.mutate({ antigravityKeyringAccess: e.target.checked })
                  }
                />
                <span>{t('config.security.agyToggle')}</span>
              </label>
            </div>

            {/* Unconfined policy */}
            <div className="space-y-2 border-t pt-5" style={{ borderColor: 'var(--border-subtle)' }}>
              <h2 className="text-base font-semibold">{t('config.security.unconfinedTitle')}</h2>
              <p className="text-sm" style={{ color: 'var(--text-secondary)' }}>
                {t('config.security.unconfinedDesc')}
              </p>
            </div>
          </div>
        </section>
      )}

      {/* TAB 6: ABOUT */}
      {tab === 'about' && (
        <section className="space-y-5">
          <div
            className="flex flex-wrap items-center gap-5 rounded-[8px] border p-5"
            style={{ backgroundColor: 'var(--bg-surface)', borderColor: 'var(--border-subtle)' }}
          >
            <GununganDetailed size={108} label={t('common.gunungan')} />
            <div className="min-w-0 flex-1 space-y-1">
              <div className="flex flex-wrap items-center gap-2">
                <h1 className="text-xl font-semibold tracking-tight">{t('config.about.title')}</h1>
                <Badge>v{updateStatus?.currentVersion ?? DALANG_VERSION}</Badge>
              </div>
              <p className="text-sm" style={{ color: 'var(--text-secondary)' }}>
                {t('config.about.subtitle')}
              </p>
            </div>
          </div>

          {/* Version & update status */}
          <div
            className="space-y-4 rounded-[8px] border p-5"
            style={{ backgroundColor: 'var(--bg-surface)', borderColor: 'var(--border-subtle)' }}
          >
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <h2 className="text-base font-semibold">{t('config.about.versionTitle')}</h2>
                <p className="mt-0.5 text-sm" style={{ color: 'var(--text-secondary)' }}>
                  {t('config.about.installedVersion', {
                    version: updateStatus?.currentVersion ?? DALANG_VERSION,
                  })}
                </p>
              </div>
              {checkForUpdates && (
                <Button
                  type="button"
                  variant="outline"
                  disabled={forceUpdateCheckMutation.isPending}
                  onClick={() => forceUpdateCheckMutation.mutate()}
                >
                  {forceUpdateCheckMutation.isPending
                    ? t('config.about.checking')
                    : t('config.about.checkNow')}
                </Button>
              )}
            </div>

            {!checkForUpdates ? (
              <p className="text-sm" style={{ color: 'var(--text-secondary)' }}>
                {t('config.about.updateDisabled')}
              </p>
            ) : updateStatus?.updateAvailable && updateStatus.latestVersion ? (
              <div
                className="space-y-3 rounded-[6px] border p-4"
                style={{
                  backgroundColor: 'var(--accent-tint)',
                  borderColor: 'var(--accent)',
                }}
              >
                <p className="text-sm font-semibold" style={{ color: 'var(--accent)' }}>
                  {t('config.about.updateAvailableTitle', { version: updateStatus.latestVersion })}
                </p>
                <p className="text-sm">{t('config.about.updateInstructions')}</p>
                <div className="space-y-2">
                  {['npx dalang-cli@latest', 'npm install -g dalang-cli@latest'].map((cmd) => (
                    <div
                      key={cmd}
                      className="flex flex-wrap items-center justify-between gap-2 rounded-[6px] border px-3 py-2"
                      style={{
                        backgroundColor: 'var(--bg-surface)',
                        borderColor: 'var(--border-subtle)',
                      }}
                    >
                      <code className="font-mono-token text-xs">{cmd}</code>
                      <Button
                        type="button"
                        variant="outline"
                        onClick={() => copyCommand(cmd)}
                      >
                        {copiedCmd === cmd ? t('common.copied') : t('common.copy')}
                      </Button>
                    </div>
                  ))}
                </div>
                <div>
                  <a
                    href={updateStatus.releaseNotesUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex min-h-[44px] items-center text-sm font-medium underline underline-offset-2"
                    style={{ color: 'var(--accent)' }}
                  >
                    {t('config.about.releaseNotes')}
                  </a>
                </div>
              </div>
            ) : (
              <p className="text-sm" style={{ color: 'var(--pass)' }}>
                {t('config.about.upToDate')}
              </p>
            )}
          </div>

          {/* Reopen wizard */}
          <div
            className="flex flex-wrap items-center justify-between gap-4 rounded-[8px] border p-5"
            style={{ backgroundColor: 'var(--bg-surface)', borderColor: 'var(--border-subtle)' }}
          >
            <div>
              <h2 className="text-base font-semibold">{t('config.about.wizardTitle')}</h2>
              <p className="mt-1 text-sm" style={{ color: 'var(--text-secondary)' }}>
                {t('config.about.wizardDesc')}
              </p>
            </div>
            <Button type="button" variant="outline" onClick={onReopenWizard}>
              {t('config.general.reopenWizard')}
            </Button>
          </div>

          {/* Licences & artwork credits */}
          <div
            className="space-y-2 rounded-[8px] border p-5"
            style={{ backgroundColor: 'var(--bg-surface)', borderColor: 'var(--border-subtle)' }}
          >
            <h2 className="text-base font-semibold">{t('config.about.licenceTitle')}</h2>
            <p className="text-sm">{t('config.about.codeLicence')}</p>
            <p className="text-sm" style={{ color: 'var(--text-secondary)' }}>
              {t('config.about.artLicence')}
            </p>
          </div>

          {/* Docs links */}
          <div
            className="space-y-2 rounded-[8px] border p-5"
            style={{ backgroundColor: 'var(--bg-surface)', borderColor: 'var(--border-subtle)' }}
          >
            <h2 className="text-base font-semibold">{t('config.about.docsTitle')}</h2>
            <ul className="flex flex-wrap gap-3 text-sm">
              {[
                { label: t('config.about.docInstall'), href: 'https://github.com/azmifauzan/dalang/blob/main/docs/INSTALL.md' },
                { label: t('config.about.docProviders'), href: 'https://github.com/azmifauzan/dalang/blob/main/docs/PROVIDERS.md' },
                { label: t('config.about.docSandbox'), href: 'https://github.com/azmifauzan/dalang/blob/main/docs/SANDBOX.md' },
                { label: t('config.about.docTroubleshooting'), href: 'https://github.com/azmifauzan/dalang/blob/main/docs/TROUBLESHOOTING.md' },
              ].map((doc) => (
                <li key={doc.href}>
                  <a
                    href={doc.href}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex min-h-[44px] items-center rounded-[6px] border px-3 underline-offset-2 hover:underline"
                    style={{ borderColor: 'var(--border-subtle)', color: 'var(--accent)' }}
                  >
                    {doc.label}
                  </a>
                </li>
              ))}
            </ul>
          </div>
        </section>
      )}

      {/* Profile Editor Modal (all v0.5 model/variant/effort/configDir features preserved) */}
      <ModalDialog
        open={profileModalOpen}
        title={
          profileForm.id
            ? t('config.team.modalEditTitle', { name: profileForm.name })
            : t('config.team.modalNewTitle')
        }
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
              className="rounded-[6px] border px-3 py-2 text-sm"
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
              <Label htmlFor="prof-name">{t('config.team.fieldName')}</Label>
              <Input
                id="prof-name"
                required
                value={profileForm.name}
                onChange={(e) => setProfileForm((f) => ({ ...f, name: e.target.value }))}
                placeholder={t('config.team.namePlaceholder')}
              />
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="prof-provider">{t('config.team.fieldProvider')}</Label>
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
              <Label htmlFor="prof-model">{t('config.team.fieldModel')}</Label>
              <NativeSelect
                id="prof-model"
                value={modelSelectValue}
                onChange={(e) => changeModel(e.target.value)}
              >
                <option value="">{t('common.cliDefault')}</option>
                {savedModelUnavailable && (
                  <option value={modelSelectValue}>{profileForm.model} (unavailable)</option>
                )}
                {providerModels.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.displayName}
                  </option>
                ))}
              </NativeSelect>
              {savedModelUnavailable && (
                <p className="text-xs" style={{ color: 'var(--error)' }}>
                  {t('config.team.modelUnavailable', { model: profileForm.model })}
                </p>
              )}
              {selectedModelInfo?.description && (
                <p className="text-xs" style={{ color: 'var(--text-secondary)' }}>
                  {selectedModelInfo.description}
                </p>
              )}
              {selectedModelInfo && selectedModelInfo.variants.length > 0 && (
                <div className="space-y-1 pt-1">
                  {selectedModelInfo.variants.map((variant) => (
                    <label
                      key={variant.id}
                      className="flex min-h-11 cursor-pointer items-center gap-2 text-xs"
                    >
                      <input
                        type="checkbox"
                        className="h-4 w-4 accent-[var(--primary)]"
                        checked={activeVariantValue === variant.value}
                        onChange={(e) => toggleVariant(variant.value, e.target.checked)}
                      />
                      <span>
                        {t('config.team.useVariant', { label: variant.label })}{' '}
                        <span className="font-mono-token" style={{ color: 'var(--text-secondary)' }}>
                          ({variant.value})
                        </span>
                      </span>
                    </label>
                  ))}
                </div>
              )}
            </div>

            <div className="space-y-1.5 md:col-span-2">
              <div className="text-sm font-medium">{t('config.team.fieldFallback')}</div>
              <FallbackFields
                idPrefix="prof-fallback"
                value={profileForm.fallback}
                onChange={(fallback) => setProfileForm((f) => ({ ...f, fallback }))}
                providers={providers}
              />
              <p className="text-xs" style={{ color: 'var(--text-secondary)' }}>
                {t('config.team.fallbackHint')}
              </p>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="prof-effort">{t('config.team.fieldEffort')}</Label>
              <NativeSelect
                id="prof-effort"
                disabled={effortLocked}
                value={
                  effortChoices.includes(profileForm.effort)
                    ? profileForm.effort
                    : effortChoices[0] ?? profileForm.effort
                }
                onChange={(e) => changeEffort(e.target.value as EffortLevel)}
              >
                {(effortChoices.length > 0 ? effortChoices : EFFORT_OPTIONS).map((eff) => (
                  <option key={eff} value={eff}>
                    {eff}
                    {selectedModelInfo?.defaultEffort === eff ? ` (${t('common.default').toLowerCase()})` : ''}
                  </option>
                ))}
              </NativeSelect>
              {effortLocked && (
                <p className="text-xs" style={{ color: 'var(--text-secondary)' }}>
                  {t('config.team.effortLocked')}
                </p>
              )}
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="prof-config-dir">{t('config.team.fieldConfigDir')}</Label>
              <Input
                id="prof-config-dir"
                value={profileForm.configDir}
                onChange={(e) => setProfileForm((f) => ({ ...f, configDir: e.target.value }))}
                placeholder={t('config.team.configDirPlaceholder')}
              />
              <p className="text-xs" style={{ color: 'var(--text-secondary)' }}>
                {configDirEnvHint(profileForm.provider)}. {t('config.team.configDirSuffix')}
              </p>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="prof-permission">{t('config.team.fieldPermission')}</Label>
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
              <Label htmlFor="prof-rounds">{t('config.team.fieldRounds')}</Label>
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
              <Label htmlFor="prof-parallel">{t('config.team.fieldParallel')}</Label>
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
              <Label htmlFor="prof-timeout">{t('config.team.fieldTimeout')}</Label>
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
              <Label htmlFor="prof-idle-timeout">{t('config.team.fieldIdleTimeout')}</Label>
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
            <Label htmlFor="prof-role-prompt">{t('config.team.fieldRolePrompt')}</Label>
            <Textarea
              id="prof-role-prompt"
              value={profileForm.rolePrompt}
              onChange={(e) => setProfileForm((f) => ({ ...f, rolePrompt: e.target.value }))}
              placeholder={t('config.team.rolePromptPlaceholder')}
            />
          </div>

          {profileForm.provider === 'antigravity' && (
            <div className="space-y-2 rounded-[6px] border border-border p-3">
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
                <Label htmlFor="prof-agy-keyring" className="text-sm leading-snug font-normal">
                  {t('config.security.agyToggle')}
                </Label>
              </div>
              <p className="text-xs" style={{ color: 'var(--text-secondary)' }}>
                {t('wizard.step2.agyKeyringRisk')}
              </p>
            </div>
          )}

          <div className="flex flex-wrap justify-end gap-2 pt-2">
            <Button type="button" variant="outline" onClick={() => setProfileModalOpen(false)}>
              {t('common.cancel')}
            </Button>
            <Button type="submit" disabled={saveProfileMutation.isPending}>
              {saveProfileMutation.isPending ? t('common.saving') : t('config.team.saveProfile')}
            </Button>
          </div>
        </form>
      </ModalDialog>

      {/* Routing Rule Editor Modal */}
      <ModalDialog
        open={routingModalOpen}
        title={routingForm.id ? t('config.routing.modalEdit') : t('config.routing.modalNew')}
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
              className="rounded-[6px] border px-3 py-2 text-sm"
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
              <Label htmlFor="route-role">{t('config.routing.fieldRole')}</Label>
              <NativeSelect
                id="route-role"
                value={routingForm.role}
                onChange={(e) => setRoutingForm((f) => ({ ...f, role: e.target.value as TaskRole }))}
              >
                {ROLE_OPTIONS.map((r) => (
                  <option key={r} value={r}>
                    {te(r)}
                  </option>
                ))}
              </NativeSelect>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="route-complexity">{t('config.routing.fieldComplexity')}</Label>
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
                <option value="">{t('config.routing.anyComplexity')}</option>
                {COMPLEXITY_OPTIONS.map((c) => (
                  <option key={c} value={c}>
                    {te(c)}
                  </option>
                ))}
              </NativeSelect>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="route-primary">{t('config.routing.fieldPrimary')}</Label>
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

            <div className="space-y-1.5 md:col-span-2">
              <div className="text-sm font-medium">{t('config.routing.fieldFallback')}</div>
              <FallbackFields
                idPrefix="route-fallback"
                value={routingForm.fallback}
                onChange={(fallback) => setRoutingForm((f) => ({ ...f, fallback }))}
                providers={providers}
              />
            </div>
          </div>

          <div className="flex flex-wrap justify-end gap-2 pt-2">
            <Button type="button" variant="outline" onClick={() => setRoutingModalOpen(false)}>
              {t('common.cancel')}
            </Button>
            <Button type="submit" disabled={saveRoutingMutation.isPending}>
              {saveRoutingMutation.isPending ? t('common.saving') : t('config.routing.saveRule')}
            </Button>
          </div>
        </form>
      </ModalDialog>
    </div>
  );
}
