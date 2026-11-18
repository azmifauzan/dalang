# PRD: DALANG

Nov 18, 2026 · @Fauzan

## Summary

DALANG is a locally running web tool. It turns one general goal into a running application by orchestrating Claude Code, Codex, and Antigravity CLI as a small team. The name is also an acronym for its workflow: **Discuss · Agree · List · Assign · Navigate · Guard**.

The user writes a goal in a chat. A Lead agent discusses and confirms the scope, then breaks it into small subtasks. A dispatcher hands each task to an agent according to role, subscription, and the model the user configured.

Everything runs on the user's machine and uses the official CLI logins. No extra API keys are needed. A human is involved at only two gates: approving the brief and approving the merge.

## Background and problem

Developers who have several coding-agent subscriptions currently run them by hand, one after another. Planning happens in one tool, coding in another, then testing and review in a third, all in the same workspace.

This manual flow causes four problems:

- **Manual handoffs.** The plan and context have to be moved from one tool to the next by hand.
- **Serial and needs babysitting.** The developer watches every stage and can only start the next one after the previous one finishes.
- **Uneven quota use.** One subscription can hit its limit while another sits idle.
- **No trail.** Decisions, plans, and review results are scattered across each tool's chat history.

Similar tools already exist: Agentty, ordewell, Orchestrator.inc, and Vibe Kanban. None of them combines a local web UI, an interview phase before planning, per-agent subscription and model settings, and Antigravity CLI support in one product.

## Goals, non-goals, and metrics

**v1 goals**

1. One goal in the chat produces a running application. A human is involved only at two gates: brief approval and merge approval.
2. Each agent role can be configured with a provider (subscription) and a model.
3. All artifacts are stored and traceable: brief, plan, tasks, logs, and reviews.
4. Quota usage is spread across subscriptions, with automatic fallback when a provider hits its limit.

**v1 non-goals**

- Not a SaaS, not multi-user, does not run in the cloud.
- Does not call model APIs directly and does not reuse the CLIs' OAuth tokens. It only runs the official CLI binaries.
- Not an IDE or code editor.
- Does not deploy to production.

**Success metrics** (proposed targets, recalibrated after the first 10 projects)

| Metric | v1 target |
| --- | --- |
| Tasks that pass review within at most 2 rounds with no manual intervention | ≥ 70% |
| Time from first goal to approved plan | ≤ 15 minutes |
| Runs that fail because of an orchestrator error (not an agent error) | < 5% |
| Tasks that fail from quota limits even though a backup provider exists | 0 |

## Users and main scenarios

**Primary user:** a solo builder or senior developer with two to three coding-agent subscriptions who builds their own products. **Secondary user:** a tech lead on a small team who uses agents for prototyping and feature work.

| Scenario | User input | Expected result |
| --- | --- | --- |
| New application from scratch | A general goal, e.g. "barcode-based attendance app with WhatsApp notifications" | A new repo with a running application, tests, and a README |
| New feature in an existing repo | Repo path + feature description | A branch with the feature that passes both existing and new tests |
| Targeted bugfix or refactor | Bug description or refactor target | A small, reviewed change with a regression test |
| Resuming a project after a break | Opening an old project in DALANG | State, plan, and remaining tasks are restored, then work continues |

## Product flow: D-A-L-A-N-G

The user steps in only at Agree and Guard. Discussion can take several rounds, and a task that fails review goes back to the coder before it reaches the user.

## Functional requirements

P0 = required in v1, P1 = should be in v1, P2 = after v1.

