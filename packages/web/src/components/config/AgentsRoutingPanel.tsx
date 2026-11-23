import { useMemo, useState } from 'react';
import type {
  AgentProfileDTO,
  RoutingRuleDTO,
  TaskComplexity,
  TaskRole,
} from '@dalang/shared';
import { ProviderIcon } from '../../assets/providers/ProviderIcon.js';
import { castDisplayName, characterForProfile } from '../../assets/wayang/WayangFigure.js';
import { useI18n } from '../../i18n/index.js';
import { providerBadgeStyle, providerDisplayShort } from '../../lib/activity.js';
import { describeFallback } from '../FallbackFields.js';
import { EmptyPanel } from '../StateViews.js';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { NativeSelect } from '@/components/ui/native-select';
import {
  COMPLEXITY_OPTIONS,
  ROLE_OPTIONS,
  simulateTaskRoute,
} from './agentHelpers.js';

export function AgentsRoutingPanel({
  rules,
  profiles,
  reordering,
  deletingId,
  onCreateRule,
  onEditRule,
  onDeleteRule,
  onMoveRule,
}: {
  rules: RoutingRuleDTO[];
  profiles: AgentProfileDTO[];
  reordering: boolean;
  deletingId: string | null;
  onCreateRule: () => void;
  onEditRule: (rule: RoutingRuleDTO) => void;
  onDeleteRule: (ruleId: string) => void;
  onMoveRule: (index: number, delta: -1 | 1) => void;
}) {
  const { t, te } = useI18n();
  const [simRole, setSimRole] = useState<TaskRole>('engineer');
  const [simComplexity, setSimComplexity] = useState<TaskComplexity>('high');
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);

  const simulated = useMemo(
    () =>
      simulateTaskRoute({
        role: simRole,
        complexity: simComplexity,
        profiles,
        rules,
      }),
    [simRole, simComplexity, profiles, rules],
  );

  const simFallbackText = describeFallback(simulated.fallback, t('common.cliDefault'));
  const simFallbackSourceLabel =
    simulated.fallbackSource === 'rule'
      ? t('config.routing.sourceRule', { n: simulated.matchedRuleIndex })
      : simulated.fallbackSource === 'profile'
        ? t('config.routing.sourceProfile')
        : simulated.fallbackSource === 'lead'
          ? t('config.routing.sourceLead')
          : null;

  return (
    <div className="space-y-5">
      {/* Live Route Simulator */}
      {profiles.length > 0 && (
        <section
          aria-labelledby="route-simulator-heading"
          className="space-y-3 rounded-[8px] border p-5"
          style={{ backgroundColor: 'var(--bg-surface)', borderColor: 'var(--border-subtle)' }}
        >
          <div>
            <h2 id="route-simulator-heading" className="text-base font-semibold">
              {t('config.routing.simulatorTitle')}
            </h2>
            <p className="mt-0.5 text-sm" style={{ color: 'var(--text-secondary)' }}>
              {t('config.routing.simulatorDesc')}
            </p>
          </div>

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-[12rem_12rem_1fr]">
            <div className="space-y-1">
              <Label htmlFor="sim-role">{t('config.routing.fieldRole')}</Label>
              <NativeSelect
                id="sim-role"
                value={simRole}
                onChange={(e) => setSimRole(e.target.value as TaskRole)}
              >
                {ROLE_OPTIONS.map((r) => (
                  <option key={r} value={r}>
                    {te(r)}
                  </option>
                ))}
              </NativeSelect>
            </div>

            <div className="space-y-1">
              <Label htmlFor="sim-complexity">{t('config.routing.simComplexity')}</Label>
              <NativeSelect
                id="sim-complexity"
                value={simComplexity}
                onChange={(e) => setSimComplexity(e.target.value as TaskComplexity)}
              >
                {COMPLEXITY_OPTIONS.map((c) => (
                  <option key={c} value={c}>
                    {te(c)}
                  </option>
                ))}
              </NativeSelect>
            </div>

            <div
              className="flex flex-col justify-center gap-1 rounded-[6px] border px-3.5 py-2.5 text-xs"
              style={{ borderColor: 'var(--border-subtle)', backgroundColor: 'var(--bg-well)' }}
            >
              {simulated.primary ? (
                <>
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge>
                      {simulated.matchedRuleIndex > 0
                        ? t('config.routing.matchedRuleBadge', { n: simulated.matchedRuleIndex })
                        : t('config.routing.defaultMatchBadge')}
                    </Badge>
                    <span className="inline-flex items-center gap-1.5 text-sm font-semibold">
                      <ProviderIcon id={simulated.primary.provider} size={15} />
                      <span>
                        {castDisplayName(
                          characterForProfile(
                            simulated.primary.name,
                            simRole,
                            false,
                            simComplexity,
                          ),
                        )}{' '}
                        ({simulated.primary.name})
                      </span>
                    </span>
                    <span className="font-mono-token" style={{ color: 'var(--text-secondary)' }}>
                      {simulated.primary.model || t('common.cliDefault')} ·{' '}
                      {t(`sessions.picker.effort.${simulated.primary.effort}`)}
                    </span>
                  </div>
                  <div style={{ color: 'var(--text-secondary)' }}>
                    {t('config.agents.backupLabel')}:{' '}
                    <span className="font-medium text-foreground">
                      {simFallbackText ?? t('common.none')}
                    </span>
                    {simFallbackSourceLabel && <span> ({simFallbackSourceLabel})</span>}
                  </div>
                </>
              ) : (
                <span style={{ color: 'var(--text-secondary)' }}>
                  {t('config.team.emptyTitle')}
                </span>
              )}
            </div>
          </div>
        </section>
      )}

      {/* Priority rules header */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-base font-semibold">{t('config.routing.priorityHeading')}</h2>
          <p className="text-sm" style={{ color: 'var(--text-secondary)' }}>
            {t('config.routing.subtitle')}
          </p>
        </div>
        <Button type="button" disabled={profiles.length === 0} onClick={onCreateRule}>
          {t('config.routing.newRule')}
        </Button>
      </div>

      {rules.length === 0 ? (
        <EmptyPanel
          title={t('config.routing.emptyTitle')}
          description={t('config.routing.emptyDesc')}
          action={
            profiles.length > 0 ? (
              <Button type="button" onClick={onCreateRule}>
                {t('config.routing.newRule')}
              </Button>
            ) : undefined
          }
        />
      ) : (
        <ol className="space-y-3">
          {rules.map((rule, index) => {
            const primaryProf = profiles.find((p) => p.id === rule.profileId);
            const primaryCast = castDisplayName(
              characterForProfile(rule.profileName, rule.role, false, rule.complexity),
            );
            const ruleFallbackText = describeFallback(rule.fallback, t('common.cliDefault'));
            const profileFallbackText = primaryProf
              ? describeFallback(primaryProf.fallback, t('common.cliDefault'))
              : null;
            const isMatched = simulated.matchedRule?.id === rule.id;
            const confirming = confirmDeleteId === rule.id;

            const fallbackPart = ruleFallbackText
              ? t('config.routing.fallbackPart', {
                  target: ruleFallbackText,
                })
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
                className="flex flex-col justify-between gap-3 rounded-[8px] border p-4 lg:flex-row lg:items-center"
                style={{
                  backgroundColor: 'var(--bg-surface)',
                  borderColor: isMatched ? 'var(--accent)' : 'var(--border-subtle)',
                }}
              >
                <div className="min-w-0 flex-1 space-y-1.5">
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge>#{index + 1}</Badge>
                    <Badge>{te(rule.role)}</Badge>
                    <Badge>
                      {rule.complexity ? te(rule.complexity) : t('config.routing.anyComplexity')}
                    </Badge>
                    {primaryProf && (
                      <Badge style={providerBadgeStyle(primaryProf.provider)}>
                        {providerDisplayShort(primaryProf.provider)}
                      </Badge>
                    )}
                    {isMatched && (
                      <Badge
                        style={{
                          color: 'var(--accent)',
                          borderColor: 'var(--accent)',
                          backgroundColor: 'var(--accent-tint)',
                        }}
                      >
                        {t('config.routing.simMatchedTag')}
                      </Badge>
                    )}
                  </div>
                  <p className="text-sm font-medium">{sentence}</p>
                  {!ruleFallbackText && profileFallbackText && (
                    <p className="text-xs" style={{ color: 'var(--text-secondary)' }}>
                      {t('config.routing.inheritsProfileFallback', { target: profileFallbackText })}
                    </p>
                  )}
                </div>

                <div className="flex flex-wrap items-center gap-2">
                  {confirming ? (
                    <>
                      <Button
                        type="button"
                        variant="destructive"
                        disabled={deletingId === rule.id}
                        onClick={() => {
                          setConfirmDeleteId(null);
                          onDeleteRule(rule.id);
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
                        aria-label={t('config.routing.moveUp', { n: index + 1 })}
                        disabled={index === 0 || reordering}
                        onClick={() => onMoveRule(index, -1)}
                      >
                        {t('common.up')}
                      </Button>
                      <Button
                        type="button"
                        variant="outline"
                        aria-label={t('config.routing.moveDown', { n: index + 1 })}
                        disabled={index === rules.length - 1 || reordering}
                        onClick={() => onMoveRule(index, 1)}
                      >
                        {t('common.down')}
                      </Button>
                      <Button type="button" variant="outline" onClick={() => onEditRule(rule)}>
                        {t('common.edit')}
                      </Button>
                      <Button
                        type="button"
                        variant="destructive"
                        onClick={() => setConfirmDeleteId(rule.id)}
                      >
                        {t('common.delete')}
                      </Button>
                    </>
                  )}
                </div>
              </li>
            );
          })}
        </ol>
      )}
    </div>
  );
}
