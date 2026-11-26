import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type {
  AskMessageContent,
  ChatImageMessage,
  DiscussMessageDTO,
  DiscussRound,
  GuardStateDTO,
  GuardTaskEntryDTO,
  ProviderStatus,
  QuickPlanMessageContent,
  RoomReportContent,
  SessionDetailDTO,
  TaskOutputKind,
} from '@dalang/shared';

function displayTaskRole(role: string): string {
  if (role === 'engineer') return 'executor';
  if (role === 'qa') return 'checker';
  return role;
}

/** What every gate shows: the question, an optional line of context, and what y and n each do. */
interface GateText {
  prompt: string;
  context?: string;
  yes: string;
  no: string;
  /** Other tasks waiting for the same kind of approval after this one. */
  alsoWaiting?: number;
}

export type PendingGate = GateText &
  (
    | { kind: 'quick_run'; planVersion: number; taskId: string; externalId: string; title: string }
    | { kind: 'approve_brief'; version: number; title: string }
    | { kind: 'approve_plan'; version: number; taskCount: number }
    // The Lead's yes/no question before Auto work replaces unfinished work; the answer goes to the Lead.
    | { kind: 'auto_work' }
    | {
        kind: 'approve_merge';
        taskId: string;
        externalId: string;
        title: string;
        output: TaskOutputKind;
        branch: string;
        reviewFailed: boolean;
      }
  );

/** The review and verify facts behind a merge question, in one line. */
function mergeContext(entry: GuardTaskEntryDTO): string | undefined {
  const review = entry.latestReview;
  if (!review) return undefined;
  const findings = review.contract.findings?.length ?? 0;
  const parts = [
    `Review round ${review.round} ${review.status === 'pass' ? 'passed' : 'failed'} (${findings} finding(s), ${review.reviewerProfileName})`,
    review.verifyExitCode === null
      ? 'verify skipped'
      : review.verifyExitCode === 0
        ? 'verify passed'
        : `verify failed (exit ${review.verifyExitCode})`,
  ];
  if (review.scopeWarnings.length > 0) parts.push(`${review.scopeWarnings.length} scope warning(s)`);
  return parts.join(' · ');
}

export function detectPendingGate(
  detail: SessionDetailDTO | null,
  guard: GuardStateDTO | null,
): PendingGate | null {
  if (!detail) return null;

  // 1. Merge / accept gate takes top priority when a task is waiting for human approval
  const mergeCandidates = guard?.tasks.filter(
    (entry) => entry.task.status === 'awaiting_merge' && entry.canApproveMerge,
  ) ?? [];
  const mergeCandidate = mergeCandidates[0];
  if (mergeCandidate) {
    const output = mergeCandidate.task.output ?? 'files';
    const id = mergeCandidate.task.externalId;
    const mainBranch = guard?.mainBranch ?? 'main';
    return {
      kind: 'approve_merge',
      taskId: mergeCandidate.task.id,
      externalId: id,
      title: mergeCandidate.task.title,
      output,
      branch: mainBranch,
      reviewFailed: false,
      prompt:
        output === 'answer'
          ? `Accept answer [${id}] "${mergeCandidate.task.title}"?`
          : `Merge [${id}] "${mergeCandidate.task.title}" into ${mainBranch}?`,
      context: mergeContext(mergeCandidate),
      yes: output === 'answer' ? 'accept' : 'merge',
      no: `keep waiting · /diff ${id} to see the ${output === 'answer' ? 'answer' : 'changes'}`,
      alsoWaiting: mergeCandidates.length - 1,
    };
  }

  // 2. The Lead asked whether Auto work may replace unfinished work. Its text is in the timeline above.
  const last = detail.messages.at(-1);
  if (detail.session.mode === 'auto' && last?.role === 'lead' && last.type === 'ask' &&
    last.content && typeof last.content === 'object' && 'pendingAutoWork' in last.content) {
    const pending = (last.content as { pendingAutoWork?: { sessionId?: string } }).pendingAutoWork;
    const replacesOwn = pending?.sessionId === detail.session.id;
    return {
      kind: 'auto_work',
      prompt: replacesOwn
        ? 'Replace the unfinished tasks of this chat with the new plan? Details are in the Lead message above.'
        : 'Discard the other session\'s unfinished work and start this request? Details are in the Lead message above.',
      yes: replacesOwn ? 'replace and start' : 'discard it and start',
      no: 'keep the current work',
    };
  }

  // 3. Quick draft plan gate
  if (detail.session.mode === 'quick' && detail.plan?.status === 'draft' && detail.plan.tasks.length > 0) {
    const task = detail.plan.tasks[0];
    return {
      kind: 'quick_run',
      planVersion: detail.plan.version,
      taskId: task.id,
      externalId: task.externalId,
      title: task.title,
      prompt: `Run Quick task [${task.externalId}] "${task.title}"?`,
      yes: 'run it',
      no: 'keep the plan as a draft',
    };
  }

  // 4. Full mode brief draft gate
  const latestBrief = detail.briefs[0];
  if (detail.session.mode === 'full' && latestBrief?.status === 'draft') {
    return {
      kind: 'approve_brief',
      version: latestBrief.version,
      title: latestBrief.content.title,
      prompt: `Approve Brief v${latestBrief.version} "${latestBrief.content.title}" and generate a plan?`,
      yes: 'approve',
      no: 'keep the brief as a draft',
    };
  }

  // 5. Full mode plan draft gate
  if (detail.session.mode === 'full' && detail.plan?.status === 'draft') {
    const hasNeedsSplit = detail.plan.tasks.some((t) => t.needsSplit);
    if (!hasNeedsSplit && detail.plan.tasks.length > 0) {
      return {
        kind: 'approve_plan',
        version: detail.plan.version,
        taskCount: detail.plan.tasks.length,
        prompt: `Approve Plan v${detail.plan.version} (${detail.plan.tasks.length} task(s)) and start work?`,
        yes: 'approve and start',
        no: 'keep the plan as a draft',
      };
    }
  }

  return null;
}

