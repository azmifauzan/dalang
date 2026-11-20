import { useEffect, useMemo, useRef, useState } from 'react';
import type { EffortLevel, ProviderId, ProviderModelInfo, ProviderStatus } from '@dalang/shared';
import { ProviderIcon } from '../assets/providers/ProviderIcon.js';
import { useI18n } from '../i18n/index.js';

/** "claude-opus-5-5" reads as "Claude Opus 5.5", like T3 Code; other providers keep their own names. */
function modelName(m: Pick<ProviderModelInfo, 'displayName' | 'resolvedModel'>): string {
  const claude = /^claude-([a-z]+)-(\d+)-(\d+)$/.exec(m.resolvedModel ?? '');
  if (!claude) return m.displayName;
  return `Claude ${claude[1].charAt(0).toUpperCase()}${claude[1].slice(1)} ${claude[2]}.${claude[3]}`;
}

/** Levels offered for the CLI default model, which reports none of its own. */
const BASE_LEVELS: EffortLevel[] = ['low', 'medium', 'high'];

export interface ModelPickerProps {
  provider: ProviderId;
  /** Empty string means the CLI's own default model. */
  model: string;
  /** Empty string means the model's default reasoning effort. */
  effort: EffortLevel | '';
  providers: ProviderStatus[];
  disabled?: boolean;
  onChange: (provider: ProviderId, model: string, effort: EffortLevel | '') => void;
}

