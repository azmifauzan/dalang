import { useState } from 'react';
import {
  splitEffortModel,
  type AgentProfileDTO,
  type EffortLevel,
  type ProviderId,
  type ProviderRuntimeStateDTO,
  type ProviderStatus,
  type RoutingRuleDTO,
} from '@dalang/shared';
import { ProviderIcon } from '../../assets/providers/ProviderIcon.js';
import {
  WayangFigure,
  castDisplayName,
  characterForProfile,
} from '../../assets/wayang/WayangFigure.js';
import { useI18n } from '../../i18n/index.js';
import { providerBadgeStyle, providerDisplayShort } from '../../lib/activity.js';
import { describeFallback } from '../FallbackFields.js';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { NativeSelect } from '@/components/ui/native-select';
import {
  CORE_ROLE_SLOTS,
  EFFORT_OPTIONS,
  PROVIDER_OPTIONS,
  effectiveFallbackForProfile,
  findCoreProfile,
  formatSecondsHuman,
  isProviderUsable,
  matchProviderModel,
  type CoreRoleSlot,
} from './agentHelpers.js';

interface InlineDraft {
  provider: ProviderId;
  model: string;
  effort: EffortLevel;
}

function CoreRoleCard({
  slot,
  profile,
  providers,
  providerStates,
  rules,
  keyringAccess,
  savingId,
  savedNoticeId,
  inlineError,
  onQuickSave,
  onOpenAdvancedEdit,
  onCreateMissingRole,
  onOpenProviders,
  onOpenSecurity,
}: {
  slot: CoreRoleSlot;
  profile: AgentProfileDTO | null;
  providers: ProviderStatus[];
  providerStates: ProviderRuntimeStateDTO[];
  rules: RoutingRuleDTO[];
  keyringAccess: boolean;
  savingId: string | null;
  savedNoticeId: string | null;
  inlineError: { id: string; text: string } | null;
  onQuickSave: (profileId: string, patch: InlineDraft) => void;
  onOpenAdvancedEdit: (profile: AgentProfileDTO) => void;
  onCreateMissingRole: (slot: CoreRoleSlot) => void;
  onOpenProviders: () => void;
  onOpenSecurity: () => void;
}) {
  const { lang, t } = useI18n();
  const [draft, setDraft] = useState<InlineDraft | null>(null);

  if (!profile) {
    return (
      <article
        className="flex flex-col justify-between gap-4 rounded-[8px] border p-5"
        style={{ backgroundColor: 'var(--bg-surface)', borderColor: 'var(--border-subtle)' }}
      >
        <div className="flex items-start gap-4">
          <div
            className="flex h-20 w-20 shrink-0 items-center justify-center rounded-[6px] border p-1"
            style={{ backgroundColor: 'var(--bg-well)', borderColor: 'var(--border-subtle)' }}
          >
            <WayangFigure character={slot.cast} variant="sungging" dimmed={true} size={72} />
          </div>
          <div className="min-w-0 flex-1 space-y-1">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="text-base font-semibold">{t(slot.titleKey)}</h2>
              <Badge>{castDisplayName(slot.cast)}</Badge>
            </div>
            <p className="text-sm" style={{ color: 'var(--text-secondary)' }}>
              {t(slot.descKey)}
            </p>
            <p className="pt-1 text-xs" style={{ color: 'var(--text-secondary)' }}>
              {t('config.agents.roleMissing')}
            </p>
          </div>
        </div>
        <div>
          <Button type="button" variant="outline" onClick={() => onCreateMissingRole(slot)}>
            {t('config.agents.restoreRole', { name: slot.profileName })}
          </Button>
        </div>
      </article>
    );
  }

  const current: InlineDraft = draft ?? {
    provider: profile.provider,
    model: profile.model,
    effort: profile.effort,
  };
  const isDirty =
    draft !== null &&
    (draft.provider !== profile.provider ||
      draft.model !== profile.model ||
      draft.effort !== profile.effort);

  const activeProviderStatus = providers.find((p) => p.id === current.provider);
  const activeRuntime = providerStates.find((ps) => ps.provider === current.provider);
  const providerModels = activeProviderStatus?.models ?? [];
  const isAgy = current.provider === 'antigravity';
  const matched = matchProviderModel(providerModels, current.model, isAgy);
  const selectedModelInfo = matched.modelInfo;
  const activeVariantValue = matched.activeVariantValue;
  const currentSplit = isAgy ? splitEffortModel(current.model) : null;
  const modelSelectValue = selectedModelInfo
    ? selectedModelInfo.id
    : currentSplit
      ? currentSplit.base
      : current.model;
  const savedModelUnavailable = Boolean(
    current.model.trim() && providerModels.length > 0 && !selectedModelInfo,
  );
  const effortChoices: EffortLevel[] = selectedModelInfo
    ? selectedModelInfo.supportedEffortLevels.length > 0
      ? selectedModelInfo.supportedEffortLevels
      : []
    : EFFORT_OPTIONS;
  const effortLocked = Boolean(
    selectedModelInfo && selectedModelInfo.supportedEffortLevels.length === 0,
  );

  const updateDraft = (updater: (prev: InlineDraft) => InlineDraft) => {
    setDraft((prev) =>
      updater(
        prev ?? {
          provider: profile.provider,
          model: profile.model,
          effort: profile.effort,
        },
      ),
    );
  };

  const handleModelChange = (selectedId: string) => {
    updateDraft((prev) => {
      if (!selectedId) return { ...prev, model: '' };
      const info = providerModels.find((m) => m.id === selectedId);
      if (!info) return { ...prev, model: selectedId };
      const nextEffort: EffortLevel =
        info.defaultEffort ??
        (info.supportedEffortLevels.includes(prev.effort)
          ? prev.effort
          : (info.supportedEffortLevels[0] ?? prev.effort));
      if (isAgy && info.supportedEffortLevels.length > 0) {
        return { ...prev, model: `${info.id}-${nextEffort}`, effort: nextEffort };
      }
      return { ...prev, model: info.value, effort: nextEffort };
    });
  };

  const handleEffortChange = (level: EffortLevel) => {
    updateDraft((prev) => {
      if (isAgy && selectedModelInfo && selectedModelInfo.supportedEffortLevels.length > 0) {
        return { ...prev, effort: level, model: `${selectedModelInfo.id}-${level}` };
      }
      const parts = isAgy ? splitEffortModel(prev.model) : null;
      return { ...prev, effort: level, model: parts ? `${parts.base}-${level}` : prev.model };
    });
  };

  const handleVariantToggle = (variantValue: string, enabled: boolean) => {
    if (!selectedModelInfo) return;
    updateDraft((prev) => ({
      ...prev,
      model: enabled ? variantValue : selectedModelInfo.value,
    }));
  };

  const effectiveFallback = effectiveFallbackForProfile(profile, rules);
  const fallbackSummary =
    describeFallback(effectiveFallback.target, t('common.cliDefault')) ?? t('common.none');

  const needsCliAttention =
    activeProviderStatus && (!activeProviderStatus.installed || !activeProviderStatus.loggedIn);
  const needsKeyring =
    activeProviderStatus?.id === 'antigravity' &&
    activeProviderStatus.installed &&
    activeProviderStatus.loggedIn &&
    !keyringAccess;
  const inCooldown = Boolean(activeRuntime?.inCooldown || activeRuntime?.quotaExhausted);

  const isSaving = savingId === profile.id;
  const justSaved = savedNoticeId === profile.id && !isDirty;
  const cardError = inlineError?.id === profile.id ? inlineError.text : null;

  const baseId = `role-${slot.key}`;

  return (
    <article
      className="flex flex-col justify-between gap-4 rounded-[8px] border p-5"
      style={{
        backgroundColor: 'var(--bg-surface)',
        borderColor: isDirty ? 'var(--accent)' : 'var(--border-subtle)',
      }}
    >
      <div className="space-y-4">
        {/* Role header */}
        <div className="flex items-start gap-3.5">
          <div
            className="flex h-20 w-20 shrink-0 items-center justify-center rounded-[6px] border p-1"
            style={{ backgroundColor: 'var(--bg-well)', borderColor: 'var(--border-subtle)' }}
          >
            <WayangFigure character={slot.cast} variant="sungging" size={72} />
          </div>
          <div className="min-w-0 flex-1 space-y-1">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex flex-wrap items-center gap-1.5">
                <h2 className="text-base font-semibold">{t(slot.titleKey)}</h2>
                <Badge>{castDisplayName(slot.cast)}</Badge>
                {profile.configDir && (
                  <Badge title={profile.configDir}>{t('config.team.customAccount')}</Badge>
                )}
              </div>
              <span className="inline-flex items-center gap-1.5 font-mono-token text-xs" style={{ color: 'var(--text-secondary)' }}>
                <ProviderIcon id={current.provider} size={15} />
                <span>{profile.name}</span>
              </span>
            </div>
            <p className="text-sm" style={{ color: 'var(--text-secondary)' }}>
              {t(slot.descKey)}
            </p>
          </div>
        </div>

        {/* Readiness warnings (honest, actionable cross-links) */}
        {needsCliAttention && (
          <div
            className="flex flex-wrap items-center justify-between gap-2 rounded-[6px] border px-3 py-2 text-xs"
            style={{
              backgroundColor: 'var(--error-tint)',
              borderColor: 'var(--error)',
              color: 'var(--error)',
            }}
          >
            <span>
              {activeProviderStatus.installed
                ? t('config.agents.roleCliNeedsLogin', {
                    provider: activeProviderStatus.displayName,
                  })
                : t('config.agents.roleCliMissing', {
                    provider: activeProviderStatus.displayName,
                  })}
            </span>
            <button
              type="button"
              onClick={onOpenProviders}
              className="inline-flex min-h-11 cursor-pointer items-center font-semibold underline underline-offset-2"
            >
              {t('config.agents.viewCliSetup')}
            </button>
          </div>
        )}

        {needsKeyring && (
          <div
            className="flex flex-wrap items-center justify-between gap-2 rounded-[6px] border px-3 py-2 text-xs"
            style={{
              backgroundColor: 'var(--accent-tint)',
              borderColor: 'var(--accent)',
              color: 'var(--accent)',
            }}
          >
            <span>{t('config.agents.roleKeyringOff')}</span>
            <button
              type="button"
              onClick={onOpenSecurity}
              className="inline-flex min-h-11 cursor-pointer items-center font-semibold underline underline-offset-2"
            >
              {t('config.agents.openSecurityLink')}
            </button>
          </div>
        )}

        {inCooldown && (
          <div
            className="flex flex-wrap items-center justify-between gap-2 rounded-[6px] border px-3 py-2 text-xs"
            style={{
              backgroundColor: 'var(--error-tint)',
              borderColor: 'var(--error)',
              color: 'var(--error)',
            }}
          >
            <span>
              {activeRuntime?.inCooldown
                ? t('config.agents.roleInCooldown', {
                    provider: providerDisplayShort(current.provider),
                  })
                : t('config.agents.roleQuotaExhausted', {
                    provider: providerDisplayShort(current.provider),
                  })}
            </span>
            <button
              type="button"
              onClick={onOpenProviders}
              className="inline-flex min-h-11 cursor-pointer items-center font-semibold underline underline-offset-2"
            >
              {t('config.agents.manageQuotas')}
            </button>
          </div>
        )}

        {/* Inline quick controls */}
        <form
          className="space-y-3"
          onSubmit={(e) => {
            e.preventDefault();
            if (!isDirty || isSaving) return;
            onQuickSave(profile.id, current);
            setDraft(null);
          }}
        >
          <div className="space-y-1.5">
            <Label htmlFor={`${baseId}-provider`}>{t('config.team.fieldProvider')}</Label>
            <NativeSelect
              id={`${baseId}-provider`}
              value={current.provider}
              onChange={(e) => {
                const nextProvider = e.target.value as ProviderId;
                const nextModels = providers.find((p) => p.id === nextProvider)?.models ?? [];
                const firstEfforts = nextModels[0]?.supportedEffortLevels;
                const nextEffort =
                  firstEfforts && firstEfforts.length > 0 && !firstEfforts.includes(current.effort)
                    ? firstEfforts[0]
                    : current.effort;
                updateDraft((prev) => ({
                  ...prev,
                  provider: nextProvider,
                  model: '',
                  effort: nextEffort,
                }));
              }}
            >
              {PROVIDER_OPTIONS.map((opt) => {
                const status = providers.find((p) => p.id === opt.value);
                const usable = isProviderUsable(status, keyringAccess);
                return (
                  <option key={opt.value} value={opt.value}>
                    {opt.label}
                    {status && !usable ? ` (${t('wizard.step3.notReady')})` : ''}
                  </option>
                );
              })}
            </NativeSelect>
          </div>

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-[1fr_auto]">
            <div className="space-y-1.5">
              <Label htmlFor={`${baseId}-model`}>{t('config.team.fieldModel')}</Label>
              <NativeSelect
                id={`${baseId}-model`}
                value={modelSelectValue}
                onChange={(e) => handleModelChange(e.target.value)}
              >
                <option value="">{t('common.cliDefault')}</option>
                {savedModelUnavailable && (
                  <option value={modelSelectValue}>
                    {current.model} ({t('config.team.unavailableTag')})
                  </option>
                )}
                {providerModels.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.displayName}
                  </option>
                ))}
              </NativeSelect>
            </div>

            <div className="space-y-1.5 sm:min-w-[8.5rem]">
              <Label htmlFor={`${baseId}-effort`}>{t('config.team.fieldEffort')}</Label>
              <NativeSelect
                id={`${baseId}-effort`}
                disabled={effortLocked}
                value={
                  effortChoices.includes(current.effort)
                    ? current.effort
                    : (effortChoices[0] ?? current.effort)
                }
                onChange={(e) => handleEffortChange(e.target.value as EffortLevel)}
              >
                {(effortChoices.length > 0 ? effortChoices : EFFORT_OPTIONS).map((eff) => (
                  <option key={eff} value={eff}>
                    {t(`sessions.picker.effort.${eff}`)}
                  </option>
                ))}
              </NativeSelect>
            </div>
          </div>

          {selectedModelInfo && selectedModelInfo.variants.length > 0 && (
            <div className="flex flex-wrap gap-3">
              {selectedModelInfo.variants.map((variant) => (
                <label
                  key={variant.id}
                  className="flex min-h-11 cursor-pointer items-center gap-2 text-xs"
                >
                  <input
                    type="checkbox"
                    className="h-4 w-4 accent-[var(--primary)]"
                    checked={activeVariantValue === variant.value}
                    onChange={(e) => handleVariantToggle(variant.value, e.target.checked)}
                  />
                  <span>{t('config.team.useVariant', { label: variant.label })}</span>
                </label>
              ))}
            </div>
          )}

          {cardError && (
            <p role="alert" className="text-xs font-medium" style={{ color: 'var(--error)' }}>
              {cardError}
            </p>
          )}

          {isDirty && (
            <div className="flex flex-wrap items-center gap-2 pt-1">
              <Button type="submit" disabled={isSaving}>
                {isSaving ? t('common.saving') : t('common.save')}
              </Button>
              <Button type="button" variant="outline" onClick={() => setDraft(null)}>
                {t('common.cancel')}
              </Button>
            </div>
          )}

          {justSaved && (
            <p role="status" className="text-xs font-medium" style={{ color: 'var(--pass)' }}>
              {t('config.agents.inlineSaved')}
            </p>
          )}
        </form>
      </div>

      {/* Footer summary & More settings */}
      <div
        className="flex flex-wrap items-center justify-between gap-3 border-t pt-3"
        style={{ borderColor: 'var(--border-subtle)' }}
      >
        <div className="min-w-0 space-y-0.5 text-xs" style={{ color: 'var(--text-secondary)' }}>
          <div className="truncate">
            <span>{t('config.agents.backupLabel')}: </span>
            <span className="font-medium" style={{ color: 'var(--text-primary)' }}>
              {fallbackSummary}
            </span>
            {effectiveFallback.source === 'rule' && (
              <span> ({t('config.agents.viaRoutingRule')})</span>
            )}
          </div>
          <div>
            {t('config.team.parallelShort', { count: profile.maxParallel })} ·{' '}
            {formatSecondsHuman(Math.round(profile.timeoutMs / 1000), lang)}
          </div>
        </div>
        <Button type="button" variant="outline" onClick={() => onOpenAdvancedEdit(profile)}>
          {t('config.agents.moreSettings')}
        </Button>
      </div>
    </article>
  );
}