| ID | Module | Requirement | Priority |
| --- | --- | --- | --- |
| F-01 | Project | Create a new project (empty folder + `git init`) or open an existing repo | P0 |
| F-02 | Project | Store `PROJECT.md` (stack, conventions, folder structure) and symlink it to `CLAUDE.md` and `AGENTS.md` | P0 |
| F-03 | Discuss | Chat with the Lead agent, with the CLI session staying connected across turns (resume session id) | P0 |
| F-04 | Discuss | The Lead sends structured questions, and the UI shows them as cards with choice options and free-text input | P0 |
| F-05 | Discuss | The user can press "enough, write the brief" at any time to end the Q&A session | P1 |
| F-06 | Agree | The Lead writes a brief: scope, features, stack, constraints, and out-of-scope items. The brief is shown as an editable document. | P0 |
| F-07 | Agree | Revise button (with a note for the Lead) and Approve button. An approved brief is locked and given a version number. | P0 |
| F-08 | List | The Lead splits the brief into milestones and tasks. Each task contains a goal, allowed files, reference files, acceptance criteria, a verify command, a role, and a complexity. | P0 |
| F-09 | List | Tasks marked `needs_split` are automatically re-split by the Lead, up to 2 levels | P1 |
| F-10 | List | Kanban board: edit, delete, add, reorder, change dependencies, and change the agent profile per task before approval | P0 |
| F-11 | Assign | The dispatcher picks up approved tasks whose dependencies are all done, and chooses a profile via routing rules | P0 |
| F-12 | Assign | Limit on the number of parallel runs per provider | P0 |
| F-13 | Assign | Fall back to a backup profile when a provider hits a limit, errors, or times out | P1 |
| F-14 | Navigate | Run the CLI headless, with logs streamed live to the task card | P0 |
| F-15 | Navigate | Git checkpoint commits before and after every run, so rollback is one click | P0 |
| F-16 | Navigate | One git worktree per task for tasks whose files do not overlap | P1 |
| F-17 | Navigate | Stop, retry, and resume buttons for every run | P0 |
| F-18 | Guard | The reviewer runs the verify command and writes `review.json`. On failure, findings are sent back to the coder (at most 2 rounds). | P0 |
| F-19 | Guard | Per-task diff view with a review summary, and approve-merge or reject buttons | P0 |
| F-20 | Guard | Post-merge integration step: run the whole test suite on the main branch | P1 |
| F-21 | Settings | CRUD for agent profiles: provider, model, effort, role prompt, permission mode, timeout | P0 |
| F-22 | Settings | Provider status page: which CLIs are installed, their versions, and login status | P0 |
| F-23 | History | Archive of all runs: prompt, output, duration, profile used, and result | P0 |
| F-24 | History | Usage statistics per provider (number of runs, duration, limit events) | P1 |
| F-25 | Notifications | Browser notification when a human gate is waiting for a decision or when the pipeline fails | P2 |

## Agent profiles, providers, and routing

**Provider** (which subscription/CLI is used) and **model** are two separate settings. One provider can offer several models. For example, Antigravity also offers non-Gemini models through its model flag, so it can serve as a cross-subscription backup.

**Agent profile fields**

| Field | Example | Notes |
| --- | --- | --- |
| `name` | `coder-small` | Unique profile name |
| `provider` | `codex` | One of `claude-code`, `codex`, `antigravity` |
| `model` | free text + suggestions | Not hardcoded, because the model list changes and depends on subscription tier |
| `effort` | `low` / `medium` / `high` | Translated to each CLI's flag where supported |
| `role_prompt` | file `prompts/coder.md` | Role instructions appended to every task brief |
| `permission_mode` | `workspace-write` | Permission limit: may only write inside the workspace |
| `timeout` / `idle_timeout` | 30 minutes / 3 minutes | The process is killed if it exceeds the limit |
| `max_parallel` | 2 | Limit on concurrent runs for this profile |

**Example routing rules** (the first matching rule wins)

```yaml
routing:
  - { role: lead,                        profile: lead }
  - { role: engineer, complexity: low,   profile: coder-small, fallback: coder-heavy }
  - { role: engineer, complexity: high,  profile: coder-heavy, fallback: lead }
  - { role: qa,                          profile: reviewer,    fallback: planner }
```

**Adapter per provider** (exact flags are verified against `--help` at implementation time)

