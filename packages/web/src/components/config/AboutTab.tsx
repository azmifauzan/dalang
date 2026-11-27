import { useState } from 'react';
import { DALANG_VERSION, type TriageContextPreviewDTO, type UpdateStatusDTO } from '@dalang/shared';
import { GununganDetailed } from '../../assets/wayang/Gunungan.js';
import { useI18n } from '../../i18n/index.js';
import { api } from '../../lib/api.js';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';

export function AboutTab({
  updateStatus,
  checkForUpdates,
  checkingUpdates,
  onForceUpdateCheck,
  onOpenGeneral,
  activeProjectId,
  onTriageSessionStarted,
}: {
  updateStatus: UpdateStatusDTO | null;
  checkForUpdates: boolean;
  checkingUpdates: boolean;
  onForceUpdateCheck: () => void;
  onOpenGeneral: () => void;
  activeProjectId?: string | null;
  onTriageSessionStarted?: (sessionId: string) => void;
}) {
  const { t } = useI18n();
  const [copiedCmd, setCopiedCmd] = useState<string | null>(null);
  const [triagePreview, setTriagePreview] = useState<TriageContextPreviewDTO | null>(null);
  const [triageNote, setTriageNote] = useState('');
  const [triageBusy, setTriageBusy] = useState(false);
  const [triageError, setTriageError] = useState<string | null>(null);

  const copyCommand = async (cmd: string) => {
    try {
      await navigator.clipboard.writeText(cmd);
      setCopiedCmd(cmd);
      setTimeout(() => setCopiedCmd(null), 1800);
    } catch {
      // Clipboard optional in non-secure contexts
    }
  };

  const version = updateStatus?.currentVersion ?? DALANG_VERSION;

  return (
    <section className="space-y-6">
      {/* Brand header with Gunungan */}
      <div
        className="flex flex-wrap items-center gap-5 rounded-[8px] border p-5"
        style={{ backgroundColor: 'var(--bg-surface)', borderColor: 'var(--border-subtle)' }}
      >
        <GununganDetailed size={108} label={t('common.gunungan')} />
        <div className="min-w-0 flex-1 space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="text-2xl font-semibold tracking-tight">{t('config.about.title')}</h1>
            <Badge>v{version}</Badge>
          </div>
          <p className="text-sm" style={{ color: 'var(--text-secondary)' }}>
            {t('config.about.subtitle')}
          </p>
        </div>
      </div>

      {/* Version & updates */}
      <div
        className="space-y-4 rounded-[8px] border p-5"
        style={{ backgroundColor: 'var(--bg-surface)', borderColor: 'var(--border-subtle)' }}
      >
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="text-base font-semibold">{t('config.about.versionTitle')}</h2>
            <p className="mt-0.5 text-sm" style={{ color: 'var(--text-secondary)' }}>
              {t('config.about.installedVersion', { version })}
            </p>
          </div>
          {checkForUpdates ? (
            <Button
              type="button"
              variant="outline"
              disabled={checkingUpdates}
              onClick={onForceUpdateCheck}
            >
              {checkingUpdates ? t('config.about.checking') : t('config.about.checkNow')}
            </Button>
          ) : (
            <Button type="button" variant="outline" onClick={onOpenGeneral}>
              {t('config.about.openGeneralUpdates')}
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
                  <code className="min-w-0 flex-1 break-all font-mono-token text-xs">{cmd}</code>
                  <Button type="button" variant="outline" onClick={() => copyCommand(cmd)}>
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
                className="inline-flex min-h-11 items-center text-sm font-medium underline underline-offset-2"
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

      {/* Report a problem (F6) */}
      <div
        className="space-y-3 rounded-[8px] border p-5"
        style={{ backgroundColor: 'var(--bg-surface)', borderColor: 'var(--border-subtle)' }}
      >
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="text-base font-semibold">{t('triage.title')}</h2>
            <p className="mt-0.5 text-sm" style={{ color: 'var(--text-secondary)' }}>
              {t('triage.desc')}
            </p>
          </div>
          <Button
            type="button"
            variant="outline"
            disabled={triageBusy}
            onClick={async () => {
              setTriageBusy(true);
              setTriageError(null);
              try {
                const res = await api.getTriagePreview();
                setTriagePreview(res.preview);
              } catch (err) {
                setTriageError(err instanceof Error ? err.message : String(err));
              } finally {
                setTriageBusy(false);
              }
            }}
          >
            {t('triage.previewBtn')}
          </Button>
        </div>
        {triageError && (
          <p role="alert" className="text-xs text-destructive">
            {triageError}
          </p>
        )}
        {triagePreview && (
          <div className="space-y-3 rounded-[6px] border p-3 text-xs" style={{ borderColor: 'var(--border-subtle)', backgroundColor: 'var(--bg-well)' }}>
            <div className="font-mono">
              DALANG v{triagePreview.version} · {triagePreview.os} · Node v{triagePreview.nodeVersion}
            </div>
            <ul className="space-y-0.5">
              {triagePreview.doctorChecks.map((c) => (
                <li key={c.id}>
                  [{c.status.toUpperCase()}] {c.label}: {c.detail}
                </li>
              ))}
            </ul>
            {triagePreview.serverLogTail && (
              <pre className="max-h-32 overflow-auto rounded border p-2 font-mono text-[11px]">
                {triagePreview.serverLogTail}
              </pre>
            )}
            <Textarea
              rows={2}
              value={triageNote}
              placeholder={t('triage.notePlaceholder')}
              onChange={(e) => setTriageNote(e.target.value)}
            />
            <div className="flex flex-wrap gap-2">
              <Button
                type="button"
                disabled={triageBusy || !activeProjectId}
                onClick={async () => {
                  if (!activeProjectId) return;
                  setTriageBusy(true);
                  setTriageError(null);
                  try {
                    const res = await api.startTriage(activeProjectId, {
                      confirmed: true,
                      ...(triageNote.trim() ? { note: triageNote.trim() } : {}),
                    });
                    setTriagePreview(null);
                    setTriageNote('');
                    onTriageSessionStarted?.(res.session.id);
                  } catch (err) {
                    setTriageError(err instanceof Error ? err.message : String(err));
                  } finally {
                    setTriageBusy(false);
                  }
                }}
              >
                {t('triage.startBtn')}
              </Button>
              <Button type="button" variant="outline" onClick={() => setTriagePreview(null)}>
                {t('common.cancel')}
              </Button>
            </div>
          </div>
        )}
      </div>

      {/* Balanced 2-column grid for Docs & Licences (RHYTHM 2 variation) */}
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <div
          className="space-y-3 rounded-[8px] border p-5"
          style={{ backgroundColor: 'var(--bg-surface)', borderColor: 'var(--border-subtle)' }}
        >
          <h2 className="text-base font-semibold">{t('config.about.docsTitle')}</h2>
          <ul className="flex flex-wrap gap-2 text-sm">
            {[
              {
                label: t('config.about.docInstall'),
                href: 'https://github.com/azmifauzan/dalang/blob/main/docs/INSTALL.md',
              },
              {
                label: t('config.about.docUsage'),
                href: 'https://github.com/azmifauzan/dalang/blob/main/docs/USAGE.md',
              },
              {
                label: t('config.about.docProviders'),
                href: 'https://github.com/azmifauzan/dalang/blob/main/docs/PROVIDERS.md',
              },
              {
                label: t('config.about.docSandbox'),
                href: 'https://github.com/azmifauzan/dalang/blob/main/docs/SANDBOX.md',
              },
              {
                label: t('config.about.docTroubleshooting'),
                href: 'https://github.com/azmifauzan/dalang/blob/main/docs/TROUBLESHOOTING.md',
              },
            ].map((doc) => (
              <li key={doc.href}>
                <a
                  href={doc.href}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex min-h-11 items-center rounded-[6px] border px-3 underline-offset-2 transition-colors duration-150 hover:bg-muted hover:underline"
                  style={{ borderColor: 'var(--border-control)', color: 'var(--accent)' }}
                >
                  {doc.label}
                </a>
              </li>
            ))}
          </ul>
        </div>

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
      </div>
    </section>
  );
}