/** A percentage at or below this is shown in red, as in the web usage bar. */
export const LOW_LIMIT_PERCENT = 20;

const PROVIDER_SHORT_NAMES: Record<string, string> = {
  'claude-code': 'claude',
  codex: 'codex',
  antigravity: 'agy',
};

export interface ProviderStatChip {
  id: string;
  name: string;
  state: 'ok' | 'login' | 'unavailable';
  /** Percent left in the tightest 5 hour window, or null when the CLI reports none. */
  fiveHour: number | null;
  /** Percent left in the tightest weekly window, or null. */
  weekly: number | null;
}

/** Percent left in a window, from whichever number the CLI reported. */
function percentLeft(w: ProviderStatus['usage']['windows'][number]): number | null {
  if (w.remainingPercent !== null) return w.remainingPercent;
  return w.usedPercent !== null ? 100 - w.usedPercent : null;
}

/** The tightest window of one kind across the provider's model groups. */
function tightestWindow(windows: ProviderStatus['usage']['windows'], kind: string): number | null {
  const values = windows
    .filter((w) => w.window === kind)
    .map(percentLeft)
    .filter((v): v is number => v !== null);
  return values.length > 0 ? Math.round(Math.min(...values)) : null;
}

/** One chip per installed provider: the same limits the web bar shows, without the icons. */
export function providerStatChips(providers: ProviderStatus[]): ProviderStatChip[] {
  return providers
    .filter((p) => p.installed)
    .map((p) => {
      const fiveHour = tightestWindow(p.usage.windows, '5h');
      const weekly = tightestWindow(p.usage.windows, 'weekly');
      const state: ProviderStatChip['state'] = !p.loggedIn
        ? 'login'
        : fiveHour === null && weekly === null
          ? 'unavailable'
          : 'ok';
      return { id: p.id, name: PROVIDER_SHORT_NAMES[p.id] ?? p.id, state, fiveHour, weekly };
    });
}

/** Plain-text form of the chips, for tests and for terminals without color. */
export function formatProviderStats(chips: ProviderStatChip[]): string {
  return chips
    .map((c) => {
      if (c.state === 'login') return `${c.name} login needed`;
      if (c.state === 'unavailable') return `${c.name} limits n/a`;
      const parts = [
        c.fiveHour !== null ? `5h ${c.fiveHour}%` : null,
        c.weekly !== null ? `wk ${c.weekly}%` : null,
      ].filter(Boolean);
      return `${c.name} ${parts.join(' ')}`;
    })
    .join('  ·  ');
}

