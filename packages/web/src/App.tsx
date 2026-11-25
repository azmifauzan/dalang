import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import type {
  ProjectSummary,
  ProviderId,
  SessionMode,
  SessionSummaryDTO,
} from '@dalang/shared';
import { GununganMark } from './assets/wayang/Gunungan.js';
import { characterForProfile } from './assets/wayang/WayangFigure.js';
import { AgreeView } from './components/AgreeView.js';
import { AskSessionView } from './components/AskSessionView.js';
import { AppLogin } from './components/AppLogin.js';
import { ConfigView } from './components/ConfigView.js';
import { DiscussView } from './components/DiscussView.js';
import { GuardView } from './components/GuardView.js';
import { ListView } from './components/ListView.js';
import { ProjectStepper, type ProjectStepId } from './components/ProjectStepper.js';
import { ProjectsView } from './components/ProjectsView.js';
import { ProviderUsageBar } from './components/ProviderUsageBar.js';
import { QuickSessionView } from './components/QuickSessionView.js';
import { SessionHeader } from './components/SessionHeader.js';
import { Sidebar, type ConfigTabId } from './components/Sidebar.js';
import { EmptyPanel, ErrorPanel, LoadingPanel, ModalDialog } from './components/StateViews.js';
import { StatisticsView } from './components/StatisticsView.js';
import { WizardView } from './components/WizardView.js';
import { WorkView } from './components/WorkView.js';
import { I18nProvider, useI18n } from './i18n/index.js';
import { parseRunLogActivity, type ActivityFeedItem } from './lib/activity.js';
import { api } from './lib/api.js';
import { applyLogLine, EMPTY_LIVE_TURN, type LiveTurn } from './lib/liveTurn.js';

interface LiveSession {
  logs: string[];
  turn: LiveTurn;
}
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

function defaultStepForSession(session: SessionSummaryDTO | null): ProjectStepId {
  if (!session) return 'discuss';
  if (
    session.workState === 'idle' &&
    session.taskCount > 0 &&
    session.doneTaskCount >= session.taskCount
  ) {
    return 'discuss';
  }
  if (session.planStatus === 'approved') return 'work';
  if (session.latestBriefStatus === 'approved') return 'plan';
  if (session.latestBriefStatus === 'draft') return 'brief';
  return 'discuss';
}

