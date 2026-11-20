import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { GununganMark } from '../assets/wayang/Gunungan.js';
import { useI18n } from '../i18n/index.js';
import { api } from '../lib/api.js';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

export function AppLogin() {
  const { t } = useI18n();
  const qc = useQueryClient();
  const [password, setPassword] = useState('');
  const login = useMutation({
    mutationFn: () => api.login(password),
    onSuccess: (status) => qc.setQueryData(['auth-status'], status),
  });

  return (
    <main className="grid min-h-dvh place-items-center p-4">
      <form
        className="w-full max-w-sm space-y-4 rounded-lg border border-input bg-card p-5"
        onSubmit={(e) => { e.preventDefault(); if (!login.isPending) login.mutate(); }}
      >
        <header className="flex flex-col items-center gap-3 text-center">
          <GununganMark size={48} />
          <h1 className="text-xl font-semibold">{t('auth.signInTitle')}</h1>
        </header>
        <div className="space-y-2">
          <Label htmlFor="login-password">{t('auth.password')}</Label>
          <Input id="login-password" type="password" autoComplete="current-password" required maxLength={256}
            value={password} onChange={(e) => setPassword(e.target.value)} disabled={login.isPending} />
        </div>
        {login.isError && <p role="alert" className="text-sm text-destructive">{login.error.message}</p>}
        <Button type="submit" className="w-full" disabled={login.isPending}>
          {t(login.isPending ? 'auth.signingIn' : 'auth.signIn')}
        </Button>
      </form>
    </main>
  );
}

export function AppLoginSettings({ onSignOut, signingOut }: { onSignOut: () => void; signingOut: boolean }) {
  const { t } = useI18n();
  const qc = useQueryClient();
  const auth = useQuery({ queryKey: ['auth-status'], queryFn: api.authStatus });
  const [password, setPassword] = useState('');
  const update = useMutation({
    mutationFn: (action: 'enable' | 'disable') =>
      api.setLogin(action === 'enable' ? { enabled: true, password } : { enabled: false }),
    onSuccess: (status) => {
      setPassword('');
      qc.setQueryData(['auth-status'], status);
    },
  });

  return (
    <section className="space-y-3" aria-labelledby="app-login-heading">
      <h2 id="app-login-heading" className="text-base font-semibold">{t('auth.settingsHeading')}</h2>
      <p className="text-sm text-muted-foreground">{t('auth.settingsDescription')}</p>
      {auth.data?.enabled ? (
        <div className="flex flex-wrap gap-2">
          <Button type="button" variant="outline" disabled={update.isPending || signingOut} onClick={onSignOut}>
            {t('auth.signOut')}
          </Button>
          <Button type="button" variant="outline" disabled={update.isPending || signingOut} onClick={() => update.mutate('disable')}>
            {t('auth.disable')}
          </Button>
        </div>
      ) : auth.data && (
        <form className="flex flex-wrap items-end gap-3"
          onSubmit={(e) => { e.preventDefault(); if (!update.isPending) update.mutate('enable'); }}>
          <div className="grid w-full max-w-sm gap-2">
            <Label htmlFor="new-login-password">{t('auth.newPassword')}</Label>
            <Input id="new-login-password" type="password" autoComplete="new-password" required minLength={12} maxLength={256}
              value={password} onChange={(e) => setPassword(e.target.value)} disabled={update.isPending} />
          </div>
          <Button type="submit" disabled={update.isPending}>{t('auth.enable')}</Button>
        </form>
      )}
      {update.isError && <p role="alert" className="text-sm text-destructive">{update.error.message}</p>}
    </section>
  );
}
