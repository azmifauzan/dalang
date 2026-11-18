import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import type { ProjectSummary, ProviderId } from '@dalang/shared';
import { api } from '../lib/api.js';
import { EmptyPanel, ErrorPanel, LoadingPanel, ModalDialog } from './StateViews.js';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Input } from '@/components/ui/input';
import { NativeSelect } from '@/components/ui/native-select';
import { Textarea } from '@/components/ui/textarea';

export function ProjectsView({
  activeProjectId,
  onSelectProject,
}: {
  activeProjectId: string | null;
  onSelectProject: (project: ProjectSummary, targetStage?: 'discuss' | 'agree' | 'list') => void;
}) {
  const qc = useQueryClient();
  const [mode, setMode] = useState<'create' | 'open'>('create');
  const [name, setName] = useState('');
  const [repoPath, setRepoPath] = useState('');
  const [stackHint, setStackHint] = useState('');
  const [initGitIfMissing, setInitGitIfMissing] = useState(true);
  const [leadProvider, setLeadProvider] = useState<ProviderId>('claude-code');
  const [editingMdProjectId, setEditingMdProjectId] = useState<string | null>(null);
  const [mdDraft, setMdDraft] = useState('');

  const projectsQuery = useQuery({
    queryKey: ['projects'],
    queryFn: () => api.listProjects(),
  });

  const mdQuery = useQuery({
    queryKey: ['project-md', editingMdProjectId],
    queryFn: () => api.getProjectMd(editingMdProjectId!),
    enabled: Boolean(editingMdProjectId),
  });

  const createMutation = useMutation({
    mutationFn: api.createOrOpenProject,
    onSuccess: ({ project }) => {
      qc.invalidateQueries({ queryKey: ['projects'] });
      setName('');
      setRepoPath('');
      setStackHint('');
      onSelectProject(project, 'discuss');
    },
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => api.deleteProject(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['projects'] });
    },
  });

  const saveMdMutation = useMutation({
    mutationFn: ({ id, content }: { id: string; content: string }) =>
      api.saveProjectMd(id, content, true),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['projects'] });
      qc.invalidateQueries({ queryKey: ['project-md', editingMdProjectId] });
      setEditingMdProjectId(null);
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
      leadProvider,
    });
  };

  const openMdEditor = async (projectId: string) => {
    setEditingMdProjectId(projectId);
    const data = await api.getProjectMd(projectId);
    setMdDraft(data.content);
  };

  const projects = projectsQuery.data?.projects ?? [];

  return (
    <div className="grid grid-cols-1 gap-6 lg:grid-cols-12">
      {/* Left column: Create or Open Project form */}
      <section
        aria-labelledby="project-form-heading"
        className="rounded-md border p-5 lg:col-span-5"
        style={{
          backgroundColor: 'var(--bg-surface)',
          borderColor: 'var(--border-subtle)',
        }}
      >
        <h1 id="project-form-heading" className="text-lg font-semibold" style={{ color: 'var(--text-primary)' }}>
          Add a workspace
        </h1>
        <p className="mt-1 text-sm" style={{ color: 'var(--text-secondary)' }}>
          Register a new folder with git init or open an existing repository. DALANG creates{' '}
          <code>PROJECT.md</code> and symlinks <code>CLAUDE.md</code> and <code>AGENTS.md</code>.
        </p>

        <div className="mt-4 grid grid-cols-2 gap-2" role="tablist" aria-label="Workspace mode">
          <Button
            type="button"
            role="tab"
            aria-selected={mode === 'create'}
            onClick={() => setMode('create')}
            variant={mode === 'create' ? 'default' : 'outline'}
          >
            New project
          </Button>
          <Button
            type="button"
            role="tab"
            aria-selected={mode === 'open'}
            onClick={() => setMode('open')}
            variant={mode === 'open' ? 'default' : 'outline'}
          >
            Open existing repo
          </Button>
        </div>

        <form onSubmit={handleSubmit} className="mt-4 space-y-4">
          <div>
            <Label htmlFor="proj-path" className="block text-sm font-medium">
              Repository folder path
            </Label>
            <Input
              id="proj-path"
              type="text"
              required
              value={repoPath}
              onChange={(e) => setRepoPath(e.target.value)}
              placeholder="/home/you/dev/my-app"
              className="mt-1 font-mono-token text-sm"
            />
          </div>

          <div>
            <Label htmlFor="proj-name" className="block text-sm font-medium">
              Project name (optional)
            </Label>
            <Input
              id="proj-name"
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Derived from folder name if blank"
              className="mt-1"
            />
          </div>

          {mode === 'create' ? (
            <div>
              <Label htmlFor="proj-stack" className="block text-sm font-medium">
                Initial stack hint for PROJECT.md (optional)
              </Label>
              <Input
                id="proj-stack"
                type="text"
                value={stackHint}
                onChange={(e) => setStackHint(e.target.value)}
                placeholder="TypeScript, Fastify, SQLite, React"
                className="mt-1"
              />
            </div>
          ) : (
            <Label className="flex min-h-[44px] cursor-pointer items-center gap-3 text-sm">
              <input
                type="checkbox"
                checked={initGitIfMissing}
                onChange={(e) => setInitGitIfMissing(e.target.checked)}
                className="h-4 w-4"
              />
              <span>Run git init if folder has no .git directory</span>
            </Label>
          )}

          <div>
            <Label htmlFor="proj-lead" className="block text-sm font-medium">
              Default Lead CLI
            </Label>
            <NativeSelect
              id="proj-lead"
              value={leadProvider}
              onChange={(e) => setLeadProvider(e.target.value as ProviderId)}
              className="mt-1"
            >
              <option value="claude-code">Claude Code (claude)</option>
              <option value="codex">Codex CLI (codex)</option>
              <option value="antigravity">Antigravity CLI (agy)</option>
            </NativeSelect>
          </div>

          {createMutation.isError && (
            <div
              role="alert"
              className="rounded border px-3 py-2 text-sm"
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
            className="w-full"
          >
            {createMutation.isPending
              ? 'Initializing workspace...'
              : mode === 'create'
                ? 'Create project & start Discuss'
                : 'Open repository & start Discuss'}
          </Button>
        </form>
      </section>

      {/* Right column: Registered Projects */}
      <section aria-labelledby="registered-projects-heading" className="space-y-4 lg:col-span-7">
        <div className="flex items-center justify-between gap-4">
          <div>
            <h2 id="registered-projects-heading" className="text-lg font-semibold">
              Registered projects
            </h2>
            <p className="text-sm" style={{ color: 'var(--text-secondary)' }}>
              Global registry in <code>~/.dalang/</code>, artifacts stored per repo in <code>.dalang/</code>.
            </p>
          </div>
          <Badge>{projects.length} total</Badge>
        </div>

        {projectsQuery.isLoading && <LoadingPanel label="Loading registered projects..." />}

        {projectsQuery.isError && (
          <ErrorPanel
            title="Could not load projects"
            detail={projectsQuery.error.message}
            onRetry={() => projectsQuery.refetch()}
          />
        )}

        {!projectsQuery.isLoading && !projectsQuery.isError && projects.length === 0 && (
          <EmptyPanel
            title="No projects registered yet"
            description="Create a new project folder or open an existing git repository using the form on the left."
          />
        )}

        {!projectsQuery.isLoading && !projectsQuery.isError && projects.length > 0 && (
          <ul className="space-y-3">
            {projects.map((proj) => {
              const isSelected = proj.id === activeProjectId;
              const linksOk = proj.symlinksValid.claudeMd && proj.symlinksValid.agentsMd;
              return (
                <li
                  key={proj.id}
                  className="rounded-md border p-4"
                  style={{
                    backgroundColor: 'var(--bg-surface)',
                    borderColor: isSelected ? 'var(--accent)' : 'var(--border-subtle)',
                  }}
                >
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <h3 className="text-base font-semibold">{proj.name}</h3>
                        <Badge>{proj.mainBranch}</Badge>
                        <Badge>{proj.leadProvider}</Badge>
                      </div>
                      <p
                        className="mt-1 truncate font-mono-token text-xs"
                        style={{ color: 'var(--text-secondary)' }}
                        title={proj.path}
                      >
                        {proj.path}
                      </p>
                    </div>

                    <div className="flex flex-wrap items-center gap-2">
                      <Button
                        type="button"
                        onClick={() => onSelectProject(proj, 'discuss')}
                      >
                        Open Discuss
                      </Button>
                      <Button
                        type="button"
                        onClick={() => openMdEditor(proj.id)}
                        variant="outline"
                      >
                        Edit PROJECT.md
                      </Button>
                      <Button
                        type="button"
                        onClick={() => deleteMutation.mutate(proj.id)}
                        disabled={deleteMutation.isPending}

                        aria-label={`Remove ${proj.name} from registry`}
                        variant="outline"
                      >
                        Remove
                      </Button>
                    </div>
                  </div>

                  <div
                    className="mt-3 flex flex-wrap items-center gap-3 border-t pt-3 text-xs"
                    style={{ borderColor: 'var(--border-subtle)', color: 'var(--text-secondary)' }}
                  >
                    <span
                      style={{
                        color: linksOk ? 'var(--pass)' : 'var(--error)',
                        fontWeight: 600,
                      }}
                    >
                      {linksOk
                        ? 'PROJECT.md symlinked to CLAUDE.md & AGENTS.md'
                        : 'Symlink repair needed for CLAUDE.md / AGENTS.md'}
                    </span>
                    <span>
                      Brief:{' '}
                      {proj.latestBriefVersion
                        ? `v${proj.latestBriefVersion} (${proj.latestBriefStatus})`
                        : 'none'}
                    </span>
                    <span>
                      Plan: {proj.taskCount} tasks ({proj.planStatus})
                    </span>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      <ModalDialog
        open={Boolean(editingMdProjectId)}
        title="PROJECT.md & Symlink Check"
        onClose={() => setEditingMdProjectId(null)}
      >
        {mdQuery.isLoading ? (
          <LoadingPanel label="Reading PROJECT.md..." />
        ) : (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              if (!editingMdProjectId) return;
              saveMdMutation.mutate({ id: editingMdProjectId, content: mdDraft });
            }}
            className="space-y-4"
          >
            <div className="text-xs" style={{ color: 'var(--text-secondary)' }}>
              Saving automatically ensures <code>CLAUDE.md</code> and <code>AGENTS.md</code> symlink to{' '}
              <code>PROJECT.md</code>.
            </div>
            <div>
              <Label htmlFor="project-md-editor" className="block text-sm font-medium">
                PROJECT.md contents
              </Label>
              <Textarea
                id="project-md-editor"
                rows={14}
                value={mdDraft}
                onChange={(e) => setMdDraft(e.target.value)}
                className="mt-1 font-mono-token text-sm"
              />
            </div>
            <div className="flex flex-wrap justify-end gap-2">
              <Button
                type="button"
                onClick={() => setEditingMdProjectId(null)}
                variant="outline"
              >
                Cancel
              </Button>
              <Button
                type="submit"
                disabled={saveMdMutation.isPending}
              >
                {saveMdMutation.isPending ? 'Saving...' : 'Save PROJECT.md & verify symlinks'}
              </Button>
            </div>
          </form>
        )}
      </ModalDialog>
    </div>
  );
}
