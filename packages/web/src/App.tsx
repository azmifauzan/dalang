import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import type { ProjectSummary } from '@dalang/shared';
import { AgreeView } from './components/AgreeView.js';
import { AssignView } from './components/AssignView.js';
import { DiscussView } from './components/DiscussView.js';
import { GuardView } from './components/GuardView.js';
import { ListView } from './components/ListView.js';
import { NavigateView } from './components/NavigateView.js';
import { ProjectsView } from './components/ProjectsView.js';
import { ProvidersView } from './components/ProvidersView.js';
import { EmptyPanel } from './components/StateViews.js';
import { api } from './lib/api.js';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { NativeSelect } from '@/components/ui/native-select';

type RouteView = 'projects' | 'discuss' | 'agree' | 'list' | 'assign' | 'navigate' | 'guard' | 'providers';

const STAGE_ITEMS: Array<{
  id: 'discuss' | 'agree' | 'list' | 'assign' | 'navigate' | 'guard';
  letter: string;
  label: string;
  availableIn: 'v0.1' | 'v0.2' | 'v0.3';
}> = [
  { id: 'discuss', letter: 'D', label: 'Discuss', availableIn: 'v0.1' },
  { id: 'agree', letter: 'A', label: 'Agree', availableIn: 'v0.1' },
  { id: 'list', letter: 'L', label: 'List', availableIn: 'v0.1' },
  { id: 'assign', letter: 'A', label: 'Assign', availableIn: 'v0.2' },
  { id: 'navigate', letter: 'N', label: 'Navigate', availableIn: 'v0.2' },
  { id: 'guard', letter: 'G', label: 'Guard', availableIn: 'v0.3' },
];

function readStored(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeStored(key: string, value: string | null): void {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    // Storage is a convenience only; the app works without it.
  }
}