| Provider | Headless command | Model selection | Notes |
| --- | --- | --- | --- |
| Claude Code | `claude -p --output-format stream-json` | `--model` | The Lead conversation continues via `--resume <session_id>` |
| Codex | `codex exec --json` | `-m`, `-c model_reasoning_effort=…` | Permissions via `--sandbox workspace-write` or `--full-auto` |
| Antigravity | `agy --output-format stream-json --mode accept-edits -p='<prompt>'` | `--model` | Works normally without a PTY (tested on v1.5.10). The prompt must be attached to the flag (`-p='...'`), because `-p` takes the next argument as the prompt. **Does not restrict writes outside the workspace**, so it must be wrapped in a sandbox (see CLI validation results). |

**Resume, session ID, and structured output** (tested)

| Provider | Session ID taken from | Resume | Schema-conforming output |
| --- | --- | --- | --- |
| Claude Code | `session_id` on every event | `--resume <id>` | `--json-schema '<json>'` → `structured_output` |
| Codex | `thread_id` in the `thread.started` event | `codex exec resume <id> --json` | `--output-schema file.json -o out.json` |
| Antigravity | `conversation_id` in the `result` event | `--conversation <id>` | `--json-schema file.json` → `result.structured_output` |

Every adapter must close stdin (`/dev/null`). Without that, Codex waits for input and hangs. Parsers ignore unknown events.

Design rule: use the strongest model for the Lead and the reviewer, and a lighter model for small coding tasks. The reviewer should preferably use a different provider from the coder on the same task (cross-model review).

## Agent output contract

All orchestrator decisions come from JSON files the agent writes to `.dalang/`, not from free text on stdout. Each file is validated with a Zod schema. If it is invalid, the agent is asked to redo it up to 2 times, with the validation error message included.

| Type | Written by | File | Main content |
| --- | --- | --- | --- |
| `questions` | Lead | `.dalang/discuss/round-N.json` | List of questions, answer options, and the reason for each question |
| `brief` | Lead | `.dalang/brief.v{n}.json` | Summary, features, stack, constraints, out of scope, assumptions |
| `plan` | Lead | `.dalang/plan.json` | Milestones and the task list (schema below) |
| `task_result` | Coder | `.dalang/tasks/{id}/result.json` | Status, changed files, notes, blockers |
| `review` | Reviewer | `.dalang/tasks/{id}/review.json` | `pass`/`fail`, verify command result, findings by severity |

**Task schema** (part of `plan`)

```json
{
  "id": "T-007",
  "title": "POST /attendance/scan endpoint",
  "milestone": "M2",
  "role": "engineer",
  "complexity": "low",
  "depends_on": ["T-003", "T-005"],
  "goal": "Record attendance from a barcode scan result",
  "files_allowed": ["src/attendance/**"],
  "files_reference": ["src/db/schema.ts", "PROJECT.md"],
  "acceptance_criteria": [
    "A valid barcode returns 201 and creates one attendance row",
    "A duplicate scan on the same day returns 409"
  ],
  "verify": "pnpm test src/attendance",
  "needs_split": false
}
```

**Review schema**

```json
{
  "task_id": "T-007",
  "status": "fail",
  "verify_exit_code": 1,
  "findings": [
    { "severity": "critical", "file": "src/attendance/scan.ts", "note": "Duplicate scan is not checked" }
  ]
}
```

## Non-functional requirements and security

