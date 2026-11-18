import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/api.js';
import { EmptyPanel, ErrorPanel, LoadingPanel } from './StateViews.js';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';

export function ProvidersView() {
  const qc = useQueryClient();
  const providersQuery = useQuery({
    queryKey: ['providers-status'],
    queryFn: () => api.getProvidersStatus(),
  });

  const profilesQuery = useQuery({
    queryKey: ['profiles'],
    queryFn: () => api.listProfiles(),
  });

  const refreshMutation = useMutation({
    mutationFn: () => api.refreshProvidersStatus(),
    onSuccess: (data) => {
      qc.setQueryData(['providers-status'], data);
    },
  });

  const providers = providersQuery.data?.providers ?? [];
  const profiles = profilesQuery.data?.profiles ?? [];

  return (
    <div className="space-y-8">
      {/* Provider Status Section (F-22) */}
      <section aria-labelledby="providers-heading" className="space-y-4">
        <div
          className="flex flex-wrap items-center justify-between gap-4 rounded-md border p-4"
          style={{
            backgroundColor: 'var(--bg-surface)',
            borderColor: 'var(--border-subtle)',
          }}
        >
          <div>
            <h1 id="providers-heading" className="text-lg font-semibold">
              Provider Status & Quotas
            </h1>
            <p className="mt-1 text-sm" style={{ color: 'var(--text-secondary)' }}>
              Checks official local CLI binaries, login state, bubblewrap sandbox readiness, and live quota windows.
            </p>
          </div>
          <Button
            type="button"
            onClick={() => refreshMutation.mutate()}
            disabled={refreshMutation.isPending}
          >
            {refreshMutation.isPending ? 'Checking CLIs...' : 'Refresh CLI status'}
          </Button>
        </div>

        {providersQuery.isLoading && (
          <LoadingPanel label="Probing claude, codex, agy, and bwrap on this machine..." />
        )}

        {providersQuery.isError && (
          <ErrorPanel
            title="Failed to check providers"
            detail={providersQuery.error.message}
            onRetry={() => providersQuery.refetch()}
          />
        )}

        {!providersQuery.isLoading && !providersQuery.isError && (
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
            {providers.map((p) => (
              <article
                key={p.id}
                className="flex flex-col justify-between rounded-md border p-5"
                style={{
                  backgroundColor: 'var(--bg-surface)',
                  borderColor: 'var(--border-subtle)',
                }}
              >
                <div>
                  <div className="flex items-start justify-between gap-2">
                    <div>
                      <h2 className="text-base font-semibold">{p.displayName}</h2>
                      <p className="font-mono-token text-xs" style={{ color: 'var(--text-secondary)' }}>
                        {p.binaryPath || p.binary}
                      </p>
                    </div>
                    <Badge

                      style={{
                        color: p.installed && p.loggedIn ? 'var(--pass)' : 'var(--error)',
                        borderColor: p.installed && p.loggedIn ? 'var(--pass)' : 'var(--error)',
                      }}
                    >
                      {!p.installed ? 'MISSING' : p.loggedIn ? 'READY' : 'LOGIN NEEDED'}
                    </Badge>
                  </div>

                  <dl className="mt-4 space-y-2 text-sm">
                    <div className="flex justify-between gap-2">
                      <dt style={{ color: 'var(--text-secondary)' }}>Version</dt>
                      <dd className="font-mono-token text-xs">{p.version || 'N/A'}</dd>
                    </div>
                    <div className="flex justify-between gap-2">
                      <dt style={{ color: 'var(--text-secondary)' }}>Auth</dt>
                      <dd className="text-right text-xs">{p.authSummary}</dd>
                    </div>
                    <div className="flex justify-between gap-2">
                      <dt style={{ color: 'var(--text-secondary)' }}>bwrap sandbox</dt>
                      <dd
                        className="text-xs font-semibold"
                        style={{ color: p.sandboxReady ? 'var(--pass)' : 'var(--error)' }}
                      >
                        {p.sandboxReady ? 'Available' : 'Unavailable'}
                      </dd>
                    </div>
                  </dl>

                  {!p.sandboxReady && (
                    <p className="mt-3 text-xs" style={{ color: 'var(--error)' }}>
                      Without bwrap, a run is not confined to the project folder.
                    </p>
                  )}
                  {p.id === 'antigravity' && p.sandboxReady && (
                    <p className="mt-3 text-xs" style={{ color: 'var(--text-secondary)' }}>
                      agy signs in through a filtered desktop keyring proxy (needs xdg-dbus-proxy and a desktop session).
                    </p>
                  )}

                  {/* Usage / Quota windows */}
                  <div
                    className="mt-4 border-t pt-3"
                    style={{ borderColor: 'var(--border-subtle)' }}
                  >
                    <h3 className="text-xs font-semibold uppercase tracking-wide" style={{ color: 'var(--text-secondary)' }}>
                      Usage windows
                    </h3>
                    {p.usage.available && p.usage.windows.length > 0 ? (
                      <ul className="mt-2 space-y-2">
                        {p.usage.windows.map((w, i) => (
                          <li key={`${w.group}-${w.window}-${i}`} className="text-xs">
                            <div className="flex justify-between gap-2">
                              <span className="truncate font-medium">{w.label}</span>
                              <span className="font-mono-token shrink-0">
                                {w.remainingPercent !== null
                                  ? `${w.remainingPercent}% left`
                                  : w.usedPercent !== null
                                    ? `${w.usedPercent}% used`
                                    : 'unknown'}
                              </span>
                            </div>
                            {w.remainingPercent !== null && (
                              <div
                                className="mt-1 h-2 w-full overflow-hidden rounded"
                                style={{ backgroundColor: 'var(--bg-well)' }}
                              >
                                <div
                                  className="h-full"
                                  style={{
                                    width: `${w.remainingPercent}%`,
                                    backgroundColor:
                                      w.remainingPercent > 20 ? 'var(--pass)' : 'var(--error)',
                                  }}
                                />
                              </div>
                            )}
                          </li>
                        ))}
                      </ul>
                    ) : (
                      <p className="mt-2 text-xs" style={{ color: 'var(--text-secondary)' }}>
                        {p.usage.error || 'Quota check unavailable for this CLI.'}
                      </p>
                    )}
                  </div>
                </div>

                {p.models.length > 0 && (
                  <div
                    className="mt-4 border-t pt-3 text-xs"
                    style={{ borderColor: 'var(--border-subtle)', color: 'var(--text-secondary)' }}
                  >
                    Suggested models: <span className="font-mono-token">{p.models.slice(0, 4).join(', ')}</span>
                  </div>
                )}
              </article>
            ))}
          </div>
        )}
      </section>

      {/* Agent Profiles Section (supports F-10 task profile assignment) */}
      <section aria-labelledby="profiles-heading" className="space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div>
            <h2 id="profiles-heading" className="text-lg font-semibold">
              Agent Profiles
            </h2>
            <p className="text-sm" style={{ color: 'var(--text-secondary)' }}>
              Built-in provider and model pairs, assignable per task on the Kanban board. Editing profiles arrives in v0.3.
            </p>
          </div>
        </div>

        {profilesQuery.isLoading && <LoadingPanel label="Loading agent profiles..." />}
        {profilesQuery.isError && (
          <ErrorPanel
            title="Could not load profiles"
            detail={profilesQuery.error.message}
            onRetry={() => profilesQuery.refetch()}
          />
        )}

        {!profilesQuery.isLoading && !profilesQuery.isError && profiles.length === 0 && (
          <EmptyPanel
            title="No profiles found"
            description="The built-in profiles are seeded when the database is created. Restart DALANG to re-seed an empty profiles table."
          />
        )}

        {profiles.length > 0 && (
          <div className="overflow-x-auto rounded-md border" style={{ borderColor: 'var(--border-subtle)', backgroundColor: 'var(--bg-surface)' }}>
            <table className="w-full border-collapse text-left text-sm">
              <thead>
                <tr className="border-b" style={{ borderColor: 'var(--border-subtle)', backgroundColor: 'var(--bg-well)' }}>
                  <th className="px-4 py-3 font-semibold">Profile</th>
                  <th className="px-4 py-3 font-semibold">Provider</th>
                  <th className="px-4 py-3 font-semibold">Model</th>
                  <th className="px-4 py-3 font-semibold">Effort</th>
                  <th className="px-4 py-3 font-semibold">Permission</th>
                </tr>
              </thead>
              <tbody>
                {profiles.map((prof) => (
                  <tr key={prof.id} className="border-b last:border-b-0" style={{ borderColor: 'var(--border-subtle)' }}>
                    <td className="px-4 py-3 font-semibold">{prof.name}</td>
                    <td className="px-4 py-3 font-mono-token text-xs">{prof.provider}</td>
                    <td className="px-4 py-3 font-mono-token text-xs">{prof.model || 'CLI default'}</td>
                    <td className="px-4 py-3">{prof.effort}</td>
                    <td className="px-4 py-3 font-mono-token text-xs">{prof.permissionMode}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
