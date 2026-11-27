import { findProfileByRef } from '@dalang/shared';
import type { AgentProfileDTO, SessionSummaryDTO } from '@dalang/shared';

export interface SlashCommandDef {
  name: string;
  usage: string;
  description: string;
}

export const SLASH_COMMANDS: SlashCommandDef[] = [
  { name: 'mouse', usage: '/mouse', description: 'Toggle mouse wheel capture for text selection' },
  { name: 'mode', usage: '/mode [auto|ask|quick|full]', description: 'Show or switch chat mode' },
  { name: 'project', usage: '/project [list|<n|name>|open [path]|create [path]]', description: 'List, switch, or open a project' },
  { name: 'new', usage: '/new', description: 'Start a new session' },
  { name: 'resume', usage: '/resume [n|id]', description: 'Pick a previous session to continue' },
  { name: 'update', usage: '/update [check|clis|all]', description: 'Check/install DALANG update or update all connected CLIs' },
  { name: 'restart', usage: '/restart', description: 'Restart DALANG and return to this session' },
  { name: 'setup', usage: '/setup [approve|set <cmd>|maintenance <cmd>|files <paths>|off|reset]', description: 'What prepares each task worktree of this project' },
  { name: 'model', usage: '/model', description: "Choose the Lead's model from every connected provider" },
  { name: 'config', usage: '/config', description: 'Language, limits refresh, agent CLIs, and the agent team' },
  { name: 'wizard', usage: '/wizard', description: 'Open the setup wizard again' },
  { name: 'diff', usage: '/diff [taskId]', description: 'Open task diff or answer in $PAGER' },
  { name: 'merge', usage: '/merge [taskId]', description: 'Approve and merge (or accept) the ready task' },
  { name: 'accept', usage: '/accept [taskId]', description: 'Accept the ready answer task (or merge a files task)' },
  { name: 'reject', usage: '/reject [taskId] [note]', description: 'Reject the awaiting task (--requeue to retry)' },
  { name: 'stop', usage: '/stop [taskId]', description: 'Stop all running agents and tasks (or one task)' },
  { name: 'web', usage: '/web', description: 'Open the web UI on the current session' },
  { name: 'run', usage: '/run', description: 'Approve and run the current draft plan' },
  { name: 'finish', usage: '/finish', description: 'Finish Discuss and write the brief (Full mode)' },
  { name: 'help', usage: '/help', description: 'Show commands and keyboard shortcuts' },
  { name: 'exit', usage: '/exit', description: 'Exit the terminal room' },
];

export interface ParsedSlashCommand {
  name: string;
  args: string[];
  rawArgs: string;
}

export function parseSlashCommand(input: string): ParsedSlashCommand | null {
  const trimmed = input.trim();
  if (!trimmed.startsWith('/')) return null;
  const rest = trimmed.slice(1);
  if (!rest) return null;
  const spaceIdx = rest.search(/\s/);
  if (spaceIdx === -1) {
    return { name: rest.toLowerCase(), args: [], rawArgs: '' };
  }
  const name = rest.slice(0, spaceIdx).toLowerCase();
  const rawArgs = rest.slice(spaceIdx + 1).trim();
  const args = rawArgs ? rawArgs.split(/\s+/) : [];
  return { name, args, rawArgs };
}

export interface CompletionItem {
  value: string;
  label: string;
  detail: string;
}

/** Sessions that `/resume` offers: not archived, newest activity first, capped so the list stays short. */
export const RESUME_LIST_LIMIT = 30;

export function resumableSessions(sessions: SessionSummaryDTO[]): SessionSummaryDTO[] {
  return sessions
    .filter((s) => !s.archivedAt)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    .slice(0, RESUME_LIST_LIMIT);
}