| Area | Requirement |
| --- | --- |
| Network access | The server binds only to `127.0.0.1`. Access from outside the machine is disabled by default. |
| Credentials | DALANG stores no API keys or tokens. Authentication relies entirely on the user's official CLI logins. |
| Isolation | Agents may only write inside the project folder. Every CLI runs through a `bwrap` sandbox wrapper (project folder read-write, rest of the filesystem read-only, separate `/tmp`). P0 on Linux; macOS via `sandbox-exec` (P1). Docker container mode remains an option (P2). A restrictive prompt is an additional layer, not the only barrier. |
| Reliability | Pipeline state is saved to SQLite on every step transition. After a crash or restart, the pipeline resumes from the last completed step. |
| Timeouts | Each run has a total timeout and an idle timeout. A stuck process is killed and the task is marked failed with the reason. |
| Observability | The stdout/stderr of every run is saved to `.dalang/logs/` and can be replayed in the UI. |
| Responsiveness | Logs appear in the UI less than 1 second after the CLI writes them. |
| Platform | Linux and macOS (P0), Windows via ConPTY (P1). |
| Compliance | Only runs official CLI binaries. Does not extract OAuth tokens and does not call provider backends directly. |
| Installation | One command: `npx dalang` starts the server and opens the browser. |

## Architecture and technology stack

**Decision: one global DALANG instance for many projects**, not one instance per project. Subscription quota is shared across projects, so the per-provider parallel limit (F-12), limit fallback (F-13), and statistics (F-24) must see all projects at once. CLI login is also per user, not per project.

| Location | Contents |
| --- | --- |
| `~/.dalang/` (global) | SQLite: project index, sessions, agent profiles, routing, `provider_event`, statistics |
| `<repo>/.dalang/` (per project) | Brief, plan, tasks, logs, reviews, versioned in git. The project stays portable and can be opened without DALANG |

One server process serves all projects. Each run is wrapped in a sandbox bound to its own project folder. Per-project routing or profile overrides are stored in `<repo>/.dalang/config` and win over global settings.

The browser talks only to the local server. The server runs the official CLIs, and the CLIs are what write to the workspace. The stack choice follows the tool's core needs: subprocesses, streaming, and JSON validation.

| Layer | Choice (latest stable, 18 Nov 2026) | Reason |
| --- | --- | --- |
| Language | TypeScript 7.0 end to end | Task and agent output schemas are written once and shared by the UI and the server |
| Runtime | Node.js 26 LTS ("Lithium", 26.13) | Active LTS since 28 Oct 2026, supported until Apr 2029. Node 22 is already in maintenance (ends Apr 2027). Mature subprocess and streaming support. `node-pty` (1.1) is optional only (live terminal view), because all three CLIs run without a TTY |
| Server | Fastify 5.12 + @fastify/websocket 11 | Lightweight, suits long-running processes and log streaming |
| Frontend | React 19.3 + Vite 8.3 + shadcn/ui (CLI 4.23, Tailwind 4.3) + TanStack Query 5.108 | Chat, kanban, and diff viewer are quick to assemble. Vite 8 needs Node 20.19+ or 22.12+ |
| Database | SQLite via better-sqlite3 13 + Drizzle ORM 0.45 | A single file, no database server. Drizzle 1.0 is at release candidate (rc.5); stay on 0.45 until 1.0 is stable. Node's built-in `node:sqlite` works on 26 but has no stable Drizzle driver yet |
| Validation | Zod 4.6 | Agent output is validated before it is used for decisions |
| Queue | p-queue 10 (in-process) | Per-provider parallel limits without needing Redis |
| Git | simple-git 4.1 + `git worktree` | Checkpoint commits and per-task isolation |
| Distribution | pnpm 12 monorepo, released to npm | `npx dalang` starts the server and opens the browser |

Versions are the latest stable releases found on the npm registry and nodejs.org on 18 Nov 2026. The lockfile pins them at implementation time.

Verified on Node 26.13.1 (Linux x64, clean install): better-sqlite3 13.2 (in-memory insert and select), node-pty 1.1 (spawned a process and read its output), Fastify 5.12 with @fastify/websocket 11 (served a request on `127.0.0.1`), and Zod 4.6 (validated a schema). Drizzle 1.0 rc.5 with the built-in `node:sqlite` driver also worked (insert and select). Not verified: macOS and Windows builds, and the Vite 8 + React 19 + shadcn/ui front end (versions only checked against the registry; `@vitejs/plugin-react` 6.3 requires Vite 8).

Two findings that affect installation:

- npm now blocks dependency install scripts until they are approved (`npm install-scripts approve`). better-sqlite3 and node-pty both declare install scripts, so `npx dalang` must either ship an `allowScripts` approval or avoid native modules. better-sqlite3 13 bundles prebuilt binaries for Linux, macOS, and Windows, so no compiler should be needed once approved. `node-pty` stays optional.
- Open decision: Drizzle 0.45 (stable) with better-sqlite3 needs that native module, while Drizzle 1.0 (rc.5, not stable yet) works with the built-in `node:sqlite` and removes the native dependency. The PRD picks stable now and revisits when Drizzle 1.0 is released.

## CLI validation results (Nov 18, 2026)

Tested on Linux with Claude Code (logged in), Codex 0.169.0, and agy 1.5.10, all headless without a TTY.

| Test | Claude | Codex | agy |
| --- | --- | --- | --- |
| Headless with JSON return | ✅ | ✅ | ✅ (±3–17 s/turn) |
| Write files to `.dalang/` | ✅ | ✅ | ✅ |
| Resume across turns | ✅ | ✅ | ✅ |
| Output conforming to a JSON schema | ✅ | ✅ | ✅ |
| Refuses writes outside the project folder | ✅ | ✅ (but `/tmp` is writable) | ❌ |
| Refuses outside writes when wrapped in `bwrap` | not tested | not tested | ✅ |
| Usage/limits readable before a run | ✅ `claude -p "/usage"` (text: 5-hour session and weekly % + reset time) | ✅ JSON-RPC `account/rateLimits/read` to `codex app-server` over stdio (`usedPercent`, `windowDurationMins`, `resetsAt`, `rateLimitReachedType`, `planType`) | ✅ `agy -p="/usage"` (text table: remaining 5-hour and weekly % per model group + reset time) |
| Usage/limits readable during a run | ✅ `rate_limit_event` in the stream | ⚠️ only in the session file `~/.codex/sessions/**/*.jsonl` | ❌ not in the stream |

Implementation notes:

- Tested `bwrap` command: `bwrap --ro-bind / / --dev /dev --proc /proc --tmpfs /tmp --bind $PROJECT $PROJECT --bind $HOME/.gemini $HOME/.gemini --chdir $PROJECT <cli> ...`. Writes outside are denied, writes inside the project still work. Reading other files stays open (e.g. `~/.ssh`); to close that, use an explicit list of binds.
- Claude: `--bare` is not used because it skips the keychain login. Use `--setting-sources project --strict-mcp-config --disable-slash-commands` (context cache drops from about 121k to about 28k tokens).
- The agy user settings (`~/.gemini/antigravity-cli/settings.json`) contain `allowNonWorkspaceAccess: true`; overriding it via `--settings` did not change the behavior.
- The agy model list comes from `agy models` (usable for model suggestions in agent profiles).
- Not yet tested: behavior when a limit is actually hit (error message and exit code in all three CLIs), agy interactive questions (`ask_question`) in headless mode, prompt-injection attacks on the restrictive prompt, and `bwrap` with Claude and Codex.

## Data model

SQLite stores state and indexes, while the full content of artifacts (brief, plan, logs, review) stays as files in `.dalang/` so it is versioned in git.

| Entity | Main fields | Relations |
| --- | --- | --- |
| `project` | id, name, path, main branch, created | has many `session`, `task` |
| `session` | id, project\_id, phase (discuss/agree/list/run), cli\_session\_id | has many `message` |
| `message` | id, session\_id, role (user/lead), type (text/questions/brief), content, time | none |
| `brief` | id, project\_id, version, status (draft/approved), file path | one approved `brief` → one `plan` |
| `plan` | id, brief\_id, version, file path | has many `task` |
| `task` | id, plan\_id, title, role, complexity, status, profile\_override, review\_rounds | `task_dependency`, many `run` |
| `task_dependency` | task\_id, depends\_on\_id | none |
| `run` | id, task\_id, profile\_id, provider, model, started, finished, exit\_code, failure\_reason, commit\_before, commit\_after, log path | one `review` (for coder runs) |
| `review` | id, run\_id, status, file path | none |
| `agent_profile` | id, name, provider, model, effort, role\_prompt, permission\_mode, timeout, max\_parallel | used by `routing_rule` and `run` |
| `routing_rule` | id, order, role, complexity, profile\_id, fallback\_profile\_id | none |
| `provider_event` | id, provider, type (rate\_limit/error/login\_expired), time | for statistics and fallback |

