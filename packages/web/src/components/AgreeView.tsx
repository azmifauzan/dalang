import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState, type FormEvent } from 'react';
import type { BriefContent, BriefDTO, ProjectSummary } from '@dalang/shared';
import { useI18n } from '../i18n/index.js';
import { api } from '../lib/api.js';
import { EmptyPanel, ErrorPanel, LoadingPanel, ModalDialog } from './StateViews.js';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Input } from '@/components/ui/input';
import { NativeSelect } from '@/components/ui/native-select';
import { Textarea } from '@/components/ui/textarea';

function linesToArray(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
}

function arrayToLines(items: string[]): string {
  return items.join('\n');
}

export function AgreeView({
  project,
  onGoToDiscuss,
  onGoToList,
}: {
  project: ProjectSummary;
  onGoToDiscuss: () => void;
  onGoToList: () => void;
}) {
  const qc = useQueryClient();
  const { t, te } = useI18n();
  const [selectedVersion, setSelectedVersion] = useState<number | null>(null);
  const [draft, setDraft] = useState<BriefContent | null>(null);
  const [reviseOpen, setReviseOpen] = useState(false);
  const [reviseNote, setReviseNote] = useState('');
  const [saveNotice, setSaveNotice] = useState<string | null>(null);

  const briefsQuery = useQuery({
    queryKey: ['briefs', project.id],
    queryFn: () => api.listBriefs(project.id),
  });

  const briefs = briefsQuery.data?.briefs ?? [];
  const activeBrief: BriefDTO | undefined =
    briefs.find((b) => b.version === selectedVersion) ?? briefs[0];

  useEffect(() => {
    if (activeBrief) {
      setSelectedVersion(activeBrief.version);
      setDraft(activeBrief.content);
    } else {
      setDraft(null);
    }
  }, [activeBrief?.id, activeBrief?.version]);

  const saveMutation = useMutation({
    mutationFn: (content: BriefContent) =>
      api.updateBrief(project.id, activeBrief!.version, content),
    onSuccess: () => {
      setSaveNotice(t('brief.savedNotice'));
      qc.invalidateQueries({ queryKey: ['briefs', project.id] });
    },
  });

  const reviseMutation = useMutation({
    mutationFn: (note: string) =>
      api.reviseBrief(project.id, activeBrief!.version, note),
    onSuccess: ({ brief }) => {
      setReviseOpen(false);
      setReviseNote('');
      setSelectedVersion(brief.version);
      setDraft(brief.content);
      qc.invalidateQueries({ queryKey: ['briefs', project.id] });
      qc.invalidateQueries({ queryKey: ['projects'] });
    },
  });

  const approveMutation = useMutation({
    mutationFn: () => api.approveBrief(project.id, activeBrief!.version),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['briefs', project.id] });
      qc.invalidateQueries({ queryKey: ['projects'] });
    },
  });

  const generatePlanMutation = useMutation({
    mutationFn: () => api.generatePlan(project.id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['plan', project.id] });
      qc.invalidateQueries({ queryKey: ['projects'] });
      onGoToList();
    },
  });

  const isLocked = activeBrief?.status === 'approved';

  return (
    <div className="space-y-5">
      <div
        className="flex flex-wrap items-center justify-between gap-4 rounded-[8px] border p-4"
        style={{ backgroundColor: 'var(--bg-surface)', borderColor: 'var(--border-subtle)' }}
      >
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="text-lg font-semibold">{t('brief.title')}</h2>
            {activeBrief && (
              <Badge
                style={{
                  color: isLocked ? 'var(--pass)' : 'var(--text-primary)',
                  borderColor: isLocked ? 'var(--pass)' : 'var(--border-subtle)',
                }}
              >
                v{activeBrief.version} · {activeBrief.status.toUpperCase()}
              </Badge>
            )}
          </div>
          <p className="mt-1 text-sm" style={{ color: 'var(--text-secondary)' }}>
            {t('brief.subtitle')}
          </p>
        </div>

        {briefs.length > 0 && (
          <div className="flex flex-wrap items-center gap-2">
            <Label htmlFor="brief-version-select" className="text-xs font-medium">
              {t('brief.version')}
            </Label>
            <NativeSelect
              id="brief-version-select"
              value={activeBrief?.version ?? ''}
              onChange={(e) => setSelectedVersion(Number(e.target.value))}
              className="w-auto"
            >
              {briefs.map((b) => (
                <option key={b.id} value={b.version}>
                  v{b.version} ({te(b.status)})
                </option>
              ))}
            </NativeSelect>
          </div>
        )}
      </div>

      {briefsQuery.isLoading && <LoadingPanel label={t('brief.loading')} />}

      {briefsQuery.isError && (
        <ErrorPanel
          title={t('brief.loadError')}
          detail={briefsQuery.error.message}
          onRetry={() => briefsQuery.refetch()}
        />
      )}

      {!briefsQuery.isLoading && !briefsQuery.isError && !activeBrief && (
        <EmptyPanel
          title={t('brief.emptyTitle')}
          description={t('brief.emptyDesc')}
          action={
            <Button type="button" onClick={onGoToDiscuss}>
              {t('brief.goToDiscuss')}
            </Button>
          }
        />
      )}

      {activeBrief && draft && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            saveMutation.mutate(draft);
          }}
          className="space-y-5 rounded-[8px] border p-6"
          style={{ backgroundColor: 'var(--bg-surface)', borderColor: 'var(--border-subtle)' }}
        >
          <div
            className="flex flex-wrap items-center justify-between gap-3 border-b pb-4"
            style={{ borderColor: 'var(--border-subtle)' }}
          >
            <span className="font-mono-token text-xs" style={{ color: 'var(--text-secondary)' }}>
              {t('brief.fileLabel', { path: activeBrief.filePath })}
            </span>
            <div className="flex flex-wrap items-center gap-2">
              {!isLocked && (
                <>
                  <Button type="submit" disabled={saveMutation.isPending} variant="outline">
                    {saveMutation.isPending ? t('common.saving') : t('brief.saveEdits')}
                  </Button>
                  <Button
                    type="button"
                    onClick={() => setReviseOpen(true)}
                    disabled={reviseMutation.isPending}
                    variant="outline"
                  >
                    {t('brief.reviseWithLead')}
                  </Button>
                  <Button
                    type="button"
                    onClick={() => approveMutation.mutate()}
                    disabled={approveMutation.isPending}
                  >
                    {approveMutation.isPending ? t('brief.approving') : t('brief.approveBrief')}
                  </Button>
                </>
              )}

              {isLocked && (
                <>
                  <Button
                    type="button"
                    onClick={() => setReviseOpen(true)}
                    variant="outline"
                  >
                    {t('brief.createRevision', { version: activeBrief.version + 1 })}
                  </Button>
                  <Button
                    type="button"
                    onClick={() => generatePlanMutation.mutate()}
                    disabled={generatePlanMutation.isPending}
                  >
                    {generatePlanMutation.isPending
                      ? t('brief.generatingPlan')
                      : t('brief.generatePlan')}
                  </Button>
                </>
              )}
            </div>
          </div>

          {saveNotice && (
            <p className="text-sm font-medium" style={{ color: 'var(--pass)' }}>
              {saveNotice}
            </p>
          )}

          {(saveMutation.isError || approveMutation.isError || generatePlanMutation.isError) && (
            <ErrorPanel
              title={t('brief.actionFailed')}
              detail={
                saveMutation.error?.message ||
                approveMutation.error?.message ||
                generatePlanMutation.error?.message ||
                t('common.unknownError')
              }
            />
          )}

          <div className="grid grid-cols-1 gap-5 md:grid-cols-2">
            <div className="md:col-span-2">
              <Label htmlFor="brief-title" className="block text-sm font-medium">
                {t('brief.fieldTitle')}
              </Label>
              <Input
                id="brief-title"
                type="text"
                disabled={isLocked}
                value={draft.title}
                onChange={(e) => setDraft({ ...draft, title: e.target.value })}
                className="mt-1 font-semibold"
              />
            </div>

            <div className="md:col-span-2">
              <Label htmlFor="brief-summary" className="block text-sm font-medium">
                {t('brief.fieldSummary')}
              </Label>
              <Textarea
                id="brief-summary"
                rows={3}
                disabled={isLocked}
                value={draft.summary}
                onChange={(e) => setDraft({ ...draft, summary: e.target.value })}
                className="mt-1"
              />
            </div>

            <div>
              <Label htmlFor="brief-scope" className="block text-sm font-medium">
                {t('brief.fieldScope')}
              </Label>
              <Textarea
                id="brief-scope"
                rows={5}
                disabled={isLocked}
                value={arrayToLines(draft.scope)}
                onChange={(e) => setDraft({ ...draft, scope: linesToArray(e.target.value) })}
                className="mt-1"
              />
            </div>

            <div>
              <Label htmlFor="brief-features" className="block text-sm font-medium">
                {t('brief.fieldFeatures')}
              </Label>
              <Textarea
                id="brief-features"
                rows={5}
                disabled={isLocked}
                value={arrayToLines(draft.features)}
                onChange={(e) => setDraft({ ...draft, features: linesToArray(e.target.value) })}
                className="mt-1"
              />
            </div>

            <div>
              <Label htmlFor="brief-stack" className="block text-sm font-medium">
                {t('brief.fieldStack')}
              </Label>
              <Textarea
                id="brief-stack"
                rows={4}
                disabled={isLocked}
                value={arrayToLines(draft.stack)}
                onChange={(e) => setDraft({ ...draft, stack: linesToArray(e.target.value) })}
                className="mt-1"
              />
            </div>

            <div>
              <Label htmlFor="brief-constraints" className="block text-sm font-medium">
                {t('brief.fieldConstraints')}
              </Label>
              <Textarea
                id="brief-constraints"
                rows={4}
                disabled={isLocked}
                value={arrayToLines(draft.constraints)}
                onChange={(e) => setDraft({ ...draft, constraints: linesToArray(e.target.value) })}
                className="mt-1"
              />
            </div>

            <div>
              <Label htmlFor="brief-oos" className="block text-sm font-medium">
                {t('brief.fieldOutOfScope')}
              </Label>
              <Textarea
                id="brief-oos"
                rows={4}
                disabled={isLocked}
                value={arrayToLines(draft.out_of_scope)}
                onChange={(e) =>
                  setDraft({ ...draft, out_of_scope: linesToArray(e.target.value) })
                }
                className="mt-1"
              />
            </div>

            <div>
              <Label htmlFor="brief-assumptions" className="block text-sm font-medium">
                {t('brief.fieldAssumptions')}
              </Label>
              <Textarea
                id="brief-assumptions"
                rows={4}
                disabled={isLocked}
                value={arrayToLines(draft.assumptions)}
                onChange={(e) =>
                  setDraft({ ...draft, assumptions: linesToArray(e.target.value) })
                }
                className="mt-1"
              />
            </div>
          </div>
        </form>
      )}

      <ModalDialog
        open={reviseOpen}
        title={t('brief.reviseModalTitle', { version: activeBrief?.version ?? '' })}
        onClose={() => setReviseOpen(false)}
      >
        <form
          onSubmit={(e: FormEvent) => {
            e.preventDefault();
            if (!reviseNote.trim()) return;
            reviseMutation.mutate(reviseNote.trim());
          }}
          className="space-y-4"
        >
          <div>
            <Label htmlFor="revise-note" className="block text-sm font-medium">
              {t('brief.reviseNoteLabel')}
            </Label>
            <Textarea
              id="revise-note"
              rows={4}
              required
              autoFocus
              value={reviseNote}
              onChange={(e) => setReviseNote(e.target.value)}
              placeholder={t('brief.revisePlaceholder')}
              className="mt-1"
            />
          </div>
          {reviseMutation.isError && (
            <p className="text-sm" style={{ color: 'var(--error)' }}>
              {reviseMutation.error.message}
            </p>
          )}
          <div className="flex justify-end gap-2">
            <Button type="button" onClick={() => setReviseOpen(false)} variant="outline">
              {t('common.cancel')}
            </Button>
            <Button
              type="submit"
              disabled={reviseMutation.isPending || !reviseNote.trim()}
            >
              {reviseMutation.isPending ? t('brief.revising') : t('brief.sendRevision')}
            </Button>
          </div>
        </form>
      </ModalDialog>
    </div>
  );
}
