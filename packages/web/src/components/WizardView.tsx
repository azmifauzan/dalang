import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  EFFORT_LEVEL_ORDER,
  type AgentProfileDTO,
  type EffortLevel,
  type FallbackTarget,
  type ProjectSummary,
  type ProviderId,
  type ProviderStatus,
} from '@dalang/shared';
import { GununganDetailed } from '../assets/wayang/Gunungan.js';
import { WayangFigure, type WayangCharacterId } from '../assets/wayang/WayangFigure.js';
import { useI18n } from '../i18n/index.js';
import { providerBadgeStyle, providerDisplayShort } from '../lib/activity.js';
import { api } from '../lib/api.js';
import { modelLabel } from '../lib/modelLabel.js';
import { ErrorPanel, LoadingPanel } from './StateViews.js';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { NativeSelect } from '@/components/ui/native-select';
import { Textarea } from '@/components/ui/textarea';

function fixCommandForProvider(p: ProviderStatus): string {
  if (p.id === 'claude-code') {
    return p.installed ? 'claude auth login' : 'npm install -g @anthropic-ai/claude-code';
  }
  if (p.id === 'codex') {
    return p.installed ? 'codex login' : 'npm install -g @openai/codex';
  }
  return p.installed ? 'agy' : 'https://antigravity.google/cli';
}

type RoleKey = 'lead' | 'coderLight' | 'coderMedium' | 'coderHeavy' | 'qa' | 'reviewer';

/** Seeded profile that carries each role. The wizard edits these profiles in place. */
const ROLE_PROFILE_NAME: Record<RoleKey, string> = {
  lead: 'lead',
  coderLight: 'coder-small',
  coderMedium: 'coder-medium',
  coderHeavy: 'coder-heavy',
  qa: 'qa',
  reviewer: 'reviewer',
};
const PROVIDER_ORDER: ProviderId[] = ['claude-code', 'codex', 'antigravity'];

