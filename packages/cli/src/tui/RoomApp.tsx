import os from 'node:os';
import path from 'node:path';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Box, Text, useApp, useInput, useStdout } from 'ink';
import type {
  AgentProfileDTO,
  ExecutionStateDTO,
  GuardStateDTO,
  ProjectSummary,
  ProviderStatus,
  SessionDetailDTO,
  SessionMode,
  SessionSummaryDTO,
} from '@dalang/shared';
import { DALANG_VERSION, DEFAULT_USAGE_REFRESH_MINUTES } from '@dalang/shared';
import { RoomApiClient, type ServerEvent } from './client.js';
import { ConfigScreen } from './ConfigScreen.js';
import { ICON_COLOR, KAYON_ICON } from './icon.js';
import { ModelPicker } from './ModelPicker.js';
import {
  ACTIVE_SOURCE_LABEL,
  activeLeadModel,
  describeModel,
  describeRunningAgents,
  type ModelChoice,
} from './models.js';
import { stripMouse, useMouseWheel, WHEEL_ROWS } from './mouse.js';
import { usableProviderIds } from './team.js';
import { Wizard } from './Wizard.js';
import {
  applyComposerCompletion,
  getComposerCompletions,
  parseSlashCommand,
  POPUP_SIZE,
  popupWindowStart,
  resolveComposerSubmit,
  resumableSessions,
  SLASH_COMMANDS,
} from './commands.js';
import {
  detectPendingGate,
  extractActivityPreview,
  formatRoomMessage,
  type FormattedRoomMessage,
  type PendingGate,
  providerStatChips,
  LOW_LIMIT_PERCENT,
  wrapTimelineLine,
} from './format.js';

export interface RoomAppProps {
  client: RoomApiClient;
  embedded: boolean;
  cwd: string;
  openBrowser: (url: string) => void;
  onOpenPager: (content: string, label: string) => Promise<{ ok: boolean; error?: string }>;
  onRequestExit?: () => void;
  /** Let the mouse wheel scroll the timeline (asks the terminal for wheel reports). */
  enableMouse?: boolean;
}

interface LocalNotice {
  id: string;
  author: string;
  authorColor: FormattedRoomMessage['authorColor'];
  badge: string | null;
  time: string;
  createdAt: string;
  lines: string[];
  isError: boolean;
}