## Phased release plan

Each phase must be useful on its own before the next one starts.

| Phase | Scope | Done when |
| --- | --- | --- |
| v0.1 Rembuk | Project, Lead chat (Discuss), brief (Agree), plan generation and kanban (List), provider status page. No execution yet. | One goal yields a valid brief and plan that pass the schema, for 3 sample projects |
| v0.2 Jalan | Sequential execution, one task at a time, adapters for all three CLIs, live logs, checkpoint commits, stop/retry | A small CRUD application is finished end to end without opening a CLI manually |
| v0.3 Kawal | Reviewer and fix loop, diff view, approve merge, integration tests, agent profiles and routing in the UI | ≥ 70% of tasks pass review within at most 2 rounds across 5 test projects |
| v0.4 Paralel | Worktree per task, dependency graph, per-provider parallel limits, quota fallback, usage statistics | Two independent tasks run at the same time without conflict; a quota limit automatically reroutes to a backup profile |
| v1.0 | Polish, Windows support, documentation, npm release | Used by the author to build 10 real projects |

## Risks, mitigations, and open questions

| Risk | Impact | Mitigation |
| --- | --- | --- |
| Poor task breakdown by the Lead (too large, vague criteria) | The coder drifts, review keeps failing | Strict task schema, the `needs_split` rule, and good plan examples in the Lead prompt |
| CLI flags or output format change on update | The adapter breaks | Adapters are split per provider, CLI versions are checked at startup, and each adapter has a smoke test |
| ~~`agy` produces no output without a TTY~~ | Not reproduced on agy 1.5.10 | Keep the idle timeout, and the per-adapter smoke test |
| `agy` writes outside the project folder (tested, even with `--sandbox` and `--settings`) | Damage to files outside the repo that does not show in `git diff` | `bwrap` wrapper on all adapters (tested to hold), plus a restrictive prompt |
| Agent changes files outside its scope | Damage to code or system | `files_allowed` checked against the diff after a run, checkpoint commits, `bwrap` sandbox, workspace-write permission mode. Note: Codex `workspace-write` can still write to `/tmp`. |
| Limit-reading formats differ per CLI and can change (`/usage` in Claude and agy is text, Codex goes through the experimental `app-server`) | Proactive quota reading (F-13) breaks when a CLI updates | One `getUsage()` adapter per provider that returns a uniform shape `{window, usedPercent, resetsAt}`, with a smoke test. If reading fails, treat usage as unknown and fall back to reactive detection from error text/exit code |
| Quota limit runs out mid-pipeline | The pipeline stops | Detect limit messages, fall back to a backup profile, or pause and resume automatically |
| Merge conflicts when tasks run in parallel | The merge fails | Parallel only for tasks whose files do not overlap; conflicts go to an integration task |
| Context out of sync between agents | Inconsistent code style and conventions | One shared `PROJECT.md`, a brief per task, and the reviewer checks conventions |

**Open questions**

- [ ] Can the Lead edit `PROJECT.md` itself, or must changes go through user approval?
- [ ] What is the default limit of review rounds before a task goes back to the user: 2 or 3?
- [ ] Does testing need a separate QA agent, or is it enough for the reviewer to run the `verify` command?
- [x] Is DALANG released as open source? Yes, under the MIT license (see `LICENSE`).
- [ ] Format of notifications for human gates: browser notifications only, or also Telegram/WhatsApp?