export interface FormattedRoomMessage {
  id: string;
  author: string;
  authorColor: 'cyan' | 'yellow' | 'green' | 'magenta' | 'red' | 'gray' | 'blue';
  badge: string | null;
  time: string;
  lines: string[];
  isError: boolean;
  markdown?: boolean;
}

function formatClock(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `${hh}:${mm}`;
}

export function authorColorFor(
  role: DiscussMessageDTO['role'],
  profileName: string | null | undefined,
): FormattedRoomMessage['authorColor'] {
  if (role === 'user') return 'cyan';
  if (role === 'system') return 'gray';
  const name = (profileName ?? role).toLowerCase();
  if (name === 'lead') return 'yellow';
  if (name.includes('review') || name === 'qa') return 'magenta';
  if (name.includes('coder')) return 'green';
  return 'blue';
}

/**
 * Text from the server and the agents (a log line, a diff, a message) can carry terminal control
 * codes. Remove escape sequences and control characters before drawing or paging it; tab and
 * newline stay.
 */
export function stripControl(text: string): string {
  return text
    .replace(/\x1b\[[0-9;?<>=!]*[ -/]*[@-~]/g, '')
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)?/g, '')
    .replace(/\x1b[@-Z\\-_]/g, '')
    .replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, '');
}

export function formatRoomMessage(msg: DiscussMessageDTO): FormattedRoomMessage {
  const author =
    msg.role === 'user'
      ? 'you'
      : msg.authorProfileName
        ? `@${msg.authorProfileName}`
        : msg.role === 'lead'
          ? '@lead'
          : 'system';

  const authorColor = msg.type === 'error' ? 'red' : authorColorFor(msg.role, msg.authorProfileName);
  const time = formatClock(msg.createdAt);
  const lines: string[] = [];
  let badge: string | null = null;

  if (msg.type === 'ask' && msg.content && typeof msg.content === 'object') {
    const ask = msg.content as AskMessageContent;
    // A yes/no question that holds back Auto work until the user answers.
    if ('pendingAutoWork' in ask) badge = 'QUESTION';
    lines.push(...(ask.text || '').split('\n'));
    if (ask.suggestion) {
      lines.push(
        `  -> Suggestion: /mode ${ask.suggestion.targetMode} (${ask.suggestion.reason})`,
      );
    }
  } else if (msg.type === 'questions' && msg.content && typeof msg.content === 'object') {
    const round = msg.content as DiscussRound;
    badge = `ROUND ${round.round}`;
    if (round.summary) lines.push(round.summary);
    for (let i = 0; i < (round.questions ?? []).length; i++) {
      const q = round.questions[i];
      lines.push(`  ${i + 1}. ${q.question}`);
      if (q.options?.length) {
        lines.push(`     Options: ${q.options.join(' | ')}`);
      }
    }
    if (round.ready_for_brief) {
      lines.push('  -> Lead is ready for the brief. Run /finish when ready.');
    }
  } else if (msg.type === 'quick_plan' && msg.content && typeof msg.content === 'object') {
    const qp = msg.content as QuickPlanMessageContent;
    badge = qp.verdict === 'ready' ? 'QUICK PLAN' : 'TOO LARGE';
    lines.push(qp.summary);
    if (qp.verdict === 'ready' && qp.task) {
      const outputTag = qp.task.output === 'answer' ? ' · answer' : '';
      lines.push(
        `  Task [${qp.task.id}] ${qp.task.title} (${displayTaskRole(qp.task.role)} · ${qp.task.complexity}${outputTag})`,
      );
      if (qp.task.files_allowed.length > 0) {
        lines.push(`  Files: ${qp.task.files_allowed.join(', ')}`);
      }
      lines.push(`  Verify: ${qp.task.verify?.trim() || '(skipped — criteria review)'}`);
    } else if (qp.reason) {
      lines.push(`  Reason: ${qp.reason}`);
      lines.push('  -> Switch with /mode full to plan this in milestones.');
    }
  } else if (msg.type === 'brief' && msg.content && typeof msg.content === 'object') {
    const b = msg.content as { version?: number; title?: string };
    badge = `BRIEF v${b.version ?? 1}`;
    lines.push(`Drafted brief: ${b.title ?? '(untitled)'}`);
  } else if (msg.type === 'plan' && msg.content && typeof msg.content === 'object') {
    const p = msg.content as {
      version?: number;
      milestoneCount?: number;
      taskCount?: number;
      tasks?: Array<{ id: string; title: string; role: string; complexity: string; output?: TaskOutputKind }>;
    };
    badge = `PLAN v${p.version ?? 1}`;
    lines.push(
      `Plan ready: ${p.taskCount ?? p.tasks?.length ?? 0} task(s) across ${p.milestoneCount ?? 1} milestone(s).`,
    );
    for (const t of (p.tasks ?? []).slice(0, 8)) {
      const outputTag = t.output === 'answer' ? ' · answer' : '';
      lines.push(`  [${t.id}] ${t.title} (${displayTaskRole(t.role)} · ${t.complexity}${outputTag})`);
    }
  } else if (msg.type === 'report' && msg.content && typeof msg.content === 'object') {
    const rep = msg.content as RoomReportContent;
    badge = rep.event.replace(/_/g, ' ').toUpperCase();
    lines.push(...rep.summary.split('\n'));
    if (rep.diffStats) {
      lines.push(
        `  Diff: ${rep.diffStats.filesChanged} file(s), +${rep.diffStats.insertions} -${rep.diffStats.deletions}`,
      );
    }
    if (rep.answer?.trim()) {
      const answerLines = rep.answer.trim().split('\n');
      const maxLines = 24;
      lines.push('');
      for (const l of answerLines.slice(0, maxLines)) {
        lines.push(`  ${l}`);
      }
      if (answerLines.length > maxLines) {
        lines.push(`  ... (${answerLines.length - maxLines} more line(s); run /diff ${rep.externalId ?? ''} to read full answer)`);
      }
    }
    if (rep.findings && rep.findings.length > 0) {
      for (const f of rep.findings.slice(0, 4)) {
        lines.push(`  - [${f.severity}] ${f.file ? `${f.file}: ` : ''}${f.note}`);
      }
    }
  } else if (msg.type === 'images' && msg.content && typeof msg.content === 'object') {
    const img = msg.content as ChatImageMessage;
    if (img.text) lines.push(...img.text.split('\n'));
    lines.push(`  [images: ${img.images.map((i) => i.name).join(', ')}]`);
  } else if (typeof msg.content === 'string') {
    lines.push(...msg.content.split('\n'));
  } else {
    lines.push(JSON.stringify(msg.content));
  }

  return {
    id: msg.id,
    author: stripControl(author),
    authorColor,
    badge: badge === null ? null : stripControl(badge),
    time,
    // A tab is zero columns wide to Ink but up to eight in the terminal, so the row would wrap and shift
    // every row under it. Incremental rendering then keeps the shifted leftovers on screen.
    lines: lines.length > 0 ? lines.map((line) => stripControl(line).replace(/\t/g, '    ')) : [''],
    isError: msg.type === 'error',
    markdown: msg.role !== 'user' && msg.role !== 'system' &&
      (msg.type === 'ask' || (msg.type !== 'error' && typeof msg.content === 'string')),
  };
}