export function AgentsTeamPanel({
  profiles,
  providers,
  providerStates,
  rules,
  keyringAccess,
  savingId,
  savedNoticeId,
  inlineError,
  deletingId,
  onQuickSave,
  onOpenCreateProfile,
  onOpenEditProfile,
  onCreateMissingRole,
  onDeleteProfile,
  onOpenProviders,
  onOpenSecurity,
}: {
  profiles: AgentProfileDTO[];
  providers: ProviderStatus[];
  providerStates: ProviderRuntimeStateDTO[];
  rules: RoutingRuleDTO[];
  keyringAccess: boolean;
  savingId: string | null;
  savedNoticeId: string | null;
  inlineError: { id: string; text: string } | null;
  deletingId: string | null;
  onQuickSave: (profileId: string, patch: InlineDraft) => void;
  onOpenCreateProfile: (initialShowAdvanced?: boolean) => void;
  onOpenEditProfile: (profile: AgentProfileDTO) => void;
  onCreateMissingRole: (slot: CoreRoleSlot) => void;
  onDeleteProfile: (profileId: string) => void;
  onOpenProviders: () => void;
  onOpenSecurity: () => void;
}) {
  const { lang, t } = useI18n();
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);

  const corePairs = CORE_ROLE_SLOTS.map((slot) => ({
    slot,
    profile: findCoreProfile(profiles, slot),
  }));
  const coreIds = new Set(
    corePairs.map((pair) => pair.profile?.id).filter((id): id is string => Boolean(id)),
  );
  const customProfiles = profiles.filter((p) => !coreIds.has(p.id));

  const coderSmall = corePairs.find((c) => c.slot.key === 'coderLight')?.profile;
  const coderMedium = corePairs.find((c) => c.slot.key === 'coderMedium')?.profile;
  const coderHeavy = corePairs.find((c) => c.slot.key === 'coderHeavy')?.profile;
  const reviewer = corePairs.find((c) => c.slot.key === 'reviewer')?.profile;
  const hasCrossProviderReview = Boolean(
    reviewer &&
      ((coderSmall && coderSmall.provider !== reviewer.provider) ||
        (coderMedium && coderMedium.provider !== reviewer.provider) ||
        (coderHeavy && coderHeavy.provider !== reviewer.provider)),
  );

  return (
    <div className="space-y-6">
      {/* Cross-provider note */}
      {reviewer && (coderSmall || coderHeavy) && (
        <div
          className="flex flex-wrap items-center justify-between gap-2 rounded-[6px] border px-4 py-3 text-sm"
          style={{
            backgroundColor: hasCrossProviderReview ? 'var(--pass-tint)' : 'var(--bg-well)',
            borderColor: hasCrossProviderReview ? 'var(--pass)' : 'var(--border-subtle)',
            color: hasCrossProviderReview ? 'var(--pass)' : 'var(--text-secondary)',
          }}
        >
          <span>
            {hasCrossProviderReview
              ? t('wizard.step3.crossProviderNote')
              : t('wizard.step3.singleProviderNote')}
          </span>
        </div>
      )}

      {/* Core 4 roles */}
      <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
        {corePairs.map(({ slot, profile }) => (
          <CoreRoleCard
            key={slot.key}
            slot={slot}
            profile={profile}
            providers={providers}
            providerStates={providerStates}
            rules={rules}
            keyringAccess={keyringAccess}
            savingId={savingId}
            savedNoticeId={savedNoticeId}
            inlineError={inlineError}
            onQuickSave={onQuickSave}
            onOpenAdvancedEdit={onOpenEditProfile}
            onCreateMissingRole={onCreateMissingRole}
            onOpenProviders={onOpenProviders}
            onOpenSecurity={onOpenSecurity}
          />
        ))}
      </div>

      {/* Custom profiles & extra accounts */}
      <section
        className="space-y-4 rounded-[8px] border p-5"
        style={{ backgroundColor: 'var(--bg-surface)', borderColor: 'var(--border-subtle)' }}
      >
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 className="text-base font-semibold">{t('config.agents.customProfilesTitle')}</h2>
            <p className="mt-0.5 text-sm" style={{ color: 'var(--text-secondary)' }}>
              {t('config.agents.customProfilesDesc')}
            </p>
          </div>
          <Button type="button" variant="outline" onClick={() => onOpenCreateProfile(false)}>
            {t('config.team.newProfile')}
          </Button>
        </div>

        {customProfiles.length === 0 ? (
          <p className="text-sm" style={{ color: 'var(--text-secondary)' }}>
            {t('config.agents.customProfilesEmpty')}
          </p>
        ) : (
          <ul className="divide-y divide-border">
            {customProfiles.map((prof) => {
              const cast = characterForProfile(prof.name);
              const fallbackName =
                describeFallback(prof.fallback, t('common.cliDefault')) ?? t('common.none');
              const confirming = confirmDeleteId === prof.id;

              return (
                <li
                  key={prof.id}
                  className="flex flex-wrap items-center justify-between gap-4 py-3.5 first:pt-1 last:pb-0"
                >
                  <div className="flex min-w-0 flex-1 items-center gap-3">
                    <div
                      className="flex h-12 w-12 shrink-0 items-center justify-center rounded-[6px] border p-0.5"
                      style={{
                        backgroundColor: 'var(--bg-well)',
                        borderColor: 'var(--border-subtle)',
                      }}
                    >
                      <WayangFigure character={cast} variant="sungging" size={42} />
                    </div>
                    <div className="min-w-0 space-y-1">
                      <div className="flex flex-wrap items-center gap-1.5">
                        <span className="font-semibold">{prof.name}</span>
                        <Badge style={providerBadgeStyle(prof.provider)}>
                          {providerDisplayShort(prof.provider)}
                        </Badge>
                        {prof.configDir && (
                          <Badge title={prof.configDir}>{t('config.team.customAccount')}</Badge>
                        )}
                      </div>
                      <p className="text-xs" style={{ color: 'var(--text-secondary)' }}>
                        <span className="font-mono-token text-foreground">
                          {prof.model || t('common.cliDefault')}
                        </span>{' '}
                        · {t(`sessions.picker.effort.${prof.effort}`)} ·{' '}
                        {t('config.team.parallelShort', { count: prof.maxParallel })} ·{' '}
                        {formatSecondsHuman(Math.round(prof.timeoutMs / 1000), lang)} ·{' '}
                        {t('config.agents.backupLabel')}: {fallbackName}
                      </p>
                    </div>
                  </div>

                  <div className="flex flex-wrap items-center gap-2">
                    {confirming ? (
                      <>
                        <Button
                          type="button"
                          variant="destructive"
                          disabled={deletingId === prof.id}
                          onClick={() => {
                            setConfirmDeleteId(null);
                            onDeleteProfile(prof.id);
                          }}
                        >
                          {t('config.agents.confirmDelete')}
                        </Button>
                        <Button
                          type="button"
                          variant="outline"
                          onClick={() => setConfirmDeleteId(null)}
                        >
                          {t('common.cancel')}
                        </Button>
                      </>
                    ) : (
                      <>
                        <Button
                          type="button"
                          variant="outline"
                          onClick={() => onOpenEditProfile(prof)}
                        >
                          {t('common.edit')}
                        </Button>
                        <Button
                          type="button"
                          variant="destructive"
                          onClick={() => setConfirmDeleteId(prof.id)}
                        >
                          {t('common.delete')}
                        </Button>
                      </>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </div>
  );
}
