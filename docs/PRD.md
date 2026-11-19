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

DALANG does not pass these schema flags. They constrain the final chat message, not the file the agent writes, and real contracts break them: Claude rejects Zod's draft 2020-12 `$schema`, and Codex's strict mode requires every property to be listed as required, which fails any optional or defaulted field. The contract is enforced by Zod on the written file, with up to two retries.

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
| Network access | The server binds only to `127.0.0.1`. Access from outside the machine is disabled by default. Requests whose `Host` or `Origin` is not a loopback name are refused (DNS rebinding guard). |
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
| Frontend | React 19.3 + Vite 8.3 + shadcn/ui (Base UI primitives, Tailwind 4.3) + TanStack Query 5.108 | Chat, kanban, and dialogs are quick to assemble. The shadcn components are copied into `packages/web/src/components/ui` and restyled to `docs/DESIGN.md` (its palette, 4/6/8px radii, 44px targets, no blur or entrance animation); no icon library or web font is added. Vite 8 needs Node 20.19+ or 22.12+ |
| Database | SQLite via better-sqlite3 13 + Drizzle ORM 0.45 | A single file, no database server. Drizzle 1.0 is at release candidate (rc.5); stay on 0.45 until 1.0 is stable. Node's built-in `node:sqlite` works on 26 but has no stable Drizzle driver yet |
| Validation | Zod 4.6 | Agent output is validated before it is used for decisions |
| Queue | p-queue 10 (in-process) | Per-provider parallel limits without needing Redis |
| Git | simple-git 4.1 + `git worktree` | Checkpoint commits and per-task isolation |
| Distribution | pnpm 12 monorepo, released to npm | `npx dalang` starts the server and opens the browser |

Versions are the latest stable releases found on the npm registry and nodejs.org on 18 Nov 2026. The lockfile pins them at implementation time.

Verified on Node 26.13.1 (Linux x64, clean install): better-sqlite3 13.2 (in-memory insert and select), node-pty 1.1 (spawned a process and read its output), Fastify 5.12 with @fastify/websocket 11 (served a request on `127.0.0.1`), and Zod 4.6 (validated a schema). Drizzle 1.0 rc.5 with the built-in `node:sqlite` driver also worked (insert and select). The front end also built: Vite 8.3 + React 19.3 + `@vitejs/plugin-react` 6.3 + TypeScript 7.0 + Tailwind 4.3 + TanStack Query 5.108 + a shadcn/ui button (`shadcn init` 4.23), with `tsc --noEmit` and `vite build` passing. TypeScript 7 removed `baseUrl` (use `paths` with `./` prefixes) and needs `"vite/client"` in `types` for CSS imports. `npm audit` reports a high-severity picomatch ReDoS reached through the shadcn CLI's dev dependencies; it does not ship in the built bundle. The built UI was also opened in a browser (Playwright, `vite preview`): React mounted, TanStack Query resolved its query, and the shadcn button rendered with Tailwind styling; the only console error was a missing `favicon.ico` in the test page. Not verified: macOS and Windows builds.

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
| Output conforming to a JSON schema (simple all-required schema; not used by DALANG) | ✅ | ✅ | ✅ |
| Refuses writes outside the project folder | ✅ | ✅ (but `/tmp` is writable) | ❌ |
| Refuses outside writes when wrapped in `bwrap` (run through the DALANG adapters) | ✅ | ✅ | ✅ |
| Usage/limits readable before a run | ✅ `claude -p "/usage"` (text: 5-hour session and weekly % + reset time) | ✅ JSON-RPC `account/rateLimits/read` to `codex app-server` over stdio (`usedPercent`, `windowDurationMins`, `resetsAt`, `rateLimitReachedType`, `planType`) | ✅ `agy -p="/usage"` (text table: remaining 5-hour and weekly % per model group + reset time) |
| Usage/limits readable during a run | ✅ `rate_limit_event` in the stream | ⚠️ only in the session file `~/.codex/sessions/**/*.jsonl` | ❌ not in the stream |

Implementation notes:

- Tested `bwrap` command: `bwrap --ro-bind / / --dev /dev --proc /proc --tmpfs /tmp --bind $PROJECT $PROJECT --bind $HOME/.gemini $HOME/.gemini --chdir $PROJECT <cli> ...`. Writes outside are denied, writes inside the project still work. Reading other files stays open (only the credential files and folders listed under Decisions are masked), and so does the network; closing those needs an explicit list of read-only binds and a filtering proxy, which is not done in v0.1.
- Claude: `--bare` is not used because it skips the keychain login. Use `--setting-sources project --strict-mcp-config --disable-slash-commands` (context cache drops from about 121k to about 28k tokens).
- The agy user settings (`~/.gemini/antigravity-cli/settings.json`) contain `allowNonWorkspaceAccess: true`; overriding it via `--settings` did not change the behavior.
- The agy model list comes from `agy models`, and the Codex list from `codex debug models` (JSON, `visibility: list`). Claude uses the aliases `sonnet`, `opus`, and `haiku`.
- Codex's own sandbox cannot start inside `bwrap` ("No permissions to create a new namespace"), so a Codex run inside `bwrap` silently fails to write files. The adapter therefore sets `sandbox_mode="danger-full-access"` when `bwrap` is the boundary and `workspace-write` otherwise. `codex exec resume` has no `--sandbox` flag, so the mode is passed with `-c` on both paths.
- The spawn environment keeps the user's `PATH` first, so CLI shebangs (`env node`) resolve to the Node the user installed. `bwrap` also runs with `--die-with-parent`, `--new-session`, `--unshare-pid`, and `--unshare-ipc`, hides `/run/user` and `/run/docker.sock`, and keeps the network open because the CLIs need it. agy is the exception for `/run/user`: it reads its login from the desktop keyring over the session bus, so hiding that folder breaks authentication, and a run can still reach the user session bus.
- Not yet tested: behavior when a limit is actually hit (error message and exit code in all three CLIs), agy interactive questions (`ask_question`) in headless mode, prompt-injection attacks on the restrictive prompt, and macOS (no `bwrap`, so agent writes are not confined there).

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
| `agent_profile` | id, name, provider, model, effort, role\_prompt, permission\_mode, timeout, max\_parallel, fallback\_profile\_id | used by `routing_rule` and `run` |
| `routing_rule` | id, order, role, complexity, profile\_id, fallback\_profile\_id | none |
| `provider_event` | id, provider, type (rate\_limit/error/login\_expired), time | for statistics and fallback |

## Phased release plan

Each phase must be useful on its own before the next one starts.

| Phase | Scope | Done when | Status |
| --- | --- | --- | --- |
| v0.1 Rembuk | Project, Lead chat (Discuss), brief (Agree), plan generation and kanban (List), provider status page. No execution yet. | One goal yields a valid brief and plan that pass the schema, for 3 sample projects | Met on 18 Nov 2026 (3 of 3 projects, real models) |
| v0.2 Jalan | Sequential execution, one task at a time, adapters for all three CLIs, live logs, checkpoint commits, stop/retry | A small CRUD application is finished end to end without opening a CLI manually | Met on 18 Nov 2026 (Notes API, 6 tasks, real models) |
| v0.3 Kawal | Reviewer and fix loop, diff view, approve merge, integration tests, agent profiles and routing in the UI | ≥ 70% of tasks pass review within at most 2 rounds across 5 test projects | Met on 19 Nov 2026 (5 real-model projects, 15 of 15 tasks passed review, 13 on round 1 and 2 on round 2) |
| v0.4 Paralel | Worktree per task, dependency graph, per-provider parallel limits, quota fallback, usage statistics | Two independent tasks run at the same time without conflict; a quota limit automatically reroutes to a backup profile | Parallel half met on 19 Nov 2026 (one real-model run, 2 independent tasks ran at the same time and merged cleanly); quota reroute verified with scripted tests only |
| v0.5 | Polish and distribution: npm package with `npx dalang` and `dalang doctor`, several accounts per provider, token and cost statistics, replay tests, macOS sandbox, push and pull request after merge, documentation | `npx dalang` starts on a clean Linux and macOS machine, and replay scenarios cover quota reroute, review fix round, and parallel merge | Planned |
| v0.6 | Agent delegation: a running agent splits its own task into subtasks on other profiles through a DALANG MCP server | One task is split by its agent into at least two subtasks on two providers, and all of them pass review and merge | Planned |
| v0.7 | Session protocols (Claude Agent SDK, `codex app-server`, ACP), steering a running task, context handoff on fallback, native Windows | A fallback mid-task continues from the handoff instead of starting over, on all three providers | Planned |
| v0.8 | Scheduled and webhook-triggered runs, outside agents over MCP | A scheduled run and a run started from a terminal agent both finish without opening the UI | Planned |