/** Provider, model, and reasoning effort in one popover, after T3 Code's composer picker. */
export function ModelPicker({
  provider,
  model,
  effort,
  providers,
  disabled = false,
  onChange,
}: ModelPickerProps) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [viewProvider, setViewProvider] = useState<ProviderId>(provider);
  const [query, setQuery] = useState('');
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  const visibleProviders = useMemo(
    () => providers.filter((p) => p.installed || p.id === provider),
    [providers, provider],
  );
  const selectedModels = providers.find((p) => p.id === provider)?.models ?? [];
  const selectedInfo = selectedModels.find((m) => m.value === model) ?? null;
  const levels: EffortLevel[] = selectedInfo
    ? selectedInfo.supportedEffortLevels
    : BASE_LEVELS;

  const viewModels = (providers.find((p) => p.id === viewProvider)?.models ?? []).filter((m) => {
    const q = query.trim().toLowerCase();
    return !q || modelName(m).toLowerCase().includes(q) || m.value.toLowerCase().includes(q);
  });

  const close = (returnFocus: boolean) => {
    setOpen(false);
    setQuery('');
    if (returnFocus) triggerRef.current?.focus();
  };

  useEffect(() => {
    if (!open) return;
    searchRef.current?.focus();
    const onPointerDown = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) close(false);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close(true);
    };
    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  const effortLabel = (level: EffortLevel | '') =>
    level === '' ? t('sessions.picker.effortDefault') : t(`sessions.picker.effort.${level}`);

  const chosenName = selectedInfo ? modelName(selectedInfo) : model || t('common.cliDefault');
  const triggerLabel = effort ? `${chosenName} · ${effortLabel(effort)}` : chosenName;

  const pickModel = (nextProvider: ProviderId, value: string) => {
    const info = providers.find((p) => p.id === nextProvider)?.models.find((m) => m.value === value);
    const allowed = info ? info.supportedEffortLevels : BASE_LEVELS;
    onChange(nextProvider, value, effort && allowed.includes(effort) ? effort : '');
  };

  const rowStyle = (active: boolean) => ({
    backgroundColor: active ? 'var(--accent-tint)' : 'transparent',
    color: 'var(--text-primary)',
  });

  return (
    <div ref={rootRef} className="relative">
      <button
        ref={triggerRef}
        type="button"
        disabled={disabled}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={t('sessions.picker.title')}
        onClick={() => {
          setViewProvider(provider);
          setOpen((v) => !v);
        }}
        className="inline-flex min-h-11 max-w-[14rem] cursor-pointer items-center gap-2 rounded-[6px] border px-2.5 text-xs font-semibold transition-colors duration-150 disabled:cursor-not-allowed disabled:opacity-50 sm:max-w-[20rem]"
        style={{
          borderColor: 'var(--border-control)',
          backgroundColor: 'var(--bg-surface)',
          color: 'var(--text-primary)',
        }}
      >
        <ProviderIcon id={provider} size={18} />
        <span className="truncate">{triggerLabel}</span>
      </button>

      {open && (
        <div
          role="dialog"
          aria-label={t('sessions.picker.title')}
          className="fixed inset-x-4 bottom-4 z-30 flex max-h-[min(26rem,70dvh)] flex-col overflow-hidden rounded-[10px] border sm:flex-row lg:absolute lg:inset-x-auto lg:right-0 lg:bottom-full lg:mb-2 lg:w-[38rem]"
          style={{
            backgroundColor: 'var(--bg-surface)',
            borderColor: 'var(--border-control)',
          }}
        >
          <div
            role="group"
            aria-label={t('sessions.picker.providers')}
            className="flex shrink-0 flex-row gap-1 border-b p-2 sm:flex-col sm:border-r sm:border-b-0"
            style={{ borderColor: 'var(--border-subtle)', backgroundColor: 'var(--bg-well)' }}
          >
            {visibleProviders.map((p) => (
              <button
                key={p.id}
                type="button"
                aria-label={p.displayName}
                title={p.displayName}
                aria-pressed={viewProvider === p.id}
                onClick={() => {
                  setViewProvider(p.id);
                  setQuery('');
                }}
                className="inline-flex h-11 w-11 cursor-pointer items-center justify-center rounded-[6px] border"
                style={{
                  borderColor: viewProvider === p.id ? 'var(--accent)' : 'transparent',
                  backgroundColor: viewProvider === p.id ? 'var(--bg-surface)' : 'transparent',
                }}
              >
                <ProviderIcon id={p.id} size={24} />
              </button>
            ))}
          </div>

          <div className="flex min-h-0 min-w-0 flex-1 flex-col">
            <input
              ref={searchRef}
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={t('sessions.picker.search')}
              aria-label={t('sessions.picker.search')}
              className="min-h-11 w-full border-0 border-b bg-transparent px-3 text-sm outline-none focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-[var(--focus-ring)]"
              style={{ borderColor: 'var(--border-subtle)', color: 'var(--text-primary)' }}
            />
            <ul className="min-h-0 flex-1 overflow-y-auto p-1.5">
              {!query.trim() && (
                <li>
                  <button
                    type="button"
                    aria-pressed={provider === viewProvider && model === ''}
                    onClick={() => pickModel(viewProvider, '')}
                    className="flex min-h-11 w-full cursor-pointer items-center justify-between gap-2 rounded-[6px] px-2.5 text-left text-sm"
                    style={rowStyle(provider === viewProvider && model === '')}
                  >
                    <span>{t('common.cliDefault')}</span>
                    {provider === viewProvider && model === '' && <span aria-hidden="true">✓</span>}
                  </button>
                </li>
              )}
              {viewModels.map((m) => {
                const active = provider === viewProvider && model === m.value;
                return (
                  <li key={m.id}>
                    <button
                      type="button"
                      aria-pressed={active}
                      onClick={() => pickModel(viewProvider, m.value)}
                      className="flex min-h-11 w-full cursor-pointer items-center justify-between gap-2 rounded-[6px] px-2.5 text-left text-sm"
                      style={rowStyle(active)}
                    >
                      <span className="truncate">{modelName(m)}</span>
                      {active && <span aria-hidden="true">✓</span>}
                    </button>
                  </li>
                );
              })}
              {viewModels.length === 0 && query.trim() && (
                <li className="px-2.5 py-3 text-sm" style={{ color: 'var(--text-secondary)' }}>
                  {t('sessions.picker.noModels')}
                </li>
              )}
            </ul>
          </div>

          <div
            className="flex shrink-0 flex-col border-t sm:w-44 sm:border-t-0 sm:border-l"
            style={{ borderColor: 'var(--border-subtle)' }}
          >
            <div
              className="flex min-h-11 items-center justify-between gap-2 border-b px-3 text-xs font-semibold"
              style={{ borderColor: 'var(--border-subtle)', color: 'var(--text-secondary)' }}
            >
              <span>{t('sessions.picker.reasoning')}</span>
              <span>{effortLabel(effort)}</span>
            </div>
            <ul className="overflow-y-auto p-1.5">
              {(['', ...levels] as Array<EffortLevel | ''>).map((level) => {
                const active = effort === level;
                return (
                  <li key={level || 'default'}>
                    <button
                      type="button"
                      aria-pressed={active}
                      onClick={() => {
                        onChange(provider, model, level);
                        close(true);
                      }}
                      className="flex min-h-11 w-full cursor-pointer items-center justify-between gap-2 rounded-[6px] px-2.5 text-left text-sm"
                      style={rowStyle(active)}
                    >
                      <span>{effortLabel(level)}</span>
                      {active && <span aria-hidden="true">✓</span>}
                    </button>
                  </li>
                );
              })}
            </ul>
          </div>
        </div>
      )}
    </div>
  );
}
