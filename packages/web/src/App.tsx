import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import type { ProjectSummary, ProviderId } from '@dalang/shared';
import { GununganMark } from './assets/wayang/Gunungan.js';
import { characterForProfile } from './assets/wayang/WayangFigure.js';
import { AgreeView } from './components/AgreeView.js';
import { ConfigView } from './components/ConfigView.js';
import { DiscussView } from './components/DiscussView.js';
import { GuardView } from './components/GuardView.js';
import { ListView } from './components/ListView.js';
import { NextStepCard } from './components/NextStepCard.js';
import { ProjectStepper, type ProjectStepId } from './components/ProjectStepper.js';
import { ProjectsView } from './components/ProjectsView.js';
import { Sidebar, type ConfigTabId } from './components/Sidebar.js';
import { EmptyPanel, ErrorPanel, LoadingPanel, ModalDialog } from './components/StateViews.js';
import { StatisticsView } from './components/StatisticsView.js';
import { WizardView } from './components/WizardView.js';
import { WorkView } from './components/WorkView.js';
import { I18nProvider, useI18n } from './i18n/index.js';
import { parseRunLogActivity, type ActivityFeedItem } from './lib/activity.js';
import { api } from './lib/api.js';
import { ThemeProvider } from './lib/theme.js';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';

type WorkspaceSection = 'project' | 'new-project' | 'statistics' | 'config' | 'wizard';

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

function defaultStepForProject(project: ProjectSummary): ProjectStepId {
  if (project.planStatus === 'approved') return 'work';
  if (project.latestBriefStatus === 'approved') return 'plan';
  if (project.latestBriefStatus === 'draft') return 'brief';
  return 'discuss';
}