See [Roadmap after v0.4](#roadmap-after-v04) for the detail and the research behind it.

### v0.1 implementation notes

Decisions made while building v0.1 (Rembuk):

- Agent profiles are seeded and read-only. Creating and editing them, and the routing UI, were left for v0.3 (done). The kanban still lets a task pick a seeded profile (F-10).
- Plan task roles are `engineer` or `qa`, matching the routing rules. Milestones, task ids, and dependencies are validated (unknown references, duplicates, and cycles are sent back to the agent like any other contract error).
- The Lead drafts a plan into `.dalang/tmp/` and DALANG writes `.dalang/plan.json` only after validation, so a failed run never overwrites the current plan. `.dalang/tmp/` is git-ignored.
- One Lead turn runs per project at a time. A second request while a turn is running is refused.
- A task's `needs_split` flag and its kanban column always agree. A plan cannot be approved while a task still needs a split, and an approved plan cannot be regenerated.
- `PROJECT.md` is symlinked to `CLAUDE.md` and `AGENTS.md` only when those names are free. An existing regular file is never replaced.
- DALANG runs outside the sandbox, so every read, write, or delete of a file the agent can reach (`.dalang/` artifacts, `PROJECT.md`, logs) refuses symlinks and folders that resolve outside the project, reads through a single descriptor opened with `O_NOFOLLOW`, writes through a temp file and rename after re-checking the folder, deletes only through a folder verified to be inside the project, and never echoes parser errors back into an agent prompt. Task ids are limited to letters, digits, `-`, and `_` because they become file names.
- The UI uses shadcn/ui components copied into `packages/web/src/components/ui` and restyled to `docs/DESIGN.md`.
- "Enough, write the brief" (F-05) is available at any time, including before the first message.
- The v0.1 completion criterion (a valid brief and plan from one goal, for 3 sample projects) was met on 18 Nov 2026 with real models, through the HTTP API and the real sandbox: one project per Lead provider, one run each, a Discuss round, a second round with scripted answers, then brief, approval, and plan.

  | Project | Lead | Time to approved plan input | Result |
  | --- | --- | --- | --- |
  | Barcode attendance app with WhatsApp alerts | Claude Code | 117 s | 4 milestones, 14 tasks, 18 dependencies |
  | JSON to PDF invoice CLI | Codex | 361 s | 4 milestones, 10 tasks, 13 dependencies |
  | Local bookmark manager | Antigravity | 136 s | 4 milestones, 5 tasks, 4 dependencies |

  Every brief and plan passed the Zod contract on the first attempt, every task had its own verify command, and the dependency graphs were acyclic. This is one run per provider, so it shows the flow works, not how often it works. The success metric of 15 minutes from goal to plan was met (all three under 6.5 minutes, including scripted answers). The first real run found two bugs that scripted agents could not: Claude rejected the draft 2020-12 `$schema` and Codex rejected schemas with optional fields. Both came from passing the CLIs' own schema flags, which constrain the final chat message rather than the file, so DALANG no longer passes them and relies on its own Zod validation.

### v0.2 implementation notes

Decisions made while building v0.2 (Jalan):

- Execution runs one task per project at a time, in dependency order. Starting a run reserves the project before any await, so two quick requests cannot both start.
- Every run must write `.dalang/tasks/{id}/result.json` (the `task_result` contract), validated with Zod, with one repair turn when it is missing or invalid. A task the agent reports as `blocked` or `failed` is a real outcome: the task is marked failed and no other provider is tried.
- Fallback to the backup profile and the per-profile parallel limit were pulled forward from v0.4. Fallback fires only on provider-level failures (rate limit, expired login, timeout, or a CLI error), never on an agent-reported failure or an invalid result.
- Routing uses the first matching rule in order; a rule with no complexity matches any complexity.
- Antigravity in the sandbox needs the keyring opt-in (see Decisions). The setting lives in a new global `settings` table (schema v3), and the routing preview shows the profile a task will really use.
- A `read-only` profile still runs with write access, because the run has to write `result.json`. Reviews honor `read-only` since v0.3.
- Checkpoints commit everything before and after each run (`git add -A`). A new project gets a root `.gitignore` (dependencies, `.env`, build output) so a checkpoint never commits them.
- DALANG runs git outside the sandbox on a repo the agent can edit. A clean filter in `.git/config` would run on the host at `git add` (confirmed by a test), so DALANG reads every config scope git will use (`git config --list --show-scope`, which includes worktree config and included files) and refuses to run git when the repo, worktree, or command scope defines `filter.*`, `include.path`, or `core.worktree`, when `extensions.worktreeConfig` is set, when `.git/config.worktree` exists, when `.git` is not a plain folder, or when the config cannot be read. System and global config stay allowed because Git LFS defines filters there. Hooks are disabled (`core.hooksPath=/dev/null`, `--no-verify`) and `.git/hooks` is read-only inside the sandbox.
- Rollback runs `git reset --hard` and is refused when the repo has commits after the last run that DALANG did not create, or uncommitted changes outside `.dalang/`. Runs after the rolled-back one are marked rolled back too.
- Without `bwrap`, execution needs an explicit opt-in per request. `sandbox-exec` for macOS is not built yet.
- `files_allowed` violations are recorded as warnings on the run. Since v0.3 they also fail the review (see the v0.3 notes).
- Live logs show the CLI's raw event lines (JSON for Claude, Codex, and agy). `node-pty` is not used.
- Verified with real models on 18 Nov 2026 through the HTTP API and the real sandbox: a Lead plan for a tiny Node module (greeter function plus a `node:test` file), trimmed to 3 tasks, then executed in order on three providers (T-001 Codex 45 s, T-002 Claude Code 9 s, T-003 Antigravity 36 s). All three runs completed on the first attempt with no fallback and no scope warnings, each wrote a valid `result.json`, the repo ended with a before checkpoint and one commit per task, a clean working tree, and `node --test` passing 2 of 2.
  The v0.2 criterion was then run at the intended size: a Notes REST API (Node.js, `node:http`, in memory, with tests and a README) planned by the Lead as 6 tasks and executed through default routing without opening a CLI by hand. Result: all 6 tasks done in about 9.5 minutes including planning, 27 of 27 tests passing, and a live check of every endpoint (201, 200, 400 for a missing title and for invalid JSON, 404 for an unknown or deleted note). Task T-006 ran on Codex, which hung for 3 minutes on "Selected model is at capacity", hit the idle timeout, and was completed by the backup profile on Claude Code: fallback was exercised by a real provider outage, not a script. One run per scenario, so this shows the flow works, not how often. The v0.2 criterion is met.

### v0.3 implementation notes

Decisions made while building v0.3 (Kawal):

- Each task runs on its own branch `dalang/{id}`. After the coder finishes, DALANG runs the task's `verify` command in the sandbox, then a reviewer reads the diff and the verify output. A failed review sends the findings back to the coder as a fix round, up to `maxReviewRounds` per profile (default 2, at most 3). A task that passes waits in `awaiting_merge` until you approve it in Guard (gate 2). Dependent tasks unlock only after the merge.
- Reviews always run read-only, whatever the profile says. DALANG writes `review.json` itself from the validated reply. A verify exit code other than 0 forces `fail`, and so does any edit outside `files_allowed` (`.dalang/` excluded). Both are enforced by DALANG, not left to the reviewer.
- The reviewer prefers a different provider than the coder. If the configured reviewer is blocked (for example agy with the keyring switch off), a usable backup takes over with a visible note.
- A merge is refused when the working tree is dirty, aborts and leaves the repo clean on conflict, and runs with hooks disabled. After a merge DALANG runs the integration command (set per project or detected from `package.json`) on the main branch, in the sandbox. Without `bwrap` the integration run is skipped unless you confirm unconfined execution.
- Rejecting a task deletes its unmerged branch, keeps its logs, and either sends it back to the queue with your note or marks it failed.
- Profiles and routing rules are editable in the UI. A profile cannot be deleted while a routing rule (as primary or fallback), a task, or a run refers to it. The agy keyring switch now sits in the profile editor as well as on the Providers page.
- Verified with real models on 18 Nov 2026 and 19 Nov 2026, through the HTTP API and the real sandbox, with agy off. A first project (greeter, 3 tasks) passed on round 1. The v0.3 criterion was then run at the intended size: five projects, planned by Claude Code with at most 3 tasks each, every task executed, verified, reviewed, diffed, and merged by script with no override.

  | Project | Tasks | Review rounds per task | Tests after merge |
  | --- | --- | --- | --- |
  | slugify module | 3 | 1, 1, 1 | 11 of 11 |
  | stack CLI | 3 | 1, 1, 1 | 28 of 28 |
  | CSV parse and sum | 3 | 2, 1, 1 | 22 of 22 |
  | todo HTTP API | 3 | 2, 1, 1 | 29 of 29 |
  | Roman numerals | 3 | 1, 1, 1 | 6 of 6 |

  All 15 tasks passed review within 2 rounds (13 on round 1, 2 on round 2), against a target of 70%. In the two round-2 cases Codex failed the first review, the coder fixed the findings, and the second review passed, so the fix loop ran for real. Reviews came from Claude Code and Codex, always a different provider from the coder when one was usable. Fifteen tasks in five small projects shows the flow works, not how often it works on larger code. The reviewer (agy) was not tried, because the keyring switch stays off by default.


### v0.4 implementation notes

- Each task runs in its own git worktree at `<data dir>/worktrees/<projectId>/<taskId>` on branch `dalang/{taskId}`. Tasks whose `files_allowed` globs overlap (an empty list overlaps everything) never run at the same time. DALANG checks every worktree before running git on it: `.git` must be a plain file pointing inside the main repo's `.git/worktrees/`, with no `config.worktree`, and the same config denylist as the main repo applies. The sandbox mounts that `.git` file read-only.
- A global in-process limiter enforces each profile's `max_parallel` per provider across all projects, for coder and reviewer turns alike.
- Quota fallback is proactive (a cached usage reading shows 0% remaining, or a recent rate-limit or login event puts the provider in cooldown) and reactive (provider failure mid-run). A cached exhausted reading expires at its reset time, or after 15 minutes when no reset time is known, so a provider is not skipped forever.
- Usage statistics (F-24) count runs, durations, and limit events per provider and per project. Events carry no project id, so the per-project filter applies to runs only.
- Trial on 19 Nov 2026, real Claude Code, through the HTTP API: a plan of two independent tasks (`upper.js`, `rev.js`) ran at the same time (two tasks active together), both passed review on round 1, both merged with `--no-ff`, the worktrees were removed, main stayed clean, and the 6 tests in the result passed. This is one run. The quota reroute with a real provider limit was not triggered; it is covered by scripted tests only.

## Roadmap after v0.4

### Research: T3 Code (19 Nov 2026)

[T3 Code](https://github.com/pingdotgg/t3code) (MIT, about 65k stars) is the closest open project: one local server that drives Claude Code, Codex, Antigravity and about eight other agent CLIs from a desktop, web, or phone client. Its docs (`docs/user`, `docs/internals`, `docs/orchestration-v2`) were read for this comparison (user guides, the orchestration-v2 design, provider and testing notes). What it does that DALANG does not yet do:

| Area | T3 Code | DALANG today |
| --- | --- | --- |
| Driving the agent | Long-lived sessions: Claude Agent SDK, `codex app-server` (JSON-RPC), ACP for other agents. Each adapter reports capabilities (resume, steer, fork, subagents, rollback); missing ones fall back by policy, not by provider-name checks | One process per turn (`claude -p`, `codex exec`, `agy`), output parsed from event lines |
| Subtasks | An agent calls `delegate_task` on T3's own MCP server (`127.0.0.1:<port>/mcp`, bearer token scoped to one provider session, expires when idle or when the session ends). The child runs on any provider and model, in the parent checkout or its own worktree, gets only the task prompt (no parent history), and its result returns to the parent. `task_status`, `task_cancel`, `wait` and `async` modes. Stopping a parent stops its children. Native subagents (Claude Task, Antigravity batches, Cursor) are shown read-only | Only the Lead splits work, at plan time. A running coder cannot split its task |
| Switching provider | A portable handoff: a budgeted selection of the conversation (default 16k tokens, first request plus recent turns plus command results, never an agent-written summary), with a tool to read what was left out | Fallback restarts the task from its brief |
| Accounts | Several instances of one provider, each with its own `CLAUDE_CONFIG_DIR` or `CODEX_HOME`, so a second account can take over | One account per provider |
| Usage | Tokens, cache hits, and estimated cost per model, read from each CLI's local history | Runs, durations, and limit events |
| Checkpoints | Hidden git refs, no commits on the user's branch | Commits before and after each run |
| Model list | Claude: a bundled model manifest (refreshed from their repo) merged with the models Claude Code reports through the Agent SDK, each with its effort levels. Codex: `model/list` on `codex app-server`. Antigravity: the models its ACP session advertises, with thinking levels per model | Since 19 Nov 2026, Claude's list comes from the same source (the `initialize` control request, one process, no API call). Codex uses `codex debug models`, agy uses `agy models`. Per-model effort levels (including `max`) are not used yet |
| Health checks | Must not start hooks, MCP servers, or a login as a side effect | Model discovery runs Claude with `--bare`, which is meant to skip hooks and MCP; not yet verified |
| Tests | Replay transcripts replace only the provider process; orchestrator, adapter, normalizer, and database run for real. Browser scenarios on a real server with a replay agent, free and repeatable | Unit tests with fake runners; real-model trials by hand |
| Distribution | `npx t3@latest`, install script, `t3 doctor`, `t3 update`, `t3 service install`, desktop and phone apps | Run from source |
| Git hosting | Push, open a pull request, watch checks | Local merge only |
| Other | Scheduled and webhook runs, outside agents over MCP with read-only to full-access levels, remote access, phone app, per-project provider switch | None of these |

What DALANG has that T3 Code does not: a brief agreed before any code, a plan with milestones and dependencies, routing by role and complexity, a reviewer on a different provider with a fix loop, `files_allowed` enforced on the diff, and a merge gate. T3 Code is a control plane for chat threads; DALANG stays a pipeline from goal to merged code. The items below borrow T3 Code's mechanisms where they make that pipeline stronger.

### v0.5: polish and distribution

- **npm package.** Publish `dalang`; `npx dalang` starts the server and opens the browser. `dalang doctor` checks Node, git, `bwrap` (or `sandbox-exec`), each CLI's install and login, and the data directory, and prints a fix for each failure.
- **Several accounts per provider.** A profile gets an optional config directory, passed as `CLAUDE_CONFIG_DIR`, `CODEX_HOME`, or the agy profile directory, and mounted writable in the sandbox. A fallback profile can then be the same provider on a second account. Usage readings and cooldowns are kept per account, not per provider.
- **Token and cost statistics.** Read token counts from the events DALANG already captures (Claude's `result` event carries usage and cost; Codex and agy are read where their events carry token counts; to be checked per CLI) and show tokens per model, cache hits, and estimated cost next to the existing run statistics. The estimate is labelled as API-equivalent, not the subscription bill.
- **Replay tests.** Record real CLI event streams and the files a run wrote into transcripts, and add a replay runner that replaces only the process. Scenarios: quota reroute to a backup profile (the open half of the v0.4 criterion), a failed review followed by a fix round, and two parallel tasks merging. Add one browser scenario on a real server with the replay runner.
- **Side-effect-free health checks.** Verify that `--bare` stops hooks and MCP servers during Claude model discovery, cache the result until "Refresh CLI status", and document the same rule for every adapter.
- **Model details from the CLIs.** The model list becomes a list of objects instead of plain ids, still read from the CLIs at startup and on Refresh CLI status, with nothing hardcoded:
  - Claude's `initialize` reply gives, per model, the accepted value, the resolved versioned id, a display name, a description (with price), `supportedEffortLevels`, and flags for fast mode and thinking. Variants such as `claude-fable-5-2[1m]` (1M context) are shown as an option of their model, not as a separate model.
  - Codex's `debug models` gives a display name, a description, `default_reasoning_level`, and `supported_reasoning_levels` per model.
  - Antigravity's `agy models` gives a display name per id; the level stays in the id, as since v0.4.
  - The profile editor shows display names, offers only the effort levels the chosen model has (including `max`, which DALANG does not accept yet), and preselects the model's default level. A saved model the CLI no longer lists is shown as unavailable, not silently dropped.
- **Checkpoints.** Evaluate hidden refs (`refs/dalang/...`) in place of checkpoint commits on the user's branch, keeping rollback working. Open question: whether reviewers and the merge still need the commits.
- **Push and pull request.** Optional per project: after the merge gate, push the branch and open a pull request with `gh`, using the task brief and review as its body.
- **macOS sandbox** with `sandbox-exec`, held to the same tests as `bwrap`. Windows runs through WSL in v0.5 and is documented as such.
- **Documentation:** install, providers, sandbox, and a troubleshooting page.

### v0.6: agent delegation

- DALANG serves an MCP endpoint on loopback. Each run gets a bearer token scoped to that run, which expires when the run ends; the token never enters logs.
- Tools: `delegate_task` (prompt, optional profile or provider and model, `files_allowed` that must be a subset of the parent's), `task_status`, `task_cancel`, with `wait` and `async` modes.
- A subtask is a real DALANG task: its own worktree from the parent branch, the same verify and review, and a result merged back into the parent branch, not into main. The parent's own review sees the combined diff.
- Limits: depth 1 (a subtask cannot delegate), a cap on subtasks per task, subtasks count against the provider limiter, and stopping the parent stops its subtasks.
- Native subagents (Claude's Task tool, Antigravity batches) are shown read-only in the run log.

### v0.7: session protocols and handoff

- Adapters move to the session protocols (Claude Agent SDK, `codex app-server`, ACP where agy supports it) behind a capability shape, keeping the one-shot CLI path as a fallback for any capability a provider lacks.
- Steer a running task with a message, and interrupt without losing the session.
- Context handoff on fallback: the next provider gets the brief plus a budgeted selection of the previous run (its requests, command results, and partial diff) instead of starting over.
- Native Windows execution, with a sandbox that meets the same tests.

### v0.8: automation

- Scheduled and webhook-triggered runs (for example a nightly dependency update task), with signature checks on webhooks.
- Outside agents over MCP: Claude Code or Codex in a terminal can read projects and start tasks, at read-only or full-access level, loopback only.

### Not planned

Remote access, relays, and phone apps. They conflict with DALANG's loopback-only security model (Host and Origin checks, no auth layer). Revisit only with a real authentication design.

## Risks, mitigations, and decisions

| Risk | Impact | Mitigation |
| --- | --- | --- |
| Poor task breakdown by the Lead (too large, vague criteria) | The coder drifts, review keeps failing | Strict task schema, the `needs_split` rule, and good plan examples in the Lead prompt |
| CLI flags or output format change on update | The adapter breaks | Adapters are split per provider, CLI versions are checked at startup, and each adapter has a smoke test |
| ~~`agy` produces no output without a TTY~~ | Not reproduced on agy 1.5.10 | Keep the idle timeout, and the per-adapter smoke test |
| `agy` writes outside the project folder (tested, even with `--sandbox` and `--settings`) | Damage to files outside the repo that does not show in `git diff` | `bwrap` wrapper on all adapters (tested to hold), plus a restrictive prompt |
| Agent changes files outside its scope | Damage to code or system | `files_allowed` checked against the diff after a run, checkpoint commits, `bwrap` sandbox, workspace-write permission mode. Note: Codex `workspace-write` can still write to `/tmp`. |
| A run can modify the provider's own state folder (`~/.claude`, `~/.codex`, `~/.gemini`), including hooks and settings that later interactive sessions load | Persistent change to the user's own CLI setup | Open in v0.1: the folders must stay writable for token refresh and session resume. Claude runs ignore user-level settings (`--setting-sources project`). Planned for v0.2: give each run a scratch copy of the state folder and copy back only session files. |
| Limit-reading formats differ per CLI and can change (`/usage` in Claude and agy is text, Codex goes through the experimental `app-server`) | Proactive quota reading (F-13) breaks when a CLI updates | One `getUsage()` adapter per provider that returns a uniform shape `{window, usedPercent, resetsAt}`, with a smoke test. If reading fails, treat usage as unknown and fall back to reactive detection from error text/exit code |
| Quota limit runs out mid-pipeline | The pipeline stops | Detect limit messages, fall back to a backup profile, or pause and resume automatically |
| Merge conflicts when tasks run in parallel | The merge fails | Parallel only for tasks whose files do not overlap; conflicts go to an integration task |
| Context out of sync between agents | Inconsistent code style and conventions | One shared `PROJECT.md`, a brief per task, and the reviewer checks conventions |

**Decisions** (made 18 Nov 2026; revisit if a reason appears)

| Question | Decision | Why |
| --- | --- | --- |
| Can the Lead edit `PROJECT.md` itself? | No. The Lead writes proposed changes to `.dalang/PROJECT.proposed.md`, and the user approves a diff before it replaces `PROJECT.md`. | Every agent reads `PROJECT.md` as instructions, so an unreviewed edit would steer all later runs. |
| Default review rounds before a task returns to the user | 2, configurable per profile up to 3. | Matches the success metric (pass within 2 rounds). A third round rarely fixes what two did not. |
| Separate QA agent? | No. The reviewer runs the task's `verify` command; role `qa` routes to the reviewer profile. | One fewer role to configure, and cross-model review already gives a second opinion. |
| Open source? | Yes, MIT. | Already in `LICENSE`. |
| Gate notifications | Browser notifications only for v1. Telegram and WhatsApp are P2, after v1. | Local single-user tool; a chat integration would need credentials DALANG promises not to hold. |
| Sandbox read access and network | Open in v0.1, except `~/.ssh`, `~/.gnupg`, `~/.aws`, `~/.docker`, `~/.kube`, `~/.config/gcloud`, `~/.git-credentials`, and `~/.netrc`, which are masked (`~/.npmrc` stays visible for private-registry installs). Revisit with explicit binds and a filtering proxy in v0.4. | CLIs need the network, and full read confinement breaks normal repos (global git config, toolchains). Masking credential folders closes the likeliest theft target at no cost. |
| agy and the session bus (opt-in) | agy runs behind a filtered `xdg-dbus-proxy` that allows only the Secret Service (`org.freedesktop.secrets`), which is the whole desktop keyring, so an agy run can read every secret in it (a residual exposure, not a fix: agy cannot sign in without it); `/run/user` is hidden for every provider and the proxy socket is mounted as the bus. Running agy in the sandbox is an explicit opt-in, off by default (setting `antigravityKeyringAccess`, a switch on the Providers page). While it is off, a task routed to agy runs on its backup profile with a visible note, a task with no usable backup is blocked with a reason, and agy as a Lead is refused. Without `xdg-dbus-proxy` or a desktop session, an agy run in the sandbox is refused with an install hint. Since v0.3 the switch is also in the agent profile editor. | agy cannot sign in without the keyring, and the plain session bus can start units outside the sandbox. Checked: from inside the sandbox, `systemd-run --user` fails and a call to `org.freedesktop.systemd1` returns ServiceUnknown. |
| macOS and Windows | Execution refuses to start on a platform without a sandbox unless the user opts in for that request, and the UI shows a warning. `sandbox-exec` (P1) is not built yet. | macOS is a P0 platform, so blocking it now would make the tool unusable there. Execution is where unconfined writes become real damage. |
| UI components | shadcn/ui, copied into the repo and restyled to `docs/DESIGN.md`. | Matches the stack in this PRD. Owning the component code keeps the design direction intact. |