function nowClock(): string {
  const d = new Date();
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/** A limit percentage: red at or below the low mark, like the web usage bar. */
function Percent({ value }: { value: number }) {
  const low = value <= LOW_LIMIT_PERCENT;
  return (
    <Text bold color={low ? 'red' : undefined}>
      {value}%
    </Text>
  );
}

/** A path with the home folder written as "~". */
function shortPath(p: string): string {
  const home = os.homedir();
  return p === home ? '~' : p.startsWith(home + path.sep) ? `~${p.slice(home.length)}` : p;
}

function matchProjectForCwd(projects: ProjectSummary[], cwd: string): ProjectSummary | null {
  const resolvedCwd = path.resolve(cwd);
  // Exact match first, then deepest parent project containing cwd.
  let best: ProjectSummary | null = null;
  for (const p of projects) {
    const resolvedProj = path.resolve(p.path);
    if (resolvedCwd === resolvedProj) return p;
    if (
      resolvedCwd.startsWith(resolvedProj + path.sep) &&
      (!best || resolvedProj.length > path.resolve(best.path).length)
    ) {
      best = p;
    }
  }
  return best;
}

export function RoomApp({
  client,
  embedded,
  cwd,
  openBrowser,
  onOpenPager,
  onRequestExit,
  enableMouse = false,
}: RoomAppProps) {
  const { exit } = useApp();
  const { stdout } = useStdout();

  const ttyOut = stdout as NodeJS.WriteStream | undefined;
  const [termSize, setTermSize] = useState({
    cols: ttyOut?.columns || 100,
    rows: ttyOut?.rows || 28,
  });

  useEffect(() => {
    if (!ttyOut) return;
    const onResize = () => {
      setTermSize({ cols: ttyOut.columns || 100, rows: ttyOut.rows || 28 });
    };
    ttyOut.on('resize', onResize);
    return () => {
      ttyOut.off('resize', onResize);
    };
  }, [ttyOut]);

  // Auth gate
  const [authNeeded, setAuthNeeded] = useState(false);
  const [passwordInput, setPasswordInput] = useState('');
  const [authError, setAuthError] = useState<string | null>(null);
  const [ready, setReady] = useState(false);

  // Room data
  const [wsConnected, setWsConnected] = useState(false);
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [activeProjectId, setActiveProjectId] = useState<string | null>(null);
  const [sessions, setSessions] = useState<SessionSummaryDTO[]>([]);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [detail, setDetail] = useState<SessionDetailDTO | null>(null);
  const [execution, setExecution] = useState<ExecutionStateDTO | null>(null);
  const [guard, setGuard] = useState<GuardStateDTO | null>(null);
  const [profiles, setProfiles] = useState<AgentProfileDTO[]>([]);
  const [mode, setMode] = useState<SessionMode>('ask');
  const [providerStatus, setProviderStatus] = useState<ProviderStatus[] | null>(null);
  const [screen, setScreen] = useState<'room' | 'wizard' | 'config' | 'model'>('room');
  const [modelChoice, setModelChoice] = useState<ModelChoice | null>(null);
  const [modelData, setModelData] = useState<{ providers: ProviderStatus[]; keyring: boolean } | null>(null);

  // Local UI state
  const [notices, setNotices] = useState<LocalNotice[]>([]);
  const [liveActivity, setLiveActivity] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [pagerOpen, setPagerOpen] = useState(false);
  const [scrollOffset, setScrollOffset] = useState(0);
  // The most the timeline can scroll back, set on each render. A scroll past it would be lost
  // rows to come back through.
  const maxScrollRef = useRef(0);
  const scrollBy = useCallback((rows: number) => {
    setScrollOffset((s) => Math.min(maxScrollRef.current, Math.max(0, s + rows)));
  }, []);
  const onWheel = useCallback((notches: number) => scrollBy(notches * WHEEL_ROWS), [scrollBy]);
  useMouseWheel(onWheel, enableMouse);

  // Composer state
  const [input, setInput] = useState('');
  const [cursor, setCursor] = useState(0);
  const [history, setHistory] = useState<string[]>([]);
  const [historyIdx, setHistoryIdx] = useState(-1);
  const [completionIdx, setCompletionIdx] = useState(0);
  const [pendingUnconfinedAction, setPendingUnconfinedAction] = useState<
    null | { label: string; run: () => Promise<void> }
  >(null);

  const activeProjectIdRef = useRef(activeProjectId);
  activeProjectIdRef.current = activeProjectId;
  const activeSessionIdRef = useRef(activeSessionId);
  activeSessionIdRef.current = activeSessionId;
  const syncedModeKeyRef = useRef<string | null>(null);
  const sendingRef = useRef(false);
  sendingRef.current = sending;
  const knownSessionIdsRef = useRef<Set<string>>(new Set());
  knownSessionIdsRef.current = new Set(sessions.map((x) => x.id));

  const pushNotice = useCallback(
    (
      text: string | string[],
      opts: { isError?: boolean; badge?: string | null; author?: string } = {},
    ) => {
      const lines = Array.isArray(text) ? text : text.split('\n');
      setNotices((prev) => [
        ...prev.slice(-40),
        {
          id: `notice-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
          author: opts.author ?? 'room',
          authorColor: opts.isError ? 'red' : 'gray',
          badge: opts.badge ?? null,
          time: nowClock(),
          createdAt: new Date().toISOString(),
          lines,
          isError: Boolean(opts.isError),
        },
      ]);
      setScrollOffset(0);
    },
    [],
  );

  const activeProject = useMemo(
    () => projects.find((p) => p.id === activeProjectId) ?? null,
    [projects, activeProjectId],
  );

  const activeSession = useMemo(
    () => sessions.find((s) => s.id === activeSessionId) ?? detail?.session ?? null,
    [sessions, activeSessionId, detail],
  );

  const leadProfile = useMemo(
    () => profiles.find((p) => p.id === 'profile-lead') ?? profiles.find((p) => p.name === 'lead') ?? null,
    [profiles],
  );
  const activeModel = useMemo(
    () =>
      activeLeadModel({
        choice: modelChoice,
        session: activeSession ? { provider: activeSession.provider, model: activeSession.model } : null,
        leadProfile,
      }),
    [modelChoice, activeSession, leadProfile],
  );

  const runningProfileNames = useMemo(() => {
    const names = new Set<string>();
    if (!execution) return names;
    for (const run of execution.runs) {
      if (run.status === 'running' && (run.kind === 'execute' || run.kind === 'fix')) {
        names.add(run.profileName);
      }
    }
    return names;
  }, [execution]);

  const completions = useMemo(
    () => getComposerCompletions(input, profiles, runningProfileNames, sessions),
    [input, profiles, runningProfileNames, sessions],
  );

  useEffect(() => {
    if (completionIdx >= completions.length) {
      setCompletionIdx(0);
    }
  }, [completions.length, completionIdx]);

  const refreshSessionState = useCallback(
    async (projectId: string, sessionId: string | null) => {
      try {
        const [{ sessions: sessList }, execState, guardState] = await Promise.all([
          client.listSessions(projectId),
          client.getExecutionState(projectId, sessionId ?? undefined).catch(() => null),
          client.getGuardState(projectId, sessionId ?? undefined).catch(() => null),
        ]);
        setSessions(sessList);
        setExecution(execState);
        setGuard(guardState);
        if (sessionId) {
          const d = await client.getSessionDetail(projectId, sessionId);
          setDetail(d);
          // Follow the session's mode only when it changes (switch or escalation), so a refresh
          // triggered by a live event does not undo a `/mode` choice the user has not sent yet.
          const modeKey = `${d.session.id}:${d.session.mode}`;
          if (syncedModeKeyRef.current !== modeKey) {
            syncedModeKeyRef.current = modeKey;
            setMode(d.session.mode);
          }
        } else {
          setDetail(null);
        }
      } catch (err) {
        pushNotice(`Refresh error: ${err instanceof Error ? err.message : String(err)}`, {
          isError: true,
        });
      }
    },
    [client, pushNotice],
  );

  const bootstrap = useCallback(async () => {
    try {
      const auth = await client.authStatus();
      if (auth.enabled && !auth.authenticated) {
        setAuthNeeded(true);
        return;
      }
      setAuthNeeded(false);

      const [projList, profList] = await Promise.all([
        client.listProjects(),
        client.listProfiles().catch(() => [] as AgentProfileDTO[]),
      ]);
      setProjects(projList);
      setProfiles(profList);

      const matched = matchProjectForCwd(projList, cwd) ?? projList[0] ?? null;
      if (matched) {
        setActiveProjectId(matched.id);
        // The room opens on a new session; /resume brings an earlier one back.
        setActiveSessionId(null);
        await refreshSessionState(matched.id, null);
      } else {
        // First run: the setup wizard, like the web.
        setScreen('wizard');
      }
      setReady(true);
    } catch (err) {
      pushNotice(`Failed to connect to DALANG server: ${err instanceof Error ? err.message : String(err)}`, {
        isError: true,
      });
      setReady(true);
    }
  }, [client, cwd, pushNotice, refreshSessionState]);

  useEffect(() => {
    void bootstrap();
  }, [bootstrap]);

  // Quick stats: the same provider limits the web bar shows. Read once, then asked again on the
  // interval chosen in Config (default 5 minutes). They are a courtesy: a failure keeps the last numbers.
  useEffect(() => {
    if (!ready || authNeeded) return;
    let stopped = false;
    let busy = false;
    let timer: ReturnType<typeof setInterval> | null = null;
    const load = async (fresh: boolean) => {
      if (busy) return;
      busy = true;
      try {
        const list = fresh ? await client.refreshProvidersStatus() : await client.getProvidersStatus();
        if (!stopped) setProviderStatus(list);
      } catch {
        // keep what is shown
      } finally {
        busy = false;
      }
    };
    void (async () => {
      await load(false);
      const minutes = await client
        .getSettings()
        .then((x) => Number(x.usageRefreshMinutes) || DEFAULT_USAGE_REFRESH_MINUTES)
        .catch(() => DEFAULT_USAGE_REFRESH_MINUTES);
      if (stopped) return;
      timer = setInterval(() => void load(true), minutes * 60_000);
      timer.unref?.();
    })();
    return () => {
      stopped = true;
      if (timer) clearInterval(timer);
    };
  }, [ready, authNeeded, client]);

  // Subscribe to live WebSocket events once authenticated & ready
  useEffect(() => {
    if (!ready || authNeeded) return;
    const unsubscribe = client.connectEvents(
      (event: ServerEvent) => {
        const pid = activeProjectIdRef.current;
        const sid = activeSessionIdRef.current;
        // On a new chat the room follows only the session our own first message creates: it is
        // not in the known list yet. Events from other sessions must not take the chat over.
        const sessionFor = (): string | null => {
          if (sid) return sid;
          const evSid = event.sessionId;
          if (sendingRef.current && evSid && !knownSessionIdsRef.current.has(evSid)) {
            setActiveSessionId(evSid);
            return evSid;
          }
          return null;
        };

        if (event.type === 'lead.turn_started' && event.projectId === pid) {
          setLiveActivity(`${event.phase ?? 'lead'} (${event.provider ?? ''}) working...`);
        } else if (event.type === 'lead.log' && event.projectId === pid && typeof event.line === 'string') {
          const preview = extractActivityPreview(event.line);
          if (preview) setLiveActivity(`${event.phase ?? 'lead'}: ${preview}`);
        } else if (event.type === 'lead.turn_finished' && event.projectId === pid) {
          setLiveActivity(null);
          if (pid) void refreshSessionState(pid, sessionFor());
        } else if (event.type === 'run.started' && event.projectId === pid) {
          setLiveActivity(`@${event.profileName ?? 'agent'} (${event.provider ?? ''}) running...`);
          if (pid) void refreshSessionState(pid, sessionFor());
        } else if (event.type === 'run.log' && event.projectId === pid && typeof event.line === 'string') {
          const preview = extractActivityPreview(event.line);
          if (preview) setLiveActivity(preview);
        } else if (
          (event.type === 'run.finished' ||
            event.type === 'review.finished' ||
            event.type === 'integration.finished') &&
          event.projectId === pid
        ) {
          setLiveActivity(null);
          if (pid) void refreshSessionState(pid, sessionFor());
        } else if (
          (event.type === 'discuss.updated' ||
            event.type === 'room.message' ||
            event.type === 'plan.updated' ||
            event.type === 'brief.updated' ||
            event.type === 'sessions.updated') &&
          event.projectId === pid
        ) {
          if (pid) void refreshSessionState(pid, sessionFor());
        }
      },
      (connected) => setWsConnected(connected),
    );
    return unsubscribe;
  }, [ready, authNeeded, client, refreshSessionState]);

  const pendingGate: PendingGate | null = useMemo(
    () => detectPendingGate(detail, guard),
    [detail, guard],
  );

  const handleExit = useCallback(() => {
    onRequestExit?.();
    exit();
  }, [exit, onRequestExit]);

  const runWithUnconfinedSupport = useCallback(
    async (label: string, fn: (allowUnconfined: boolean) => Promise<void>) => {
      try {
        await fn(false);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (/Confirm unconfined execution/i.test(msg)) {
          setPendingUnconfinedAction({
            label,
            run: async () => {
              await fn(true);
            },
          });
          pushNotice(
            `${msg} Type y + Enter to run unconfined, or n + Enter to cancel.`,
            { badge: 'SANDBOX' },
          );
          return;
        }
        throw err;
      }
    },
    [pushNotice],
  );

  const executeGateDecision = useCallback(
    async (accept: boolean) => {
      if (pendingUnconfinedAction) {
        const act = pendingUnconfinedAction;
        setPendingUnconfinedAction(null);
        if (!accept) {
          pushNotice(`Cancelled ${act.label}.`);
          return;
        }
        setSending(true);
        try {
          await act.run();
          if (activeProjectId) await refreshSessionState(activeProjectId, activeSessionId);
        } catch (err) {
          pushNotice(err instanceof Error ? err.message : String(err), { isError: true });
        } finally {
          setSending(false);
        }
        return;
      }

      const sid = activeSessionId ?? detail?.session.id ?? null;
      if (!pendingGate || !activeProjectId || !sid) return;

      setSending(true);
      try {
        if (pendingGate.kind === 'quick_run') {
          if (!accept) {
            pushNotice('Kept Quick plan in draft. Edit your request or run /run when ready.');
            return;
          }
          // The coder's own "task started" report announces the run in the timeline.
          await runWithUnconfinedSupport(`Quick task [${pendingGate.externalId}]`, async (allowUnconfined) => {
            await client.approveQuickAndRun(activeProjectId, sid, allowUnconfined);
          });
        } else if (pendingGate.kind === 'approve_brief') {
          if (!accept) {
            pushNotice('Brief left in draft. Send a follow-up message or revise it in /web.');
            return;
          }
          await client.approveBrief(activeProjectId, pendingGate.version, sid);
          pushNotice(`Approved Brief v${pendingGate.version}. Generating plan...`, { badge: 'BRIEF' });
          await client.generatePlan(activeProjectId, sid);
        } else if (pendingGate.kind === 'approve_plan') {
          if (!accept) {
            pushNotice('Plan left in draft. Run /run when ready to approve and start.');
            return;
          }
          await client.approvePlan(activeProjectId, sid);
          await runWithUnconfinedSupport(`Plan v${pendingGate.version}`, async (allowUnconfined) => {
            await client.startExecution(activeProjectId, sid, allowUnconfined);
            pushNotice(`Approved Plan v${pendingGate.version} and started work.`, { badge: 'PLAN' });
          });
        } else if (pendingGate.kind === 'approve_merge') {
          if (!accept) {
            // `n` only declines the merge for now; rejecting discards the work, so it stays an explicit `/reject`.
            pushNotice(
              `[${pendingGate.externalId}] stays waiting for merge. Use /reject ${pendingGate.externalId} [note] to discard it.`,
              { badge: 'GUARD' },
            );
            return;
          }
          // The server posts the "task merged" report with the commit, so no local notice here.
          await runWithUnconfinedSupport(`merge [${pendingGate.externalId}]`, async (allowUnconfined) => {
            await client.approveMergeTask(activeProjectId, pendingGate.taskId, { allowUnconfined });
          });
        }
        await refreshSessionState(activeProjectId, sid);
      } catch (err) {
        pushNotice(err instanceof Error ? err.message : String(err), { isError: true });
      } finally {
        setSending(false);
      }
    },
    [
      pendingUnconfinedAction,
      pendingGate,
      activeProjectId,
      activeSessionId,
      detail?.session.id,
      client,
      pushNotice,
      refreshSessionState,
      runWithUnconfinedSupport,
    ],
  );

  /** After the wizard or /config changed profiles or providers, read them again. */
  const reloadAfterSetup = useCallback(async () => {
    try {
      const [profList, status] = await Promise.all([client.listProfiles(), client.getProvidersStatus()]);
      setProfiles(profList);
      setProviderStatus(status);
    } catch {
      // keep what is shown
    }
  }, [client]);

  const closeScreen = useCallback(() => {
    setScreen('room');
    void reloadAfterSetup();
  }, [reloadAfterSetup]);

  const openModelPicker = useCallback(async () => {
    try {
      const [status, settings] = await Promise.all([client.getProvidersStatus(), client.getSettings()]);
      setProviderStatus(status);
      setModelData({ providers: status, keyring: settings.antigravityKeyringAccess });
      setScreen('model');
    } catch (err) {
      pushNotice(`Could not read the providers: ${err instanceof Error ? err.message : String(err)}`, {
        isError: true,
      });
    }
  }, [client, pushNotice]);

  const completeWizard = useCallback(
    async (project: ProjectSummary, goal: string) => {
      try {
        setProjects(await client.listProjects());
      } catch {
        setProjects((prev) => (prev.some((p) => p.id === project.id) ? prev : [...prev, project]));
      }
      setActiveProjectId(project.id);
      setActiveSessionId(null);
      setDetail(null);
      setMode('ask');
      setScreen('room');
      await refreshSessionState(project.id, null);
      await reloadAfterSetup();
      if (goal) {
        setInput(goal);
        setCursor(goal.length);
      }
      pushNotice(
        `Opened project "${project.name}". ${goal ? 'Your goal is in the composer: press Enter to send it.' : 'Type a message to begin.'}`,
        { badge: 'PROJECT' },
      );
    },
    [client, pushNotice, refreshSessionState, reloadAfterSetup],
  );

  const handleSlashCommand = useCallback(
    async (raw: string) => {
      const cmd = parseSlashCommand(raw);
      if (!cmd) return;

      try {
        switch (cmd.name) {
          case 'exit':
            handleExit();
            return;

          case 'help': {
            pushNotice(
              [
                'Slash commands:',
                ...SLASH_COMMANDS.map((c) => `  ${c.usage.padEnd(42)} ${c.description}`),
                '',
                'Routing & shortcuts:',
                '  <message>          Send to Lead in current mode (ask / quick / full)',
                '  @<profile> <msg>   Idle profile -> read-only Ask; running coder -> steer',
                '  Tab                Autocomplete @profile or /command',
                '  PageUp / PageDown  Scroll timeline (or Ctrl+U / Ctrl+D, or the mouse wheel)',
                '  y / n + Enter      Answer the active gate prompt',
              ],
              { badge: 'HELP' },
            );
            return;
          }

          case 'mode': {
            const arg = cmd.args[0]?.toLowerCase();
            if (!arg) {
              pushNotice(`Composer mode is [${mode}]. Switch with /mode ask, /mode quick, or /mode full.`, {
                badge: 'MODE',
              });
              return;
            }
            if (arg !== 'ask' && arg !== 'quick' && arg !== 'full') {
              pushNotice('Usage: /mode [ask|quick|full]', { isError: true });
              return;
            }
            setMode(arg);
            pushNotice(`Composer mode set to [${arg}].`, { badge: 'MODE' });
            return;
          }

          case 'project':
          case 'projects': {
            const sub = cmd.args[0]?.toLowerCase();
            if (!sub || sub === 'list') {
              const latest = await client.listProjects();
              setProjects(latest);
              if (latest.length === 0) {
                pushNotice(`No projects yet. Run \`/project open ${cwd}\` or \`/project create <path>\`.`);
                return;
              }
              pushNotice(
                [
                  'Projects (switch with /project <n> or /project <name>):',
                  ...latest.map(
                    (p, idx) =>
                      `  ${idx + 1}. ${p.id === activeProjectId ? '*' : ' '} ${p.name}: ${p.path}${p.workingSessionId ? ' [working]' : ''}`,
                  ),
                ],
                { badge: 'PROJECTS' },
              );
              return;
            }
            if (sub === 'open' || sub === 'create') {
              const targetPath = path.resolve(cwd, cmd.args.slice(1).join(' ') || '.');
              setSending(true);
              try {
                const created = await client.createOrOpenProject({
                  mode: sub,
                  path: targetPath,
                  initGitIfMissing: sub === 'create',
                });
                const latest = await client.listProjects();
                setProjects(latest);
                setActiveProjectId(created.id);
                setActiveSessionId(null);
                setDetail(null);
                await refreshSessionState(created.id, null);
                pushNotice(`Opened project "${created.name}" (${created.path}).`, { badge: 'PROJECT' });
              } finally {
                setSending(false);
              }
              return;
            }
            const byIndex = Number(sub);
            const target =
              Number.isInteger(byIndex) && byIndex >= 1 && byIndex <= projects.length
                ? projects[byIndex - 1]
                : projects.find((p) => p.name.toLowerCase() === sub || p.id === sub);
            if (!target) {
              pushNotice(`Project not found: ${sub}. Run /project list.`, { isError: true });
              return;
            }
            setActiveProjectId(target.id);
            setActiveSessionId(null);
            setDetail(null);
            setMode('ask');
            await refreshSessionState(target.id, null);
            pushNotice(`Switched to project "${target.name}". New session.`, { badge: 'PROJECT' });
            return;
          }

          case 'new': {
            if (!activeProjectId) {
              pushNotice('Select or open a project first (/project).', { isError: true });
              return;
            }
            setActiveSessionId(null);
            setDetail(null);
            setExecution(null);
            setGuard(null);
            setMode('ask');
            syncedModeKeyRef.current = null;
            pushNotice('New session. Send a message to begin.', { badge: 'SESSION' });
            return;
          }

          case 'resume': {
            if (!activeProjectId) {
              pushNotice('Select or open a project first (/project).', { isError: true });
              return;
            }
            const { sessions: latest } = await client.listSessions(activeProjectId);
            setSessions(latest);
            const options = resumableSessions(latest);
            if (options.length === 0) {
              pushNotice('No previous sessions in this project yet. Send a message to start one.');
              return;
            }
            const sub = cmd.args[0]?.toLowerCase();
            if (!sub) {
              // Open the picker: the composer now reads "/resume " and the popup lists the sessions.
              setInput('/resume ');
              setCursor('/resume '.length);
              return;
            }
            const byIndex = Number(sub);
            const target =
              Number.isInteger(byIndex) && byIndex >= 1 && byIndex <= options.length
                ? options[byIndex - 1]
                : options.find((x) => x.id === sub || x.id.toLowerCase().startsWith(sub));
            if (!target) {
              pushNotice(`Session not found: ${sub}. Run /resume to pick one.`, { isError: true });
              return;
            }
            setActiveSessionId(target.id);
            await refreshSessionState(activeProjectId, target.id);
            pushNotice(`Resumed "${target.title?.trim() || target.id.slice(0, 8)}" [${target.mode}].`, {
              badge: 'SESSION',
            });
            return;
          }

          case 'wizard':
            setScreen('wizard');
            return;

          case 'config':
            setScreen('config');
            return;

          case 'model':
            await openModelPicker();
            return;

          case 'diff': {
            if (!activeProjectId) {
              pushNotice('No active project.', { isError: true });
              return;
            }
            const requestedId = cmd.args[0];
            const guardTasks = guard?.tasks ?? [];
            const targetEntry = requestedId
              ? guardTasks.find(
                  (t) =>
                    t.task.id === requestedId ||
                    t.task.externalId.toLowerCase() === requestedId.toLowerCase(),
                )
              : guardTasks.find((t) => t.task.status === 'awaiting_merge') ??
                guardTasks.find((t) => t.diffAvailable) ??
                guardTasks[0];
            const taskId = targetEntry?.task.id ?? requestedId;
            if (!taskId) {
              pushNotice('No task with a diff found in this session.', { isError: true });
              return;
            }
            const diff = await client.getTaskDiff(activeProjectId, taskId);
            const header = `# Diff for [${diff.externalId}] (${diff.files.length} file(s), +${diff.totalAdditions} -${diff.totalDeletions})\n\n`;
            const body = diff.rawDiff || '(empty diff)';
            setPagerOpen(true);
            try {
              const res = await onOpenPager(header + body, `dalang-${diff.externalId}`);
              if (!res.ok) {
                pushNotice(
                  [
                    `Could not open $PAGER (${res.error ?? 'unknown'}). Inline summary:`,
                    ...body.split('\n').slice(0, 40),
                  ],
                  { badge: 'DIFF' },
                );
              } else {
                pushNotice(
                  `Closed diff for [${diff.externalId}] (${diff.files.length} file(s), +${diff.totalAdditions} -${diff.totalDeletions}).`,
                  { badge: 'DIFF' },
                );
              }
            } finally {
              setPagerOpen(false);
            }
            return;
          }

          case 'merge': {
            if (!activeProjectId) {
              pushNotice('No active project.', { isError: true });
              return;
            }
            const requestedId = cmd.args[0];
            const guardTasks = guard?.tasks ?? [];
            const entry = requestedId
              ? guardTasks.find(
                  (t) =>
                    t.task.id === requestedId ||
                    t.task.externalId.toLowerCase() === requestedId.toLowerCase(),
                )
              : guardTasks.find((t) => t.task.status === 'awaiting_merge' && t.canApproveMerge);
            if (!entry) {
              pushNotice('No task awaiting merge.', { isError: true });
              return;
            }
            setSending(true);
            try {
              await runWithUnconfinedSupport(`merge [${entry.task.externalId}]`, async (allowUnconfined) => {
                await client.approveMergeTask(activeProjectId, entry.task.id, {
                  allowUnconfined,
                  allowFailedReview: entry.task.status === 'review_failed',
                });
              });
              await refreshSessionState(activeProjectId, activeSessionId);
            } finally {
              setSending(false);
            }
            return;
          }

          case 'reject': {
            if (!activeProjectId) {
              pushNotice('No active project.', { isError: true });
              return;
            }
            const requeue = cmd.args.includes('--requeue');
            const cleanArgs = cmd.args.filter((a) => a !== '--requeue');
            const guardTasks = guard?.tasks ?? [];
            const firstMatch = cleanArgs[0]
              ? guardTasks.find(
                  (t) =>
                    t.task.id === cleanArgs[0] ||
                    t.task.externalId.toLowerCase() === cleanArgs[0].toLowerCase(),
                )
              : undefined;
            const entry =
              firstMatch ??
              guardTasks.find((t) => t.canReject && (t.task.status === 'awaiting_merge' || t.task.status === 'review_failed'));
            if (!entry) {
              pushNotice('No rejectable task in Guard.', { isError: true });
              return;
            }
            const note = (firstMatch ? cleanArgs.slice(1) : cleanArgs).join(' ').trim() || 'Rejected in terminal room';
            setSending(true);
            try {
              // The server posts the "task rejected" report with the note.
              await client.rejectTask(activeProjectId, entry.task.id, { note, requeue });
              await refreshSessionState(activeProjectId, activeSessionId);
            } finally {
              setSending(false);
            }
            return;
          }

          case 'stop': {
            if (!activeProjectId) {
              pushNotice('No active project.', { isError: true });
              return;
            }
            const taskId = cmd.args[0];
            const res = await client.stopExecution(activeProjectId, {
              sessionId: activeSessionId ?? undefined,
              taskId,
            });
            pushNotice(res.stopped ? 'Stopped running execution.' : 'No active execution to stop.', {
              badge: 'STOP',
            });
            await refreshSessionState(activeProjectId, activeSessionId);
            return;
          }

          case 'run': {
            if (!activeProjectId || !activeSessionId) {
              pushNotice('No active session with a plan.', { isError: true });
              return;
            }
            setSending(true);
            try {
              if (detail?.session.mode === 'quick' && detail.plan?.status === 'draft') {
                await runWithUnconfinedSupport('Quick task', async (allowUnconfined) => {
                  await client.approveQuickAndRun(activeProjectId, activeSessionId, allowUnconfined);
                });
              } else {
                if (detail?.plan?.status === 'draft') {
                  await client.approvePlan(activeProjectId, activeSessionId);
                }
                await runWithUnconfinedSupport('execution', async (allowUnconfined) => {
                  await client.startExecution(activeProjectId, activeSessionId, allowUnconfined);
                });
              }
              pushNotice('Execution started.', { badge: 'RUN' });
              await refreshSessionState(activeProjectId, activeSessionId);
            } finally {
              setSending(false);
            }
            return;
          }

          case 'finish': {
            if (!activeProjectId || !activeSessionId) {
              pushNotice('No active Full session to finish Discuss.', { isError: true });
              return;
            }
            setSending(true);
            try {
              const brief = await client.finishDiscuss(activeProjectId, activeSessionId);
              pushNotice(`Drafted Brief v${brief.version}: "${brief.content.title}".`, {
                badge: 'BRIEF',
              });
              await refreshSessionState(activeProjectId, activeSessionId);
            } finally {
              setSending(false);
            }
            return;
          }

          case 'web': {
            const params = new URLSearchParams();
            if (activeProjectId) params.set('project', activeProjectId);
            if (activeSessionId) params.set('session', activeSessionId);
            const qs = params.toString();
            const url = `${client.baseUrl}/${qs ? `?${qs}` : ''}`;
            openBrowser(url);
            pushNotice(`Opened web UI: ${url}`, { badge: 'WEB' });
            return;
          }

          default:
            pushNotice(`Unknown command "/${cmd.name}". Run /help for available commands.`, {
              isError: true,
            });
        }
      } catch (err) {
        pushNotice(err instanceof Error ? err.message : String(err), { isError: true });
      }
    },
    [
      activeProjectId,
      activeSessionId,
      client,
      cwd,
      detail,
      guard,
      handleExit,
      mode,
      onOpenPager,
      openBrowser,
      openModelPicker,
      projects,
      pushNotice,
      refreshSessionState,
      runWithUnconfinedSupport,
      sessions,
    ],
  );

  const handleSubmit = useCallback(
    async (raw: string) => {
      const trimmed = raw.trim();
      if (!trimmed) return;

      setInput('');
      setCursor(0);
      setHistory((prev) => [trimmed, ...prev.filter((h) => h !== trimmed)].slice(0, 50));
      setHistoryIdx(-1);
      setScrollOffset(0);

      // Answer active gate / unconfined prompt with y/n
      if (pendingUnconfinedAction || pendingGate) {
        const lower = trimmed.toLowerCase();
        if (lower === 'y' || lower === 'yes') {
          await executeGateDecision(true);
          return;
        }
        if (lower === 'n' || lower === 'no') {
          await executeGateDecision(false);
          return;
        }
      }

      if (trimmed.startsWith('/')) {
        await handleSlashCommand(trimmed);
        return;
      }

      if (!activeProjectId) {
        pushNotice(
          `No project selected. Run \`/project open ${cwd}\` or \`/project list\` first.`,
          { isError: true },
        );
        return;
      }

      setSending(true);
      try {
        const res = await client.sendChatMessage(activeProjectId, {
          sessionId: activeSessionId ?? undefined,
          mode,
          message: trimmed,
          ...(modelChoice
            ? {
                provider: modelChoice.provider,
                model: modelChoice.model,
                ...(modelChoice.effort ? { effort: modelChoice.effort } : {}),
              }
            : {}),
        });
        setActiveSessionId(res.session.id);
        setSending(false);
        void refreshSessionState(activeProjectId, res.session.id);
      } catch (err) {
        setSending(false);
        pushNotice(err instanceof Error ? err.message : String(err), { isError: true });
      }
    },
    [
      activeProjectId,
      activeSessionId,
      client,
      cwd,
      executeGateDecision,
      handleSlashCommand,
      mode,
      modelChoice,
      pendingGate,
      pendingUnconfinedAction,
      pushNotice,
      refreshSessionState,
    ],
  );

  const handleAuthSubmit = useCallback(async (override?: string) => {
    const password = override ?? passwordInput;
    if (!password.trim()) return;
    setAuthError(null);
    try {
      const status = await client.login(password);
      if (status.authenticated) {
        setPasswordInput('');
        setAuthNeeded(false);
        await bootstrap();
      } else {
        setAuthError('Authentication failed.');
      }
    } catch (err) {
      setAuthError(err instanceof Error ? err.message : String(err));
    }
  }, [bootstrap, client, passwordInput]);

  // Ctrl+C leaves from any screen.
  useInput((ch, key) => {
    if (key.ctrl && ch === 'c') handleExit();
  });

  useInput(
    (rawCh, key) => {
      // A mouse report must never land in the composer as typed text.
      const ch = stripMouse(rawCh);
      if (pagerOpen) return;

      // Auth prompt mode
      if (authNeeded) {
        if (key.return) {
          void handleAuthSubmit();
          return;
        }
        if (key.backspace || key.delete) {
          setPasswordInput((p) => p.slice(0, -1));
          return;
        }
        if (!key.ctrl && !key.meta && ch) {
          // A pasted password can arrive together with its Enter.
          const newline = ch.search(/[\r\n]/);
          if (newline === -1) {
            setPasswordInput((p) => p + ch);
          } else {
            const full = passwordInput + ch.slice(0, newline);
            setPasswordInput(full);
            void handleAuthSubmit(full);
          }
        }
        return;
      }

      // Timeline scrolling
      if (key.pageUp || (key.ctrl && ch === 'u')) {
        scrollBy(6);
        return;
      }
      if (key.pageDown || (key.ctrl && ch === 'd')) {
        scrollBy(-6);
        return;
      }

      // Completion navigation
      if (completions.length > 0) {
        if (key.tab) {
          const picked = completions[completionIdx] ?? completions[0];
          if (picked) {
            const next = applyComposerCompletion(input, picked.value);
            setInput(next);
            setCursor(next.length);
            setCompletionIdx(0);
          }
          return;
        }
        if (key.upArrow) {
          setCompletionIdx((i) => (i - 1 + completions.length) % completions.length);
          return;
        }
        if (key.downArrow) {
          setCompletionIdx((i) => (i + 1) % completions.length);
          return;
        }
      }

      // Submit
      if (key.return) {
        if (sending) return;
        const submit = resolveComposerSubmit(input, completions, completionIdx);
        if (submit.action === 'fill') {
          setInput(submit.text);
          setCursor(submit.text.length);
          setCompletionIdx(0);
        } else {
          void handleSubmit(submit.text);
        }
        return;
      }

      // History navigation when popup not visible
      if (key.upArrow && history.length > 0) {
        const nextIdx = Math.min(historyIdx + 1, history.length - 1);
        setHistoryIdx(nextIdx);
        const entry = history[nextIdx] ?? '';
        setInput(entry);
        setCursor(entry.length);
        return;
      }
      if (key.downArrow) {
        if (historyIdx <= 0) {
          setHistoryIdx(-1);
          setInput('');
          setCursor(0);
        } else {
          const nextIdx = historyIdx - 1;
          setHistoryIdx(nextIdx);
          const entry = history[nextIdx] ?? '';
          setInput(entry);
          setCursor(entry.length);
        }
        return;
      }

      // Cursor movement & editing
      if (key.leftArrow) {
        setCursor((c) => Math.max(0, c - 1));
        return;
      }
      if (key.rightArrow) {
        setCursor((c) => Math.min(input.length, c + 1));
        return;
      }
      if (key.ctrl && ch === 'a') {
        setCursor(0);
        return;
      }
      if (key.ctrl && ch === 'e') {
        setCursor(input.length);
        return;
      }
      if (key.ctrl && ch === 'w') {
        const before = input.slice(0, cursor).replace(/\S+\s*$/, '');
        const after = input.slice(cursor);
        setInput(before + after);
        setCursor(before.length);
        return;
      }
      if (key.backspace || key.delete) {
        if (cursor > 0) {
          setInput((s) => s.slice(0, cursor - 1) + s.slice(cursor));
          setCursor((c) => c - 1);
        }
        return;
      }
      if (key.escape) {
        setInput('');
        setCursor(0);
        return;
      }
      if (!key.ctrl && !key.meta && ch) {
        // A paste or fast input can arrive as one chunk with the Enter inside it ("text\r").
        // Ink only flags `key.return` for a lone "\r", so split the chunk here.
        const chunk = ch.replace(/\r\n?/g, '\n');
        const submits = chunk.endsWith('\n');
        const text = chunk.replace(/\n+$/, '').replace(/\n/g, ' ');
        const next = input.slice(0, cursor) + text + input.slice(cursor);
        if (submits && !sending) {
          void handleSubmit(next);
          return;
        }
        setInput(next);
        setCursor(cursor + text.length);
      }
    },
    { isActive: !pagerOpen && screen === 'room' },
  );

  // Build visible timeline items in chronological order
  const formattedMessages = useMemo<FormattedRoomMessage[]>(() => {
    const serverEntries = (detail?.messages ?? []).map((m) => ({
      ts: m.createdAt,
      item: formatRoomMessage(m),
    }));
    const noticeEntries = notices.map((n) => ({
      ts: n.createdAt,
      item: n as FormattedRoomMessage,
    }));
    return [...serverEntries, ...noticeEntries]
      .sort((a, b) => a.ts.localeCompare(b.ts))
      .map((entry) => entry.item);
  }, [detail?.messages, notices]);

  // Flatten timeline entries into renderable lines for clean windowing
  const flattened = useMemo(() => {
    const rows: Array<{ key: string; node: React.ReactNode }> = [];
    for (const msg of formattedMessages) {
      rows.push({
        key: `${msg.id}-hdr`,
        node: (
          <Box gap={1}>
            <Text bold color={msg.authorColor}>
              {msg.author}
            </Text>
            {msg.badge ? (
              <Text color={msg.isError ? 'red' : 'yellow'}>[{msg.badge}]</Text>
            ) : null}
            {msg.time ? <Text dimColor>{msg.time}</Text> : null}
          </Box>
        ),
      });
      // Two columns of timeline padding plus the two-space indent.
      const lineWidth = termSize.cols - 4;
      msg.lines.forEach((line, idx) => {
        wrapTimelineLine(line, lineWidth).forEach((row, rowIdx) => {
          rows.push({
            key: `${msg.id}-l-${idx}-${rowIdx}`,
            node: (
              <Text color={msg.isError ? 'red' : undefined} wrap="truncate-end">
                {'  '}
                {row}
              </Text>
            ),
          });
        });
      });
    }
    return rows;
  }, [formattedMessages, termSize.cols]);

  if (authNeeded) {
    return (
      <Box flexDirection="column" padding={1} borderStyle="round" borderColor="yellow">
        <Text bold color="yellow">
          DALANG v{DALANG_VERSION}: sign in required
        </Text>
        <Text dimColor>Enter your local DALANG password and press Enter (Ctrl+C to exit):</Text>
        <Box marginTop={1}>
          <Text color="cyan">Password: </Text>
          <Text>{'*'.repeat(passwordInput.length)}_</Text>
        </Box>
        {authError ? <Text color="red">{authError}</Text> : null}
      </Box>
    );
  }

  // The popup shows a window of POPUP_SIZE items that follows the selection.
  const popupStart = popupWindowStart(completionIdx, completions.length, POPUP_SIZE);
  // Command names are short; session titles are not. The label column fits the widest visible one.
  const popupLabelWidth = Math.max(
    18,
    ...completions.slice(popupStart, popupStart + POPUP_SIZE).map((c) => Array.from(c.label).length),
  );
  const popupRows =
    completions.length > 0
      ? Math.min(completions.length, POPUP_SIZE) + 2 + (completions.length > POPUP_SIZE ? 1 : 0)
      : 0;
  const gateRows = pendingGate || pendingUnconfinedAction ? 3 : 0;
  const liveRows = liveActivity || sending ? 1 : 0;
  // Header 6 rows, composer 3, footer 1.
  const chromeRows = 10 + popupRows + gateRows + liveRows;
  // The root box is one row shorter than the terminal (so the last line never scrolls the screen);
  // the timeline gets what is left of that height after the fixed rows.
  const rootHeight = termSize.rows - 1;

  if (screen === 'wizard') {
    return (
      <Wizard
        client={client}
        cwd={cwd}
        width={termSize.cols}
        height={rootHeight}
        onSkip={() => {
          setScreen('room');
          void reloadAfterSetup();
          if (projects.length === 0) {
            pushNotice([
              'No DALANG projects registered yet.',
              `Run \`/wizard\` to set up, \`/project open ${cwd}\` to open the current folder, or \`/project create <path>\` to create a new one.`,
            ]);
          }
        }}
        onComplete={(project, goal) => void completeWizard(project, goal)}
      />
    );
  }
  if (screen === 'config') {
    return (
      <ConfigScreen
        client={client}
        width={termSize.cols}
        height={rootHeight}
        onClose={closeScreen}
        onWizard={() => setScreen('wizard')}
      />
    );
  }
  if (screen === 'model' && modelData) {
    return (
      <ModelPicker
        providers={modelData.providers}
        usable={usableProviderIds(modelData.providers, modelData.keyring)}
        active={activeModel}
        width={termSize.cols}
        height={rootHeight}
        onCancel={() => setScreen('room')}
        onChoose={(choice) => {
          setModelChoice(choice);
          setScreen('room');
          pushNotice(
            choice
              ? `Lead model set to ${describeModel(choice)}. It applies to your next messages.`
              : "Back to the Lead's own model setting.",
            { badge: 'MODEL' },
          );
        }}
      />
    );
  }
  const viewportHeight = Math.max(6, rootHeight - chromeRows);

  const maxOffset = Math.max(0, flattened.length - viewportHeight);
  maxScrollRef.current = maxOffset;
  const clampedOffset = Math.min(scrollOffset, maxOffset);
  const endIdx = Math.max(0, flattened.length - clampedOffset);
  const startIdx = Math.max(0, endIdx - viewportHeight);
  const visibleRows = flattened.slice(startIdx, endIdx);

  const beforeCursor = input.slice(0, cursor);
  const atCursor = input[cursor] ?? ' ';
  const afterCursor = input.slice(cursor + 1);

  // Keep the header on one row: the session title takes whatever width is left and is cut with "...".
  const headerRight = `[${mode.toUpperCase()}] ${embedded ? 'embedded' : 'attached'}${wsConnected ? ' · live' : ''}`;
  const headerLeftFixed = `DALANG v${DALANG_VERSION} · ${activeProject?.name ?? '(no project)'} · `;
  // 4 columns of border and padding, plus the 7 the icon takes (5 wide and a 2 column gap).
  const titleRoom = termSize.cols - 4 - 7 - headerRight.length - 2 - headerLeftFixed.length;
  const statChips = providerStatus === null ? null : providerStatChips(providerStatus);
  const runningAgents = describeRunningAgents(execution?.runs ?? []);
  const fullTitle = activeSession?.title || 'new chat';
  const headerTitle =
    titleRoom <= 3
      ? ''
      : Array.from(fullTitle).length > titleRoom
        ? `${Array.from(fullTitle).slice(0, titleRoom - 3).join('')}...`
        : fullTitle;

  return (
    <Box flexDirection="column" width={termSize.cols} height={rootHeight}>
      {/* Header: icon, title row, and the provider quick stats */}
      <Box borderStyle="round" borderColor="yellow" paddingX={1}>
        <Box flexDirection="column" marginRight={2} flexShrink={0}>
          {KAYON_ICON.map((row, i) => (
            <Text key={i} bold color={ICON_COLOR}>
              {row}
            </Text>
          ))}
        </Box>
        <Box flexDirection="column" flexGrow={1}>
          <Box justifyContent="space-between">
            <Box gap={1}>
              <Text bold color="yellow">
                DALANG v{DALANG_VERSION}
              </Text>
              <Text dimColor>·</Text>
              <Text bold>{activeProject?.name ?? '(no project)'}</Text>
              <Text dimColor>·</Text>
              <Text wrap="truncate-end">{headerTitle}</Text>
            </Box>
            <Box gap={1}>
              <Text bold color={mode === 'ask' ? 'cyan' : mode === 'quick' ? 'green' : 'magenta'}>
                [{mode.toUpperCase()}]
              </Text>
              <Text dimColor>
                {embedded ? 'embedded' : 'attached'}
                {wsConnected ? ' · live' : ''}
              </Text>
            </Box>
          </Box>
          <Text wrap="truncate-end">
            {statChips === null ? (
              <Text dimColor>limits loading...</Text>
            ) : statChips.length === 0 ? (
              <Text dimColor>no provider CLI found</Text>
            ) : (
              statChips.map((chip, idx) => (
                <Text key={chip.id}>
                  {idx > 0 ? <Text dimColor>{'  ·  '}</Text> : null}
                  <Text bold>{chip.name}</Text>
                  {chip.state === 'login' ? (
                    <Text dimColor>{' login needed'}</Text>
                  ) : chip.state === 'unavailable' ? (
                    <Text dimColor>{' limits n/a'}</Text>
                  ) : (
                    <>
                      {chip.fiveHour !== null ? (
                        <>
                          <Text dimColor>{' 5h '}</Text>
                          <Percent value={chip.fiveHour} />
                        </>
                      ) : null}
                      {chip.weekly !== null ? (
                        <>
                          <Text dimColor>{' wk '}</Text>
                          <Percent value={chip.weekly} />
                        </>
                      ) : null}
                    </>
                  )}
                </Text>
              ))
            )}
          </Text>
          <Text wrap="truncate-end">
            <Text bold>Lead </Text>
            {activeModel ? (
              <>
                <Text>{describeModel(activeModel)}</Text>
                <Text dimColor>{`  (${ACTIVE_SOURCE_LABEL[activeModel.source]})`}</Text>
              </>
            ) : (
              <Text dimColor>no model set: /model or /wizard</Text>
            )}
          </Text>
          <Text wrap="truncate-end" dimColor={runningAgents.length === 0}>
            {runningAgents.length > 0 ? (
              <>
                <Text bold>Running </Text>
                <Text>{runningAgents.join('  ·  ')}</Text>
              </>
            ) : (
              shortPath(activeProject?.path ?? cwd)
            )}
          </Text>
        </Box>
      </Box>

      {/* Timeline */}
      <Box flexDirection="column" flexGrow={1} paddingX={1} overflow="hidden">
        {visibleRows.length === 0 ? (
          <Box flexDirection="column" marginTop={1}>
            <Text dimColor>
              New session. Type a message for the Lead, @profile to tag an agent, or /help for commands.
            </Text>
            <Text dimColor>
              {resumableSessions(sessions).length > 0
                ? `/resume continues one of ${resumableSessions(sessions).length} earlier session(s). `
                : ''}
              Switch modes with /mode ask | quick | full. Open the browser UI anytime with /web.
            </Text>
          </Box>
        ) : (
          visibleRows.map((row) => <Box key={row.key}>{row.node}</Box>)
        )}
      </Box>

      {/* Live activity strip */}
      {liveActivity || sending ? (
        <Box paddingX={1}>
          <Text color="yellow" wrap="truncate-end">
            ● {liveActivity || 'Waiting for agent response...'}
          </Text>
        </Box>
      ) : null}

      {/* Active gate prompt */}
      {pendingUnconfinedAction ? (
        <Box borderStyle="single" borderColor="red" paddingX={1}>
          <Text bold color="red" wrap="truncate-middle">
            [SANDBOX] Confirm unconfined {pendingUnconfinedAction.label}? (y/n + Enter)
          </Text>
        </Box>
      ) : pendingGate ? (
        <Box borderStyle="single" borderColor="yellow" paddingX={1}>
          <Text bold color="yellow" wrap="truncate-middle">
            [GATE] {pendingGate.prompt}
          </Text>
        </Box>
      ) : null}

      {/* Completion popup */}
      {completions.length > 0 ? (
        <Box flexDirection="column" borderStyle="single" borderColor="gray" paddingX={1}>
          {completions.slice(popupStart, popupStart + POPUP_SIZE).map((item, offset) => {
            const selected = popupStart + offset === completionIdx;
            return (
              <Box key={item.value} gap={2}>
                <Text bold={selected} inverse={selected} color={selected ? 'cyan' : undefined}>
                  {selected ? '>' : ' '} {item.label.padEnd(popupLabelWidth)}
                </Text>
                <Text dimColor={!selected} wrap="truncate-end">
                  {item.detail}
                </Text>
              </Box>
            );
          })}
          {completions.length > POPUP_SIZE ? (
            <Text dimColor>
              {completionIdx + 1}/{completions.length} · Up/Down to move, Tab to pick
            </Text>
          ) : null}
        </Box>
      ) : null}

      {/* Composer */}
      <Box borderStyle="round" borderColor={sending ? 'gray' : 'cyan'} paddingX={1}>
        <Text bold color="cyan">
          [{mode}] &gt;{' '}
        </Text>
        <Text>{beforeCursor}</Text>
        <Text inverse>{atCursor}</Text>
        <Text>{afterCursor}</Text>
      </Box>

      {/* Footer hints */}
      <Box paddingX={1} justifyContent="space-between">
        {/* With a scroll marker on the right, the command list shrinks so neither side is cut. */}
        <Text dimColor wrap="truncate-end">
          {startIdx > 0 || clampedOffset > 0
            ? '@profile tag/steer · /help /exit'
            : '@profile tag/steer · /model /resume /new /config /wizard /web /help /exit'}
        </Text>
        {clampedOffset > 0 ? (
          <Text color="yellow" wrap="truncate-end">
            {`↑${startIdx} above · ↓${clampedOffset} below · wheel or PgUp/PgDn`}
          </Text>
        ) : startIdx > 0 ? (
          <Text dimColor wrap="truncate-end">
            {`↑${startIdx} above · wheel or PgUp`}
          </Text>
        ) : null}
      </Box>
    </Box>
  );
}
