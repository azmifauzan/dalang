import { useState } from 'react';
import type { ProviderStatus, UpdateSettingsInput } from '@dalang/shared';
import { useI18n } from '../../i18n/index.js';
import { AppLoginSettings } from '../AppLogin.js';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';

const BWRAP_COMMANDS = [
  'sudo apt install bubblewrap',
  'sudo dnf install bubblewrap',
];

export function SecurityTab({
  sandboxProvider,
  keyringAccess,
  savingSettings,
  settingsError,
  onUpdateSettings,
  onSignOut,
  signingOut,
}: {
  sandboxProvider: ProviderStatus | undefined;
  keyringAccess: boolean;
  savingSettings: boolean;
  settingsError: string | null;
  onUpdateSettings: (patch: UpdateSettingsInput) => void;
  onSignOut: () => void;
  signingOut: boolean;
}) {
  const { t } = useI18n();
  const [copiedCmd, setCopiedCmd] = useState<string | null>(null);

  const copyCommand = async (cmd: string) => {
    try {
      await navigator.clipboard.writeText(cmd);
      setCopiedCmd(cmd);
      setTimeout(() => setCopiedCmd(null), 1800);
    } catch {
      // Clipboard optional in non-secure contexts
    }
  };

  return (
    <section className="space-y-6">
      <header className="border-b pb-4" style={{ borderColor: 'var(--border-subtle)' }}>
        <h1 className="text-2xl font-semibold tracking-tight">{t('config.security.title')}</h1>
        <p className="mt-1 text-sm" style={{ color: 'var(--text-secondary)' }}>
          {t('config.security.subtitle')}
        </p>
      </header>

      {settingsError && (
        <div
          role="alert"
          className="rounded-[6px] border px-3.5 py-2.5 text-sm"
          style={{
            backgroundColor: 'var(--error-tint)',
            borderColor: 'var(--error)',
            color: 'var(--error)',
          }}
        >
          {settingsError}
        </div>
      )}

      {/* Card 1: Access control */}
      <div
        className="rounded-[8px] border p-5"
        style={{ backgroundColor: 'var(--bg-surface)', borderColor: 'var(--border-subtle)' }}
      >
        <AppLoginSettings onSignOut={onSignOut} signingOut={signingOut} />
      </div>

      {/* Card 2: Execution isolation & permissions */}
      <div
        className="divide-y divide-border rounded-[8px] border p-5"
        style={{ backgroundColor: 'var(--bg-surface)', borderColor: 'var(--border-subtle)' }}
      >
        {/* Sandbox state */}
        <div className="space-y-2.5 pb-5">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="text-base font-semibold">{t('config.security.sandboxTitle')}</h2>
            <Badge
              style={{
                color: sandboxProvider?.sandboxReady ? 'var(--pass)' : 'var(--error)',
                borderColor: sandboxProvider?.sandboxReady ? 'var(--pass)' : 'var(--error)',
                backgroundColor: sandboxProvider?.sandboxReady
                  ? 'var(--pass-tint)'
                  : 'var(--error-tint)',
              }}
            >
              {sandboxProvider?.sandboxReady
                ? sandboxProvider.sandboxEngine
                : t('config.agents.sandboxUnavailable')}
            </Badge>
          </div>
          <p className="max-w-2xl text-sm" style={{ color: 'var(--text-secondary)' }}>
            {sandboxProvider?.sandboxReady
              ? t('config.security.sandboxReadyDesc', { engine: sandboxProvider.sandboxEngine })
              : t('config.security.sandboxMissingDesc')}
          </p>
          {!sandboxProvider?.sandboxReady && (
            <div className="space-y-2 pt-1">
              <p className="text-xs font-medium" style={{ color: 'var(--text-secondary)' }}>
                {t('config.security.sandboxLinuxFix')}
              </p>
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                {BWRAP_COMMANDS.map((cmd) => (
                  <div
                    key={cmd}
                    className="flex flex-wrap items-center justify-between gap-2 rounded-[6px] border px-3 py-1.5"
                    style={{
                      borderColor: 'var(--border-subtle)',
                      backgroundColor: 'var(--bg-well)',
                    }}
                  >
                    <code className="min-w-0 flex-1 break-all font-mono-token text-xs">{cmd}</code>
                    <Button type="button" variant="outline" onClick={() => copyCommand(cmd)}>
                      {copiedCmd === cmd ? t('common.copied') : t('common.copy')}
                    </Button>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>

        {/* Antigravity desktop keyring */}
        <div className="space-y-2 py-5">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="text-base font-semibold">{t('config.security.agyTitle')}</h2>
            <Badge
              style={{
                color: keyringAccess ? 'var(--accent)' : 'var(--text-secondary)',
                borderColor: keyringAccess ? 'var(--accent)' : 'var(--border-subtle)',
                backgroundColor: keyringAccess ? 'var(--accent-tint)' : 'var(--bg-well)',
              }}
            >
              {keyringAccess ? t('config.security.stateEnabled') : t('config.security.stateOff')}
            </Badge>
          </div>
          <p className="max-w-2xl text-sm" style={{ color: 'var(--text-secondary)' }}>
            {t('config.security.agyDesc')}
          </p>
          <label className="flex min-h-11 cursor-pointer items-center gap-3 pt-1 text-sm font-medium">
            <input
              id="security-agy-keyring"
              type="checkbox"
              className="h-4 w-4 accent-[var(--primary)]"
              checked={keyringAccess}
              disabled={savingSettings}
              onChange={(e) => onUpdateSettings({ antigravityKeyringAccess: e.target.checked })}
            />
            <span>{t('config.security.agyToggle')}</span>
          </label>
        </div>

        {/* Unconfined policy */}
        <div className="space-y-2 pt-5">
          <h2 className="text-base font-semibold">{t('config.security.unconfinedTitle')}</h2>
          <p className="max-w-2xl text-sm" style={{ color: 'var(--text-secondary)' }}>
            {t('config.security.unconfinedDesc')}
          </p>
        </div>
      </div>
    </section>
  );
}