/** "5m ago", "3h ago", "2d ago" for a past ISO time. */
export function relativeTime(iso: string, now: number = Date.now()): string {
  const diff = Math.max(0, now - new Date(iso).getTime());
  if (Number.isNaN(diff)) return '';
  const min = Math.floor(diff / 60_000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min}m ago`;
  const hours = Math.floor(min / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

function clip(text: string, max: number): string {
  const chars = Array.from(text);
  return chars.length > max ? `${chars.slice(0, max - 3).join('')}...` : text;
}

export function getComposerCompletions(
  input: string,
  profiles: AgentProfileDTO[],
  runningProfileNames: ReadonlySet<string>,
  sessions: SessionSummaryDTO[] = [],
): CompletionItem[] {
  const trimmedStart = input.trimStart();

  // `/resume <filter>`: the previous sessions, numbered the same way `/resume <n>` reads them.
  const resumeMatch = trimmedStart.match(/^\/resume\s+(\S*)$/i);
  if (resumeMatch) {
    const query = resumeMatch[1].toLowerCase();
    return resumableSessions(sessions)
      .map((s, idx) => ({ s, number: idx + 1 }))
      .filter(
        ({ s, number }) =>
          !query ||
          String(number) === query ||
          s.id.toLowerCase().startsWith(query) ||
          (s.title || '').toLowerCase().includes(query),
      )
      .map(({ s, number }) => ({
        value: `/resume ${s.id}`,
        label: `${number}. ${clip(s.title?.trim() || '(untitled)', 44)}`,
        detail: `[${s.mode}] ${relativeTime(s.updatedAt)}${s.workState === 'working' ? ' · working' : ''}`,
      }));
  }

  // `/update <subcommand>`: check DALANG update, update connected CLIs, or update everything.
  const updateMatch = trimmedStart.match(/^\/update\s+(\S*)$/i);
  if (updateMatch) {
    const query = updateMatch[1].toLowerCase();
    const options: CompletionItem[] = [
      { value: '/update check', label: '/update check', detail: 'Check for the latest DALANG version' },
      { value: '/update clis', label: '/update clis', detail: 'Update all connected agent CLIs (Claude, Codex, Agy)' },
      { value: '/update all', label: '/update all', detail: 'Update DALANG and all connected agent CLIs' },
    ];
    return options.filter((opt) => !query || opt.value.slice('/update '.length).startsWith(query));
  }

  // Slash command completion when typing `/...` with no space yet
  if (trimmedStart.startsWith('/') && !trimmedStart.includes(' ')) {
    const query = trimmedStart.slice(1).toLowerCase();
    return SLASH_COMMANDS.filter((c) => c.name.startsWith(query)).map((c) => ({
      value: `/${c.name}`,
      label: `/${c.name}`,
      detail: c.description,
    }));
  }

  // Leading `@<profile>` completion
  const mentionMatch = input.match(/^(\s*)@([A-Za-z0-9._-]*)$/);
  if (!mentionMatch) return [];
  const query = mentionMatch[2].toLowerCase();

  const items: CompletionItem[] = [];
  if (runningProfileNames.size > 0) {
    if ('executor'.startsWith(query)) {
      items.push({
        value: '@executor',
        label: '@executor',
        detail: `steer running (${[...runningProfileNames].join(', ')})`,
      });
    }
  }

  // A renamed checker profile still gets the @checker alias; one named `checker` is listed below.
  const qaProfile = findProfileByRef(profiles, 'qa');
  if (qaProfile && qaProfile.name !== 'checker' && query.length > 0 && 'checker'.startsWith(query)) {
    const isRunning = runningProfileNames.has(qaProfile.name);
    items.push({
      value: '@checker',
      label: '@checker',
      detail: isRunning ? `running · steer (${qaProfile.provider})` : `idle · ask (${qaProfile.provider})`,
    });
  }

  for (const p of profiles) {
    if (!p.name.toLowerCase().startsWith(query)) continue;
    const isRunning = runningProfileNames.has(p.name);
    const roleHint =
      p.name === 'lead'
        ? 'Lead'
        : isRunning
          ? `running · steer (${p.provider})`
          : `idle · ask (${p.provider})`;
    items.push({
      value: `@${p.name}`,
      label: `@${p.name}`,
      detail: roleHint,
    });
  }

  return items;
}

export type ComposerSubmit =
  | { action: 'send'; text: string }
  | { action: 'run'; text: string }
  | { action: 'fill'; text: string };

/**
 * What Enter does in the composer. While the popup is open and the input is only a partial
 * `/command` or `@profile`, Enter acts on the highlighted item: a command runs, a mention is
 * filled in (it still needs a message). Otherwise the typed text is sent as it is.
 */
export function resolveComposerSubmit(
  input: string,
  completions: CompletionItem[],
  selected: number,
): ComposerSubmit {
  const picked = completions[selected] ?? completions[0];
  if (picked) {
    if (input.trimStart().startsWith('/') && picked.value.startsWith('/')) {
      return { action: 'run', text: picked.value };
    }
    if (/^\s*@[A-Za-z0-9._-]*$/.test(input)) {
      return { action: 'fill', text: applyComposerCompletion(input, picked.value) };
    }
  }
  return { action: 'send', text: input };
}

export const POPUP_SIZE = 6;

/** First visible item of a `size`-row popup so the selected item stays on screen. */
export function popupWindowStart(selected: number, total: number, size: number): number {
  if (total <= size) return 0;
  return Math.min(Math.max(0, selected - size + 1), total - size);
}

export function applyComposerCompletion(input: string, completionValue: string): string {
  const trimmedStart = input.trimStart();
  if (trimmedStart.startsWith('/') && !trimmedStart.includes(' ')) {
    return `${completionValue} `;
  }
  const mentionMatch = input.match(/^(\s*)@([A-Za-z0-9._-]*)$/);
  if (mentionMatch) {
    return `${mentionMatch[1]}${completionValue} `;
  }
  return `${completionValue} `;
}