/**
 * Wraps one timeline line to `width` columns at spaces, breaking words longer than a row.
 * The timeline scrolls by row, so long replies must become several rows instead of being cut off.
 * ponytail: counts code points, not display cells; wide CJK or emoji can still overflow by a few columns.
 */
export function wrapTimelineLine(line: string, width: number): string[] {
  const max = Math.max(10, Math.floor(width));
  const chars = Array.from(line);
  if (chars.length <= max) return [line];
  const indent = line.match(/^\s*/)?.[0] ?? '';
  const rows: string[] = [];
  let rest = chars;
  let prefix = '';
  while (prefix.length + rest.length > max) {
    const room = max - prefix.length;
    const slice = rest.slice(0, room + 1);
    let cut = slice.lastIndexOf(' ');
    if (cut <= 0) cut = room;
    rows.push(prefix + rest.slice(0, cut).join('').trimEnd());
    rest = rest.slice(cut);
    while (rest[0] === ' ') rest = rest.slice(1);
    prefix = indent;
  }
  if (rest.length > 0) rows.push(prefix + rest.join(''));
  return rows;
}

function toolActivity(name: unknown): string {
  if (typeof name !== 'string') return 'Using a tool';
  if (/grep|glob|find|search|list/i.test(name)) return 'Searching files';
  if (/read|view|open/i.test(name)) return 'Reading files';
  if (/edit|write|patch|replace/i.test(name)) return 'Editing files';
  if (/bash|run|exec|command|shell/i.test(name)) return 'Running a command';
  return 'Using a tool';
}

