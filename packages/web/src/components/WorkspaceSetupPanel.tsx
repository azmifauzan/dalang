import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { WorkspaceSetupConfig, WorkspaceSetupDTO } from '@dalang/shared';
import { api } from '../lib/api.js';
import { useI18n } from '../i18n/index.js';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';

/** What prepares each task worktree: the same decision as `/setup` in the terminal room. */
export function WorkspaceSetupPanel({ projectId, onlyWhenUndecided = false }: { projectId: string; onlyWhenUndecided?: boolean }) {
  const { t } = useI18n();
  const qc = useQueryClient();
  const queryKey = ['workspace-setup', projectId];
  const { data } = useQuery({ queryKey, queryFn: () => api.getWorkspaceSetup(projectId) });
  const [command, setCommand] = useState('');
  const [maintenance, setMaintenance] = useState('');
  const [files, setFiles] = useState('');
  const [check, setCheck] = useState('');

  const shown = data?.approved ?? data?.proposal ?? null;
  const shownKey = JSON.stringify(shown);
  useEffect(() => {
    setCommand(shown?.command ?? '');
    setMaintenance(shown?.maintenanceCommand ?? '');
    setFiles((shown?.files ?? []).join('\n'));
    setCheck(data?.proposal?.checkCommand ?? data?.approved?.checkCommand ?? '');
    // Reset the drafts only when the saved or proposed setup changes, not while the user types.
  }, [shownKey]);

  const apply = (next: WorkspaceSetupDTO) => qc.setQueryData(queryKey, next);
  const save = useMutation({ mutationFn: (config: WorkspaceSetupConfig) => api.setWorkspaceSetup(projectId, config), onSuccess: apply });
  const reset = useMutation({ mutationFn: () => api.resetWorkspaceSnapshot(projectId), onSuccess: apply });

  if (!data || (onlyWhenUndecided && !data.needsApproval)) return null;
  const error = (save.error ?? reset.error) as Error | null;
  const pending = save.isPending || reset.isPending;

  return (
    <section className="space-y-3 rounded-[4px] border p-4" style={{ borderColor: 'var(--border-subtle)' }}>
      <h2 className="text-sm font-semibold">{t('setup.title')}</h2>
      <p className="text-sm" style={{ color: 'var(--text-secondary)' }}>
        {data.needsApproval ? t('setup.proposed', { source: data.proposal?.source ?? '' }) : t('setup.desc')}
      </p>
      <div className="space-y-1.5">
        <Label htmlFor="setup-check">{t('setup.check')}</Label>
        <Textarea id="setup-check" rows={1} className="font-mono text-xs" value={check} onChange={(e) => setCheck(e.target.value)} />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="setup-command">{t('setup.command')}</Label>
        <Textarea id="setup-command" rows={2} className="font-mono text-xs" value={command} onChange={(e) => setCommand(e.target.value)} />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="setup-maintenance">{t('setup.maintenance')}</Label>
        <Textarea id="setup-maintenance" rows={1} className="font-mono text-xs" value={maintenance} onChange={(e) => setMaintenance(e.target.value)} />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="setup-files">{t('setup.files')}</Label>
        <Textarea id="setup-files" rows={2} className="font-mono text-xs" value={files} onChange={(e) => setFiles(e.target.value)} />
      </div>
      {data.warnings.map((warning) => (
        <p key={warning} className="text-sm" style={{ color: 'var(--error)' }}>{warning}</p>
      ))}
      {error && <p className="text-sm" style={{ color: 'var(--error)' }}>{error.message}</p>}
      <div className="flex flex-wrap gap-2">
        <Button
          type="button"
          disabled={pending}
          onClick={() =>
            save.mutate({
              command: command.trim() || null,
              maintenanceCommand: maintenance.trim() || null,
              checkCommand: check.trim() || null,
              files: files.split('\n').map((f) => f.trim()).filter(Boolean),
            })
          }
        >
          {t('setup.save')}
        </Button>
        <Button type="button" variant="outline" disabled={pending} onClick={() => save.mutate({ command: null, maintenanceCommand: null, checkCommand: check.trim() || null, files: [] })}>
          {t('setup.builtin')}
        </Button>
        {data.hasSnapshot && (
          <Button type="button" variant="outline" disabled={pending} onClick={() => reset.mutate()}>
            {t('setup.resetSnapshot')}
          </Button>
        )}
      </div>
    </section>
  );
}
