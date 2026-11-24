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
  ProviderStatus,
  QuickPlanMessageContent,
  RoomReportContent,
  SessionDetailDTO,
} from '@dalang/shared';

export type PendingGate =
  | {
      kind: 'quick_run';
      planVersion: number;
      taskId: string;
      externalId: string;
      title: string;
      prompt: string;
    }
  | {
      kind: 'approve_brief';
      version: number;
      title: string;
      prompt: string;
    }
  | {
      kind: 'approve_plan';
      version: number;
      taskCount: number;
      prompt: string;
    }
  | {
      kind: 'approve_merge';
      taskId: string;
      externalId: string;
      title: string;
      branch: string;
      reviewFailed: boolean;
      prompt: string;
    };

export function detectPendingGate(
  detail: SessionDetailDTO | null,
  guard: GuardStateDTO | null,
): PendingGate | null {
  if (!detail) return null;

  // 1. Merge gate takes top priority when a task is waiting for human merge approval
  const mergeCandidate = guard?.tasks.find(
    (entry) => entry.task.status === 'awaiting_merge' && entry.canApproveMerge,
  );
  if (mergeCandidate) {
    return {
      kind: 'approve_merge',
      taskId: mergeCandidate.task.id,
      externalId: mergeCandidate.task.externalId,
      title: mergeCandidate.task.title,
      branch: guard?.mainBranch ?? 'main',
      reviewFailed: false,
      prompt: `Merge [${mergeCandidate.task.externalId}] "${mergeCandidate.task.title}" into ${guard?.mainBranch ?? 'main'}? (y/n · /diff to inspect)`,
    };
  }

  // 2. Quick draft plan gate
  if (detail.session.mode === 'quick' && detail.plan?.status === 'draft' && detail.plan.tasks.length > 0) {
    const task = detail.plan.tasks[0];
    return {
      kind: 'quick_run',
      planVersion: detail.plan.version,
      taskId: task.id,
      externalId: task.externalId,
      title: task.title,
      prompt: `Run Quick task [${task.externalId}] "${task.title}"? (y/n)`,
    };
  }

  // 3. Full mode brief draft gate
  const latestBrief = detail.briefs[0];
  if (detail.session.mode === 'full' && latestBrief?.status === 'draft') {
    return {
      kind: 'approve_brief',
      version: latestBrief.version,
      title: latestBrief.content.title,
      prompt: `Approve Brief v${latestBrief.version} "${latestBrief.content.title}" and generate plan? (y/n)`,
    };
  }

  // 4. Full mode plan draft gate
  if (detail.session.mode === 'full' && detail.plan?.status === 'draft') {
    const hasNeedsSplit = detail.plan.tasks.some((t) => t.needsSplit);
    if (!hasNeedsSplit && detail.plan.tasks.length > 0) {
      return {
        kind: 'approve_plan',
        version: detail.plan.version,
        taskCount: detail.plan.tasks.length,
        prompt: `Approve Plan v${detail.plan.version} (${detail.plan.tasks.length} task(s)) and start work? (y/n)`,
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
      lines.push(`  Task [${qp.task.id}] ${qp.task.title} (${qp.task.role} · ${qp.task.complexity})`);
      if (qp.task.files_allowed.length > 0) {
        lines.push(`  Files: ${qp.task.files_allowed.join(', ')}`);
      }
      lines.push(`  Verify: ${qp.task.verify}`);
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
      tasks?: Array<{ id: string; title: string; role: string; complexity: string }>;
    };
    badge = `PLAN v${p.version ?? 1}`;
    lines.push(
      `Plan ready: ${p.taskCount ?? p.tasks?.length ?? 0} task(s) across ${p.milestoneCount ?? 1} milestone(s).`,
    );
    for (const t of (p.tasks ?? []).slice(0, 8)) {
      lines.push(`  [${t.id}] ${t.title} (${t.role} · ${t.complexity})`);
    }
  } else if (msg.type === 'report' && msg.content && typeof msg.content === 'object') {
    const rep = msg.content as RoomReportContent;
    badge = rep.event.replace(/_/g, ' ').toUpperCase();
    lines.push(rep.summary);
    if (rep.diffStats) {
      lines.push(
        `  Diff: ${rep.diffStats.filesChanged} file(s), +${rep.diffStats.insertions} -${rep.diffStats.deletions}`,
      );
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
    lines: lines.length > 0 ? lines.map(stripControl) : [''],
    isError: msg.type === 'error',
  };
}

/** Extracts a concise human-readable line from raw CLI stream-json or dalang log lines. */
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

export function extractActivityPreview(rawLine: string): string | null {
  const preview = extractActivityPreviewRaw(rawLine);
  return preview === null ? null : stripControl(preview) || null;
}

function extractActivityPreviewRaw(rawLine: string): string | null {
  const trimmed = rawLine.trim();
  if (!trimmed) return null;
  if (trimmed.startsWith('[dalang')) {
    return trimmed.replace(/^\[dalang(?::\w+)?\]\s*/, '').slice(0, 120);
  }
  if (!trimmed.startsWith('{')) {
    return trimmed.slice(0, 120);
  }
  try {
    const obj = JSON.parse(trimmed) as Record<string, unknown>;
    if (obj.type === 'assistant' && obj.message && typeof obj.message === 'object') {
      const content = (obj.message as { content?: Array<{ type?: string; text?: string; name?: string }> }).content;
      if (Array.isArray(content)) {
        const tool = content.find((c) => c.type === 'tool_use' && c.name);
        if (tool?.name) return `Using tool: ${tool.name}`;
        const txt = content.find((c) => c.type === 'text' && c.text);
        if (txt?.text) return txt.text.replace(/\s+/g, ' ').slice(0, 120);
      }
    }
    if (obj.type === 'item.completed' && obj.item && typeof obj.item === 'object') {
      const item = obj.item as { type?: string; text?: string; command?: string };
      if (item.command) return `Ran: ${item.command.slice(0, 100)}`;
      if (item.text) return item.text.replace(/\s+/g, ' ').slice(0, 120);
    }
    if (typeof obj.text === 'string' && obj.text.trim()) {
      return obj.text.replace(/\s+/g, ' ').slice(0, 120);
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