function AppShell() {
  const qc = useQueryClient();
  const { t } = useI18n();

  const [section, setSection] = useState<WorkspaceSection>('project');
  const [configTab, setConfigTab] = useState<ConfigTabId>('general');
  const previousSectionRef = useRef<'project' | 'new-project' | 'statistics'>('project');

  const [activeProjectId, setActiveProjectId] = useState<string | null>(() => {
    return readStored('dalang.activeProjectId');
  });
  const [projectStep, setProjectStep] = useState<ProjectStepId>('discuss');
  const [initialGoal, setInitialGoal] = useState<string>('');
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);

  const [wizardDismissed, setWizardDismissed] = useState<boolean>(
    () => readStored('dalang.wizardDismissed') === '1',
  );
  const initializedFromProjectsRef = useRef(false);

  const [liveLogs, setLiveLogs] = useState<string[]>([]);
  const [runLogsByRunId, setRunLogsByRunId] = useState<Record<string, string[]>>({});
  const [liveActivityByProject, setLiveActivityByProject] = useState<
    Record<string, ActivityFeedItem[]>
  >({});
  const runMetaByRunIdRef = useRef<
    Record<string, { taskId: string; profileName: string; provider?: ProviderId }>
  >({});

  const [editingMdProjectId, setEditingMdProjectId] = useState<string | null>(null);
  const [mdDraft, setMdDraft] = useState('');
  const [quickError, setQuickError] = useState<string | null>(null);

  useEffect(() => {
    writeStored('dalang.activeProjectId', activeProjectId);
  }, [activeProjectId]);

  const projectsQuery = useQuery({
    queryKey: ['projects'],
    queryFn: () => api.listProjects(),
  });

  const updateStatusQuery = useQuery({
    queryKey: ['update-status'],
    queryFn: () => api.getUpdateStatus(false),
    staleTime: 60_000,
    retry: 0,
  });

  const projects = projectsQuery.data?.projects ?? [];
  const activeProject: ProjectSummary | null =
    projects.find((p) => p.id === activeProjectId) ?? projects[0] ?? null;

  // Decide initial destination once projects load:
  // - 0 projects & wizard not dismissed -> open first-run wizard
  // - >= 1 projects (existing install / upgrade path) -> skip wizard and open most recent project
  useEffect(() => {
    if (!projectsQuery.isSuccess || initializedFromProjectsRef.current) return;
    initializedFromProjectsRef.current = true;

    if (projects.length === 0) {
      if (!wizardDismissed) {
        setSection('wizard');
      } else {
        setSection('new-project');
      }
      return;
    }

    const chosen = projects.find((p) => p.id === activeProjectId) ?? projects[0];
    setActiveProjectId(chosen.id);
    setProjectStep(defaultStepForProject(chosen));
    setSection('project');
  }, [projectsQuery.isSuccess, projects, activeProjectId, wizardDismissed]);

  // Keep activeProjectId valid if the current project is removed
  useEffect(() => {
    if (!projectsQuery.isSuccess) return;
    if (projects.length === 0) {
      if (activeProjectId !== null) setActiveProjectId(null);
      return;
    }
    if (!activeProjectId || !projects.some((p) => p.id === activeProjectId)) {
      setActiveProjectId(projects[0].id);
      setProjectStep(defaultStepForProject(projects[0]));
    }
  }, [projectsQuery.isSuccess, projects, activeProjectId]);

  const discussQuery = useQuery({
    queryKey: ['discuss', activeProject?.id],
    queryFn: () => api.getDiscussState(activeProject!.id),
    enabled: Boolean(activeProject && section === 'project'),
  });

  const executionQuery = useQuery({
    queryKey: ['execution', activeProject?.id],
    queryFn: () => api.getExecutionState(activeProject!.id),
    enabled: Boolean(
      activeProject && section === 'project' && activeProject.planStatus === 'approved',
    ),
    refetchInterval: (query) => {
      const exec = query.state.data?.execution;
      const hasActive = (exec?.activeRuns?.length ?? 0) > 0 || Boolean(exec?.activeRun);
      return hasActive || exec?.queueRunning ? 3000 : false;
    },
  });

  const mdQuery = useQuery({
    queryKey: ['project-md', editingMdProjectId],
    queryFn: () => api.getProjectMd(editingMdProjectId!),
    enabled: Boolean(editingMdProjectId),
  });

  useEffect(() => {
    if (mdQuery.data && editingMdProjectId) {
      setMdDraft(mdQuery.data.content);
    }
  }, [mdQuery.data, editingMdProjectId]);

  const saveMdMutation = useMutation({
    mutationFn: ({ id, content }: { id: string; content: string }) =>
      api.saveProjectMd(id, content, true),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['projects'] });
      if (editingMdProjectId) {
        qc.invalidateQueries({ queryKey: ['project-md', editingMdProjectId] });
      }
      setEditingMdProjectId(null);
    },
  });

  const deleteProjectMutation = useMutation({
    mutationFn: (id: string) => api.deleteProject(id),
    onSuccess: (_data, deletedId) => {
      qc.invalidateQueries({ queryKey: ['projects'] });
      const remaining = projects.filter((p) => p.id !== deletedId);
      if (remaining.length > 0) {
        setActiveProjectId(remaining[0].id);
        setProjectStep(defaultStepForProject(remaining[0]));
        setSection('project');
      } else {
        setActiveProjectId(null);
        setSection('new-project');
      }
    },
  });

  const quickFinishDiscussMutation = useMutation({
    mutationFn: (projectId: string) => api.finishDiscuss(projectId),
    onMutate: () => setQuickError(null),
    onSuccess: (_data, projectId) => {
      qc.invalidateQueries({ queryKey: ['briefs', projectId] });
      qc.invalidateQueries({ queryKey: ['discuss', projectId] });
      qc.invalidateQueries({ queryKey: ['projects'] });
      setProjectStep('brief');
    },
    onError: (err) => setQuickError((err as Error).message),
  });

  const quickGeneratePlanMutation = useMutation({
    mutationFn: (projectId: string) => api.generatePlan(projectId),
    onMutate: () => setQuickError(null),
    onSuccess: (_data, projectId) => {
      qc.invalidateQueries({ queryKey: ['plan', projectId] });
      qc.invalidateQueries({ queryKey: ['projects'] });
      setProjectStep('plan');
    },
    onError: (err) => setQuickError((err as Error).message),
  });

  const quickStartWorkMutation = useMutation({
    mutationFn: (projectId: string) => api.startExecution(projectId, {}),
    onMutate: () => setQuickError(null),
    onSuccess: (_data, projectId) => {
      qc.invalidateQueries({ queryKey: ['execution', projectId] });
      qc.invalidateQueries({ queryKey: ['plan', projectId] });
      qc.invalidateQueries({ queryKey: ['projects'] });
      setProjectStep('work');
    },
    onError: (err) => setQuickError((err as Error).message),
  });

  const pushActivity = (projectId: string, item: ActivityFeedItem) => {
    setLiveActivityByProject((prev) => ({
      ...prev,
      [projectId]: [item, ...(prev[projectId] ?? [])].slice(0, 80),
    }));
  };

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
            taskId?: string;
            runId?: string;
            profileName?: string;
            provider?: string;
            line?: string;
            status?: string;
            error?: string;
            round?: number;
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
            const provider = msg.provider as ProviderId | undefined;
            const profileName = msg.profileName ?? 'coder';
            runMetaByRunIdRef.current[msg.runId] = {
              taskId: msg.taskId ?? '',
              profileName,
              provider,
            };
            setRunLogsByRunId((prev) => ({ ...prev, [msg.runId!]: [] }));
            pushActivity(msg.projectId, {
              id: `${msg.runId}-started-${Date.now()}`,
              timestamp: new Date().toISOString(),
              projectId: msg.projectId,
              taskId: msg.taskId,
              character: characterForProfile(profileName),
              provider,
              kind: 'started',
              title: profileName,
            });
            qc.invalidateQueries({ queryKey: ['execution', msg.projectId] });
            qc.invalidateQueries({ queryKey: ['providers-status'] });
            qc.invalidateQueries({ queryKey: ['statistics'] });
          } else if (msg.type === 'run.log' && msg.projectId && msg.runId && msg.line) {
            setRunLogsByRunId((prev) => ({
              ...prev,
              [msg.runId!]: [...(prev[msg.runId!] ?? []).slice(-300), msg.line!],
            }));
            const meta = runMetaByRunIdRef.current[msg.runId];
            const parsed = parseRunLogActivity(msg.line, {
              projectId: msg.projectId,
              taskId: msg.taskId ?? meta?.taskId ?? '',
              profileName: meta?.profileName ?? 'coder',
              provider: meta?.provider,
            });
            if (parsed) {
              pushActivity(msg.projectId, parsed);
            }
          } else if (msg.type === 'run.finished' && msg.projectId) {
            const meta = msg.runId ? runMetaByRunIdRef.current[msg.runId] : undefined;
            const ok = msg.status === 'completed';
            pushActivity(msg.projectId, {
              id: `${msg.runId ?? 'run'}-finished-${Date.now()}`,
              timestamp: new Date().toISOString(),
              projectId: msg.projectId,
              taskId: msg.taskId ?? meta?.taskId,
              character: characterForProfile(meta?.profileName ?? 'coder'),
              provider: meta?.provider,
              kind: ok ? 'completed' : 'failed',
              reason: msg.error ?? msg.status,
            });
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
          } else if (msg.type === 'review.finished' && msg.projectId) {
            pushActivity(msg.projectId, {
              id: `review-${msg.taskId ?? ''}-${Date.now()}`,
              timestamp: new Date().toISOString(),
              projectId: msg.projectId,
              taskId: msg.taskId,
              character: 'arjuna',
              kind: msg.status === 'pass' ? 'review_pass' : 'review_fail',
              round: msg.round ?? 1,
            });
            qc.invalidateQueries({ queryKey: ['guard', msg.projectId] });
            qc.invalidateQueries({ queryKey: ['execution', msg.projectId] });
            qc.invalidateQueries({ queryKey: ['plan', msg.projectId] });
            qc.invalidateQueries({ queryKey: ['task-diff', msg.projectId] });
            qc.invalidateQueries({ queryKey: ['projects'] });
          } else if (msg.type === 'integration.finished' && msg.projectId) {
            pushActivity(msg.projectId, {
              id: `integration-${Date.now()}`,
              timestamp: new Date().toISOString(),
              projectId: msg.projectId,
              taskId: msg.taskId ?? undefined,
              character: 'arjuna',
              kind: 'integration',
              status: msg.status ?? 'passed',
            });
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

  const handleSelectProject = (project: ProjectSummary, explicitStep?: ProjectStepId) => {
    setActiveProjectId(project.id);
    setProjectStep(explicitStep ?? defaultStepForProject(project));
    setSection('project');
    previousSectionRef.current = 'project';
    setQuickError(null);
    setMobileMenuOpen(false);
  };

  const handleOpenConfig = (tab: ConfigTabId = 'general') => {
    if (section === 'project' || section === 'new-project' || section === 'statistics') {
      previousSectionRef.current = section;
    }
    setConfigTab(tab);
    setSection('config');
    setMobileMenuOpen(false);
  };

  const handleBackFromConfig = () => {
    if (previousSectionRef.current === 'project' && !activeProject) {
      setSection('new-project');
    } else {
      setSection(previousSectionRef.current);
    }
    setMobileMenuOpen(false);
  };

  const handleOpenStatistics = () => {
    setSection('statistics');
    previousSectionRef.current = 'statistics';
    setMobileMenuOpen(false);
  };

  const handleNewProject = () => {
    setSection('new-project');
    previousSectionRef.current = 'new-project';
    setMobileMenuOpen(false);
  };

  const handleSkipWizard = () => {
    setWizardDismissed(true);
    writeStored('dalang.wizardDismissed', '1');
    if (activeProject) {
      setSection('project');
    } else {
      setSection('new-project');
    }
  };

  const handleCompleteWizardProject = (project: ProjectSummary, goalText: string) => {
    setWizardDismissed(true);
    writeStored('dalang.wizardDismissed', '1');
    setActiveProjectId(project.id);
    setInitialGoal(goalText);
    setProjectStep('discuss');
    setSection('project');
    previousSectionRef.current = 'project';
  };

  const handleReopenWizard = () => {
    setSection('wizard');
    setMobileMenuOpen(false);
  };

  const executionState = executionQuery.data?.execution ?? null;
  const previews = executionState?.dispatchPreviews ?? [];
  const allTasksDone =
    Boolean(activeProject?.planStatus === 'approved') &&
    previews.length > 0 &&
    previews.every((p) => p.status === 'done');

  const hasDiscussMessages = (discussQuery.data?.messages.length ?? 0) > 0;
  const quickBusy =
    quickFinishDiscussMutation.isPending ||
    quickGeneratePlanMutation.isPending ||
    quickStartWorkMutation.isPending;

  return (
    <div className="flex min-h-dvh flex-col md:flex-row">
      {/* Mobile top bar */}
      <header
        className="flex items-center justify-between gap-3 border-b px-4 py-2.5 md:hidden"
        style={{
          backgroundColor: 'var(--bg-surface)',
          borderColor: 'var(--border-subtle)',
        }}
      >
        <div className="flex min-w-0 items-center gap-2">
          <GununganMark size={22} />
          <span className="text-base font-bold tracking-tight">{t('app.title')}</span>
        </div>
        <Button
          type="button"
          variant="outline"
          onClick={() => setMobileMenuOpen(true)}
          aria-expanded={mobileMenuOpen}
          aria-label={t('common.menu')}
        >
          {t('common.menu')}
        </Button>
      </header>

      {/* Left sidebar (desktop fixed + mobile modal drawer) */}
      <Sidebar
        mode={section === 'config' ? 'config' : 'workspace'}
        projects={projects}
        activeProjectId={activeProject?.id ?? null}
        activeSection={section}
        configTab={configTab}
        updateStatus={updateStatusQuery.data?.update ?? null}
        mobileOpen={mobileMenuOpen}
        onCloseMobile={() => setMobileMenuOpen(false)}
        onNewProject={handleNewProject}
        onSelectProject={(project) => handleSelectProject(project)}
        onOpenStatistics={handleOpenStatistics}
        onOpenConfig={handleOpenConfig}
        onBackFromConfig={handleBackFromConfig}
        onSelectConfigTab={(tab) => setConfigTab(tab)}
      />

      {/* Main workspace */}
      <main className="min-w-0 flex-1 overflow-x-clip px-4 py-5 sm:px-6 lg:px-8">
        <div className="mx-auto w-full max-w-6xl space-y-5">
          {section === 'wizard' && (
            <WizardView
              onSkip={handleSkipWizard}
              onCompleteProject={handleCompleteWizardProject}
            />
          )}

          {section === 'new-project' && (
            <ProjectsView
              onSelectProject={(project) => handleSelectProject(project, 'discuss')}
            />
          )}

          {section === 'statistics' && <StatisticsView />}

          {section === 'config' && (
            <ConfigView
              tab={configTab}
              updateStatus={updateStatusQuery.data?.update ?? null}
              onReopenWizard={handleReopenWizard}
            />
          )}

          {section === 'project' && projectsQuery.isLoading && (
            <LoadingPanel label={t('projects.loading')} />
          )}

          {section === 'project' && projectsQuery.isError && (
            <ErrorPanel
              title={t('projects.loadError')}
              detail={(projectsQuery.error as Error).message}
              onRetry={() => projectsQuery.refetch()}
            />
          )}

          {section === 'project' &&
            !projectsQuery.isLoading &&
            !projectsQuery.isError &&
            !activeProject && (
              <EmptyPanel
                title={t('project.selectFirstTitle')}
                description={t('project.selectFirstDesc')}
                action={
                  <div className="flex flex-wrap gap-2">
                    <Button type="button" onClick={handleNewProject}>
                      {t('project.createButton')}
                    </Button>
                    <Button type="button" variant="outline" onClick={handleReopenWizard}>
                      {t('config.general.reopenWizard')}
                    </Button>
                  </div>
                }
              />
            )}

          {section === 'project' && activeProject && (
            <>
              <ProjectStepper
                project={activeProject}
                currentStep={projectStep}
                onSelectStep={(step) => {
                  setProjectStep(step);
                  setQuickError(null);
                }}
                onEditProjectMd={() => setEditingMdProjectId(activeProject.id)}
                onRemoveProject={() => deleteProjectMutation.mutate(activeProject.id)}
                removingProject={deleteProjectMutation.isPending}
                allTasksDone={allTasksDone}
              />

              <NextStepCard
                project={activeProject}
                currentStep={projectStep}
                execution={executionState}
                hasDiscussMessages={hasDiscussMessages}
                onNavigateStep={(step) => {
                  setProjectStep(step);
                  setQuickError(null);
                }}
                onQuickWriteBrief={() => quickFinishDiscussMutation.mutate(activeProject.id)}
                onQuickGeneratePlan={() => quickGeneratePlanMutation.mutate(activeProject.id)}
                onQuickStartWork={() => quickStartWorkMutation.mutate(activeProject.id)}
                busy={quickBusy}
              />

              {quickError && (
                <ErrorPanel title={t('plan.actionFailed')} detail={quickError} />
              )}

              {projectStep === 'discuss' && (
                <DiscussView
                  key={activeProject.id}
                  project={activeProject}
                  liveLogs={liveLogs}
                  initialGoal={initialGoal}
                  onConsumeInitialGoal={() => setInitialGoal('')}
                  onGoToAgree={() => setProjectStep('brief')}
                />
              )}

              {projectStep === 'brief' && (
                <AgreeView
                  key={activeProject.id}
                  project={activeProject}
                  onGoToDiscuss={() => setProjectStep('discuss')}
                  onGoToList={() => setProjectStep('plan')}
                />
              )}

              {projectStep === 'plan' && (
                <ListView
                  key={activeProject.id}
                  project={activeProject}
                  onGoToAgree={() => setProjectStep('brief')}
                  onGoToWork={() => setProjectStep('work')}
                />
              )}

              {projectStep === 'work' && (
                <WorkView
                  key={activeProject.id}
                  project={activeProject}
                  liveLogsByRunId={runLogsByRunId}
                  liveActivity={liveActivityByProject[activeProject.id] ?? []}
                  onGoToPlan={() => setProjectStep('plan')}
                  onGoToReview={() => setProjectStep('review')}
                />
              )}

              {projectStep === 'review' && (
                <GuardView
                  key={activeProject.id}
                  project={activeProject}
                  onGoToWork={() => setProjectStep('work')}
                />
              )}
            </>
          )}
        </div>
      </main>

      {/* PROJECT.md editor modal launched from ProjectStepper */}
      <ModalDialog
        open={Boolean(editingMdProjectId)}
        title={t('projects.mdModalTitle')}
        onClose={() => setEditingMdProjectId(null)}
      >
        {mdQuery.isLoading ? (
          <LoadingPanel label={t('projects.mdLoading')} />
        ) : mdQuery.isError ? (
          <ErrorPanel
            title={t('projects.loadError')}
            detail={(mdQuery.error as Error).message}
          />
        ) : (
          <div className="space-y-4">
            <p className="text-sm" style={{ color: 'var(--text-secondary)' }}>
              {t('projects.mdNote')}
            </p>
            <div>
              <Label htmlFor="header-project-md-editor" className="mb-1 block text-xs font-medium">
                {t('projects.mdLabel')}
              </Label>
              <Textarea
                id="header-project-md-editor"
                rows={14}
                value={mdDraft}
                onChange={(e) => setMdDraft(e.target.value)}
                className="font-mono-token text-xs"
              />
            </div>
            {saveMdMutation.isError && (
              <ErrorPanel
                title={t('projects.loadError')}
                detail={(saveMdMutation.error as Error).message}
              />
            )}
            <div className="flex flex-wrap justify-end gap-2">
              <Button
                type="button"
                variant="outline"
                onClick={() => setEditingMdProjectId(null)}
              >
                {t('common.cancel')}
              </Button>
              <Button
                type="button"
                disabled={saveMdMutation.isPending || !editingMdProjectId}
                onClick={() => {
                  if (!editingMdProjectId) return;
                  saveMdMutation.mutate({
                    id: editingMdProjectId,
                    content: mdDraft,
                  });
                }}
              >
                {saveMdMutation.isPending ? t('common.saving') : t('projects.mdSave')}
              </Button>
            </div>
          </div>
        )}
      </ModalDialog>
    </div>
  );
}

export function App() {
  const qc = useQueryClient();
  const settingsQuery = useQuery({
    queryKey: ['settings'],
    queryFn: () => api.getSettings(),
    staleTime: 30_000,
  });

  return (
    <ThemeProvider>
      <I18nProvider
        serverLanguage={settingsQuery.data?.settings.language}
        onLanguageChanged={() => {
          qc.invalidateQueries({ queryKey: ['settings'] });
        }}
      >
        <AppShell />
      </I18nProvider>
    </ThemeProvider>
  );
}
