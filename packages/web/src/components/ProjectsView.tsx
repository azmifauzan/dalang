import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import type { ProjectSummary } from '@dalang/shared';
import { useI18n } from '../i18n/index.js';
import { api } from '../lib/api.js';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Input } from '@/components/ui/input';

export function ProjectsView({
  onSelectProject,
}: {
  onSelectProject: (project: ProjectSummary) => void;
}) {
  const qc = useQueryClient();
  const { t } = useI18n();
  const [mode, setMode] = useState<'create' | 'open'>('create');
  const [name, setName] = useState('');
  const [repoPath, setRepoPath] = useState('');
  const [stackHint, setStackHint] = useState('');
  const [initGitIfMissing, setInitGitIfMissing] = useState(true);

  const createMutation = useMutation({
    mutationFn: api.createOrOpenProject,
    onSuccess: ({ project }) => {
      qc.invalidateQueries({ queryKey: ['projects'] });
      setName('');
      setRepoPath('');
      setStackHint('');
      onSelectProject(project);
    },
  });

  const handleSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (!repoPath.trim()) return;
    createMutation.mutate({
      mode,
      name: name.trim() || undefined,
      path: repoPath.trim(),
      stackHint: mode === 'create' ? stackHint.trim() || undefined : undefined,
      initGitIfMissing: mode === 'open' ? initGitIfMissing : false,
    });
  };

  return (
    <div className="grid grid-cols-1 gap-6 lg:grid-cols-12">
      {/* Create or Open Project form */}
      <section
        aria-labelledby="project-form-heading"
        className="rounded-[8px] border p-5 lg:col-span-7"
        style={{
          backgroundColor: 'var(--bg-surface)',
          borderColor: 'var(--border-subtle)',
        }}
      >
        <h1 id="project-form-heading" className="text-lg font-semibold">
          {t('projects.addHeading')}
        </h1>
        <p className="mt-1 text-sm" style={{ color: 'var(--text-secondary)' }}>
          {t('projects.addDesc')}
        </p>

        <div className="mt-4 grid grid-cols-2 gap-2" role="tablist" aria-label={t('projects.addHeading')}>
          <Button
            type="button"
            role="tab"
            aria-selected={mode === 'create'}
            onClick={() => setMode('create')}
            variant={mode === 'create' ? 'default' : 'outline'}
          >
            {t('projects.modeCreate')}
          </Button>
          <Button
            type="button"
            role="tab"
            aria-selected={mode === 'open'}
            onClick={() => setMode('open')}
            variant={mode === 'open' ? 'default' : 'outline'}
          >
            {t('projects.modeOpen')}
          </Button>
        </div>

        <form onSubmit={handleSubmit} className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-2">
          <div className="sm:col-span-2">
            <Label htmlFor="proj-path" className="block text-sm font-medium">
              {t('projects.pathLabel')}
            </Label>
            <Input
              id="proj-path"
              type="text"
              required
              value={repoPath}
              onChange={(e) => setRepoPath(e.target.value)}
              placeholder={t('projects.pathPlaceholder')}
              className="mt-1 font-mono-token text-sm"
            />
          </div>

          <div className="sm:col-span-2">
            <Label htmlFor="proj-name" className="block text-sm font-medium">
              {t('projects.nameLabel')}
            </Label>
            <Input
              id="proj-name"
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={t('projects.namePlaceholder')}
              className="mt-1"
            />
          </div>

          {mode === 'create' ? (
            <div className="sm:col-span-2">
              <Label htmlFor="proj-stack" className="block text-sm font-medium">
                {t('projects.stackLabel')}
              </Label>
              <Input
                id="proj-stack"
                type="text"
                value={stackHint}
                onChange={(e) => setStackHint(e.target.value)}
                placeholder={t('projects.stackPlaceholder')}
                className="mt-1"
              />
            </div>
          ) : (
            <Label className="flex min-h-[44px] cursor-pointer items-center gap-3 text-sm sm:col-span-2">
              <input
                type="checkbox"
                checked={initGitIfMissing}
                onChange={(e) => setInitGitIfMissing(e.target.checked)}
                className="h-4 w-4 accent-[var(--primary)]"
              />
              <span>{t('projects.initGitLabel')}</span>
            </Label>
          )}

          {createMutation.isError && (
            <div
              role="alert"
              className="rounded border px-3 py-2 text-sm sm:col-span-2"
              style={{
                backgroundColor: 'var(--error-tint)',
                borderColor: 'var(--error)',
                color: 'var(--error)',
              }}
            >
              {createMutation.error.message}
            </div>
          )}

          <Button
            type="submit"
            disabled={createMutation.isPending || !repoPath.trim()}
            className="w-full sm:col-span-2"
          >
            {createMutation.isPending
              ? t('projects.initializing')
              : mode === 'create'
                ? t('projects.submitCreate')
                : t('projects.submitOpen')}
          </Button>
        </form>
      </section>
      {/* What happens next */}
      <aside
        aria-labelledby="project-next-heading"
        className="space-y-4 rounded-[8px] border p-5 lg:col-span-5"
        style={{ backgroundColor: 'var(--bg-surface)', borderColor: 'var(--border-subtle)' }}
      >
        <h2 id="project-next-heading" className="text-lg font-semibold">
          {t('projects.nextHeading')}
        </h2>
        <ol className="space-y-3">
          {(['projects.next1', 'projects.next2', 'projects.next3', 'projects.next4'] as const).map((key, i) => (
            <li key={key} className="flex gap-3 text-sm">
              <span
                className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full border font-mono-token text-xs font-semibold"
                style={{ borderColor: 'var(--accent)', color: 'var(--accent)' }}
              >
                {i + 1}
              </span>
              <span style={{ color: 'var(--text-secondary)' }}>{t(key)}</span>
            </li>
          ))}
        </ol>
        <p className="border-t pt-3 text-xs" style={{ borderColor: 'var(--border-subtle)', color: 'var(--text-secondary)' }}>
          {t('projects.nextTeamNote')}
        </p>
      </aside>
    </div>
  );
}
