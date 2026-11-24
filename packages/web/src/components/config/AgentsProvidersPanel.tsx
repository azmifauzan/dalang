import { useState } from 'react';
import type {
  AgentProfileDTO,
  ProviderId,
  ProviderRuntimeStateDTO,
  ProviderStatus,
} from '@dalang/shared';
import { ProviderIcon } from '../../assets/providers/ProviderIcon.js';
import { useI18n } from '../../i18n/index.js';
import { providerDisplayShort } from '../../lib/activity.js';
import { modelLabel } from '../../lib/modelLabel.js';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  configDirEnvHint,
  providerSetupCommand,
  remainingPercent,
} from './agentHelpers.js';

const LOW_QUOTA_THRESHOLD = 20;

export function AgentsProvidersPanel({
  providers,
  providerStates,
  profiles,
  keyringAccess,
  updatingProviderId,
  updateSuccessProviderId,
  updateErrorProviderId,
  updateErrorMessage,
  clearingCooldown,
  onUpdateCli,
  onClearCooldown,
  onOpenTeam,
  onOpenSecurity,
  onEditAccountProfile,
  onAddSeparateAccount,
}: {
  providers: ProviderStatus[];
  providerStates: ProviderRuntimeStateDTO[];
  profiles: AgentProfileDTO[];
  keyringAccess: boolean;
  updatingProviderId: ProviderId | null;
  updateSuccessProviderId: ProviderId | null;
  updateErrorProviderId: ProviderId | null;
  updateErrorMessage: string | null;
  clearingCooldown: boolean;
  onUpdateCli: (providerId: ProviderId) => void;
  onClearCooldown: (providerId: ProviderId) => void;
  onOpenTeam: () => void;
  onOpenSecurity: () => void;
  onEditAccountProfile: (profile: AgentProfileDTO) => void;
  onAddSeparateAccount: () => void;
}) {
  const { t, formatDateTime } = useI18n();
  const [copiedCmd, setCopiedCmd] = useState<string | null>(null);
  const [expandedModels, setExpandedModels] = useState<Record<string, boolean>>({});

  const copyCommand = async (cmd: string) => {
    try {
      await navigator.clipboard.writeText(cmd);
      setCopiedCmd(cmd);
      setTimeout(() => setCopiedCmd(null), 1800);
    } catch {
      // Clipboard optional in non-secure contexts
    }
  };

  const resetText = (raw: string | null): string | null => {
    if (!raw) return null;
    const text = /^\d{4}-\d{2}-\d{2}T/.test(raw) ? formatDateTime(raw) : raw;
    return t('usage.resets', { time: text });
  };

  const extraAccountProfiles = profiles.filter((p) => Boolean(p.configDir));

  return (
    <div className="space-y-6">
      {/* 3-state responsive grid: 1 col phone -> 2 col tablet -> 3 col desktop */}
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
        {providers.map((p) => {
          const runtime = providerStates.find((ps) => ps.provider === p.id);
          const ready = p.installed && p.loggedIn;
          const setupCmd = providerSetupCommand(p);
          const usedByProfiles = profiles.filter((prof) => prof.provider === p.id);
          const showAllModels = Boolean(expandedModels[p.id]);
          const needsKeyring = p.id === 'antigravity' && ready && !keyringAccess;

          return (
            <article
              key={p.id}
              className="flex flex-col justify-between gap-4 rounded-[8px] border p-5"
              style={{
                backgroundColor: 'var(--bg-surface)',
                borderColor:
                  runtime?.inCooldown || runtime?.quotaExhausted
                    ? 'var(--error)'
                    : 'var(--border-subtle)',
              }}
            >
              <div className="space-y-4">
                {/* Provider header */}
                <div className="flex items-start justify-between gap-3">
                  <div className="flex min-w-0 items-center gap-2.5">
                    <ProviderIcon id={p.id} size={24} />
                    <div className="min-w-0">
                      <h2 className="text-base font-semibold">{p.displayName}</h2>
                      <p
                        className="truncate font-mono-token text-xs"
                        style={{ color: 'var(--text-secondary)' }}
                        title={p.binaryPath || p.binary}
                      >
                        {p.binaryPath || p.binary}
                      </p>
                    </div>
                  </div>
                  <Badge
                    style={
                      !ready
                        ? {
                            color: 'var(--error)',
                            borderColor: 'var(--error)',
                            backgroundColor: 'var(--error-tint)',
                          }
                        : needsKeyring
                          ? {
                              color: 'var(--accent)',
                              borderColor: 'var(--accent)',
                              backgroundColor: 'var(--accent-tint)',
                            }
                          : {
                              color: 'var(--pass)',
                              borderColor: 'var(--pass)',
                              backgroundColor: 'var(--pass-tint)',
                            }
                    }
                  >
                    {!p.installed
                      ? t('config.agents.statusMissing')
                      : !p.loggedIn
                        ? t('config.agents.statusLogin')
                        : needsKeyring
                          ? t('config.agents.statusKeyringOff')
                          : t('config.agents.statusReady')}
                  </Badge>
                </div>

                {/* Actionable install / sign-in guide when not ready */}
                {!ready && (
                  <div
                    className="space-y-2 rounded-[6px] border p-3"
                    style={{ borderColor: 'var(--border-subtle)', backgroundColor: 'var(--bg-well)' }}
                  >
                    <p className="text-xs font-medium">
                      {!p.installed
                        ? t('config.agents.installHint')
                        : t('config.agents.loginHint')}
                    </p>
                    <div
                      className="flex flex-wrap items-center justify-between gap-2 rounded-[4px] border px-2.5 py-1.5"
                      style={{
                        borderColor: 'var(--border-subtle)',
                        backgroundColor: 'var(--bg-surface)',
                      }}
                    >
                      <code className="min-w-0 flex-1 break-all font-mono-token text-xs">
                        {setupCmd}
                      </code>
                      <Button type="button" variant="outline" onClick={() => copyCommand(setupCmd)}>
                        {copiedCmd === setupCmd ? t('common.copied') : t('common.copy')}
                      </Button>
                    </div>
                  </div>
                )}

                {/* Antigravity keyring hint */}
                {needsKeyring && (
                  <div
                    className="space-y-1.5 rounded-[6px] border px-3 py-2.5 text-xs"
                    style={{
                      backgroundColor: 'var(--accent-tint)',
                      borderColor: 'var(--accent)',
                      color: 'var(--accent)',
                    }}
                  >
                    <p>{t('config.agents.roleKeyringOff')}</p>
                    <button
                      type="button"
                      onClick={onOpenSecurity}
                      className="inline-flex min-h-11 cursor-pointer items-center font-semibold underline underline-offset-2"
                    >
                      {t('config.agents.openSecurityLink')}
                    </button>
                  </div>
                )}

                {/* Cooldown / quota alert */}
                {runtime && (runtime.inCooldown || runtime.quotaExhausted) && (
                  <div
                    className="flex flex-wrap items-center justify-between gap-2 rounded-[6px] border px-3 py-2 text-xs"
                    style={{
                      backgroundColor: 'var(--error-tint)',
                      borderColor: 'var(--error)',
                      color: 'var(--error)',
                    }}
                  >
                    <span>
                      {runtime.inCooldown
                        ? t('config.agents.cooldownReason', {
                            reason: runtime.cooldownReason ?? t('enum.rate_limit'),
                          })
                        : (runtime.quotaReason ?? t('common.quotaExhausted'))}
                    </span>
                    {runtime.inCooldown && (
                      <Button
                        type="button"
                        variant="outline"
                        disabled={clearingCooldown}
                        onClick={() => onClearCooldown(p.id)}
                      >
                        {t('config.agents.clearCooldown')}
                      </Button>
                    )}
                  </div>
                )}

                {/* Key metadata */}
                <dl className="space-y-1.5 text-xs">
                  <div className="flex justify-between gap-2">
                    <dt style={{ color: 'var(--text-secondary)' }}>{t('config.agents.version')}</dt>
                    <dd className="font-mono-token">{p.version || 'N/A'}</dd>
                  </div>
                  <div className="flex justify-between gap-2">
                    <dt style={{ color: 'var(--text-secondary)' }}>{t('config.agents.auth')}</dt>
                    <dd className="text-right">{p.authSummary}</dd>
                  </div>
                  <div className="flex justify-between gap-2">
                    <dt style={{ color: 'var(--text-secondary)' }}>{t('config.agents.sandbox')}</dt>
                    <dd
                      className="font-semibold"
                      style={{ color: p.sandboxReady ? 'var(--pass)' : 'var(--error)' }}
                    >
                      {p.sandboxReady
                        ? p.sandboxEngine === 'sandbox-exec'
                          ? 'sandbox-exec (macOS)'
                          : p.sandboxEngine === 'windows-mxc'
                            ? 'MXC (Windows)'
                            : 'bwrap (Linux)'
                        : t('config.agents.sandboxUnavailable')}
                    </dd>
                  </div>
                  {runtime && (
                    <div className="flex justify-between gap-2">
                      <dt style={{ color: 'var(--text-secondary)' }}>
                        {t('config.agents.parallelPool')}
                      </dt>
                      <dd className="font-mono-token font-semibold">
                        {t('work.slotsActive', {
                          active: runtime.activeCount,
                          max: runtime.maxParallel,
                        })}
                      </dd>
                    </div>
                  )}
                </dl>

                {/* Usage windows with reset times */}
                <div className="border-t pt-3" style={{ borderColor: 'var(--border-subtle)' }}>
                  <h3 className="text-xs font-semibold" style={{ color: 'var(--text-secondary)' }}>
                    {t('config.agents.usageWindows')}
                  </h3>
                  {p.usage.available && p.usage.windows.length > 0 ? (
                    <ul className="mt-2 space-y-2.5">
                      {p.usage.windows.map((w, i) => {
                        const left = remainingPercent(w);
                        const reset = resetText(w.resetsAt);
                        return (
                          <li key={`${w.group}-${w.window}-${i}`} className="text-xs">
                            <div className="flex justify-between gap-2">
                              <span className="min-w-0 break-words font-medium">{w.label}</span>
                              <span
                                className="shrink-0 font-mono-token font-semibold"
                                style={{
                                  color:
                                    left !== null && left <= LOW_QUOTA_THRESHOLD
                                      ? 'var(--error)'
                                      : 'var(--text-primary)',
                                }}
                              >
                                {left !== null ? t('usage.left', { pct: left }) : 'n/a'}
                              </span>
                            </div>
                            {left !== null && (
                              <div
                                className="mt-1 h-2 w-full overflow-hidden rounded"
                                style={{ backgroundColor: 'var(--bg-well)' }}
                              >
                                <div
                                  className="h-full"
                                  style={{
                                    width: `${left}%`,
                                    backgroundColor:
                                      left > LOW_QUOTA_THRESHOLD ? 'var(--pass)' : 'var(--error)',
                                  }}
                                />
                              </div>
                            )}
                            {reset && (
                              <p className="mt-0.5" style={{ color: 'var(--text-secondary)' }}>
                                {reset}
                              </p>
                            )}
                          </li>
                        );
                      })}
                    </ul>
                  ) : (
                    <p className="mt-1.5 text-xs" style={{ color: 'var(--text-secondary)' }}>
                      {p.usage.error || t('config.agents.quotaUnavailable')}
                    </p>
                  )}
                </div>

                {/* Cross-link to Team roles using this CLI */}
                <div className="border-t pt-3 text-xs" style={{ borderColor: 'var(--border-subtle)' }}>
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span style={{ color: 'var(--text-secondary)' }}>
                      {t('config.agents.usedByLabel')}:{' '}
                      <strong className="font-medium text-foreground">
                        {usedByProfiles.length > 0
                          ? usedByProfiles.map((prof) => prof.name).join(', ')
                          : t('config.agents.usedByNone')}
                      </strong>
                    </span>
                    <button
                      type="button"
                      onClick={onOpenTeam}
                      className="inline-flex min-h-11 cursor-pointer items-center font-semibold underline underline-offset-2"
                      style={{ color: 'var(--accent)' }}
                    >
                      {t('config.agents.assignRoles')}
                    </button>
                  </div>
                </div>

                {/* Expandable Models list */}
                {p.models.length > 0 && (
                  <div className="border-t pt-3 text-xs" style={{ borderColor: 'var(--border-subtle)' }}>
                    <div className="flex items-center justify-between gap-2">
                      <span style={{ color: 'var(--text-secondary)' }}>
                        {t('config.agents.availableModels', { count: p.models.length })}
                      </span>
                      {p.models.length > 3 && (
                        <button
                          type="button"
                          aria-expanded={showAllModels}
                          onClick={() =>
                            setExpandedModels((prev) => ({ ...prev, [p.id]: !prev[p.id] }))
                          }
                          className="inline-flex min-h-11 cursor-pointer items-center font-medium underline underline-offset-2"
                          style={{ color: 'var(--accent)' }}
                        >
                          {showAllModels
                            ? t('config.agents.hideModels')
                            : t('config.agents.showAllModels')}
                        </button>
                      )}
                    </div>
                    {showAllModels ? (
                      <ul className="mt-2 space-y-1.5">
                        {p.models.map((m) => (
                          <li
                            key={m.id}
                            className="rounded-[4px] border px-2.5 py-1.5"
                            style={{
                              borderColor: 'var(--border-subtle)',
                              backgroundColor: 'var(--bg-well)',
                            }}
                          >
                            <div className="flex flex-wrap items-center justify-between gap-1">
                              <span className="font-medium text-foreground">{modelLabel(m)}</span>
                              {m.supportedEffortLevels.length > 0 && (
                                <span
                                  className="font-mono-token text-[11px]"
                                  style={{ color: 'var(--text-secondary)' }}
                                >
                                  {m.supportedEffortLevels.join(' / ')}
                                </span>
                              )}
                            </div>
                            {m.description && (
                              <p className="mt-0.5 text-[11px]" style={{ color: 'var(--text-secondary)' }}>
                                {m.description}
                              </p>
                            )}
                          </li>
                        ))}
                      </ul>
                    ) : (
                      <p className="mt-1 font-mono-token text-foreground">
                        {p.models
                          .slice(0, 5)
                          .map((m) => modelLabel(m))
                          .join(', ')}
                      </p>
                    )}
                  </div>
                )}
              </div>

              {/* Footer: Update CLI action */}
              {p.installed && (
                <div className="space-y-2 border-t pt-3" style={{ borderColor: 'var(--border-subtle)' }}>
                  <Button
                    type="button"
                    variant="outline"
                    className="w-full"
                    disabled={Boolean(updatingProviderId) || Boolean(runtime?.activeCount)}
                    onClick={() => onUpdateCli(p.id)}
                  >
                    {updatingProviderId === p.id
                      ? t('config.agents.updatingCli')
                      : t('config.agents.updateCli')}
                  </Button>
                  {updateSuccessProviderId === p.id && (
                    <p role="status" className="text-xs" style={{ color: 'var(--pass)' }}>
                      {t('config.agents.cliUpdated')}
                    </p>
                  )}
                  {updateErrorProviderId === p.id && updateErrorMessage && (
                    <p role="alert" className="break-words text-xs" style={{ color: 'var(--error)' }}>
                      {updateErrorMessage}
                    </p>
                  )}
                </div>
              )}
            </article>
          );
        })}
      </div>

      {/* Separate / extra accounts */}
      <section
        className="space-y-3 rounded-[8px] border p-5"
        style={{ backgroundColor: 'var(--bg-surface)', borderColor: 'var(--border-subtle)' }}
      >
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 className="text-base font-semibold">{t('config.agents.extraAccountsTitle')}</h2>
            <p className="mt-0.5 text-sm" style={{ color: 'var(--text-secondary)' }}>
              {t('config.agents.extraAccountsDesc')}
            </p>
          </div>
          <Button type="button" variant="outline" onClick={onAddSeparateAccount}>
            {t('config.agents.addExtraAccount')}
          </Button>
        </div>

        {extraAccountProfiles.length === 0 ? (
          <p className="text-sm" style={{ color: 'var(--text-secondary)' }}>
            {t('config.agents.noExtraAccounts')}
          </p>
        ) : (
          <ul className="space-y-2">
            {extraAccountProfiles.map((prof) => (
              <li
                key={prof.id}
                className="flex flex-wrap items-center justify-between gap-3 rounded-[6px] border px-3.5 py-2.5 text-xs"
                style={{ borderColor: 'var(--border-subtle)', backgroundColor: 'var(--bg-well)' }}
              >
                <div className="flex min-w-0 flex-wrap items-center gap-2">
                  <ProviderIcon id={prof.provider} size={16} />
                  <span className="font-semibold">
                    {prof.name} ({providerDisplayShort(prof.provider)})
                  </span>
                  <code className="break-all font-mono-token" style={{ color: 'var(--text-secondary)' }}>
                    {configDirEnvHint(prof.provider)}={prof.configDir}
                  </code>
                </div>
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => onEditAccountProfile(prof)}
                >
                  {t('common.edit')}
                </Button>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