export function extractActivityPreview(rawLine: string): string | null {
  const trimmed = rawLine.trim();
  if (trimmed.startsWith('[dalang] Running verify command:')) return 'Running verification';
  if (trimmed.startsWith('[dalang] Preparing worktree:')) return 'Installing dependencies';
  if (trimmed.startsWith('[dalang] Waiting for parallel slot')) return 'Waiting for an agent slot';
  if (trimmed.startsWith('[dalang] Waiting for in-flight delegated subtasks')) return 'Waiting for delegated tasks';
  if (!trimmed.startsWith('{')) return null;
  try {
    const obj = JSON.parse(trimmed) as Record<string, unknown>;
    if (obj.type === 'provider.error' && obj.retrying === true) return 'Provider is reconnecting';
    if (obj.type === 'assistant') {
      const content = (obj.message as { content?: unknown } | null)?.content;
      if (Array.isArray(content)) {
        const tool = content.findLast((block) => block?.type === 'tool_use');
        if (tool) return toolActivity(tool.name);
        if (content.some((block) => block?.type === 'text')) return 'Writing a response';
        if (content.some((block) => block?.type === 'thinking' || block?.type === 'redacted_thinking')) return 'Thinking';
      }
    }
    if (obj.type === 'item.started' || obj.type === 'item.updated' || obj.type === 'item.completed') {
      const item = obj.item as { type?: string; tool?: unknown } | null;
      switch (item?.type) {
        case 'reasoning': return 'Thinking';
        case 'command_execution': return obj.type === 'item.completed' ? 'Processing command results' : 'Running a command';
        case 'file_change': return 'Editing files';
        case 'web_search': return 'Searching the web';
        case 'mcp_tool_call': return toolActivity(item.tool);
        case 'agent_message': return 'Writing a response';
      }
    }
    if (obj.event === 'step_update') {
      const step = obj.step_update as { step_type?: string; state?: string; tool_name?: unknown } | null;
      switch (step?.step_type) {
        case 'tool': return step.state === 'ACTIVE' ? toolActivity(step.tool_name) : null;
        case 'thinking': return 'Thinking';
        case 'agent_response': return 'Writing a response';
      }
    }
  } catch {
    return null;
  }
  return null;
}

/**
 * Opens diff/text content in `$PAGER` (default `less -R` on Unix, `more` on Windows)
 * by writing to a temporary file so the pager receives full TTY keyboard control.
 */
export function openTextInPager(content: string, label = 'dalang-diff'): { ok: boolean; error?: string } {
  const safeLabel = label.replace(/[^A-Za-z0-9._-]/g, '_');
  const tmpFile = path.join(os.tmpdir(), `${safeLabel}-${process.pid}-${Date.now()}.diff`);
  try {
    fs.writeFileSync(tmpFile, stripControl(content), 'utf8');
    const envPager = process.env.PAGER?.trim();
    const isWin = process.platform === 'win32';
    const pagerCmd = envPager || (isWin ? 'more' : 'less -R');
    const parts = pagerCmd.split(/\s+/).filter(Boolean);
    const bin = parts[0];
    const args = [...parts.slice(1), tmpFile];
    const res = spawnSync(bin, args, {
      stdio: 'inherit',
      shell: isWin,
    });
    if (res.error) {
      return { ok: false, error: res.error.message };
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  } finally {
    fs.rmSync(tmpFile, { force: true });
  }
}