export function WizardView({
  onSkip,
  onCompleteProject,
}: {
  onSkip: () => void;
  onCompleteProject: (project: ProjectSummary, initialGoal: string) => void;
}) {
  const qc = useQueryClient();
  const { t } = useI18n();
  const [step, setStep] = useState<1 | 2 | 3 | 4>(1);
  const [userPaused, setUserPaused] = useState(false);
  const [tabHidden, setTabHidden] = useState(() =>
    typeof document !== 'undefined' ? document.visibilityState === 'hidden' : false,
  );
  const [copiedCmd, setCopiedCmd] = useState<string | null>(null);

  // Step 4 project form
  const [mode, setMode] = useState<'create' | 'open'>('create');
  const [repoPath, setRepoPath] = useState('');
  const [projectName, setProjectName] = useState('');
  const [stackHint, setStackHint] = useState('');
  const [initGitIfMissing, setInitGitIfMissing] = useState(true);
  const [goal, setGoal] = useState('');

  useEffect(() => {
    const onVis = () => setTabHidden(document.visibilityState === 'hidden');
    document.addEventListener('visibilitychange', onVis);
    return () => document.removeEventListener('visibilitychange', onVis);
  }, []);

  const providersQuery = useQuery({
    queryKey: ['providers-status'],
    queryFn: () => api.getProvidersStatus(),
  });
  const settingsQuery = useQuery({
    queryKey: ['settings'],
    queryFn: () => api.getSettings(),
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
    onSuccess: (data) => qc.setQueryData(['providers-status'], data),
  });

  const keyringMutation = useMutation({
    mutationFn: (enabled: boolean) => api.updateSettings({ antigravityKeyringAccess: enabled }),
    onSuccess: (data) => qc.setQueryData(['settings'], data),
  });

  const restoreRoleMutation = useMutation({
    mutationFn: async (key: RoleKey) => {
      const fallbackCli = PROVIDER_ORDER.find((id) => usableIds.has(id)) ?? 'claude-code';
      const defaultEffort: EffortLevel =
        key === 'coderLight' ? 'low' : key === 'coderMedium' ? 'medium' : 'high';
      const created = await api.createProfile({
        name: ROLE_PROFILE_NAME[key],
        provider: fallbackCli,
        model: '',
        effort: defaultEffort,
        rolePrompt: '',
        permissionMode: key === 'reviewer' ? 'read-only' : 'workspace-write',
        timeoutMs: key === 'reviewer' || key === 'qa' ? 1_200_000 : 1_800_000,
        idleTimeoutMs: 180_000,
        maxParallel: key === 'coderLight' ? 2 : 1,
        maxReviewRounds: 2,
        fallback: null,
        configDir: null,
      });
      return created.profile;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['profiles'] });
      qc.invalidateQueries({ queryKey: ['routing'] });
    },
  });

  const providers = providersQuery.data?.providers ?? [];
  const profiles = profilesQuery.data?.profiles ?? [];
  const rules = routingQuery.data?.rules ?? [];
  const keyringAccess = settingsQuery.data?.settings.antigravityKeyringAccess ?? false;

  const usableAgentsCount = providers.filter(
    (p) => p.installed && p.loggedIn && (p.id !== 'antigravity' || keyringAccess),
  ).length;

  const usableIds = useMemo(
    () =>
      new Set(
        providers
          .filter((p) => p.installed && p.loggedIn && (p.id !== 'antigravity' || keyringAccess))
          .map((p) => p.id),
      ),
    [providers, keyringAccess],
  );

  const roleProfiles = useMemo(() => {
    const byName = (name: string) => profiles.find((p) => p.name === name) ?? null;
    return {
      lead: byName(ROLE_PROFILE_NAME.lead),
      coderLight: byName(ROLE_PROFILE_NAME.coderLight),
      coderMedium: byName(ROLE_PROFILE_NAME.coderMedium),
      coderHeavy: byName(ROLE_PROFILE_NAME.coderHeavy),
      qa: byName(ROLE_PROFILE_NAME.qa),
      reviewer: byName(ROLE_PROFILE_NAME.reviewer),
    } satisfies Record<RoleKey, AgentProfileDTO | null>;
  }, [profiles]);

  // Provider, model, effort, and optional fallback chosen per role profile; saved only when the team is accepted.
  const [edits, setEdits] = useState<
    Record<string, { provider?: ProviderId; model?: string; effort?: EffortLevel }>
  >({});
  const [fallbackEdits, setFallbackEdits] = useState<Record<string, ProviderId | ''>>({});

  const modelsOf = (provider: ProviderId) => providers.find((p) => p.id === provider)?.models ?? [];
  const effortsFor = (provider: ProviderId, model: string): readonly EffortLevel[] => {
    const info = modelsOf(provider).find((m) => m.value === model);
    return info && info.supportedEffortLevels.length > 0 ? info.supportedEffortLevels : EFFORT_LEVEL_ORDER;
  };
  /** Effective provider, model, and effort for a role profile, falling back to a ready provider. */
  const valueOf = (prof: AgentProfileDTO) => {
    const e = edits[prof.id] ?? {};
    const readyFallback = PROVIDER_ORDER.find((id) => usableIds.has(id)) ?? prof.provider;
    const provider = e.provider ?? (usableIds.has(prof.provider) ? prof.provider : readyFallback);
    const model = e.model ?? (provider === prof.provider ? prof.model : '');
    const allowed = effortsFor(provider, model);
    const wanted = e.effort ?? prof.effort;
    const effort = allowed.includes(wanted) ? wanted : (allowed[0] as EffortLevel);
    return { provider, model, effort };
  };

  /** Effective fallback CLI for a role profile (from user edit, profile/rule default, or another ready CLI). */
  const fallbackProviderOf = (prof: AgentProfileDTO, primaryProvider: ProviderId): ProviderId | '' => {
    if (prof.id in fallbackEdits) {
      return fallbackEdits[prof.id];
    }
    const existingRule = rules.find((r) => r.profileId === prof.id && r.fallback !== null)?.fallback ?? null;
    const seedTarget = prof.fallback ?? existingRule;
    if (seedTarget && usableIds.has(seedTarget.provider) && seedTarget.provider !== primaryProvider) {
      return seedTarget.provider;
    }
    return PROVIDER_ORDER.find((id) => usableIds.has(id) && id !== primaryProvider) ?? '';
  };

  const toFallbackTarget = (provider: ProviderId | ''): FallbackTarget | null =>
    provider ? { provider, model: '', effort: 'high', configDir: null } : null;

  const roleKeys = ['lead', 'coderLight', 'coderMedium', 'coderHeavy', 'qa', 'reviewer'] as const;
  const crossProvider =
    Boolean(roleProfiles.reviewer) &&
    [roleProfiles.coderLight, roleProfiles.coderMedium, roleProfiles.coderHeavy].some((p) =>
      Boolean(p && valueOf(p).provider !== valueOf(roleProfiles.reviewer!).provider),
    );
  const leadProvider: ProviderId = roleProfiles.lead
    ? valueOf(roleProfiles.lead).provider
    : (PROVIDER_ORDER.find((id) => usableIds.has(id)) ?? 'claude-code');

  const applyTeamMutation = useMutation({
    mutationFn: async () => {
      const targetByProfileId = new Map<string, FallbackTarget | null>();
      for (const key of roleKeys) {
        const prof = roleProfiles[key];
        if (!prof) continue;
        const v = valueOf(prof);
        const fbTarget = toFallbackTarget(fallbackProviderOf(prof, v.provider));
        targetByProfileId.set(prof.id, fbTarget);
        if (
          v.provider !== prof.provider ||
          v.model !== prof.model ||
          v.effort !== prof.effort ||
          JSON.stringify(fbTarget) !== JSON.stringify(prof.fallback)
        ) {
          await api.updateProfile(prof.id, { ...v, fallback: fbTarget });
        }
      }
      // Keep seeded routing rules aligned with each role's profile and fallback provider.
      for (const rule of rules) {
        let nextPrimary = rule.profileId;
        if (rule.role === 'lead' && roleProfiles.lead) {
          nextPrimary = roleProfiles.lead.id;
        } else if (rule.role === 'engineer') {
          const primary =
            rule.complexity === 'low'
              ? roleProfiles.coderLight
              : rule.complexity === 'medium'
                ? (roleProfiles.coderMedium ?? roleProfiles.coderHeavy)
                : roleProfiles.coderHeavy;
          if (primary) nextPrimary = primary.id;
        } else if (rule.role === 'qa') {
          const primary = roleProfiles.qa ?? roleProfiles.reviewer;
          if (primary) nextPrimary = primary.id;
        } else if (rule.role === 'reviewer' && roleProfiles.reviewer) {
          nextPrimary = roleProfiles.reviewer.id;
        }
        const nextFallback = targetByProfileId.has(nextPrimary)
          ? targetByProfileId.get(nextPrimary)!
          : rule.fallback;
        if (
          nextPrimary !== rule.profileId ||
          JSON.stringify(nextFallback) !== JSON.stringify(rule.fallback)
        ) {
          await api.updateRoutingRule(rule.id, { profileId: nextPrimary, fallback: nextFallback });
        }
      }
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['routing'] });
      qc.invalidateQueries({ queryKey: ['profiles'] });
      setStep(4);
    },
  });

  const createProjectMutation = useMutation({
    mutationFn: () =>
      api.createOrOpenProject({
        mode,
        name: projectName.trim() || undefined,
        path: repoPath.trim(),
        stackHint: mode === 'create' ? stackHint.trim() || undefined : undefined,
        initGitIfMissing: mode === 'open' ? initGitIfMissing : false,
        leadProvider,
      }),
    onSuccess: ({ project }) => {
      qc.invalidateQueries({ queryKey: ['projects'] });
      onCompleteProject(project, goal.trim());
    },
  });

  const copyText = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopiedCmd(text);
      setTimeout(() => setCopiedCmd(null), 1600);
    } catch {
      // ignore
    }
  };

  const handleProjectSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (!repoPath.trim()) return;
    createProjectMutation.mutate();
  };

  const animationPaused = userPaused || tabHidden;

  const castIntro: Array<{ id: WayangCharacterId; name: string; role: string }> = [
    { id: 'semar', name: t('wizard.cast.semar'), role: t('wizard.cast.semarRole') },
    { id: 'bima', name: t('wizard.cast.bima'), role: t('wizard.cast.bimaRole') },
    { id: 'gatotkaca', name: t('wizard.cast.gatotkaca'), role: t('wizard.cast.gatotkacaRole') },
    { id: 'kresna', name: t('wizard.cast.kresna'), role: t('wizard.cast.kresnaRole') },
    { id: 'srikandi', name: t('wizard.cast.srikandi'), role: t('wizard.cast.srikandiRole') },
    { id: 'arjuna', name: t('wizard.cast.arjuna'), role: t('wizard.cast.arjunaRole') },
  ];

  return (
    <div className="mx-auto max-w-4xl space-y-6 py-2">
      {/* Progress bar & header */}
      <div
        className="space-y-3 rounded-[8px] border p-5"
        style={{ backgroundColor: 'var(--bg-surface)', borderColor: 'var(--border-subtle)' }}
      >
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <p className="font-mono-token text-xs font-semibold uppercase" style={{ color: 'var(--accent)' }}>
              {t('wizard.stepCounter', { current: step, total: 4 })}
            </p>
            <h1 className="text-xl font-semibold tracking-tight">{t('wizard.title')}</h1>
          </div>
          <Button type="button" variant="outline" onClick={onSkip}>
            {t('wizard.skip')}
          </Button>
        </div>

        {/* 4-segment progress bar */}
        <div className="grid grid-cols-4 gap-2" aria-hidden="true">
          {[1, 2, 3, 4].map((idx) => (
            <div
              key={idx}
              className="h-2 rounded-[4px]"
              style={{
                backgroundColor: idx <= step ? 'var(--accent)' : 'var(--bg-well)',
              }}
            />
          ))}
        </div>
      </div>

      {/* SCREEN 1: HOW DALANG WORKS */}
      {step === 1 && (
        <section
          className="space-y-6 rounded-[8px] border p-6"
          style={{ backgroundColor: 'var(--bg-surface)', borderColor: 'var(--border-subtle)' }}
        >
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div className="max-w-2xl space-y-1">
              <h2 className="text-lg font-semibold">{t('wizard.step1.title')}</h2>
              <p className="text-sm" style={{ color: 'var(--text-secondary)' }}>
                {t('wizard.step1.subtitle')}
              </p>
            </div>
            <Button
              type="button"
              variant="outline"
              onClick={() => setUserPaused((p) => !p)}
            >
              {userPaused ? t('common.playAnimation') : t('common.pauseAnimation')}
            </Button>
          </div>

          {/* Animated wayang cast stage */}
          <div
            className="rounded-[8px] border p-5"
            style={{ backgroundColor: 'var(--bg-well)', borderColor: 'var(--border-subtle)' }}
          >
            <div className="grid grid-cols-2 items-end gap-3 sm:grid-cols-4 lg:grid-cols-7">
              <div className="col-span-2 flex flex-col items-center sm:col-span-1">
                <GununganDetailed size={108} label={t('common.gunungan')} />
              </div>
              {castIntro.map((c) => (
                <div key={c.id} className="flex flex-col items-center text-center">
                  <WayangFigure
                    character={c.id}
                    variant="sungging"
                    animated={true}
                    paused={animationPaused}
                    size={96}
                    label={`${c.name} (${c.role})`}
                  />
                  <span className="mt-1 text-sm font-semibold">{c.name}</span>
                  <span className="text-xs" style={{ color: 'var(--text-secondary)' }}>
                    {c.role}
                  </span>
                </div>
              ))}
            </div>
          </div>

          {/* 3 clear gates */}
          <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
            {[
              { title: t('wizard.step1.flow1Title'), desc: t('wizard.step1.flow1Desc') },
              { title: t('wizard.step1.flow2Title'), desc: t('wizard.step1.flow2Desc') },
              { title: t('wizard.step1.flow3Title'), desc: t('wizard.step1.flow3Desc') },
            ].map((item) => (
              <div
                key={item.title}
                className="rounded-[6px] border p-4"
                style={{ borderColor: 'var(--border-subtle)', backgroundColor: 'var(--bg-canvas)' }}
              >
                <h3 className="text-sm font-semibold">{item.title}</h3>
                <p className="mt-1 text-xs" style={{ color: 'var(--text-secondary)' }}>
                  {item.desc}
                </p>
              </div>
            ))}
          </div>

          <div className="flex justify-end">
            <Button type="button" onClick={() => setStep(2)}>
              {t('common.next')}
            </Button>
          </div>
        </section>
      )}

      {/* SCREEN 2: AGENTS */}
      {step === 2 && (
        <section
          className="space-y-5 rounded-[8px] border p-6"
          style={{ backgroundColor: 'var(--bg-surface)', borderColor: 'var(--border-subtle)' }}
        >
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div>
              <h2 className="text-lg font-semibold">{t('wizard.step2.title')}</h2>
              <p className="mt-1 text-sm" style={{ color: 'var(--text-secondary)' }}>
                {t('wizard.step2.subtitle')}
              </p>
            </div>
            <Button
              type="button"
              variant="outline"
              disabled={refreshMutation.isPending}
              onClick={() => refreshMutation.mutate()}
            >
              {refreshMutation.isPending ? t('wizard.step2.checking') : t('wizard.step2.refresh')}
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
            <div className="space-y-4">
              {providers.length > 0 && (
                <div
                  className="rounded-[6px] border px-4 py-3 text-sm"
                  style={{
                    borderColor: providers[0].sandboxReady ? 'var(--pass)' : 'var(--error)',
                    backgroundColor: providers[0].sandboxReady ? 'var(--pass-tint)' : 'var(--error-tint)',
                    color: providers[0].sandboxReady ? 'var(--pass)' : 'var(--error)',
                  }}
                >
                  {providers[0].sandboxReady
                    ? t('wizard.step2.sandboxReady', { engine: providers[0].sandboxEngine })
                    : t('wizard.step2.sandboxMissing')}
                </div>
              )}

              <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
                {providers.map((p) => {
                  const ready = p.installed && p.loggedIn;
                  const fixCmd = fixCommandForProvider(p);
                  return (
                    <article
                      key={p.id}
                      className="flex flex-col justify-between gap-3 rounded-[6px] border p-4"
                      style={{
                        borderColor: ready ? 'var(--pass)' : 'var(--border-subtle)',
                        backgroundColor: 'var(--bg-canvas)',
                      }}
                    >
                      <div className="space-y-2">
                        <div className="flex items-center justify-between gap-2">
                          <h3 className="text-sm font-semibold">{p.displayName}</h3>
                          <Badge
                            style={{
                              color: ready ? 'var(--pass)' : 'var(--error)',
                              borderColor: ready ? 'var(--pass)' : 'var(--error)',
                            }}
                          >
                            {!p.installed
                              ? t('config.agents.statusMissing')
                              : p.loggedIn
                                ? t('config.agents.statusReady')
                                : t('config.agents.statusLogin')}
                          </Badge>
                        </div>
                        <p className="font-mono-token text-xs" style={{ color: 'var(--text-secondary)' }}>
                          {p.version || p.binary} · {t('wizard.step2.modelsCount', { count: p.models.length })}
                        </p>
                        <p className="text-xs" style={{ color: 'var(--text-secondary)' }}>
                          {p.authSummary}
                        </p>
                      </div>

                      {!ready && (
                        <div className="space-y-1.5 border-t pt-2.5" style={{ borderColor: 'var(--border-subtle)' }}>
                          <span className="text-[11px] font-medium" style={{ color: 'var(--text-secondary)' }}>
                            {t('wizard.step2.fixCommand')}:
                          </span>
                          <div className="flex items-center justify-between gap-2 rounded-[4px] border px-2 py-1.5" style={{ borderColor: 'var(--border-subtle)', backgroundColor: 'var(--bg-surface)' }}>
                            <code className="truncate font-mono-token text-xs">{fixCmd}</code>
                            <Button type="button" variant="outline" onClick={() => copyText(fixCmd)}>
                              {copiedCmd === fixCmd ? t('common.copied') : t('common.copy')}
                            </Button>
                          </div>
                        </div>
                      )}
                    </article>
                  );
                })}
              </div>

              {/* Antigravity keyring permission with plain risk explanation */}
              {providers.some((p) => p.id === 'antigravity' && p.installed) && (
                <div
                  className="rounded-[6px] border p-4"
                  style={{ borderColor: 'var(--border-subtle)', backgroundColor: 'var(--bg-well)' }}
                >
                  <label className="flex min-h-[44px] cursor-pointer items-start gap-3 text-sm font-medium">
                    <input
                      type="checkbox"
                      className="mt-1 h-4 w-4 accent-[var(--primary)]"
                      checked={keyringAccess}
                      disabled={keyringMutation.isPending}
                      onChange={(e) => keyringMutation.mutate(e.target.checked)}
                    />
                    <span>
                      {t('wizard.step2.agyKeyringTitle')}
                      <span
                        className="mt-1 block text-xs font-normal"
                        style={{ color: 'var(--text-secondary)' }}
                      >
                        {t('wizard.step2.agyKeyringRisk')}
                      </span>
                    </span>
                  </label>
                </div>
              )}

              {usableAgentsCount === 0 && (
                <p role="alert" className="text-sm font-medium" style={{ color: 'var(--error)' }}>
                  {t('wizard.step2.needOneAgent')}
                </p>
              )}
            </div>
          )}

          <div className="flex flex-wrap justify-between gap-2 pt-2">
            <Button type="button" variant="outline" onClick={() => setStep(1)}>
              {t('common.back')}
            </Button>
            <Button
              type="button"
              disabled={usableAgentsCount === 0}
              onClick={() => setStep(3)}
            >
              {t('common.next')}
            </Button>
          </div>
        </section>
      )}

      {/* SCREEN 3: TEAM */}
      {step === 3 && (
        <section
          className="space-y-5 rounded-[8px] border p-6"
          style={{ backgroundColor: 'var(--bg-surface)', borderColor: 'var(--border-subtle)' }}
        >
          <div>
            <h2 className="text-lg font-semibold">{t('wizard.step3.title')}</h2>
            <p className="mt-1 text-sm" style={{ color: 'var(--text-secondary)' }}>
              {t('wizard.step3.subtitle')}
            </p>
          </div>

          <p className="text-xs font-medium" style={{ color: crossProvider ? 'var(--pass)' : 'var(--text-secondary)' }}>
            {crossProvider ? t('wizard.step3.crossProviderNote') : t('wizard.step3.singleProviderNote')}
          </p>

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            {(
              [
                { key: 'lead', cast: 'semar', label: t('wizard.step3.leadRole') },
                { key: 'coderLight', cast: 'bima', label: t('wizard.step3.coderRole') },
                { key: 'coderMedium', cast: 'gatotkaca', label: t('wizard.step3.coderMediumRole') },
                { key: 'coderHeavy', cast: 'kresna', label: t('wizard.step3.coderHeavyRole') },
                { key: 'qa', cast: 'srikandi', label: t('wizard.step3.qaRole') },
                { key: 'reviewer', cast: 'arjuna', label: t('wizard.step3.reviewerRole') },
              ] as const
            ).map((card) => {
              const prof = roleProfiles[card.key];
              const cur = prof ? valueOf(prof) : null;
              const fbProvider = prof && cur ? fallbackProviderOf(prof, cur.provider) : '';
              const models = cur ? modelsOf(cur.provider) : [];
              const efforts = cur ? effortsFor(cur.provider, cur.model) : EFFORT_LEVEL_ORDER;
              const patch = (next: { provider?: ProviderId; model?: string; effort?: EffortLevel }) =>
                prof && setEdits((prev) => ({ ...prev, [prof.id]: { ...(prev[prof.id] ?? {}), ...next } }));
              return (
                <div
                  key={card.key}
                  className="flex items-start gap-4 rounded-[6px] border p-4"
                  style={{ borderColor: 'var(--border-subtle)', backgroundColor: 'var(--bg-canvas)' }}
                >
                  <div
                    className="flex h-20 w-20 shrink-0 items-center justify-center rounded-[6px] border"
                    style={{ borderColor: 'var(--border-subtle)', backgroundColor: 'var(--bg-well)' }}
                  >
                    <WayangFigure character={card.cast} variant="sungging" size={72} />
                  </div>
                  <div className="min-w-0 flex-1 space-y-1.5">
                    <div className="text-sm font-semibold">{card.label}</div>
                    {prof && cur ? (
                      <>
                        <NativeSelect
                          aria-label={`${card.label}: ${t('config.team.fieldProvider')}`}
                          value={cur.provider}
                          onChange={(e) => {
                            const provider = e.target.value as ProviderId;
                            patch({ provider, model: '', effort: effortsFor(provider, '')[0] as EffortLevel });
                          }}
                        >
                          {PROVIDER_ORDER.map((id) => (
                            <option key={id} value={id}>
                              {providerDisplayShort(id)}
                              {usableIds.has(id) ? '' : ` (${t('wizard.step3.notReady')})`}
                            </option>
                          ))}
                        </NativeSelect>
                        <div className="grid grid-cols-[1fr_auto] gap-1.5">
                          <NativeSelect
                            aria-label={`${card.label}: ${t('config.team.fieldModel')}`}
                            value={cur.model}
                            onChange={(e) => {
                              const next = models.find((m) => m.value === e.target.value);
                              patch({
                                model: e.target.value,
                                effort: efforts.includes(cur.effort)
                                  ? cur.effort
                                  : (next?.defaultEffort ?? (effortsFor(cur.provider, e.target.value)[0] as EffortLevel)),
                              });
                            }}
                          >
                            <option value="">{t('common.cliDefault')}</option>
                            {cur.model && !models.some((m) => m.value === cur.model) && (
                              <option value={cur.model}>{cur.model}</option>
                            )}
                            {models.map((m) => (
                              <option key={m.id} value={m.value}>
                                {modelLabel(m)}
                              </option>
                            ))}
                          </NativeSelect>
                          <NativeSelect
                            aria-label={`${card.label}: ${t('config.team.fieldEffort')}`}
                            value={cur.effort}
                            onChange={(e) => patch({ effort: e.target.value as EffortLevel })}
                          >
                            {efforts.map((lvl) => (
                              <option key={lvl} value={lvl}>
                                {lvl}
                              </option>
                            ))}
                          </NativeSelect>
                        </div>
                        <div className="flex items-center gap-2 pt-0.5">
                          <span
                            className="shrink-0 text-xs"
                            style={{ color: 'var(--text-secondary)' }}
                          >
                            {t('config.agents.backupLabel')}:
                          </span>
                          <NativeSelect
                            aria-label={`${card.label}: ${t('config.agents.backupLabel')}`}
                            value={fbProvider}
                            onChange={(e) => {
                              const next = e.target.value as ProviderId | '';
                              setFallbackEdits((prev) => ({ ...prev, [prof.id]: next }));
                            }}
                          >
                            <option value="">{t('common.none')}</option>
                            {PROVIDER_ORDER.map((id) => (
                              <option key={id} value={id}>
                                {providerDisplayShort(id)}
                                {usableIds.has(id) ? '' : ` (${t('wizard.step3.notReady')})`}
                              </option>
                            ))}
                          </NativeSelect>
                        </div>
                      </>
                    ) : (
                      <div className="space-y-2">
                        <p className="text-xs" style={{ color: 'var(--text-secondary)' }}>
                          {t('wizard.step3.profileMissing')}
                        </p>
                        <Button
                          type="button"
                          variant="outline"
                          disabled={restoreRoleMutation.isPending}
                          onClick={() => restoreRoleMutation.mutate(card.key)}
                        >
                          {t('config.agents.restoreRole', { name: ROLE_PROFILE_NAME[card.key] })}
                        </Button>
                      </div>
                    )}
                  </div>
                </div>
              );
            })}
          </div>

          {applyTeamMutation.isError && (
            <ErrorPanel
              title={t('config.routing.loadError')}
              detail={applyTeamMutation.error.message}
            />
          )}

          <div className="flex flex-wrap justify-between gap-2 pt-2">
            <Button type="button" variant="outline" onClick={() => setStep(2)}>
              {t('common.back')}
            </Button>
            <Button
              type="button"
              disabled={applyTeamMutation.isPending}
              onClick={() => applyTeamMutation.mutate()}
            >
              {applyTeamMutation.isPending ? t('wizard.step3.applying') : t('wizard.step3.acceptTeam')}
            </Button>
          </div>
        </section>
      )}

      {/* SCREEN 4: FIRST PROJECT */}
      {step === 4 && (
        <section
          className="space-y-5 rounded-[8px] border p-6"
          style={{ backgroundColor: 'var(--bg-surface)', borderColor: 'var(--border-subtle)' }}
        >
          <div>
            <h2 className="text-lg font-semibold">{t('wizard.step4.title')}</h2>
            <p className="mt-1 text-sm" style={{ color: 'var(--text-secondary)' }}>
              {t('wizard.step4.subtitle')}
            </p>
          </div>

          <div className="grid grid-cols-2 gap-2" role="tablist" aria-label={t('wizard.step4.title')}>
            <Button
              type="button"
              role="tab"
              aria-selected={mode === 'create'}
              variant={mode === 'create' ? 'default' : 'outline'}
              onClick={() => setMode('create')}
            >
              {t('projects.modeCreate')}
            </Button>
            <Button
              type="button"
              role="tab"
              aria-selected={mode === 'open'}
              variant={mode === 'open' ? 'default' : 'outline'}
              onClick={() => setMode('open')}
            >
              {t('projects.modeOpen')}
            </Button>
          </div>

          <form onSubmit={handleProjectSubmit} className="space-y-4">
            <div className="grid gap-4 sm:grid-cols-2">
              <div>
                <Label htmlFor="wiz-proj-path" className="block text-sm font-medium">
                  {t('projects.pathLabel')}
                </Label>
                <Input
                  id="wiz-proj-path"
                  type="text"
                  required
                  value={repoPath}
                  onChange={(e) => setRepoPath(e.target.value)}
                  placeholder={t('projects.pathPlaceholder')}
                  className="mt-1 font-mono-token text-sm"
                />
              </div>
              <div>
                <Label htmlFor="wiz-proj-name" className="block text-sm font-medium">
                  {t('projects.nameLabel')}
                </Label>
                <Input
                  id="wiz-proj-name"
                  type="text"
                  value={projectName}
                  onChange={(e) => setProjectName(e.target.value)}
                  placeholder={t('projects.namePlaceholder')}
                  className="mt-1"
                />
              </div>
            </div>

            {mode === 'create' ? (
              <div>
                <Label htmlFor="wiz-proj-stack" className="block text-sm font-medium">
                  {t('projects.stackLabel')}
                </Label>
                <Input
                  id="wiz-proj-stack"
                  type="text"
                  value={stackHint}
                  onChange={(e) => setStackHint(e.target.value)}
                  placeholder={t('projects.stackPlaceholder')}
                  className="mt-1"
                />
              </div>
            ) : (
              <label className="flex min-h-[44px] cursor-pointer items-center gap-3 text-sm">
                <input
                  type="checkbox"
                  checked={initGitIfMissing}
                  onChange={(e) => setInitGitIfMissing(e.target.checked)}
                  className="h-4 w-4 accent-[var(--primary)]"
                />
                <span>{t('projects.initGitLabel')}</span>
              </label>
            )}

            <div>
              <Label htmlFor="wiz-proj-goal" className="block text-sm font-medium">
                {t('wizard.step4.goalLabel')}
              </Label>
              <Textarea
                id="wiz-proj-goal"
                rows={3}
                value={goal}
                onChange={(e) => setGoal(e.target.value)}
                placeholder={t('wizard.step4.goalPlaceholder')}
                className="mt-1"
              />
            </div>

            {createProjectMutation.isError && (
              <div
                role="alert"
                className="rounded-[6px] border px-3 py-2 text-sm"
                style={{
                  backgroundColor: 'var(--error-tint)',
                  borderColor: 'var(--error)',
                  color: 'var(--error)',
                }}
              >
                {createProjectMutation.error.message}
              </div>
            )}

            <div className="flex flex-wrap justify-between gap-2 pt-2">
              <Button type="button" variant="outline" onClick={() => setStep(3)}>
                {t('common.back')}
              </Button>
              <Button
                type="submit"
                disabled={createProjectMutation.isPending || !repoPath.trim()}
              >
                {createProjectMutation.isPending
                  ? t('wizard.step4.starting')
                  : mode === 'create'
                    ? t('wizard.step4.startButton')
                    : t('wizard.step4.openButton')}
              </Button>
            </div>
          </form>
        </section>
      )}
    </div>
  );
}
