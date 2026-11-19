import {
  EFFORT_LEVEL_ORDER,
  type EffortLevel,
  type FallbackTarget,
  type ProviderId,
  type ProviderStatus,
} from '@dalang/shared';
import { useI18n } from '../i18n/index.js';
import { providerDisplayShort } from '../lib/activity.js';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { NativeSelect } from '@/components/ui/native-select';

/** Form state of a fallback target; an empty provider means "no fallback". */
export interface FallbackForm {
  provider: ProviderId | '';
  model: string;
  effort: EffortLevel;
  configDir: string;
}

export const EMPTY_FALLBACK: FallbackForm = { provider: '', model: '', effort: 'high', configDir: '' };

export function fallbackToForm(target: FallbackTarget | null): FallbackForm {
  return target
    ? { provider: target.provider, model: target.model, effort: target.effort, configDir: target.configDir ?? '' }
    : EMPTY_FALLBACK;
}

export function fallbackFromForm(form: FallbackForm): FallbackTarget | null {
  return form.provider
    ? { provider: form.provider, model: form.model.trim(), effort: form.effort, configDir: form.configDir.trim() || null }
    : null;
}

/** "Codex · gpt-5 · high" for a sentence or a table cell. */
export function describeFallback(target: FallbackTarget | null, cliDefault: string): string | null {
  if (!target) return null;
  return [
    providerDisplayShort(target.provider),
    target.model || cliDefault,
    target.effort,
    target.configDir ? target.configDir : null,
  ]
    .filter(Boolean)
    .join(' · ');
}

const PROVIDERS: ProviderId[] = ['claude-code', 'codex', 'antigravity'];

/** CLI, model, effort, and optional account for a fallback: the same role instructions run there. */
export function FallbackFields({
  idPrefix,
  value,
  onChange,
  providers,
}: {
  idPrefix: string;
  value: FallbackForm;
  onChange: (next: FallbackForm) => void;
  providers: ProviderStatus[];
}) {
  const { t } = useI18n();
  const models = value.provider ? (providers.find((p) => p.id === value.provider)?.models ?? []) : [];
  const info = models.find((m) => m.value === value.model);
  const efforts: readonly EffortLevel[] =
    info && info.supportedEffortLevels.length > 0 ? info.supportedEffortLevels : EFFORT_LEVEL_ORDER;
  const effortOptions = efforts.includes(value.effort) ? efforts : [value.effort, ...efforts];

  return (
    <div className="space-y-2">
      <div className="space-y-1.5">
        <Label htmlFor={`${idPrefix}-provider`}>{t('fallback.provider')}</Label>
        <NativeSelect
          id={`${idPrefix}-provider`}
          value={value.provider}
          onChange={(e) => {
            const provider = e.target.value as ProviderId | '';
            onChange({ ...value, provider, model: '', configDir: provider === value.provider ? value.configDir : '' });
          }}
        >
          <option value="">{t('common.none')}</option>
          {PROVIDERS.map((id) => (
            <option key={id} value={id}>
              {providerDisplayShort(id)}
            </option>
          ))}
        </NativeSelect>
      </div>
      {value.provider && (
        <>
          <div className="grid grid-cols-[1fr_auto] gap-2">
            <div className="space-y-1.5">
              <Label htmlFor={`${idPrefix}-model`}>{t('config.team.fieldModel')}</Label>
              <NativeSelect
                id={`${idPrefix}-model`}
                value={value.model}
                onChange={(e) => {
                  const next = models.find((m) => m.value === e.target.value);
                  const allowed = next && next.supportedEffortLevels.length > 0 ? next.supportedEffortLevels : EFFORT_LEVEL_ORDER;
                  onChange({
                    ...value,
                    model: e.target.value,
                    effort: allowed.includes(value.effort) ? value.effort : (next?.defaultEffort ?? (allowed[0] as EffortLevel)),
                  });
                }}
              >
                <option value="">{t('common.cliDefault')}</option>
                {value.model && !info && <option value={value.model}>{value.model}</option>}
                {models.map((m) => (
                  <option key={m.id} value={m.value}>
                    {m.displayName}
                  </option>
                ))}
              </NativeSelect>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor={`${idPrefix}-effort`}>{t('config.team.fieldEffort')}</Label>
              <NativeSelect
                id={`${idPrefix}-effort`}
                value={value.effort}
                onChange={(e) => onChange({ ...value, effort: e.target.value as EffortLevel })}
              >
                {effortOptions.map((lvl) => (
                  <option key={lvl} value={lvl}>
                    {lvl}
                  </option>
                ))}
              </NativeSelect>
            </div>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor={`${idPrefix}-dir`}>{t('config.team.fieldConfigDir')}</Label>
            <Input
              id={`${idPrefix}-dir`}
              value={value.configDir}
              onChange={(e) => onChange({ ...value, configDir: e.target.value })}
              placeholder={t('config.team.configDirPlaceholder')}
              className="font-mono-token text-sm"
            />
          </div>
        </>
      )}
    </div>
  );
}