function AppShell({ authEnabled }: { authEnabled: boolean }) {
  const qc = useQueryClient();
  const { t } = useI18n();
  const signOutMutation = useMutation({
    mutationFn: api.logout,
    onSuccess: (status) => {
      qc.setQueryData(['auth-status'], status);
      return qc.invalidateQueries({ queryKey: ['auth-status'] });
    },
  });
  const signOut = () => signOutMutation.mutate();
  const factoryResetMutation = useMutation({
    mutationFn: api.factoryReset,
    onSuccess: () => {
      writeStored('dalang.activeProjectId', null);
      writeStored('dalang.activeSessionId', null);
      writeStored('dalang.sidebarCollapsed', null);
      writeStored('dalang.wizardDismissed', null);
      writeStored('dalang.theme', null);
      writeStored('dalang.language', null);
      qc.clear();
      window.location.reload();
    },
  });

  const [section, setSection] = useState<WorkspaceSection>('project');
  const [configTab, setConfigTab] = useState<ConfigTabId>('general');
  const previousSectionRef = useRef<'project' | 'new-project' | 'statistics'>('project');

  const [activeProjectId, setActiveProjectId] = useState<string | null>(() => {
    const param = new URLSearchParams(window.location.search).get('project');
    return param || readStored('dalang.activeProjectId');
  });
  const [activeSessionId, setActiveSessionId] = useState<string | null>(() => {
    const param = new URLSearchParams(window.location.search).get('session');
    return param || readStored('dalang.activeSessionId');
  });
  const [sidebarCollapsed, setSidebarCollapsed] = useState(
    () => readStored('dalang.sidebarCollapsed') === '1',
  );
  const [draftMode, setDraftMode] = useState<SessionMode>('auto');
  const [showArchivedSessions, setShowArchivedSessions] = useState(false);
  const [projectStep, setProjectStep] = useState<ProjectStepId>('discuss');
  const [initialGoal, setInitialGoal] = useState<string>('');
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);

  const [wizardDismissed, setWizardDismissed] = useState<boolean>(
    () => readStored('dalang.wizardDismissed') === '1',
  );
  const initializedFromProjectsRef = useRef(false);

  // What each chat's CLI is doing right now. Kept here, not in the chat view, so it survives switching chats.
  const [liveBySession, setLiveBySession] = useState<Record<string, LiveSession>>({});
  // A new chat has no session in the page until its first answer returns, so follow the newest turn.
  const [newestLiveSessionId, setNewestLiveSessionId] = useState<string | null>(null);
  // The CLI picked in the chat composer, so the header names the one that will answer.
  const [chatProvider, setChatProvider] = useState<ProviderId | null>(null);
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

  useEffect(() => {
    writeStored('dalang.activeSessionId', activeSessionId);
  }, [activeSessionId]);

  useEffect(() => {
    writeStored('dalang.sidebarCollapsed', sidebarCollapsed ? '1' : null);
  }, [sidebarCollapsed]);

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

  const sessionsQuery = useQuery({
    queryKey: ['sessions', activeProject?.id],
    queryFn: () => api.listSessions(activeProject!.id, true),
    enabled: Boolean(activeProject),
  });

  const allProjectSessions = sessionsQuery.data?.sessions ?? [];
  const activeProjectSessions = allProjectSessions.filter((s) => !s.archivedAt);
  const archivedProjectSessions = allProjectSessions.filter((s) => Boolean(s.archivedAt));
  const activeSession: SessionSummaryDTO | null = activeSessionId
    ? (allProjectSessions.find((s) => s.id === activeSessionId) ?? null)
    : null;

  // Decide initial destination once projects load:
  // - 0 projects & wizard not dismissed -> open first-run wizard
  // - >= 1 projects -> skip wizard and open most recent project
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
    if (!activeSessionId && chosen.workingSessionId) {
      setActiveSessionId(chosen.workingSessionId);
    }
    setSection('project');
  }, [projectsQuery.isSuccess, projects, activeProjectId, activeSessionId, wizardDismissed]);

  // Keep activeProjectId valid if the current project is removed
  useEffect(() => {
    if (!projectsQuery.isSuccess) return;
    if (projects.length === 0) {
      if (activeProjectId !== null) setActiveProjectId(null);
      if (activeSessionId !== null) setActiveSessionId(null);
      return;
    }
    if (!activeProjectId || !projects.some((p) => p.id === activeProjectId)) {
      setActiveProjectId(projects[0].id);
      setActiveSessionId(projects[0].workingSessionId ?? null);
      setDraftMode('auto');
    }
  }, [projectsQuery.isSuccess, projects, activeProjectId, activeSessionId]);

  const upsertSessionCache = (projectId: string, sess: SessionSummaryDTO) => {
    qc.setQueryData<{ sessions: SessionSummaryDTO[] }>(['sessions', projectId], (prev) => {
      const list = prev?.sessions ?? [];
      const rest = list.filter((s) => s.id !== sess.id);
      return { sessions: [sess, ...rest] };
    });
  };

  // Keep activeSessionId valid for the active project once its sessions load
  useEffect(() => {
    if (!sessionsQuery.isSuccess || sessionsQuery.isFetching || !activeProject) return;
    if (activeSessionId && !allProjectSessions.some((s) => s.id === activeSessionId)) {
      setActiveSessionId(activeProject.workingSessionId ?? null);
    }
  }, [sessionsQuery.isSuccess, sessionsQuery.isFetching, activeProject, activeSessionId, allProjectSessions]);

  const discussQuery = useQuery({
    queryKey: ['discuss', activeProject?.id, activeSession?.id],
    queryFn: () => api.getDiscussState(activeProject!.id, activeSession!.id),
    enabled: Boolean(
      activeProject && activeSession && activeSession.mode === 'full' && section === 'project',
    ),
  });

  const executionQuery = useQuery({
    queryKey: ['execution', activeProject?.id, activeSession?.id],
    queryFn: () => api.getExecutionState(activeProject!.id, activeSession!.id),
    enabled: Boolean(
      activeProject &&
        activeSession &&
        activeSession.mode === 'full' &&
        section === 'project' &&
        activeSession.planStatus === 'approved',
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
        setActiveSessionId(remaining[0].workingSessionId ?? null);
        setDraftMode('auto');
        setSection('project');
      } else {
        setActiveProjectId(null);
        setActiveSessionId(null);
        setSection('new-project');
      }
    },
  });

  const renameSessionMutation = useMutation({
    mutationFn: ({ projectId, sessionId, title }: { projectId: string; sessionId: string; title: string }) =>
      api.updateSession(projectId, sessionId, { title }),
    onSuccess: (_res, vars) => {
      qc.invalidateQueries({ queryKey: ['sessions', vars.projectId] });
      qc.invalidateQueries({ queryKey: ['session-detail', vars.projectId, vars.sessionId] });
      qc.invalidateQueries({ queryKey: ['projects'] });
    },
    onError: (err) => setQuickError((err as Error).message),
  });

  const archiveSessionMutation = useMutation({
    mutationFn: ({
      projectId,
      sessionId,
      archived,
    }: {
      projectId: string;
      sessionId: string;
      archived: boolean;
    }) => api.updateSession(projectId, sessionId, { archived }),
    onMutate: () => setQuickError(null),
    onSuccess: (_res, vars) => {
      qc.invalidateQueries({ queryKey: ['sessions', vars.projectId] });
      qc.invalidateQueries({ queryKey: ['projects'] });
    },
    onError: (err) => setQuickError((err as Error).message),
  });

  const deleteSessionMutation = useMutation({
    mutationFn: ({ projectId, sessionId }: { projectId: string; sessionId: string }) =>
      api.deleteSession(projectId, sessionId),
    onMutate: () => setQuickError(null),
    onSuccess: (_res, vars) => {
      if (activeSessionId === vars.sessionId) {
        setActiveSessionId(null);
        setDraftMode('auto');
      }
      qc.invalidateQueries({ queryKey: ['sessions', vars.projectId] });
      qc.invalidateQueries({ queryKey: ['projects'] });
    },
    onError: (err) => setQuickError((err as Error).message),
  });

  const discardWorkMutation = useMutation({
    mutationFn: ({ projectId, sessionId }: { projectId: string; sessionId: string }) =>
      api.discardSessionWork(projectId, sessionId),
    onMutate: () => setQuickError(null),
    onSuccess: (_res, vars) => {
      qc.invalidateQueries({ queryKey: ['sessions', vars.projectId] });
      qc.invalidateQueries({ queryKey: ['session-detail', vars.projectId, vars.sessionId] });
      qc.invalidateQueries({ queryKey: ['execution', vars.projectId] });
      qc.invalidateQueries({ queryKey: ['guard', vars.projectId] });
      qc.invalidateQueries({ queryKey: ['plan', vars.projectId] });
      qc.invalidateQueries({ queryKey: ['projects'] });
    },
    onError: (err) => setQuickError((err as Error).message),
  });

  const promoteSessionMutation = useMutation({
    mutationFn: ({
      projectId,
      sessionId,
      mode,
    }: {
      projectId: string;
      sessionId: string;
      mode: SessionMode;
    }) => api.switchSessionMode(projectId, sessionId, mode),
    onMutate: () => setQuickError(null),
    onSuccess: ({ session: updated }, vars) => {
      upsertSessionCache(vars.projectId, updated);
      qc.invalidateQueries({ queryKey: ['sessions', vars.projectId] });
      qc.invalidateQueries({ queryKey: ['session-detail', vars.projectId, vars.sessionId] });
      qc.invalidateQueries({ queryKey: ['discuss', vars.projectId] });
      qc.invalidateQueries({ queryKey: ['plan', vars.projectId] });
      qc.invalidateQueries({ queryKey: ['projects'] });
      if (updated.mode === 'full') {
        setProjectStep('discuss');
      }
    },
    onError: (err) => setQuickError((err as Error).message),
  });


  const pushActivity = (projectId: string, item: ActivityFeedItem) => {
    setLiveActivityByProject((prev) => ({
      ...prev,
      [projectId]: [item, ...(prev[projectId] ?? [])].slice(0, 80),
    }));
  };

  // A finished run has used some of the limits, so refresh them soon. Runs often end in bursts, so at most
  // one refresh per 30 seconds, and none while one is already running.
  const usageRefreshRef = useRef({ at: 0, busy: false });
  const refreshUsageAfterRun = () => {
    const state = usageRefreshRef.current;
    if (state.busy || Date.now() - state.at < 30_000) return;
    state.busy = true;
    api
      .refreshProvidersStatus()
      .then((data) => qc.setQueryData(['providers-status'], data))
      .catch(() => undefined)
      .finally(() => {
        state.busy = false;
        state.at = Date.now();
      });
  };

  // WebSocket live updates
  useEffect(() => {
    const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${proto}//${window.location.host}/ws`;
    let ws: WebSocket | null = null;
    let closedByEffect = false;

    try {
      ws = new WebSocket(wsUrl);
      ws.onclose = () => {
        if (!closedByEffect) qc.invalidateQueries({ queryKey: ['auth-status'] });
      };
      ws.onmessage = (ev) => {
        try {
          const msg = JSON.parse(ev.data as string) as {
            type: string;
            projectId?: string;
            sessionId?: string;
            taskId?: string;
            parentTaskId?: string;
            parentExternalId?: string;
            externalId?: string;
            title?: string;
            targetBranch?: string;
            runId?: string;
            profileName?: string;
            provider?: string;
            line?: string;
            status?: string;
            error?: string;
            round?: number;
          };

          if (msg.type === 'lead.turn_started' && msg.projectId === activeProjectId) {
            if (msg.sessionId) {
              setNewestLiveSessionId(msg.sessionId);
              setLiveBySession((prev) => ({
                ...prev,
                [msg.sessionId!]: { logs: [], turn: EMPTY_LIVE_TURN },
              }));
            }
            qc.invalidateQueries({ queryKey: ['statistics'] });
          } else if (msg.type === 'lead.turn_finished' && msg.projectId) {
            refreshUsageAfterRun();
            qc.invalidateQueries({ queryKey: ['statistics'] });
          } else if (msg.type === 'lead.log' && msg.projectId === activeProjectId && msg.line) {
            if (msg.sessionId) {
              setLiveBySession((prev) => {
                const current = prev[msg.sessionId!] ?? { logs: [], turn: EMPTY_LIVE_TURN };
                return {
                  ...prev,
                  [msg.sessionId!]: {
                    logs: [...current.logs.slice(-40), msg.line!],
                    turn: applyLogLine(current.turn, msg.line!),
                  },
                };
              });
            }
          } else if (
            msg.type === 'automation.updated' ||
            msg.type === 'automation.triggered' ||
            msg.type === 'automation.finished'
          ) {
            qc.invalidateQueries({ queryKey: ['automations'] });
            qc.invalidateQueries({ queryKey: ['automation-runs'] });
            if (msg.projectId) {
              qc.invalidateQueries({ queryKey: ['sessions', msg.projectId] });
              qc.invalidateQueries({ queryKey: ['projects'] });
            }
          } else if (msg.type === 'sessions.updated' && msg.projectId) {
            qc.invalidateQueries({ queryKey: ['sessions', msg.projectId] });
            qc.invalidateQueries({ queryKey: ['session-detail', msg.projectId] });
            qc.invalidateQueries({ queryKey: ['projects'] });
          } else if ((msg.type === 'discuss.updated' || msg.type === 'room.message') && msg.projectId) {
            qc.invalidateQueries({ queryKey: ['discuss', msg.projectId] });
            qc.invalidateQueries({ queryKey: ['session-detail', msg.projectId] });
          } else if (msg.type === 'brief.updated' && msg.projectId) {
            qc.invalidateQueries({ queryKey: ['briefs', msg.projectId] });
            qc.invalidateQueries({ queryKey: ['sessions', msg.projectId] });
            qc.invalidateQueries({ queryKey: ['projects'] });
          } else if (msg.type === 'plan.updated' && msg.projectId) {
            qc.invalidateQueries({ queryKey: ['plan', msg.projectId] });
            qc.invalidateQueries({ queryKey: ['session-detail', msg.projectId] });
            qc.invalidateQueries({ queryKey: ['execution', msg.projectId] });
            qc.invalidateQueries({ queryKey: ['guard', msg.projectId] });
            qc.invalidateQueries({ queryKey: ['sessions', msg.projectId] });
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
            qc.invalidateQueries({ queryKey: ['session-detail', msg.projectId] });
            qc.invalidateQueries({ queryKey: ['sessions', msg.projectId] });
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
            refreshUsageAfterRun();
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
            qc.invalidateQueries({ queryKey: ['session-detail', msg.projectId] });
            qc.invalidateQueries({ queryKey: ['plan', msg.projectId] });
            qc.invalidateQueries({ queryKey: ['guard', msg.projectId] });
            qc.invalidateQueries({ queryKey: ['sessions', msg.projectId] });
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
            qc.invalidateQueries({ queryKey: ['session-detail', msg.projectId] });
            qc.invalidateQueries({ queryKey: ['execution', msg.projectId] });
            qc.invalidateQueries({ queryKey: ['plan', msg.projectId] });
            qc.invalidateQueries({ queryKey: ['task-diff', msg.projectId] });
            qc.invalidateQueries({ queryKey: ['sessions', msg.projectId] });
            qc.invalidateQueries({ queryKey: ['projects'] });
          } else if (msg.type === 'task.delegated' && msg.projectId) {
            const provider = msg.provider as ProviderId | undefined;
            pushActivity(msg.projectId, {
              id: `delegated-${msg.taskId ?? ''}-${Date.now()}`,
              timestamp: new Date().toISOString(),
              projectId: msg.projectId,
              taskId: msg.taskId,
              taskExternalId: msg.externalId,
              character: characterForProfile(msg.profileName ?? 'coder'),
              provider,
              kind: 'delegated',
              title: msg.title,
              target: msg.parentExternalId,
            });
            qc.invalidateQueries({ queryKey: ['execution', msg.projectId] });
            qc.invalidateQueries({ queryKey: ['plan', msg.projectId] });
            qc.invalidateQueries({ queryKey: ['session-detail', msg.projectId] });
          } else if (msg.type === 'task.subtask_merged' && msg.projectId) {
            pushActivity(msg.projectId, {
              id: `submerged-${msg.taskId ?? ''}-${Date.now()}`,
              timestamp: new Date().toISOString(),
              projectId: msg.projectId,
              taskId: msg.taskId,
              taskExternalId: msg.externalId,
              character: 'arjuna',
              kind: 'subtask_merged',
              target: msg.targetBranch,
            });
            qc.invalidateQueries({ queryKey: ['execution', msg.projectId] });
            qc.invalidateQueries({ queryKey: ['plan', msg.projectId] });
            qc.invalidateQueries({ queryKey: ['session-detail', msg.projectId] });
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
            qc.invalidateQueries({ queryKey: ['session-detail', msg.projectId] });
            qc.invalidateQueries({ queryKey: ['execution', msg.projectId] });
            qc.invalidateQueries({ queryKey: ['plan', msg.projectId] });
            qc.invalidateQueries({ queryKey: ['task-diff', msg.projectId] });
            qc.invalidateQueries({ queryKey: ['sessions', msg.projectId] });
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
  }, [activeProjectId, authEnabled, qc]);

  const handleSelectProject = (project: ProjectSummary) => {
    setActiveProjectId(project.id);
    // Opening a project shows its active working session if one exists, otherwise straight into an empty Ask chat (creates no session).
    setActiveSessionId(project.workingSessionId ?? null);
    setDraftMode('auto');
    setSection('project');
    previousSectionRef.current = 'project';
    setQuickError(null);
    setMobileMenuOpen(false);
  };

  const handleNewChat = (project: ProjectSummary) => {
    setActiveProjectId(project.id);
    setActiveSessionId(null);
    setDraftMode('auto');
    setProjectStep('discuss');
    setSection('project');
    previousSectionRef.current = 'project';
    setQuickError(null);
    setMobileMenuOpen(false);
  };

  const handleSelectSession = (project: ProjectSummary, session: SessionSummaryDTO) => {
    setActiveProjectId(project.id);
    setActiveSessionId(session.id);
    setProjectStep(defaultStepForSession(session));
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
    setActiveSessionId(null);
    setDraftMode('auto');
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
    Boolean(activeSession?.planStatus === 'approved') &&
    previews.length > 0 &&
    previews.every((p) => p.status === 'done');


  const sessionMutating =
    renameSessionMutation.isPending ||
    archiveSessionMutation.isPending ||
    deleteSessionMutation.isPending ||
    discardWorkMutation.isPending ||
    promoteSessionMutation.isPending;

  return (
    <div className="flex min-h-dvh flex-col lg:flex-row">
      {/* Mobile top bar */}
      <header
        className="flex items-center justify-between gap-3 border-b px-4 py-2.5 lg:hidden"
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
        activeSessionId={activeSession?.id ?? null}
        activeProjectSessions={activeProjectSessions}
        archivedProjectSessions={archivedProjectSessions}
        showArchivedSessions={showArchivedSessions}
        activeSection={section}
        configTab={configTab}
        updateStatus={updateStatusQuery.data?.update ?? null}
        mobileOpen={mobileMenuOpen}
        collapsed={sidebarCollapsed}
        onToggleCollapsed={() => setSidebarCollapsed((v) => !v)}
        onCloseMobile={() => setMobileMenuOpen(false)}
        onNewProject={handleNewProject}
        onSelectProject={handleSelectProject}
        onNewChat={handleNewChat}
        onSelectSession={handleSelectSession}
        onToggleShowArchived={() => setShowArchivedSessions((v) => !v)}
        onOpenStatistics={handleOpenStatistics}
        onOpenConfig={handleOpenConfig}
        onSignOut={authEnabled ? signOut : undefined}
        signingOut={signOutMutation.isPending}
        onBackFromConfig={handleBackFromConfig}
        onSelectConfigTab={(tab) => setConfigTab(tab)}
      />

      {/* Main workspace */}
      <main className="flex min-w-0 flex-1 flex-col overflow-x-clip px-4 py-5 sm:px-6 lg:px-8">
        {authEnabled && signOutMutation.isError && (
          <ErrorPanel title={t('auth.signOut')} detail={signOutMutation.error.message} onRetry={signOut} />
        )}
        <div
          className={
            section === 'project'
              ? 'flex w-full flex-1 flex-col gap-4'
              : 'mx-auto w-full max-w-6xl space-y-4'
          }
        >
          {section === 'wizard' && (
            <WizardView
              onSkip={handleSkipWizard}
              onCompleteProject={handleCompleteWizardProject}
            />
          )}

          {section === 'new-project' && (
            <ProjectsView onSelectProject={handleSelectProject} />
          )}

          {section === 'statistics' && <StatisticsView />}

          {section === 'config' && (
            <ConfigView
              tab={configTab}
              updateStatus={updateStatusQuery.data?.update ?? null}
              onSelectTab={(nextTab) => setConfigTab(nextTab)}
              onReopenWizard={handleReopenWizard}
              onFactoryReset={() => factoryResetMutation.mutate()}
              resettingFactory={factoryResetMutation.isPending}
              factoryResetError={factoryResetMutation.isError ? factoryResetMutation.error.message : null}
              onSignOut={signOut}
              signingOut={signOutMutation.isPending}
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
            <div className="flex flex-1 flex-col gap-4">
              <ProviderUsageBar />
              <SessionHeader
                project={activeProject}
                session={activeSession}
                draftMode={draftMode}
                provider={chatProvider ?? activeSession?.provider ?? activeProject.leadProvider}
                onRenameSession={(title) => {
                  if (!activeSession) return;
                  renameSessionMutation.mutate({
                    projectId: activeProject.id,
                    sessionId: activeSession.id,
                    title,
                  });
                }}
                onToggleArchiveSession={(archived) => {
                  if (!activeSession) return;
                  archiveSessionMutation.mutate({
                    projectId: activeProject.id,
                    sessionId: activeSession.id,
                    archived,
                  });
                }}
                onDeleteSession={() => {
                  if (!activeSession) return;
                  deleteSessionMutation.mutate({
                    projectId: activeProject.id,
                    sessionId: activeSession.id,
                  });
                }}
                onDiscardWork={() => {
                  if (!activeSession) return;
                  discardWorkMutation.mutate({
                    projectId: activeProject.id,
                    sessionId: activeSession.id,
                  });
                }}
                onEditProjectMd={() => setEditingMdProjectId(activeProject.id)}
                onRemoveProject={() => deleteProjectMutation.mutate(activeProject.id)}
                busy={sessionMutating}
                removingProject={deleteProjectMutation.isPending}
              />

              {quickError && (
                <ErrorPanel title={t('plan.actionFailed')} detail={quickError} />
              )}

              {activeSession?.mode === 'auto' && (
                <nav className="flex gap-2" aria-label={t('nav.projectStepsAria')}>
                  {(['discuss', 'work', 'review'] as const).map((step) => (
                    <button key={step} type="button" onClick={() => setProjectStep(step)} aria-pressed={projectStep === step}>
                      {t(step === 'discuss' ? 'step.1.label' : step === 'work' ? 'step.4.label' : 'step.5.label')}
                    </button>
                  ))}
                </nav>
              )}
              {activeSession?.mode === 'auto' && projectStep === 'work' && (
                <WorkView project={activeProject} sessionId={activeSession.id} liveLogsByRunId={runLogsByRunId}
                  liveActivity={liveActivityByProject[activeProject.id] ?? []}
                  onGoToPlan={() => setProjectStep('discuss')} onGoToReview={() => setProjectStep('review')} />
              )}
              {activeSession?.mode === 'auto' && projectStep === 'review' && (
                <GuardView project={activeProject} sessionId={activeSession.id} onGoToWork={() => setProjectStep('work')} />
              )}
              {(!activeSession || activeSession.mode === 'ask' || (activeSession.mode === 'auto' && projectStep !== 'work' && projectStep !== 'review')) && (
                <AskSessionView
                  key={`${activeProject.id}:${activeSession?.id ?? 'new'}`}
                  project={activeProject}
                  session={activeSession}
                  draftMode={draftMode}
                  onChangeDraftMode={setDraftMode}
                  live={liveBySession[activeSession?.id ?? newestLiveSessionId ?? '']}
                  onProviderChange={setChatProvider}
                  initialPrompt={initialGoal}
                  onConsumeInitialPrompt={() => setInitialGoal('')}
                  onSessionCreatedOrUpdated={(sess) => {
                    upsertSessionCache(activeProject.id, sess);
                    setActiveSessionId(sess.id);
                    if (sess.mode === 'full') {
                      setProjectStep('discuss');
                    }
                  }}
                  onPromoteSession={(sessionId, mode) => {
                    promoteSessionMutation.mutate({
                      projectId: activeProject.id,
                      sessionId,
                      mode,
                    });
                  }}
                />
              )}

              {/* Quick session: short 4-stage timeline + one-screen flow */}
              {activeSession && activeSession.mode === 'quick' && (
                <QuickSessionView
                  key={`${activeProject.id}:${activeSession.id}`}
                  project={activeProject}
                  session={activeSession}
                  live={liveBySession[activeSession.id]}
                  onProviderChange={setChatProvider}
                  liveLogsByRunId={runLogsByRunId}
                  onSessionUpdated={(sess) => {
                    upsertSessionCache(activeProject.id, sess);
                    setActiveSessionId(sess.id);
                    if (sess.mode === 'full') {
                      setProjectStep('discuss');
                    }
                  }}
                  onPromoteToFull={() => {
                    promoteSessionMutation.mutate({
                      projectId: activeProject.id,
                      sessionId: activeSession.id,
                      mode: 'full',
                    });
                  }}
                />
              )}

              {/* Full session: v0.6 five-step guided workflow */}
              {activeSession && activeSession.mode === 'full' && (
                <>
                  <ProjectStepper
                    project={activeProject}
                    session={activeSession}
                    currentStep={projectStep}
                    onSelectStep={(step) => {
                      setProjectStep(step);
                      setQuickError(null);
                    }}
                    allTasksDone={allTasksDone}
                  />

                  {projectStep === 'discuss' && (
                    <DiscussView
                      key={`${activeProject.id}:${activeSession.id}`}
                      project={activeProject}
                      session={activeSession}
                      live={liveBySession[activeSession.id]}
                      onProviderChange={setChatProvider}
                      initialGoal={initialGoal}
                      onConsumeInitialGoal={() => setInitialGoal('')}
                      onGoToAgree={() => setProjectStep('brief')}
                    />
                  )}

                  {projectStep === 'brief' && (
                    <AgreeView
                      key={`${activeProject.id}:${activeSession.id}`}
                      project={activeProject}
                      sessionId={activeSession.id}
                      onGoToDiscuss={() => setProjectStep('discuss')}
                      onGoToList={() => setProjectStep('plan')}
                    />
                  )}

                  {projectStep === 'plan' && (
                    <ListView
                      key={`${activeProject.id}:${activeSession.id}`}
                      project={activeProject}
                      sessionId={activeSession.id}
                      onGoToAgree={() => setProjectStep('brief')}
                      onGoToWork={() => setProjectStep('work')}
                    />
                  )}

                  {projectStep === 'work' && (
                    <WorkView
                      key={`${activeProject.id}:${activeSession.id}`}
                      project={activeProject}
                      sessionId={activeSession.id}
                      liveLogsByRunId={runLogsByRunId}
                      liveActivity={liveActivityByProject[activeProject.id] ?? []}
                      onGoToPlan={() => setProjectStep('plan')}
                      onGoToReview={() => setProjectStep('review')}
                    />
                  )}

                  {projectStep === 'review' && (
                    <GuardView
                      key={`${activeProject.id}:${activeSession.id}`}
                      project={activeProject}
                      sessionId={activeSession.id}
                      onGoToWork={() => setProjectStep('work')}
                    />
                  )}
                </>
              )}
            </div>
          )}
        </div>
      </main>

      {/* PROJECT.md editor modal */}
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
  const authQuery = useQuery({ queryKey: ['auth-status'], queryFn: api.authStatus, retry: false });
  const authenticated = authQuery.data?.authenticated;
  const settingsQuery = useQuery({
    queryKey: ['settings'],
    queryFn: () => api.getSettings(),
    staleTime: 30_000,
    enabled: authenticated === true,
  });

  useEffect(() => {
    const refreshAuth = () => { void qc.invalidateQueries({ queryKey: ['auth-status'] }); };
    window.addEventListener('dalang-auth-required', refreshAuth);
    return () => window.removeEventListener('dalang-auth-required', refreshAuth);
  }, [qc]);

  useEffect(() => {
    if (authenticated === false) {
      qc.removeQueries({ predicate: (query) => query.queryKey[0] !== 'auth-status' });
    }
  }, [authenticated, qc]);

  return (
    <ThemeProvider>
      <I18nProvider
        serverLanguage={settingsQuery.data?.settings.language ?? authQuery.data?.language}
        onLanguageChanged={() => {
          qc.invalidateQueries({ queryKey: ['settings'] });
        }}
      >
        {authQuery.data ? (
          authenticated ? <AppShell authEnabled={authQuery.data.enabled} /> : <AppLogin />
        ) : authQuery.isError ? (
          <ErrorPanel title="DALANG" detail={authQuery.error.message} onRetry={() => authQuery.refetch()} />
        ) : <LoadingPanel label="DALANG" />}
      </I18nProvider>
    </ThemeProvider>
  );
}
