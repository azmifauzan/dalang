/**
 * Room & Web Feature Parity Inventory (PRD v0.15 R5a / R5c).
 *
 * Every web page, setting, and action is paired with its terminal room counterpart
 * (or one of the three PRD-approved web-only exceptions). Shared by core parity
 * checks and the Room/Web parity replay suites.
 */

export type ParityCategory =
  | 'config'
  | 'project'
  | 'work'
  | 'review_merge'
  | 'history'
  | 'statistics'
  | 'triage';

export type ParityStatus = 'parity' | 'exception' | 'gap';

export interface ParityInventoryItem {
  /** Stable identifier used by tests and reports. */
  id: string;
  category: ParityCategory;
  /** Human-readable location in the Web UI. */
  webLocation: string;
  /** Description of the setting or action. */
  capability: string;
  /** Terminal room command or screen counterpart (null only when status === 'exception'). */
  roomCounterpart: string | null;
  /** Slash command name(s) that back this capability in the room, for automated verification. */
  roomCommands?: string[];
  status: ParityStatus;
  /** Required written reason when status === 'exception'. */
  exceptionReason?: string;
  /** Optional shared scenario id exercised by both browser-replay and room-replay. */
  scenarioId?: string;
}

/**
 * Only these three web-only exceptions are approved in PRD v0.15 R5(c).
 * Any new exception requires user approval and a written reason in docs/PRD.md.
 */
export const APPROVED_PARITY_EXCEPTION_IDS = [
  'config.general.theme',
  'config.security.app_password',
  'config.general.factory_reset',
] as const;