export function App() {
  const qc = useQueryClient();
  const [view, setView] = useState<RouteView>('projects');
  const [activeProjectId, setActiveProjectId] = useState<string | null>(() => {
    return readStored('dalang.activeProjectId');
  });
  const [theme, setTheme] = useState<'light' | 'dark'>(() => {
    const saved = readStored('dalang.theme');
    return saved === 'dark' ? 'dark' : 'light';
  });
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [liveLogs, setLiveLogs] = useState<string[]>([]);
  const [runLogsByRunId, setRunLogsByRunId] = useState<Record<string, string[]>>({});

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
    writeStored('dalang.theme', theme);
  }, [theme]);

  useEffect(() => {
    writeStored('dalang.activeProjectId', activeProjectId);
  }, [activeProjectId]);

  // WebSocket live updates
  useEffect(() => {
    const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${proto}//${window.location.host}/ws`;
    let ws: WebSocket | null = null;
    let closedByEffect = false;

    try {
      ws = new WebSocket(wsUrl);
      ws.onmessage = (ev) => {
        try {
          const msg = JSON.parse(ev.data as string) as {
            type: string;
            projectId?: string;
            runId?: string;
            line?: string;
          };
          if (msg.type === 'lead.turn_started' && msg.projectId === activeProjectId) {
            setLiveLogs([]);
          } else if (msg.type === 'lead.log' && msg.projectId === activeProjectId && msg.line) {
            setLiveLogs((prev) => [...prev.slice(-40), msg.line!]);
          } else if (msg.type === 'discuss.updated' && msg.projectId) {
            qc.invalidateQueries({ queryKey: ['discuss', msg.projectId] });
          } else if (msg.type === 'brief.updated' && msg.projectId) {
            qc.invalidateQueries({ queryKey: ['briefs', msg.projectId] });
            qc.invalidateQueries({ queryKey: ['projects'] });
          } else if (msg.type === 'plan.updated' && msg.projectId) {
            qc.invalidateQueries({ queryKey: ['plan', msg.projectId] });
            qc.invalidateQueries({ queryKey: ['execution', msg.projectId] });
            qc.invalidateQueries({ queryKey: ['guard', msg.projectId] });
            qc.invalidateQueries({ queryKey: ['projects'] });
          } else if (msg.type === 'run.started' && msg.projectId && msg.runId) {
            setRunLogsByRunId((prev) => ({ ...prev, [msg.runId!]: [] }));
            qc.invalidateQueries({ queryKey: ['execution', msg.projectId] });
            qc.invalidateQueries({ queryKey: ['providers-status'] });
            qc.invalidateQueries({ queryKey: ['statistics'] });
          } else if (msg.type === 'run.log' && msg.projectId && msg.runId && msg.line) {
            setRunLogsByRunId((prev) => ({
              ...prev,
              [msg.runId!]: [...(prev[msg.runId!] ?? []).slice(-300), msg.line!],
            }));
          } else if (msg.type === 'run.finished' && msg.projectId) {
            qc.invalidateQueries({ queryKey: ['execution', msg.projectId] });
            qc.invalidateQueries({ queryKey: ['plan', msg.projectId] });
            qc.invalidateQueries({ queryKey: ['guard', msg.projectId] });
            qc.invalidateQueries({ queryKey: ['providers-status'] });
            qc.invalidateQueries({ queryKey: ['statistics'] });
            if (msg.runId) {
              qc.invalidateQueries({ queryKey: ['run-log', msg.projectId, msg.runId] });
            }
          } else if (msg.type === 'provider.updated') {
            qc.invalidateQueries({ queryKey: ['providers-status'] });
            qc.invalidateQueries({ queryKey: ['statistics'] });
            if (activeProjectId) {
              qc.invalidateQueries({ queryKey: ['execution', activeProjectId] });
            }
          } else if (
            (msg.type === 'review.finished' || msg.type === 'integration.finished') &&
            msg.projectId
          ) {
            qc.invalidateQueries({ queryKey: ['guard', msg.projectId] });
            qc.invalidateQueries({ queryKey: ['execution', msg.projectId] });
            qc.invalidateQueries({ queryKey: ['plan', msg.projectId] });
            qc.invalidateQueries({ queryKey: ['task-diff', msg.projectId] });
            qc.invalidateQueries({ queryKey: ['projects'] });
          }
        } catch {
          // ignore malformed event
        }
      };
    } catch {
      // WebSocket optional when running static preview
    }

    return () => {
      closedByEffect = true;
      if (ws && closedByEffect) {
        ws.close();
      }
    };
  }, [activeProjectId, qc]);

  const projectsQuery = useQuery({
    queryKey: ['projects'],
    queryFn: () => api.listProjects(),
  });

  const projects = projectsQuery.data?.projects ?? [];
  const activeProject: ProjectSummary | null =
    projects.find((p) => p.id === activeProjectId) ?? projects[0] ?? null;

  useEffect(() => {
    if (!activeProjectId && projects.length > 0) {
      setActiveProjectId(projects[0].id);
    }
  }, [activeProjectId, projects]);

  const handleSelectProject = (
    proj: ProjectSummary,
    targetStage: 'discuss' | 'agree' | 'list' = 'discuss',
  ) => {
    setActiveProjectId(proj.id);
    setView(targetStage);
    setMobileMenuOpen(false);
  };

  const toggleTheme = () => {
    setTheme((prev) => (prev === 'light' ? 'dark' : 'light'));
  };

  return (
    <div className="min-h-dvh flex flex-col">
      <header
        className="border-b"
        style={{
          backgroundColor: 'var(--bg-surface)',
          borderColor: 'var(--border-subtle)',
        }}
      >
        <div className="mx-auto flex max-w-7xl flex-wrap items-center justify-between gap-3 px-4 py-3">
          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={() => {
                setView('projects');
                setMobileMenuOpen(false);
              }}
              className="flex min-h-[44px] items-center gap-2 rounded px-2 text-left"
            >
              <svg
                width="24"
                height="24"
                viewBox="0 0 24 24"
                fill="none"
                aria-hidden="true"
                style={{ color: 'var(--accent)' }}
              >
                <path
                  d="M12 2C14.2 5.4 19.2 9.4 19.2 14C19.2 16.4 17.6 18.2 15.6 19H8.4C6.4 18.2 4.8 16.4 4.8 14C4.8 9.4 9.8 5.4 12 2Z"
                  fill="var(--accent-tint)"
                  stroke="currentColor"
                  strokeWidth="1.75"
                  strokeLinejoin="round"
                />
                <path
                  d="M9.5 19V16.2L12 14.6L14.5 16.2V19"
                  stroke="currentColor"
                  strokeWidth="1.5"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
                <path
                  d="M12 5.5V14.6"
                  stroke="currentColor"
                  strokeWidth="1.5"
                  strokeLinecap="round"
                />
                <path
                  d="M12 9.5C10.4 9.5 9.3 8.5 8.8 7.3M12 9.5C13.6 9.5 14.7 8.5 15.2 7.3M12 12.8C9.8 12.8 8.3 11.6 7.6 10.2M12 12.8C14.2 12.8 15.7 11.6 16.4 10.2"
                  stroke="currentColor"
                  strokeWidth="1.4"
                  strokeLinecap="round"
                />
                <path
                  d="M6.5 19H17.5M8.5 21.2H15.5M12 19V22.2"
                  stroke="currentColor"
                  strokeWidth="1.6"
                  strokeLinecap="round"
                />
              </svg>
              <span className="text-base font-bold tracking-tight">DALANG</span>
              <Badge>v0.4</Badge>
            </button>

            {activeProject && (
              <div className="hidden items-center gap-2 sm:flex">
                <Label htmlFor="active-project-select" className="sr-only">
                  Active project
                </Label>
                <NativeSelect
                  id="active-project-select"
                  value={activeProject.id}
                  onChange={(e) => {
                    setActiveProjectId(e.target.value);
                    if (view === 'projects') setView('discuss');
                  }}
                  className="w-auto max-w-[220px] text-sm"
                >
                  {projects.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </NativeSelect>
              </div>
            )}
          </div>

          <div className="flex items-center gap-2">
            <nav aria-label="Primary sections" className="hidden items-center gap-2 md:flex">
              <Button
                type="button"
                onClick={() => setView('projects')}
                variant={view === 'projects' ? 'default' : 'outline'}
              >
                Projects
              </Button>
              <Button
                type="button"
                onClick={() => setView('providers')}
                variant={view === 'providers' ? 'default' : 'outline'}
              >
                Providers
              </Button>
            </nav>

            <Button
              type="button"
              onClick={toggleTheme}

              aria-label={`Switch to ${theme === 'light' ? 'dark' : 'light'} theme`}
              variant="outline"
            >
              {theme === 'light' ? 'Dark mode' : 'Light mode'}
            </Button>

            <Button
              type="button"
              onClick={() => setMobileMenuOpen((v) => !v)}
              className="md:hidden"
              aria-expanded={mobileMenuOpen}
              variant="outline"
            >
              Menu
            </Button>
          </div>
        </div>

        {/* Mobile menu */}
        {mobileMenuOpen && (
          <div
            className="space-y-3 border-t px-4 py-3 md:hidden"
            style={{ borderColor: 'var(--border-subtle)' }}
          >
            {projects.length > 0 && (
              <div>
                <Label htmlFor="mobile-project-select" className="block text-xs font-medium">
                  Active project
                </Label>
                <NativeSelect
                  id="mobile-project-select"
                  value={activeProject?.id ?? ''}
                  onChange={(e) => {
                    setActiveProjectId(e.target.value);
                    setMobileMenuOpen(false);
                  }}
                  className="mt-1"
                >
                  {projects.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </NativeSelect>
              </div>
            )}
            <div className="flex flex-wrap gap-2">
              <Button
                type="button"
                onClick={() => {
                  setView('projects');
                  setMobileMenuOpen(false);
                }}
                variant={view === 'projects' ? 'default' : 'outline'}
              >
                Projects
              </Button>
              <Button
                type="button"
                onClick={() => {
                  setView('providers');
                  setMobileMenuOpen(false);
                }}
                variant={view === 'providers' ? 'default' : 'outline'}
              >
                Providers
              </Button>
            </div>
          </div>
        )}

        {/* D-A-L-A-N-G Stage Rail */}
        {activeProject && (
          <div
            className="border-t"
            style={{
              backgroundColor: 'var(--bg-well)',
              borderColor: 'var(--border-subtle)',
            }}
          >
            <nav
              aria-label="DALANG workflow stages"
              className="mx-auto flex max-w-7xl flex-wrap items-center gap-2 px-4 py-2"
            >
              {STAGE_ITEMS.map((stage) => {
                const isLive =
                  stage.availableIn === 'v0.1' ||
                  stage.availableIn === 'v0.2' ||
                  stage.availableIn === 'v0.3';
                const isActive = view === stage.id;
                return (
                  <Button
                    key={stage.id}
                    type="button"
                    disabled={!isLive}
                    onClick={() => {
                      if (isLive) setView(stage.id as RouteView);
                    }}
                    variant={isActive ? 'default' : 'outline'}
                    style={
                      !isLive
                        ? { opacity: 0.65, cursor: 'not-allowed' }
                        : undefined
                    }
                    title={
                      isLive
                        ? `Open ${stage.label}`
                        : `${stage.label} ships in ${stage.availableIn}`
                    }
                  >
                    <span className="font-mono-token mr-1.5 font-bold">{stage.letter}</span>
                    <span>{stage.label}</span>
                    {!isLive && (
                      <span className="ml-2 text-xs" style={{ color: 'var(--text-secondary)' }}>
                        ({stage.availableIn})
                      </span>
                    )}
                  </Button>
                );
              })}
            </nav>
          </div>
        )}
      </header>

      <main className="mx-auto w-full max-w-7xl flex-1 px-4 py-6">
        {view === 'projects' && (
          <ProjectsView
            activeProjectId={activeProject?.id ?? null}
            onSelectProject={handleSelectProject}
          />
        )}

        {view === 'providers' && <ProvidersView />}

        {(view === 'discuss' ||
          view === 'agree' ||
          view === 'list' ||
          view === 'assign' ||
          view === 'navigate' ||
          view === 'guard') &&
          !activeProject && (
            <EmptyPanel
              title="Select or create a project first"
              description="No active project is selected. Create a new folder or open an existing git repository in Projects."
              action={
                <Button type="button" onClick={() => setView('projects')}>
                  Go to Projects
                </Button>
              }
            />
          )}

        {view === 'discuss' && activeProject && (
          <DiscussView
            key={activeProject.id}
            project={activeProject}
            liveLogs={liveLogs}
            onGoToAgree={() => setView('agree')}
          />
        )}

        {view === 'agree' && activeProject && (
          <AgreeView
            key={activeProject.id}
            project={activeProject}
            onGoToDiscuss={() => setView('discuss')}
            onGoToList={() => setView('list')}
          />
        )}

        {view === 'list' && activeProject && (
          <ListView
            key={activeProject.id}
            project={activeProject}
            onGoToAgree={() => setView('agree')}
            onGoToAssign={() => setView('assign')}
          />
        )}

        {view === 'assign' && activeProject && (
          <AssignView
            key={activeProject.id}
            project={activeProject}
            onGoToList={() => setView('list')}
            onGoToNavigate={() => setView('navigate')}
          />
        )}

        {view === 'navigate' && activeProject && (
          <NavigateView
            key={activeProject.id}
            project={activeProject}
            liveLogsByRunId={runLogsByRunId}
            onGoToList={() => setView('list')}
            onGoToAssign={() => setView('assign')}
            onGoToGuard={() => setView('guard')}
          />
        )}

        {view === 'guard' && activeProject && (
          <GuardView
            key={activeProject.id}
            project={activeProject}
            onGoToNavigate={() => setView('navigate')}
          />
        )}
      </main>
    </div>
  );
}
