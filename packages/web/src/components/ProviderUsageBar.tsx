import { useEffect, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { DEFAULT_USAGE_REFRESH_MINUTES, type ProviderStatus, type UsageWindow } from '@dalang/shared';
import { ProviderIcon } from '../assets/providers/ProviderIcon.js';
import { useI18n } from '../i18n/index.js';
import { api } from '../lib/api.js';
import { Button } from '@/components/ui/button';

/** Percent left in a window, from whichever number the CLI reported. */
function remaining(w: UsageWindow): number | null {
  if (w.remainingPercent !== null) return w.remainingPercent;
  return w.usedPercent !== null ? 100 - w.usedPercent : null;
}

/** The tightest window of one kind across the provider's model groups. */
function tightest(windows: UsageWindow[], kind: string): number | null {
  const values = windows
    .filter((w) => w.window === kind)
    .map(remaining)
    .filter((v): v is number => v !== null);
  return values.length > 0 ? Math.min(...values) : null;
}

const LOW = 20;

function Percent({ value }: { value: number }) {
  return (
    <span
      className={value <= LOW ? 'font-bold' : 'font-semibold'}
      style={{ color: value <= LOW ? 'var(--error)' : 'var(--text-primary)' }}
    >
      {value}%
    </span>
  );
}

/** A slim line of the 5 hour and weekly limits per connected provider, with the full list on expand. */
export function ProviderUsageBar() {
  const { t, formatDateTime, formatTime } = useI18n();
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [panelMaxH, setPanelMaxH] = useState<number | undefined>(undefined);
  const rootRef = useRef<HTMLDivElement>(null);
  const toggleRef = useRef<HTMLButtonElement>(null);

  const statusQuery = useQuery({
    queryKey: ['providers-status'],
    queryFn: () => api.getProvidersStatus(),
  });
  const settingsQuery = useQuery({ queryKey: ['settings'], queryFn: () => api.getSettings() });
  const intervalMs =
    (settingsQuery.data?.settings.usageRefreshMinutes ?? DEFAULT_USAGE_REFRESH_MINUTES) * 60_000;
  const refreshMutation = useMutation({
    mutationFn: () => api.refreshProvidersStatus(),
    onSuccess: (data) => qc.setQueryData(['providers-status'], data),
  });

  // Keep the limits current: ask the CLIs again on the chosen interval while the page is in view, and as soon
  // as the page comes back into view if that long has passed.
  const refreshRef = useRef(refreshMutation);
  refreshRef.current = refreshMutation;
  const updatedAtRef = useRef(0);
  updatedAtRef.current = statusQuery.dataUpdatedAt;
  useEffect(() => {
    const refresh = () => {
      if (document.hidden || refreshRef.current.isPending) return;
      refreshRef.current.mutate();
    };
    const id = window.setInterval(refresh, intervalMs);
    // Coming back to a tab that sat in the background: refresh at once if the numbers are a minute old.
    const onVisible = () => {
      if (Date.now() - updatedAtRef.current >= intervalMs) refresh();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      window.clearInterval(id);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [intervalMs]);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setOpen(false);
        toggleRef.current?.focus();
      }
    };
    // The panel may use the space between the bar and the bottom of the window, whatever its size.
    const fit = () => {
      const bottom = rootRef.current?.getBoundingClientRect().bottom ?? 0;
      setPanelMaxH(Math.max(160, window.innerHeight - bottom - 12));
    };
    fit();
    window.addEventListener('resize', fit);
    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('resize', fit);
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  const providers = (statusQuery.data?.providers ?? []).filter((p) => p.installed);

  const resetText = (raw: string | null): string | null => {
    if (!raw) return null;
    // Claude reports a ready-made local string; Codex and Antigravity report ISO times.
    const text = /^\d{4}-\d{2}-\d{2}T/.test(raw) ? formatDateTime(raw) : raw;
    return t('usage.resets', { time: text });
  };

  const chip = (p: ProviderStatus) => {
    const five = tightest(p.usage.windows, '5h');
    const weekly = tightest(p.usage.windows, 'weekly');
    const parts: Array<{ label: string; value: number }> = [];
    if (five !== null) parts.push({ label: t('usage.fiveHour'), value: five });
    if (weekly !== null) parts.push({ label: t('usage.weekly'), value: weekly });
    return (
      <li
        key={p.id}
        className="flex min-h-11 items-center gap-2 text-xs"
        title={p.usage.error || p.authSummary}
      >
        <ProviderIcon id={p.id} size={16} />
        <span className="sr-only">{p.displayName}</span>
        {!p.loggedIn ? (
          <span style={{ color: 'var(--text-secondary)' }}>{t('usage.loginNeeded')}</span>
        ) : parts.length === 0 ? (
          <span style={{ color: 'var(--text-secondary)' }}>{t('config.agents.quotaUnavailable')}</span>
        ) : (
          <>
            {/* Narrow screens keep one number per provider: the tightest window. */}
            <span className="font-mono-token sm:hidden">
              <Percent value={Math.min(...parts.map((x) => x.value))} />
            </span>
            {parts.map((part) => (
              <span key={part.label} className="hidden font-mono-token sm:inline">
                <span style={{ color: 'var(--text-secondary)' }}>{part.label} </span>
                <Percent value={part.value} />
              </span>
            ))}
          </>
        )}
      </li>
    );
  };

  return (
    <div
      ref={rootRef}
      className="sticky top-0 z-20 -mx-4 -mt-5 border-b px-4 sm:-mx-6 sm:px-6 lg:-mx-8 lg:px-8"
      style={{ backgroundColor: 'var(--bg-canvas)', borderColor: 'var(--border-subtle)' }}
    >
      <div className="flex flex-wrap items-center justify-between gap-x-4">
        {statusQuery.isLoading ? (
          <p className="min-h-11 py-3 text-xs" style={{ color: 'var(--text-secondary)' }}>
            {t('usage.loading')}
          </p>
        ) : statusQuery.isError ? (
          <p className="min-h-11 py-3 text-xs" style={{ color: 'var(--text-secondary)' }}>
            {t('usage.error')}
          </p>
        ) : (
          <ul aria-label={t('usage.title')} className="flex flex-wrap items-center gap-x-5">
            {providers.map(chip)}
          </ul>
        )}

        <button
          ref={toggleRef}
          type="button"
          aria-expanded={open}
          aria-controls="provider-usage-details"
          onClick={() => setOpen((v) => !v)}
          className="inline-flex min-h-11 cursor-pointer items-center gap-1 rounded-[6px] px-2 text-xs font-semibold"
          style={{ color: 'var(--text-primary)' }}
        >
          {open ? t('usage.hide') : t('usage.details')}
          <span aria-hidden="true">{open ? '▴' : '▾'}</span>
        </button>
      </div>

      {open && (
        <div
          id="provider-usage-details"
          className="absolute inset-x-4 top-full z-30 mt-1 overflow-y-auto rounded-[10px] border p-4 sm:inset-x-6 lg:inset-x-8"
          style={{
            backgroundColor: 'var(--bg-surface)',
            borderColor: 'var(--border-control)',
            maxHeight: panelMaxH,
          }}
        >
          <div className="mb-3 flex items-center justify-between gap-3">
            <div className="min-w-0">
              <h2 className="text-sm font-semibold">{t('usage.title')}</h2>
              {statusQuery.dataUpdatedAt > 0 && (
                <p className="text-xs" style={{ color: 'var(--text-secondary)' }}>
                  {t('usage.updated', {
                    time: formatTime(new Date(statusQuery.dataUpdatedAt).toISOString()),
                    minutes: intervalMs / 60_000,
                  })}
                </p>
              )}
            </div>
            <Button
              type="button"
              variant="outline"
              disabled={refreshMutation.isPending}
              onClick={() => refreshMutation.mutate()}
            >
              {refreshMutation.isPending ? t('usage.refreshing') : t('common.refresh')}
            </Button>
          </div>

          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
            {providers.map((p) => (
              <section key={p.id} aria-label={p.displayName} className="min-w-0">
                <div className="flex items-center gap-2">
                  <ProviderIcon id={p.id} size={18} />
                  <h3 className="text-sm font-semibold">{p.displayName}</h3>
                </div>
                <p className="mt-0.5 truncate text-xs" style={{ color: 'var(--text-secondary)' }}>
                  {p.authSummary}
                </p>
                {!p.loggedIn ? (
                  <p className="mt-2 text-xs">{t('usage.loginNeeded')}</p>
                ) : p.usage.available && p.usage.windows.length > 0 ? (
                  <ul className="mt-2 space-y-2.5">
                    {p.usage.windows.map((w, i) => {
                      const left = remaining(w);
                      const reset = resetText(w.resetsAt);
                      return (
                        <li key={`${w.group}-${w.window}-${i}`} className="text-xs">
                          <div className="flex justify-between gap-2">
                            <span className="min-w-0 break-words font-medium">{w.label}</span>
                            <span
                              className="shrink-0 font-mono-token font-semibold"
                              style={{
                                color: left !== null && left <= LOW ? 'var(--error)' : 'var(--text-primary)',
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
                                  backgroundColor: left > LOW ? 'var(--pass)' : 'var(--error)',
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
                  <p className="mt-2 text-xs" style={{ color: 'var(--text-secondary)' }}>
                    {p.usage.error || t('config.agents.quotaUnavailable')}
                  </p>
                )}
              </section>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