export const PARITY_INVENTORY: readonly ParityInventoryItem[] = [
  // ─── Config: General ──────────────────────────────────────────────────────
  {
    id: 'config.general.language',
    category: 'config',
    webLocation: 'Config > General > Language',
    capability: 'Switch UI and Lead/Reviewer output language (en / id)',
    roomCounterpart: '/config -> Language',
    roomCommands: ['config'],
    status: 'parity',
  },
  {
    id: 'config.general.theme',
    category: 'config',
    webLocation: 'Config > General > Theme',
    capability: 'Switch light / dark / system web theme',
    roomCounterpart: null,
    status: 'exception',
    exceptionReason: 'Terminal rooms inherit the user terminal emulator color scheme (PRD R5c).',
  },
  {
    id: 'config.general.usage_refresh',
    category: 'config',
    webLocation: 'Config > General > Provider limits refresh',
    capability: 'Set provider quota refresh interval',
    roomCounterpart: '/config -> Provider limits refresh',
    roomCommands: ['config'],
    status: 'parity',
  },
  {
    id: 'config.general.check_updates',
    category: 'config',
    webLocation: 'Config > General > Check for updates',
    capability: 'Toggle automatic DALANG update checks',
    roomCounterpart: '/config -> Check for new versions',
    roomCommands: ['config', 'update'],
    status: 'parity',
  },
  {
    id: 'config.general.wizard',
    category: 'config',
    webLocation: 'Config > General > Reopen setup wizard',
    capability: 'Reopen the first-run setup wizard',
    roomCounterpart: '/wizard (or /config -> Setup wizard)',
    roomCommands: ['wizard', 'config'],
    status: 'parity',
  },
  {
    id: 'config.general.factory_reset',
    category: 'config',
    webLocation: 'Config > General > Factory reset',
    capability: 'Wipe DALANG database and reset settings',
    roomCounterpart: null,
    status: 'exception',
    exceptionReason: 'Destructive full-database factory reset stays web-only behind a modal confirmation (PRD R5c).',
  },

  // ─── Config: Agents, Profiles, Providers & Routing ────────────────────────
  {
    id: 'config.agents.providers_status',
    category: 'config',
    webLocation: 'Config > Agents > CLIs & Quotas',
    capability: 'Inspect provider CLI installation, auth, sandbox status, quotas, and refresh',
    roomCounterpart: '/config -> Agent CLIs or /providers [refresh]',
    roomCommands: ['config', 'providers'],
    status: 'parity',
  },
  {
    id: 'config.agents.update_cli',
    category: 'config',
    webLocation: 'Config > Agents > CLIs & Quotas > Update CLI',
    capability: 'Update installed provider CLIs',
    roomCounterpart: '/update clis (or /update all)',
    roomCommands: ['update'],
    status: 'parity',
  },
  {
    id: 'config.agents.clear_cooldown',
    category: 'config',
    webLocation: 'Config > Agents > CLIs & Quotas > Clear cooldown',
    capability: 'Clear provider cooldown / quota lockout state',
    roomCounterpart: '/providers clear-cooldown <provider>',
    roomCommands: ['providers'],
    status: 'parity',
  },
  {
    id: 'config.agents.team_core_roles',
    category: 'config',
    webLocation: 'Config > Agents > Team & Roles (basic)',
    capability: 'Configure provider, model, reasoning effort, and fallback for core roles',
    roomCounterpart: '/config -> Agent team or /profile set <name> ...',
    roomCommands: ['config', 'profile'],
    status: 'parity',
  },
  {
    id: 'config.agents.profile_advanced',
    category: 'config',
    webLocation: 'Config > Agents > Profile editor (Advanced)',
    capability: 'Edit parallel slots, account folder (configDir), permission mode, review rounds, timeouts, and role prompt',
    roomCounterpart: '/config -> Agent team -> Advanced or /profile set <name> <field> <value>',
    roomCommands: ['config', 'profile'],
    status: 'parity',
    scenarioId: 'profile-advanced-settings',
  },
  {
    id: 'config.agents.profile_create_delete',
    category: 'config',
    webLocation: 'Config > Agents > Add / Delete profile',
    capability: 'Create a custom agent profile and delete custom profiles',
    roomCounterpart: '/profile add <name> <provider> [model] and /profile delete <name>',
    roomCommands: ['profile'],
    status: 'parity',
  },
  {
    id: 'config.agents.routing_rules',
    category: 'config',
    webLocation: 'Config > Agents > Task routing',
    capability: 'List, create, edit, reorder, and delete task routing rules',
    roomCounterpart: '/routing [list|add|edit|move|delete] (and /config -> Task routing)',
    roomCommands: ['routing', 'config'],
    status: 'parity',
  },

  // ─── Config: Automation & MCP Tokens ──────────────────────────────────────
  {
    id: 'config.automation.schedules_webhooks',
    category: 'config',
    webLocation: 'Config > Automation > Schedules & Webhooks',
    capability: 'List, create, pause/enable, trigger, rotate webhook secret, view runs, and delete automations',
    roomCounterpart: '/automation [list|add|enable|disable|trigger|rotate|runs|delete]',
    roomCommands: ['automation', 'config'],
    status: 'parity',
  },
  {
    id: 'config.automation.mcp_tokens',
    category: 'config',
    webLocation: 'Config > Automation > Outside Agents (MCP tokens)',
    capability: 'List, create (one-time reveal), revoke, and delete MCP access tokens',
    roomCounterpart: '/tokens [list|create|revoke|delete]',
    roomCommands: ['tokens', 'config'],
    status: 'parity',
  },

  // ─── Config: Security & About ─────────────────────────────────────────────
  {
    id: 'config.security.app_password',
    category: 'config',
    webLocation: 'Config > Security > App password',
    capability: 'Enable, change, or disable browser login password',
    roomCounterpart: null,
    status: 'exception',
    exceptionReason: 'App password protects browser HTTP sessions; terminal room connects locally or authenticates if enabled (PRD R5c).',
  },
  {
    id: 'config.security.sandbox_keyring',
    category: 'config',
    webLocation: 'Config > Security > Sandbox & Antigravity keyring',
    capability: 'Inspect sandbox engine status and toggle Antigravity desktop keyring consent',
    roomCounterpart: '/config -> Agent CLIs (Antigravity keyring access)',
    roomCommands: ['config'],
    status: 'parity',
  },
  {
    id: 'config.about.updates',
    category: 'config',
    webLocation: 'Config > About > Version & Updates',
    capability: 'View DALANG version and check for updates',
    roomCounterpart: '/update check',
    roomCommands: ['update'],
    status: 'parity',
  },

  // ─── Project & Session Management ─────────────────────────────────────────
  {
    id: 'project.switch_open_create',
    category: 'project',
    webLocation: 'Sidebar > Projects (Open / Create / Switch)',
    capability: 'List, switch, open existing folder, or create new project',
    roomCounterpart: '/project [list|<n|name>|open|create]',
    roomCommands: ['project'],
    status: 'parity',
  },
  {
    id: 'project.settings',
    category: 'project',
    webLocation: 'Project settings (Lead, integration cmd, push/PR, remote, delete)',
    capability: 'View/update project Lead, integration command, push/PR after merge, git remote, and delete project',
    roomCounterpart: '/project [settings|lead|integration|push|pr|remote|delete]',
    roomCommands: ['project'],
    status: 'parity',
  },
  {
    id: 'project.project_md',
    category: 'project',
    webLocation: 'Project > PROJECT.md & symlinks',
    capability: 'Inspect PROJECT.md and repair CLAUDE.md / AGENTS.md symlinks',
    roomCounterpart: '/project md [show|repair]',
    roomCommands: ['project'],
    status: 'parity',
  },
  {
    id: 'project.workspace_setup',
    category: 'project',
    webLocation: 'Project > Worktree setup & snapshot',
    capability: 'Inspect, approve, edit setup/check/maintenance commands, local files, and reset snapshot',
    roomCounterpart: '/setup [approve|check|set|maintenance|files|off|reset]',
    roomCommands: ['setup'],
    status: 'parity',
  },
  {
    id: 'project.sessions',
    category: 'project',
    webLocation: 'Sidebar > Sessions (New / Switch / Rename / Archive / Delete / Discard)',
    capability: 'Start new session, resume, switch mode, rename, archive/unarchive, discard work, or delete session',
    roomCounterpart: '/new, /resume, /mode, /session [list|rename|archive|unarchive|discard|delete]',
    roomCommands: ['new', 'resume', 'mode', 'session'],
    status: 'parity',
  },

  // ─── Work & Execution ─────────────────────────────────────────────────────
  {
    id: 'work.chat_and_modes',
    category: 'work',
    webLocation: 'Session > Chat composer (Auto / Ask / Quick / Full, model picker, @mentions)',
    capability: 'Chat with Lead, switch mode, pick model, ask/steer profiles with @mention',
    roomCounterpart: 'Room composer, /mode, /model, @<profile>',
    roomCommands: ['mode', 'model'],
    status: 'parity',
    scenarioId: 'ask-chat-and-model',
  },
  {
    id: 'work.structured_questions',
    category: 'work',
    webLocation: 'Session > Structured question card',
    capability: 'Answer structured Lead questions with single/multi choice or custom text',
    roomCounterpart: 'Approval/Question box (numbered choice or custom reply)',
    roomCommands: ['help'],
    status: 'parity',
    scenarioId: 'structured-question-answer',
  },
  {
    id: 'work.brief_and_plan_approval',
    category: 'work',
    webLocation: 'Session > Discuss / Agree / List (Finish, Approve Brief, Generate & Approve Plan)',
    capability: 'Finish discuss, approve/revise brief, review plan with critical path, approve and run',
    roomCounterpart: '/finish, /run, y / n gate decisions',
    roomCommands: ['finish', 'run'],
    status: 'parity',
    scenarioId: 'plan-approve-and-execute',
  },
  {
    id: 'work.execution_controls',
    category: 'work',
    webLocation: 'Work view > Task controls (Status, Run, Retry, Continue, Assign profile, Stop, Rollback)',
    capability: 'Inspect tasks/runs/slot waits, run or retry task (with warning), continue on branch, assign profile, stop, rollback',
    roomCounterpart: '/work [status|run|retry|assign|rollback], /continue, /stop',
    roomCommands: ['work', 'continue', 'stop'],
    status: 'parity',
  },
  {
    id: 'work.scope_request',
    category: 'work',
    webLocation: 'Work / Guard > Allow extra files scope request',
    capability: 'Approve additional files requested by a blocked executor and resume',
    roomCounterpart: 'Scope request gate (y / n)',
    roomCommands: ['work'],
    status: 'parity',
  },
  {
    id: 'work.busy_commands',
    category: 'work',
    webLocation: 'Composer while busy (model picker stays usable; blocked submit shows notice)',
    capability: 'Run read-only/settings actions while busy and keep draft intact when blocked',
    roomCounterpart: 'Busy-safe slash commands (/config, /model, /help, /diff, /work, /stats, /history, /stop)',
    roomCommands: ['config', 'model', 'help', 'diff', 'work', 'stats', 'history', 'stop'],
    status: 'parity',
  },

  // ─── Review & Merge (Guard) ───────────────────────────────────────────────
  {
    id: 'review_merge.diff_and_answer',
    category: 'review_merge',
    webLocation: 'Guard > Diff & Answer inspector',
    capability: 'Inspect full task diff or answer output',
    roomCounterpart: '/diff [taskId] (opens in $PAGER)',
    roomCommands: ['diff'],
    status: 'parity',
  },
  {
    id: 'review_merge.approve_reject',
    category: 'review_merge',
    webLocation: 'Guard > Approve Merge / Accept / Reject',
    capability: 'Approve merge/accept answer, override failed review, or reject with destructive warning',
    roomCounterpart: '/merge, /accept, /reject [taskId] [--requeue], y / n gate',
    roomCommands: ['merge', 'accept', 'reject'],
    status: 'parity',
    scenarioId: 'review-and-merge-gate',
  },
  {
    id: 'review_merge.integration_and_pr',
    category: 'review_merge',
    webLocation: 'Guard > Run Integration (sandbox / outside sandbox) & Push/PR',
    capability: 'Run project integration check (including confirmed outside-sandbox override) and push PR',
    roomCounterpart: '/integration [--outside-sandbox] [cmd] and /work push-pr <taskId>',
    roomCommands: ['integration', 'work'],
    status: 'parity',
  },

  // ─── History ──────────────────────────────────────────────────────────────
  {
    id: 'history.runs_and_logs',
    category: 'history',
    webLocation: 'History view > Sessions, Runs, and Run Logs',
    capability: 'Browse past sessions and task runs and open timestamped run logs',
    roomCounterpart: '/history [sessions|runs|log <runId>]',
    roomCommands: ['history'],
    status: 'parity',
  },

  // ─── Statistics ───────────────────────────────────────────────────────────
  {
    id: 'statistics.usage_and_timing',
    category: 'statistics',
    webLocation: 'Statistics view > Provider, Model, Project usage & phase timings',
    capability: 'View run counts, token usage, estimated cost, and step timing breakdown',
    roomCounterpart: '/stats [days] (alias /statistics)',
    roomCommands: ['stats', 'statistics'],
    status: 'parity',
    scenarioId: 'statistics-overview',
  },

  // ─── Triage ───────────────────────────────────────────────────────────────
  {
    id: 'triage.report_problem',
    category: 'triage',
    webLocation: 'Config > About > Report a problem',
    capability: 'Preview redacted diagnostics and start local Ask triage session after confirmation',
    roomCounterpart: '/triage [problem]',
    roomCommands: ['triage'],
    status: 'parity',
    scenarioId: 'triage-preview-and-start',
  },
];
