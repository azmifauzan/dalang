import { useEffect, useState } from 'react';
import type { ProjectSummary, ProviderId, SessionMode, SessionSummaryDTO } from '@dalang/shared';
import { ProviderIcon } from '../assets/providers/ProviderIcon.js';
import { PROVIDER_LABELS } from '../assets/providers/names.js';
import { useI18n } from '../i18n/index.js';
import { ModalDialog } from './StateViews.js';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';

export interface SessionHeaderProps {
  project: ProjectSummary;
  session: SessionSummaryDTO | null;
  draftMode: SessionMode;
  /** The CLI this chat uses (or will use for the next message), not the project's default. */
  provider: ProviderId;
  onRenameSession: (title: string) => void;
  onToggleArchiveSession: (archived: boolean) => void;
  onDeleteSession: () => void;
  onDiscardWork: () => void;
  onEditProjectMd: () => void;
  onRemoveProject: () => void;
  busy?: boolean;
  removingProject?: boolean;
}

export function SessionHeader({
  project,
  session,
  draftMode,
  provider,
  onRenameSession,
  onToggleArchiveSession,
  onDeleteSession,
  onDiscardWork,
  onEditProjectMd,
  onRemoveProject,
  busy = false,
  removingProject = false,
}: SessionHeaderProps) {
  const { t } = useI18n();
  const [editingTitle, setEditingTitle] = useState(false);
  const [titleDraft, setTitleDraft] = useState(session?.title ?? '');
  const [confirmDeleteSession, setConfirmDeleteSession] = useState(false);
  const [confirmDiscardWork, setConfirmDiscardWork] = useState(false);
  const [confirmRemoveProject, setConfirmRemoveProject] = useState(false);

  useEffect(() => {
    setEditingTitle(false);
    setTitleDraft(session?.title ?? '');
  }, [session?.id, session?.title]);

  const effectiveMode: SessionMode = session?.mode ?? draftMode;
  const isWorking = session?.workState === 'working';

  const commitRename = () => {
    const trimmed = titleDraft.trim();
    setEditingTitle(false);
    if (session && trimmed && trimmed !== session.title) {
      onRenameSession(trimmed);
    } else {
      setTitleDraft(session?.title ?? '');
    }
  };

  return (
    <>
      <div
        className="space-y-2.5 rounded-[8px] border px-4 py-3"
        style={{
          backgroundColor: 'var(--bg-surface)',
          borderColor: 'var(--border-subtle)',
        }}
      >
        {/* Top row: project identity + PROJECT.md + project remove */}
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="truncate text-base font-semibold tracking-tight">{project.name}</h1>
              <Badge>{project.mainBranch}</Badge>
              <Badge className="gap-1.5">
                <ProviderIcon id={provider} size={12} />
                {PROVIDER_LABELS[provider]}
              </Badge>
            </div>
            <p
              className="mt-0.5 truncate font-mono-token text-[11px]"
              style={{ color: 'var(--text-secondary)' }}
              title={project.path}
            >
              {project.path}
            </p>
            {!(project.symlinksValid.claudeMd && project.symlinksValid.agentsMd) && (
              <p className="mt-1 text-xs font-semibold" style={{ color: 'var(--error)' }}>
                {t('projects.symlinksWarn')}
              </p>
            )}
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <Button type="button" variant="outline" onClick={onEditProjectMd}>
              {t('project.editProjectMd')}
            </Button>
            {confirmRemoveProject ? (
              <div className="flex items-center gap-1.5">
                <Button
                  type="button"
                  variant="destructive"
                  disabled={removingProject}
                  onClick={() => {
                    setConfirmRemoveProject(false);
                    onRemoveProject();
                  }}
                >
                  {t('project.confirmRemove')}
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => setConfirmRemoveProject(false)}
                >
                  {t('common.cancel')}
                </Button>
              </div>
            ) : (
              <Button
                type="button"
                variant="outline"
                onClick={() => setConfirmRemoveProject(true)}
              >
                {t('project.removeProject')}
              </Button>
            )}
          </div>
        </div>

        {/* Session strip: mode badge + clickable session title + session actions */}
        <div
          className="flex flex-wrap items-center justify-between gap-3 border-t pt-2.5"
          style={{ borderColor: 'var(--border-subtle)' }}
        >
          <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2">
            <Badge
              data-session-mode={effectiveMode}
              style={{
                borderColor: effectiveMode === 'ask' ? 'var(--border-control)' : 'var(--accent)',
                color: effectiveMode === 'ask' ? 'var(--text-primary)' : 'var(--accent)',
                backgroundColor: effectiveMode === 'ask' ? 'var(--bg-well)' : 'var(--accent-tint)',
              }}
            >
              {t(`sessions.mode.${effectiveMode}Badge`)}
            </Badge>

            {isWorking && (
              <Badge
                data-session-working="true"
                style={{
                  borderColor: 'var(--accent)',
                  color: 'var(--accent)',
                  backgroundColor: 'var(--accent-tint)',
                }}
              >
                <span
                  aria-hidden="true"
                  className="mr-1.5 inline-block h-2 w-2 rounded-full"
                  style={{ backgroundColor: 'var(--accent)' }}
                />
                {t('sessions.workingDotLabel')}
              </Badge>
            )}

            {session ? (
              editingTitle ? (
                <form
                  onSubmit={(e) => {
                    e.preventDefault();
                    commitRename();
                  }}
                  className="flex min-w-[200px] flex-1 items-center gap-2"
                >
                  <Input
                    aria-label={t('sessions.renameLabel')}
                    value={titleDraft}
                    autoFocus
                    onChange={(e) => setTitleDraft(e.target.value)}
                    onBlur={commitRename}
                    onKeyDown={(e) => {
                      if (e.key === 'Escape') {
                        setEditingTitle(false);
                        setTitleDraft(session.title);
                      }
                    }}
                    className="max-w-md text-sm"
                  />
                </form>
              ) : (
                <button
                  type="button"
                  onClick={() => setEditingTitle(true)}
                  title={t('sessions.renameHint')}
                  className="min-h-[44px] max-w-full cursor-pointer truncate rounded-[4px] px-2 text-left text-sm font-semibold hover:underline"
                  style={{ color: 'var(--text-primary)' }}
                >
                  {session.title}
                </button>
              )
            ) : (
              <span className="text-sm font-medium" style={{ color: 'var(--text-secondary)' }}>
                {t('sessions.newChat')}
              </span>
            )}
          </div>

          {session && (
            <div className="flex flex-wrap items-center gap-2">
              {isWorking && (
                <Button
                  type="button"
                  variant="outline"
                  disabled={busy}
                  onClick={() => setConfirmDiscardWork(true)}
                >
                  {t('sessions.discardWork')}
                </Button>
              )}
              <Button
                type="button"
                variant="outline"
                disabled={busy || (isWorking && !session.archivedAt)}
                title={isWorking && !session.archivedAt ? t('sessions.archiveDisabledWorking') : undefined}
                onClick={() => onToggleArchiveSession(!session.archivedAt)}
              >
                {session.archivedAt ? t('sessions.unarchive') : t('sessions.archive')}
              </Button>
              <Button
                type="button"
                variant="outline"
                disabled={busy}
                onClick={() => setConfirmDeleteSession(true)}
              >
                {t('sessions.delete')}
              </Button>
            </div>
          )}
        </div>
      </div>

      {/* Delete session confirmation */}
      <ModalDialog
        open={confirmDeleteSession}
        title={t('sessions.deleteTitle')}
        onClose={() => setConfirmDeleteSession(false)}
      >
        <div className="space-y-4">
          <p className="text-sm" style={{ color: 'var(--text-secondary)' }}>
            {t('sessions.deleteBody', {
              title: session?.title ?? '',
              branch: project.mainBranch,
            })}
          </p>
          <div className="flex flex-wrap justify-end gap-2">
            <Button
              type="button"
              variant="outline"
              onClick={() => setConfirmDeleteSession(false)}
            >
              {t('common.cancel')}
            </Button>
            <Button
              type="button"
              variant="destructive"
              disabled={busy}
              onClick={() => {
                setConfirmDeleteSession(false);
                onDeleteSession();
              }}
            >
              {t('sessions.deleteConfirm')}
            </Button>
          </div>
        </div>
      </ModalDialog>

      {/* Discard unfinished work confirmation */}
      <ModalDialog
        open={confirmDiscardWork}
        title={t('sessions.discardTitle')}
        onClose={() => setConfirmDiscardWork(false)}
      >
        <div className="space-y-4">
          <p className="text-sm" style={{ color: 'var(--text-secondary)' }}>
            {t('sessions.discardBody', {
              title: session?.title ?? '',
              branch: project.mainBranch,
            })}
          </p>
          <div className="flex flex-wrap justify-end gap-2">
            <Button
              type="button"
              variant="outline"
              onClick={() => setConfirmDiscardWork(false)}
            >
              {t('common.cancel')}
            </Button>
            <Button
              type="button"
              variant="destructive"
              disabled={busy}
              onClick={() => {
                setConfirmDiscardWork(false);
                onDiscardWork();
              }}
            >
              {t('sessions.discardConfirm')}
            </Button>
          </div>
        </div>
      </ModalDialog>
    </>
  );
}
