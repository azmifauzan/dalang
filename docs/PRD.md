# PRD: DALANG

Nov 18, 2026 · @Fauzan · Updated through v0.13.6, Nov 25, 2026

## Summary

Dalang is a local terminal and browser workbench for Claude Code, Codex CLI, and Antigravity CLI. Every project opens into a chat. Auto chooses between answering, discussing, planning, and starting work; Ask answers repository questions, Quick runs one reviewed task, and Full coordinates larger changes through a brief and task plan. [Current user guide](USAGE.md)

All four modes save their conversation per project. Quick and Full run tasks in isolated Git worktrees with verification, automated review, and explicit merge approval. The dispatcher uses routing rules to select providers and models by role and task complexity.

Dalang runs on the user's machine and uses the official CLI logins. The name comes from the original workflow: **Discuss · Agree · List · Assign · Navigate · Guard**.

## Background and problem

Linux and WSL 2 use bubblewrap, macOS uses sandbox-exec, and native Windows can use Codex's MXC launcher after passing confinement checks on the host. When confinement is unavailable, execution requires explicit consent. Windows verification and integration commands use `cmd.exe`. Instruction pointers replace symlinks on Windows when symlink privileges are unavailable. [Platform setup](INSTALL.md)

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

In Full, the current UI labels are **Discuss**, **Brief**, **Plan**, **Work**, and **Review & merge**. The user approves the brief and plan, starts work, and decides which tasks to merge. Quick starts from a single task plan and uses the same execution and merge safeguards. Ask is read-only for project files and creates no tasks. The table below records the original workflow requirements and their priorities.

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
| F-13 | Assign | Fall back to another CLI, model, and effort (or a second account) when a provider hits a limit, errors, or times out; the fallback keeps the profile's role instructions | P1 |
| F-14 | Navigate | Run the CLI headless, with logs streamed live to the task card | P0 |
| F-15 | Navigate | Git checkpoint commits before and after every run, so rollback is one click | P0 |
| F-16 | Navigate | One git worktree per task for tasks whose files do not overlap | P1 |
| F-17 | Navigate | Stop, retry, and resume buttons for every run | P0 |
| F-18 | Guard | The reviewer runs the verify command and writes `review.json`. On failure, findings are sent back to the coder (at most 2 rounds). | P0 |
| F-19 | Guard | Per-task diff view with a review summary, and approve-merge or reject buttons | P0 |
| F-20 | Guard | Post-merge integration step: run the whole test suite on the main branch | P1 |
| F-21 | Settings | CRUD for agent profiles: provider, model, effort, role prompt, permission mode, timeout | P0 |
| F-22 | Settings | Provider status page with CLI installation, version, and login status. From v0.7.2 it also runs the official CLI updaters. | P0 |
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
| Network access | Standard installs bind to `127.0.0.1`. Docker publishes on host loopback. The server checks `Host` and `Origin` for loopback names to prevent DNS rebinding. |
| Credentials | Provider authentication stays with the official CLIs. Optional DALANG login stores a salted app-password hash and uses process-local browser sessions. |
| Isolation | On Linux `bwrap` provides a project workspace, a read-only filesystem outside its writable mounts, and a separate `/tmp`. macOS uses `sandbox-exec`. The Docker setup preserves the per-project bubblewrap sandbox. |
| Reliability | Pipeline state is saved to SQLite on every step transition. After a crash or restart, the pipeline resumes from the last completed step. |
| Timeouts | Each run has a total timeout and an idle timeout. A stuck process is killed and the task is marked failed with the reason. |
| Observability | The stdout/stderr of every run is saved to `.dalang/logs/` and can be replayed in the UI. |
| Responsiveness | Logs appear in the UI less than 1 second after the CLI writes them. |
| Platform | Linux and macOS (P0), Windows via ConPTY (P1). |
| Compliance | Only runs official CLI binaries. Does not extract OAuth tokens and does not call provider backends directly. |
| Installation | `npx dalang-cli` opens the terminal team room (since v0.12); `npx dalang-cli web` starts the server and opens the browser. `docker compose up --build -d` starts a local container from the source checkout. |

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
| Distribution | pnpm 12 monorepo, released to npm | `npx dalang-cli` opens the terminal team room; `npx dalang-cli web` starts the server and opens the browser |

Versions are the latest stable releases found on the npm registry and nodejs.org on 18 Nov 2026. The lockfile pins them at implementation time.

Verified on Node 26.13.1 (Linux x64, clean install): better-sqlite3 13.2 (in-memory insert and select), node-pty 1.1 (spawned a process and read its output), Fastify 5.12 with @fastify/websocket 11 (served a request on `127.0.0.1`), and Zod 4.6 (validated a schema). Drizzle 1.0 rc.5 with the built-in `node:sqlite` driver also worked (insert and select). The front end also built: Vite 8.3 + React 19.3 + `@vitejs/plugin-react` 6.3 + TypeScript 7.0 + Tailwind 4.3 + TanStack Query 5.108 + a shadcn/ui button (`shadcn init` 4.23), with `tsc --noEmit` and `vite build` passing. TypeScript 7 removed `baseUrl` (use `paths` with `./` prefixes) and needs `"vite/client"` in `types` for CSS imports. `npm audit` reports a high-severity picomatch ReDoS reached through the shadcn CLI's dev dependencies; it does not ship in the built bundle. The built UI was also opened in a browser (Playwright, `vite preview`): React mounted, TanStack Query resolved its query, and the shadcn button rendered with Tailwind styling; the only console error was a missing `favicon.ico` in the test page. Not verified: macOS and Windows builds.

Two findings that affect installation:

- npm now blocks dependency install scripts until they are approved (`npm install-scripts approve`). better-sqlite3 and node-pty both declare install scripts, so `npx dalang-cli` must either ship an `allowScripts` approval or avoid native modules. better-sqlite3 13 bundles prebuilt binaries for Linux, macOS, and Windows, so no compiler should be needed once approved. `node-pty` stays optional.
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
- The agy model list comes from `agy models`, and the Codex list from `codex debug models` (JSON, `visibility: list`). Claude's list comes from an `initialize` control request over `--input-format stream-json` (the same list as its `/model` picker, no API call; updated 19 Nov 2026, earlier versions used the aliases `sonnet`, `opus`, and `haiku`).
- Codex's own sandbox cannot start inside `bwrap` ("No permissions to create a new namespace"), so a Codex run inside `bwrap` silently fails to write files. The adapter therefore sets `sandbox_mode="danger-full-access"` when `bwrap` is the boundary and `workspace-write` otherwise. `codex exec resume` has no `--sandbox` flag, so the mode is passed with `-c` on both paths.
- The spawn environment keeps the user's `PATH` first so CLI shebangs (`env node`) resolve to the installed Node. `bwrap` runs with `--die-with-parent`, `--new-session`, `--unshare-pid`, and `--unshare-ipc`, hides `/run/user` and `/run/docker.sock`, and keeps the network open for the CLIs. For opted-in Antigravity runs, DALANG mounts a proxy socket that exposes only the Secret Service. [Antigravity keyring](SANDBOX.md#antigravity-keyring-exposure-opt-in)
- Not yet tested: behavior when a limit is actually hit (error message and exit code in all three CLIs), agy interactive questions (`ask_question`) in headless mode, prompt-injection attacks on the restrictive prompt, and macOS (no `bwrap`, so agent writes are not confined there).

## Data model

SQLite stores state and indexes, while the full content of artifacts (brief, plan, logs, review) stays as files in `.dalang/` so it is versioned in git.

| Entity | Main fields | Relations |
| --- | --- | --- |
| `project` | id, name, path, main branch, created | has many `session`, `task` |
| `session` | id, project\_id, mode (ask/quick/full, v0.7), work\_state (idle/working, v0.7), title (v0.7), phase (discuss/agree/list/run), cli\_session\_id | has many `message`; one `working` per project (v0.7) |
| `message` | id, session\_id, role, type, content, time | has many `message_images` (v0.7.2) |
| `message_images` | id, message\_id, MIME type, image bytes | Deletion cascades from its message |
| `brief` | id, project\_id, session\_id (v0.7), version, status (draft/approved), file path | one approved `brief` → one `plan` |
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
| v0.5 | Polish and distribution: npm package with `npx dalang-cli` and `dalang doctor`, several accounts per provider, token and cost statistics, replay tests, macOS sandbox, push and pull request after merge, documentation | `npx dalang-cli` starts on a clean Linux and macOS machine, and replay scenarios cover quota reroute, review fix round, and parallel merge | Released on 19 Nov 2026 as `dalang-cli@0.5.0` on npm (Linux verified: replay scenarios, headless Chromium browser E2E, `dalang doctor`, `pnpm pack` bundle; macOS `sandbox-exec` unit-tested for parity, clean macOS host install not yet run) |
| v0.6 | UI revamp: first-run wizard, five-step guided project flow, wayang stage with activity feed during work, Config page with sidebar tabs, theme toggle, Indonesian and English (UI and agent output), redrawn gunungan logo, new-version notice | A new user reaches the Discuss step of a first project through the wizard without reading docs, and no action of the v0.5 UI is lost | Released on 19 Nov 2026 as `dalang-cli@0.6.0` on npm. Verified on Linux with unit tests, server API tests, CLI doctor tests, and headless Chromium CDP E2E for fresh-install wizard, upgrade path, 6 Config tabs, Statistics, Work stage pause/visibility, ID/EN i18n with a no-English-leak scan of every step and Config tab, light/dark theme, update notice, and 390px mobile drawer) |
| v0.7 | Ask, Quick, and Full in a shared chat, saved sessions, one working session per project, and a provider limits bar | Read-only Q&A, a one-task fix from request to merge in one chat, and a five-step Full flow | Linux verification covers typecheck, build, database upgrades, CLI diagnostics, and all three modes in Chromium with replayed agents. [GitHub release](https://github.com/azmifauzan/dalang/releases/tag/v0.7.0) · [npm package](https://www.npmjs.com/package/dalang-cli/v/0.7.0) |
| v0.7.2 | Chat image attachments, optional local login, Docker Compose, and provider CLI updates | Upload and reopen a chat image, protect app APIs and live connections when login is enabled, and launch the Docker image with all three updaters available | Implemented and covered by API, Chromium replay, and Linux Docker checks |
| v0.7.3 | Native Windows execution, instruction pointers, platform shell commands, and review artifact scope | Install the tarball and complete a live Quick plan, code, verify, read-only review, merge, and integration on Windows; retain Linux regression coverage | Verified on Windows with Codex and Edge; 104 applicable Windows tests and 107 Linux tests passed. GitHub release and tarball distribution; npm publication is separate. |
| v0.8 | Agent delegation: a running agent splits its own task into subtasks on other profiles through a DALANG MCP server | One task is split by its agent into at least two subtasks on two providers, and all of them pass review and merge | Implemented. Verified on 23 Nov 2026 with replay providers in the core delegation tests and over real HTTP in the loopback `/mcp` server test; a run on live provider CLIs is not yet done |
| v0.9 | Workspace projects: one project for a root folder whose top-level folders are their own git repositories, with worktrees, review, merge, and rollback per repo | A Quick task in a workspace edits a nested repo, passes review, and merges into that repo's branch | Implemented. Verified on 23 Nov 2026 with a schema v12 to v13 upgrade test, core nested-repo lifecycle, merge, push, rollback, and delegation tests, and a Chromium replay E2E Quick task touching a nested repo; a live Quick task on the `sei-office` workspace (copy of app data, Claude coder, Antigravity review) changed `frontend/` and `scheduling-service/`, merged one commit into each repo's checked-out branch, left `backend/` untouched, and was then reverted. that run also found Antigravity coder runs failing on `agy` 1.5.15, fixed in 0.9.1 |
| v0.10 | Session protocols (Claude Code stream-json sessions, `codex app-server`, ACP), steering a running task, context handoff on fallback, native Windows confinement | A fallback mid-task continues from the handoff instead of starting over, on all three providers | Released in 0.10.0. Linux regression and live provider checks passed. Native Windows verification pending. |
| v0.11 | Scheduled and webhook-triggered runs, outside agents over MCP | A scheduled run and a run started from a terminal agent both finish without opening the UI | Released in 0.11.0. Schema v14 adds `automations`, `automation_runs`, and `mcp_tokens`. Verified on 24 Nov 2026 with core cron, webhook, and MCP tests, a real-HTTP server test, a v13 to v14 upgrade test, and the Chromium Config check. A live check on a copy of the app data ran a real Claude Code client against `/mcp`: the read-only token saw 7 tools and only its project, and the full-access token's `start_task` finished, passed review, and auto-merged. A live every-minute schedule and a signed webhook each completed and merged; an unsigned webhook got 401. Codex accepted the generated config but was not run against `/mcp`. 0.11.1 adds signed timestamps and replay refusal for webhooks, and passes the webhook body to the coder only through `{{payload}}`, fenced as data. |
| v0.12.0 | Terminal team room (`dalang`), `dalang web` rename, role reports & schema v15, `@<profile>` mention routing | In a TTY, `dalang` runs a Quick task from plan to merge with no browser; `dalang web` behaves like v0.11; routing tests cover Lead, idle Ask, and running coder steering | Released in v0.12.0. Schema v15 adds `author_profile_id` and `kind` on `messages`. Verified on Linux (Node 26, Ink 8, React 19.3) with v14 to v15 upgrade tests, core mention-routing and report tests, CLI routing and compatibility tests, and an Ink E2E Quick task from plan to merge with `/diff`, `/web`, and y/n gates. On 24 Nov 2026 a live run in a real pseudo-terminal, on a copy of the app data upgraded from v13 to v15, ran a Quick task from the Lead's plan (Claude) through the coder and review (Antigravity) to merge with no browser, and `@reviewer` answered in Ask mode. A second live run with empty app data and the real provider CLIs went through the first-run wizard to a first project, `/model` listed the Claude and Codex models, `/config` opened, the mouse wheel scrolled a long session, and the layout held at 80 by 24 and 110 by 38. macOS Terminal, WSL 2, and Windows Terminal rendering checks remain open. |

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

### v0.5 implementation notes

Decisions made while building v0.5 (Polish and distribution):

- **Packaging:** `shared`, `core` and `server` stay private workspace packages. `pnpm --filter dalang-cli build` inlines them into `packages/cli/bundle/cli.js` with rolldown; third-party packages stay external and are listed in the `dalang` package's `dependencies`. Checked on 19 Nov 2026 by installing the packed tarball into an empty directory with npm on Node 26 and Node 24: `dalang --version`, `dalang doctor`, and the server (`/api/health` and the UI) all worked. Minimum Node is 24 (22 was not tested).
- **Checkpoints (hybrid hidden refs):** Pre-run baselines (`ensureMainBaseline` on existing repos) and failed/stopped run snapshots are written into hidden refs under `refs/dalang/checkpoints/*` via a temporary `GIT_INDEX_FILE` (`write-tree` + `commit-tree` + `update-ref`), keeping `mainBranch` free of noise commits while preserving rollback. Completed task work still commits on `dalang/{id}` so the reviewer diff, Gate 2 diff inspector, and `git merge --no-ff` keep working cleanly.
- **Several accounts per provider (schema v7):** `agent_profiles.config_dir` maps to `CLAUDE_CONFIG_DIR`, `CODEX_HOME`, or `AGY_CONFIG_DIR` / `XDG_CONFIG_HOME` and is mounted writable inside the sandbox (`bwrap` and `sandbox-exec`). Usage caches, cooldown windows, and `ProviderLimiter` concurrency slots are keyed per account (`buildAccountKey(provider, configDir)`), allowing a fallback profile on the same provider with a different account.
- **Model details from the CLIs:** `ProviderModelInfo` carries `id`, `value`, `resolvedModel`, `displayName`, `description`, `supportedEffortLevels` (including `max`), `defaultEffort`, `supportsFastMode`, `supportsThinking`, and `variants` (for example Claude's `[1m]` 1M context option attached to its base model). The profile editor displays names, descriptions, variant toggles, and model-scoped effort options, and marks unavailable saved models instead of silently dropping them.
- **Side-effect-free health checks:** Verified against the real host `claude` CLI on 19 Nov 2026 that `--bare --no-session-persistence` skips `.claude/settings.json` `SessionStart` hooks during model discovery. All adapter health checks execute with `cwd: os.tmpdir()` and stay cached until Refresh CLI status.
- **Token and cost statistics:** Stream-json usage events are extracted per turn across Claude, Codex, and Antigravity, persisted on `runs` (schema v7), and aggregated per model, per provider, per project, and overall in `GET /api/statistics` and Providers. When a CLI omits `total_cost_usd`, DALANG computes an estimate labeled explicitly as API-equivalent cost, not the subscription bill.
- **Push and pull request:** Per-project `pushAfterMerge`, `createPrAfterMerge`, and `gitRemote` settings plus manual `POST /api/projects/:id/tasks/:taskId/push-pr` run `git push` and `gh pr create` with the task brief and review summary as the PR body.
- **macOS `sandbox-exec`:** Seatbelt SBPL generation (`wrapWithSandboxExec`) mirrors Linux `bwrap` (read-only workspace for reviews, `.git/hooks` write denial, `/tmp` isolation, writable account config dir) and is covered by parity unit tests. Live macOS host execution remains to be verified on Apple hardware; Windows runs via WSL 2 as documented in `docs/SANDBOX.md`.
- **Verification on 19 Nov 2026 (Linux):** Process-level `ReplayCliRunner` tests pass for all three required replay scenarios (quota reroute to a backup account, failed review + fix round + merge + push/PR, and two parallel tasks merging), plus a headless Chromium browser scenario against a real DALANG server verifying Providers model/variant/token UI, Guard push/PR controls, dark mode toggle, and mobile 390px layout overflow. `dalang doctor` and `pnpm pack --dry-run` verified locally.

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

### Research: terminal clients and similar tools (20 Nov 2026)

Question: should DALANG offer a terminal UI (TUI) next to the web UI? This is a research note and an open question, not a decision. No roadmap item depends on it. Figures come from web search results (blogs and vendor posts, not the primary reports) and were not cross-checked.

**Similar tools**

| Tool | Shape | Note |
| --- | --- | --- |
| T3 Code | Desktop, web server, and mobile GUI over Claude Code, Codex, and OpenCode | Alpha. Started with `npx` or a desktop app. No TUI |
| Claude Squad | Go TUI, one tmux session and one git worktree per agent | Works over SSH. Runs agents in parallel but has no brief, plan, review, or merge gate |
| Conductor | macOS app, parallel agents in worktrees | Closed source |
| Crystal | Desktop app | Retired in Feb 2026 for a paid successor |
| Vibe Kanban | Kanban board for agents | Company closed in Apr 2026, now community maintained |
| OpenCode | One server with a TUI, a web UI, a desktop app, and an SDK attached to it | Per its docs the web UI lacks some TUI features (custom keybinds, custom themes). Docs suggest the TUI for keyboard work and the web UI for file trees and diff review |

- **Orchestration in OpenCode** is one primary agent with subagents (each with its own model, permissions, and prompt), plus community plugins for background and parallel agents. It is not a pipeline with a brief, a reviewer on another provider, and a merge gate. DALANG orchestrates other CLIs, OpenCode orchestrates models inside its own harness.
- **Subscriptions**: OpenCode can use a ChatGPT Plus or Pro login and GitHub Copilot without an API key. Using a Claude Pro or Max login there is not supported by Anthropic (the OpenCode docs say so, and one review reports a block on third-party OAuth since 9 Jan 2026), so Claude needs an API key. DALANG drives the official CLIs, which log in themselves, so a Claude subscription works through Claude Code. Worth stating in the README. The status of that policy was not checked against Anthropic directly.

**Terminal or web?** No survey found splits developers by terminal, IDE, or web client. Surveys measure which tool is used, not through what surface. Signals:

- Stack Overflow 2025: Claude Code about 10% of all respondents, Cursor 18%, agents used by 31%. Stack Overflow 2026: coding assistants 66%, agents 26%.
- JetBrains 2026 (via a secondary summary): 90% of professional developers use AI agents weekly, Claude Code 39% at work, then Copilot 21%, Codex 16%, Cursor 12%.
- Pragmatic Engineer 2026 (via a secondary summary): 70% of engineers use two to four AI tools at once.
- Terminal-first tools now ship IDE, desktop, and web surfaces too (Claude Code, and the Codex desktop app in 2026). No source shows a TUI would add DALANG users.

**What a TUI would involve** (if it is ever built)

- Every PRD feature can run in a terminal. Easy: chat, the question cards, run logs and controls, settings, history, statistics, the Ask, Quick, and Full composer. Needs extra work: the editable brief (open `$EDITOR`), the task board (keyboard reordering instead of drag and drop), and the diff and merge gate (a scrollable diff, with the browser as fallback for large diffs). Changes: browser notifications become a terminal bell or an OS notification, and the wayang artwork is not carried over.
- The workable shape is the OpenCode pattern: the server keeps all session, mode, and gate logic and the TUI is a thin client of the same API, so the two UIs cannot drift. Ink (React for the terminal) would reuse the TypeScript and React stack and the `shared` types.
- Cost: a second frontend to maintain for a small project, and OpenCode itself shows the two UIs still diverge in features. It is best started after the v0.7 session API is stable.
- Cheaper first step if wanted: non-interactive commands against the running server (`ask`, `quick`, `sessions`, `status`, `approve`), which can grow into a TUI.

### v0.5: polish and distribution

- **npm package.** Publish `dalang-cli` (the name `dalang` is taken on npm by an unrelated package; the installed command stays `dalang`); `npx dalang-cli` starts the server and opens the browser. `dalang doctor` checks Node, git, `bwrap` (or `sandbox-exec`), each CLI's install and login, and the data directory, and prints a fix for each failure.
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

### v0.6: UI revamp

Agreed in a design discussion on 19 Nov 2026 (mockups were throwaway and are not kept).

#### Intent

The current UI confuses people new to DALANG. It shows six tabs named after internal stage names (Discuss, Agree, List, Assign, Navigate, Guard), a Providers page that mixes CLI status, profiles, routing, and statistics, and no guidance about what to do next. The revamp makes the first visit simple and fully guided, makes the running pipeline feel like a team at work, and adds Indonesian next to English.

**Target user:** someone who already uses Claude Code, Codex, or Antigravity from the terminal but does not yet know how DALANG works. They do not need to be taught what an agent CLI is; they need to learn DALANG's flow (goal, brief, plan, work, review and merge) and where they must decide.

#### Goals

- A first-run wizard that gets a new user from an empty install to the Discuss step of a first project.
- Every project screen states the next action in plain words.
- During execution, an animated wayang stage shows which agent does what, backed by a factual activity feed.
- Settings move to a Config page with tabs in the sidebar.
- UI in Indonesian and English; the Lead and reviewer write in the chosen language.
- A light/dark toggle instead of the "Dark mode" button.
- A gunungan logo that looks like a real kayon.

#### Non-goals

- No change to the pipeline itself (routing, review loop, merge gate, sandbox). Logic in `packages/core` stays; the UI talks to the same API.
- No languages beyond `id` and `en` in v0.6.
- No mobile app, no remote access.
- No new state management or animation library.

#### Anti-goals (a failure even if it works)

- Any loss of what the current UI can do: every action available today (answer the Lead, approve brief and plan, edit tasks, start, stop, retry, rollback, review diff, approve or reject merge, integration command, profile and routing editing, statistics) must still be reachable.
- Animation that hides facts. The stage is decoration on top of the feed and kanban; status must never be readable only from the animation.
- Animation that costs a busy machine: it must stop when the tab is hidden or the OS asks for reduced motion.
- Mixed languages on one screen (an untranslated string in the `id` UI).

#### Approaches considered

| Approach | Trade-off | Decision |
| --- | --- | --- |
| A. Incremental: wrap the current views in a new shell, translate gradually | Lowest risk, but keeps today's confusing content inside each tab | Rejected |
| B. Rewrite `packages/web` | Most consistent, but rewrites about 7,200 tested lines (Guard, diff, kanban, profile editor) and risks regressions in working flows | Rejected |
| C. Hybrid: new shell, new pages for wizard, Config, and the stage; existing views moved into steps, tidied, and moved to the translation dictionary | Keeps tested logic, changes the layout and flow fully | **Chosen** |

#### Decisions (made with the user)

##### Layout

- Left sidebar (after T3 Code): "+ New project", the project list, then Statistics and Config, and at the bottom the language switch (`ID | EN`) and the theme toggle (sun/moon switch).
- Inside a project, a five-step stepper at the top replaces the six tabs:

  | Step | Replaces |
  | --- | --- |
  | 1 Discuss (Diskusi) | Discuss |
  | 2 Brief | Agree |
  | 3 Plan (Rencana) | List |
  | 4 Work (Pengerjaan) | Assign + Navigate |
  | 5 Review and merge | Guard |

  Done steps show a check, the current step is highlighted, later steps are visible but not active. The D-A-L-A-N-G letters may stay as a small label; they are not the navigation.
- Under the stepper, a "Next step" card said what to do now in one sentence with one primary button. v0.7 removed it, because its button repeated an action that already sits in the step.

##### First-run wizard

Shown when there is no project yet. Four screens with a progress bar, Back, Next, and "Skip wizard". It can be reopened from Config → About.

1. **How DALANG works:** a short animation with the wayang cast: you give a goal, the Lead plans, agents work, you approve at two gates (brief and merge).
2. **Agents:** detected CLIs with version, login, model count, and sandbox state. Anything not ready shows the exact fix command to copy (for example `claude auth login`). Antigravity's keyring permission is asked here with its risk explained. At least one ready agent is required to continue.
3. **Team:** one card per role (Lead, a coder for simple tasks, a coder for complex tasks, Reviewer), each with a CLI choice (Claude, Codex, or Antigravity), a model, and a reasoning effort, plus a fallback card that picks which team member steps in. The defaults come from the seeded profiles and the ready CLIs (a role whose seeded CLI is not ready starts on a ready one). Accepting writes the choices into the role's seeded profile and the routing rules; model details, limits, extra profiles, and accounts stay in Config → Team.
4. **First project:** pick a folder (new or an existing repo), write the goal in one sentence, and land in step 1 Discuss.

##### Work stage (step 4)

- A wayang stage (kelir lit by a blencong lamp, banana-trunk base) above the kanban, with the activity feed below it.
- Characters by role: **Semar** = Lead, **Bima** = Coder for simple tasks, **Kresna** = Coder for complex tasks, **Arjuna** = Reviewer, **Gatotkaca** = fallback. The provider shows as the colour of the character's label (Claude orange, Codex green, agy blue). Several coders in parallel appear as several Bima figures.
- Active agents move (body sway, arms worked from shoulder and elbow like a dalang playing them); waiting agents are dimmed (for example "quota, resumes 14:05"). Clicking a figure opens that task's log.
- Feed lines are factual and come from run events: "Bima (Codex) is writing `src/routes.ts`", "Arjuna (Claude) ran `npm test`: 12/12 passed", "T-001 passed review round 1, waiting for merge approval".
- Style: shadow (dark silhouettes on the lit screen). The coloured (sungging) version of the same figures is used in the wizard and on Config → Team cards.

##### Wayang and gunungan artwork

- Source: photographs of real wayang kulit (Tropenmuseum collection on Wikimedia Commons, CC BY-SA 3.0) for Semar, Bima, Kresna, Arjuna, and Gatotkaca, and a CC0 kayon photograph for the gunungan.
- Method: cut each figure out of its photo, split it at the real joints (wayang kulit arms are separate pieces pinned at shoulder and elbow), and trace each piece to SVG. Pivot points sit on the pins.
- The derived artwork stays CC BY-SA 3.0 with attribution in `packages/web/src/assets/wayang/CREDITS.md` and in Config → About. The code stays MIT.
- Gunungan: a detailed version (tree of life, gate, guardians) for the wizard and About, and a simplified silhouette for the sidebar logo and favicon (fine carving is invisible at 16 to 24 px).

##### Config page

Opening Config swaps the sidebar for Config tabs with "← Back".

| Tab | Content |
| --- | --- |
| General | Language, theme (light, dark, follow system), reopen the wizard, check for new versions (on or off) |
| Agents | CLI status, login, version, models, quota, cooldown, and CLI updates (v0.7.2) |
| Team | Agent profiles as wayang cards: character by role, provider, model, effort, fallback |
| Task routing | Routing rules shown as sentences ("Complex engineer tasks → Kresna (Codex), fallback Gatotkaca (Claude)") with the editor behind them |
| Security | Optional DALANG login (v0.7.2), sandbox state, Antigravity keyring permission, and unconfined execution settings |
| About | Version and update status, licence, wayang artwork credits, documentation links |

Statistics move to their own sidebar entry.

##### Theme

- A toggle switch replaces the "Dark mode" button. Default follows the system (`prefers-color-scheme`); a manual choice is remembered.

##### Languages

- UI strings in `id` and `en`. Default from the browser language (`id*` → Indonesian, anything else → English); a manual choice is remembered.
- The chosen language also goes to the agents: the Lead writes its questions, brief, and plan in it, and the reviewer writes its findings in it. Code, file names, commit messages, and the JSON contract keys stay English.

#### Technical calls (builder's choices, stated for review)

- **i18n:** typed dictionaries (`packages/web/src/i18n/en.ts`, `id.ts`) with a small `t()` and `Intl` for dates and numbers; no library for two languages. A missing key in either dictionary fails the typecheck.
- **Language to agents:** the language is a global setting stored server side (the `settings` table), so the Lead and reviewer prompts can read it; the UI language and agent language are the same setting.
- **Animation:** SVG and CSS transforms only; pivots per limb. Paused with `document.visibilityState` and `prefers-reduced-motion`.
- **Design tokens:** `docs/DESIGN.md` must be updated: its MOTION 1 dial forbids infinite loops, which the stage needs. The new rule: MOTION 1 everywhere except the wayang stage and the wizard intro, which may loop and must pause as above. The six-stage rail section is replaced by the five-step stepper.
- **Update notice:** the server asks the npm registry (`https://registry.npmjs.org/dalang-cli/latest`) for the newest version at most once per 24 hours and caches the answer in the `settings` table. The request carries no project, account, or usage data. It is on by default and can be switched off in Config → General (the owner's call to confirm: an unattended outgoing request from a local-first tool). When a newer version exists, the sidebar footer shows "Version X is available" and Config → About shows the command to copy (`npx dalang-cli@latest` or `npm install -g dalang-cli@latest`, with a link to the release notes). DALANG never installs or restarts itself. `dalang doctor` prints the same hint. A failed check (offline, registry down) counts as the day's attempt, keeps the last known answer, and shows nothing when there is none.
- **State:** keep TanStack Query and the existing API client.
- **Which step is current:** steps 1 to 3 are sequential. Once execution starts, steps 4 and 5 are both open (some tasks run while others wait for merge). The "Next step" card picks the action that blocks progress first: a merge or reject decision, then a failed task needing retry, then "agents are working, nothing to do".
- **Fallback is a target, not a profile (schema v8):** a fallback is a CLI, model, effort, and an optional account directory, stored on routing rules and on profiles (`fallback_provider`, `fallback_model`, `fallback_effort`, `fallback_config_dir`). The fallback run is the primary profile started on that target, so the role instructions, limits, and permissions stay the same. A target identical to the primary route is ignored. Upgrading copies each old fallback profile's CLI, model, effort, and account into a target, and puts the engineer tiers back in low, medium, high order.
- **Wizard team step:** it edits the provider, model, and effort of the four seeded role profiles (lead, coder-small, coder-heavy, reviewer) and sets the routing rules' primary profiles and fallback targets; the light and heavy coder tiers stay separate. It never deletes profiles or rules. Skipping the wizard leaves the seeded defaults.
- **Wizard folder step:** a path field with validation, as the current project form does (a browser page cannot open a native folder picker on the local disk).
- **Language change mid-project:** applies to the next agent turn; text already written stays in its language.
- **Upgrade path:** existing installs with projects skip the wizard and open the most recent project.

#### Build order

Each step leaves the app usable, so the work can stop or ship at any step.

1. **i18n and theme first:** the `t()` dictionaries, the language setting (server side, `settings` table), the theme toggle with "follow system", and every existing string moved to `en` and `id`. The UI looks the same but speaks both languages. Pass the language to the Lead and reviewer prompts.
2. **Shell:** the sidebar (projects, Statistics, Config, language, theme), the five-step stepper, and the "Next step" card, with the existing views mounted inside the steps unchanged.
3. **Config:** move the Providers page content into the six tabs; Statistics gets its own page. Add the update notice here (server check, sidebar hint, About command, General toggle, `doctor` hint).
4. **Tidy the steps:** go through each step's view, simplify its layout and wording for the target user, and check the anti-goal list (no action lost).
5. **Artwork:** trace the four wayang figures (split at shoulder and elbow) and the gunungan (detailed and simplified) to SVG, with `CREDITS.md`. Replace the logo and favicon.
6. **Wizard:** the four screens, shown on an empty install, reopenable from Config → About.
7. **Work stage:** the kelir with figures driven by run events, the activity feed, pausing on hidden tab and reduced motion.
8. **Docs and checks:** update `docs/DESIGN.md` (motion rule, stepper), README screenshots, and run the "done when" checks in both languages.

#### Left to the builder

- Exact copy for each step card and wizard screen (in both languages), within the rules above.
- How the feed derives its sentences from run events.
- Which existing view fragments are reused as is and which are rewritten.
- Layout at phone width (the sidebar becomes a drawer).

#### Done when

- A new user on a fresh install reaches step 1 Discuss of a first project through the wizard without reading docs.
- Every action listed under anti-goals is reachable in the new layout.
- No untranslated string in either language (typecheck plus a scan of rendered pages).
- The stage pauses on a hidden tab and under reduced motion.
- With a newer version on the registry, the sidebar and Config → About show it; with the check off or the network down, nothing is shown and nothing breaks.
- Lead output (questions, brief, plan) arrives in the chosen language for both `id` and `en`.

### v0.7: session modes

#### Intent

The v0.6 flow always runs `Discuss → Brief → Plan → Work → Review & merge`. That is right for a feature and heavy for "explain this module" or "change the button colour". Users should pick how much process a piece of work needs, without losing the merge gate that keeps the repo safe.

#### Decisions (made with the user)

- **Sessions are saved per project and can be reopened, like a normal AI chat.** Each project keeps a list of its sessions (title, mode, last activity). Opening one restores the full conversation, the brief, the plan, and the task board of that session. A session is never "closed": it can be renamed, archived, or deleted (deleting asks for confirmation and never touches merged code).
- **One session at a time may hold unfinished work.** Sessions are free to pile up, but while a session has running tasks, a task awaiting review, or an unmerged branch (state `working`), no other session in that project can start work. The others stay readable and can still chat in Ask mode. When the work merges or is discarded, the session returns to `idle`. Parallel working sessions are not planned: they would need per-session worktrees and quota arbitration across sessions (revisit after v0.8).
- **Reopening and continuing.** The Lead's context is restored through the saved CLI session id when the CLI can resume it; otherwise the saved messages are handed back to it as context. A finished Quick or Full session reopens as a chat: new messages are Ask-style questions about what was done, and the composer can start a new Quick or Full cycle in the same session (when no other session is `working`).
- **A project opens straight into a chat with Ask selected.** The first message creates a session in the selected mode. An empty chat centers its composer and moves it to the bottom after the first message.
- **The mode lives in the composer.** A small segmented control beside the send button reads `Ask | Quick | Full`, with Ask selected. Switching it changes what sending does: Ask sends a message, Quick asks the Lead for a mini plan, Full starts the Discuss step with the Brief gate. The sidebar lists projects, and a project expands to its sessions (newest first, each with a small mode mark and a dot when it is `working`); `New chat` sits at the top of that list. The mode is never picked in the sidebar.
- **Switching up is promotion, and it happens on send.** Choosing a mode in the control only decides what the next message does, so looking at Quick or Full changes nothing. When a message is sent in a higher mode, the session moves up and carries the conversation over (the Lead's earlier answers become context for the brief or the mini plan). A question (Ask) can be sent in any session at any time and never changes its mode, so a Full session can still be asked something. Quick is not offered inside a Full session until its work is finished, because a Full session already holds a brief and a plan. Switching down is disabled while the session is `working`, with a short reason, because work that changed files cannot become read-only. The Lead may suggest a switch in the chat ("this looks like a small fix, switch to Quick?") with a one-click button; it never switches on its own.
- **The stepper and timeline appear only after a switch.** Ask shows no steps. Quick shows a short timeline (Request → Work → Review → Merge). Full shows the five-step stepper. A strip above the chat shows the mode badge and the session title (click to rename).
- **Ask** (the default in v0.7): a chat with the Lead about the repository. Read-only: no tasks, no worktree, nothing written outside `.dalang/` chat logs. Switching to Full from here is the "turn this talk into a brief" path.
- **Quick**: for a bug fix or small feature. The user writes the request; the Lead returns one mini plan card (a single task with `files_allowed`, no brief) in the chat; one click on `Run` starts it; the usual verify, review (with the fix loop), and merge gate follow. If the Lead judges the work to need more than one task or touches many areas, it says so and offers a switch to Full, which keeps the request and the Lead's findings as the start of the Discuss step.
- **Full**: Discuss, Brief, Plan, Work, and Review & merge. The composer supplies the Lead model and each step holds its own controls.
- **The merge gate applies in every mode that changes files.** Lighter modes skip planning ceremony, not safety: sandbox, `files_allowed`, verify, review, and the approval to merge stay.
- **Promotion is explicit.** A session moves up (Ask → Quick, Ask → Full, Quick → Full) when a message is sent in the higher mode. Nothing is promoted by a guess; the Lead may suggest it with a button. A question (Ask) is allowed in any session and never changes its mode.

#### Data model change (schema v9)

- `session` gains `title`, `mode` (`ask`, `quick`, `full`), `work_state` (`idle`, `working`), `updated_at`, and `archived_at`. A partial unique index allows one `working` session per project.
- `brief` and `plan` move from the project to the session (`session_id`), so each session carries its own brief, plan, and task board. Tasks keep their plan.
- The stage a project holds today moves onto a session. Migration: each project that has a brief, plan, or messages gets one Full session carrying them (`working` if its work is unfinished, otherwise `idle`), titled from the brief or the first message; every other project starts with no session and its chat opens empty.
- Artifact files move from `.dalang/` to `.dalang/sessions/<session id>/` (brief, plan, review, logs), so sessions do not overwrite each other; the migration moves the existing files.
- `plan.brief_id` becomes nullable: a Quick plan has no brief. Tasks, runs, reviews, and the merge gate are unchanged.

#### Goals and non-goals

- Goal: opening a project and asking a question needs no choice at all; a small fix needs one input, one click to run, one click to merge.
- Non-goal: automatic mode detection, several `working` sessions in one project, per-session profiles, full-text search across sessions, and a new Config tab.
- Anti-goal: a mode that can change files without the merge gate, or a Quick session that silently grows into a large unreviewed change.

#### Done when

- An Ask session on a real repository answers questions and leaves `git status` clean.
- A Quick session fixes a seeded small bug, passes verify and review, and merges after one approval, with no brief written.
- Opening a project shows the chat with the composer ready and creates no session until the first message.
- Switching an Ask session to Quick or Full keeps the conversation; a question can still be asked in a Full session, and Quick is not offered inside a Full session until its work is finished.
- A Quick request the Lead judges too big offers a switch to Full, and the Full session starts with that request already in Discuss.
- Sessions of a project are listed in the sidebar and reopening one restores its conversation, brief, plan, and board; the Lead answers a follow-up in a reopened session with the earlier context.
- Starting work in a second session while another is `working` is refused with a clear message naming the first; after it merges or is discarded, the second can start.
- A v0.6 database upgrades to schema v9 with every project's stage, brief, plan, tasks, and messages intact in its session.
- The i18n leak scan passes for the new screens in Indonesian, and the browser E2E covers all three modes.

#### Implementation notes (shipped in v0.7.0)

- **Schema v9 and artifact migration**: `sessions` gained `title`, `mode`, `work_state`, `archived_at`, and the partial unique index `idx_sessions_one_working_per_project ON sessions(project_id) WHERE work_state = 'working'`. `briefs` and `plans` gained `session_id`, and `plans.brief_id` became nullable. `migrateToV9` turns each active v0.6 project into one Full session (`working` when unfinished work exists, else `idle`), deletes empty orphan sessions, moves `.dalang/` artifacts into `.dalang/sessions/<sessionId>/`, rewrites the stored paths, and adds the session ignore lines to `.dalang/.gitignore`.
- **Ask**: Ask turns run with `permissionMode: 'read-only'` and write raw CLI logs into `.dalang/tmp/`, so `git status` stays clean even on upgraded repos.
- **Quick**: a Quick turn validates a single-task `QuickPlanContractSchema` (`verdict: 'ready' | 'too_large'`), stores `plans.brief_id = null`, and runs the same sandbox, `files_allowed`, verify, review loop, and merge approval inline.
- **Mode choice**: the composer buttons are local state. The chat endpoint takes the requested `mode` and promotes the session when that mode is higher. `POST /api/projects/:id/chat` also accepts `provider`, `model`, and `effort` for the turn.
- **Running turn**: `LeadService` keeps the Lead turns running now, by session, from the `lead.turn_started` and `lead.turn_finished` events, and reports one as `turn` on the session summary (in memory, with a one hour stale guard). Pages show the running panel from that, so it survives switching chats. Live log lines are kept per session in the page.
- **One chat surface**: Ask, Quick, and the Full discuss step share `ChatTranscript`, `RunningTurn`, `ComposerDock`, `useChatScroll`, and `useComposerChoice` under `packages/web/src/components/chat/`. Replies render through `react-markdown` and `remark-gfm`. The model picker lists Claude models by their resolved version.
- **Provider limits**: `ProviderUsageBar` reads the provider status and refreshes it on the `usageRefreshMinutes` setting (3, 5, or 10, default 5) while the page is visible, and when a run finishes.
- **Lead usage statistics**. The `lead_turns` table records Lead calls and reported usage. Statistics combines those records with execution, fix, and review runs. Upgrades can recover historical usage from existing Lead logs on disk.
- **Removed**: the "Next step" card, the Lead CLI and model fields of the Discuss step, and the duplicate plan buttons.
- **Reopening and context**: a reopened session restores its conversation, brief, plan, and board. Follow-up turns resume the saved CLI session when it can, and otherwise hand the saved messages and a summary of completed work back as context.

#### Chat images, local sign-in, and Docker (v0.7.2)

- The shared composer accepts up to three PNG, JPEG, or WebP images per turn, each up to 4 MiB. Claude Code receives image blocks on stream-JSON stdin. Codex reads temporary image files through `--image`, including on resumed turns. Schema v10 stores image bytes separately from the transcript and removes them with their messages. [Attachment guide](USAGE.md#attach-images)
- Local sign-in is off by default. The Security tab can require one app password for the workspace APIs, image downloads, and live WebSocket connections. The password hash persists and browser sessions expire on restart. [Security model](SANDBOX.md#optional-app-login)
- Docker Compose provisions the three CLIs, bubblewrap, and a container-local Secret Service. The app stores its database and the providers' sign-ins and updated binaries in a persistent home volume. Each provider's **Update CLI** action runs its native updater and refreshes the status in Config. [Docker setup](INSTALL.md#run-with-docker)

#### Native Windows compatibility (v0.7.3)

- The runner uses the platform PATH delimiter, discovers native Windows executables, and preserves quoting for verification commands and executable paths containing spaces. Relative artifact paths in planning, execution, review, and JSON repair prompts use forward slashes on every platform.
- Windows instruction pointers are recognized as configured while user-owned instruction files are preserved. Required task result metadata is exempt from application scope in the reviewer prompt, matching the existing scope checker.
- Merge integration accepts `allowUnconfined: false` by default; the Quick and Full views forward explicit consent. Linux and macOS keep their existing sandbox engines and shells.
- A live Codex Quick task on Windows completed plan, code, verification, read-only review, merge, and integration. Staged Windows runs passed 104 applicable tests with 5 unavailable symlink/FIFO cases skipped; Linux passed 107 with 2 Windows-only cases skipped. Edge exercised the browser flows. macOS parity tests passed; native Apple hardware verification remains open.
- v0.7.3 ships as a GitHub release tarball with checksums. npm publication is separate from the GitHub release. [Release procedure](RELEASING.md)

### v0.8: agent delegation

- DALANG serves an MCP endpoint on loopback (`/mcp`). Each depth-0 coder run gets a bearer token scoped to that run, which expires when the run ends; the token is redacted before writing logs or emitting events so it never enters logs.
- Claude Code and Codex coders receive the MCP config; Antigravity coders do not, because `agy` accepts MCP servers only from its saved config and rejects them in `--settings`.
- Tools: `delegate_task` (prompt, optional title, profile or provider/model/effort, `files_allowed` validated as a subset of the parent's, optional acceptance criteria and verify command, `wait` and `async` modes), `task_status`, and `task_cancel`.
- A subtask is a real DALANG task (schema v12: `delegated_by_run_id`, `delegation_depth`, `merge_target_branch`): its own worktree branched from the parent task branch, the same verify and automated review loop, and automatic merge back into the parent branch (inside the parent worktree), never directly into main. The parent's own review sees the combined diff before Gate 2 merge to main.
- Limits: depth 1 (subtasks receive no MCP config and depth >= 1 delegation is refused server-side), a configurable cap on subtasks per task (default 6), subtasks count against the global `ProviderLimiter` (with deadlock-safe slot yielding for same-account `wait` calls), overlapping sibling subtasks serialize automatically, and stopping the parent stops its subtasks.
- Native subagents (Claude's `Task`/`Agent` tool calls and Antigravity subagent/batch events) are parsed from run logs and shown read-only in the Work view run inspector and activity feed.

### v0.9: workspace projects with nested repositories (released, 23 Nov 2026)

Goal: open a workspace folder such as `sei-office` as one project, where the root repo ignores `frontend/`, `backend/`, and `scheduling-service/` and each of those is its own git repository. This is how the owner already works with Claude Code, Codex, and Antigravity from the root folder. Today a Quick or Full task fails there because the task worktree only contains the root repo, so files under a nested repo are missing (seen on T-001, two failed runs on 23 Nov).

Probes done on 23 Nov 2026 (clones of the real repos, git 2.53):

- `git worktree add` of a nested repo inside the root task worktree works, and `git status` stays separate: the root worktree sees no change when a nested file is edited.
- A `--no-ff` merge into a nested repo succeeds while unrelated files there have uncommitted changes. Git refuses only when an uncommitted file would be overwritten.
- Sizes: `frontend` 4,001 tracked files, `backend` 1,695, `scheduling-service` 136. Ignored folders (logs, cache, `target/`, `secrets/`) are not in a worktree, as with the root today.
- All three nested repos and the root have uncommitted changes, and `scheduling-service` is on a feature branch, not `dev`. The current Gate 2 rule refuses a merge when any file is dirty, so merging in `sei-office` fails today even for root-only tasks.

Design:

- At task start DALANG finds the top-level folders that contain their own `.git` (top level only). It creates the root worktree as now, then one worktree per nested repo at the same relative path, on branch `dalang/<task>` from that repo's checked-out branch.
- Paths stay root-relative (`frontend/application/...`), so the Lead's plan, `files_allowed`, overlap checks, verify commands, and agent prompts need no change.
- Checkpoints, changed files, scope checks, review diffs, and rollback run per repo and are joined with the repo prefix. The diff view labels each repo.
- Gate 2 merges each changed repo into its base branch, one commit per repo, matching the workspace rule "one commit per repo". When a later repo fails, repos already merged return to their pre-merge commit with `git reset --keep`, which keeps uncommitted work.
- The sandbox mounts each nested worktree's `.git` link file read-only, as it does for the root.
- Delegated subtasks get nested worktrees from the parent task's branches and merge back per repo.
- Out of scope: git submodules and nested repos below the top level.

| Phase | Name | Scope | Depends on | Size |
| --- | --- | --- | --- | --- |
| 1 | Data model | Schema v13 table `task_repos` (task, repo path, base branch, base SHA, branch, worktree path) and per-run checkpoint SHAs per repo | none | M |
| 2 | Worktree lifecycle | Detect nested repos, create and remove nested worktrees on start, stop, retry, cancel, merge, and cleanup; sandbox read-only binds | 1 | M |
| 3 | Checkpoints and scope | Per-repo checkpoint commits and hidden refs, joined changed-file list, scope check | 2 | M |
| 4 | Review and diff | Joined diff for the reviewer and the Work and Quick diff views, with repo labels | 3 | M |
| 5 | Merge gate | Per-repo dirty-overlap check, merge, push and pull request per repo remote, all-or-nothing return | 4 | L |
| 6 | Rollback and delegation | Rollback per repo, subtask worktrees and merges per repo | 5 | M |
| 7 | Proof and docs | Replay E2E with a nested-repo fixture, a live Quick task on `sei-office` touching `frontend/`, docs | 6 | M |

Milestones: phases 1 to 4 let a task edit and get reviewed across repos; phase 5 makes it mergeable; phases 6 and 7 complete the release.

Decided 23 Nov 2026: this ships as v0.9, before session protocols (now v0.10) and automation (now v0.11).

Decided 23 Nov 2026 by the owner:

- Base branch: each nested repo uses the branch checked out when the task starts, and the task merges back into that branch. This matches how the owner works with other CLIs, which edit whatever branch is checked out.
- Uncommitted changes at merge: a merge is refused only when an uncommitted file in the target repo is also changed by the task. Other uncommitted work stays in place. This applies to the root repo too.

Interim: v0.8.0 failed a task at start when its `files_allowed` pointed into a nested repo. Phase 2 removed that check now that nested worktrees are managed end to end.

### v0.10: session protocols and handoff

- Adapters move to the session protocols (Claude Code's stream-json session, `codex app-server`, ACP where agy supports it) behind a capability shape, keeping the one-shot CLI path as a fallback for any capability a provider lacks.
- Steer a running task with a message, and interrupt without losing the session.
- Context handoff on fallback: the next provider gets the brief plus a budgeted selection of the previous run (its requests, command results, and partial diff) instead of starting over.
- Native Windows OS confinement with a sandbox that meets the same tests; unconfined native execution is available in v0.7.3.

Scripted runs cover handoff from each of the three providers, including recent command output and the partial diff. Live sessions on Linux verified resume and interrupt for all three providers. Claude and Codex also passed live steering checks. The Windows MXC implementation runs local confinement checks before enabling the backend. It still needs a run on native Windows.

### v0.11: automation

- Scheduled and webhook-triggered runs (for example a nightly dependency update task), with HMAC-SHA256 signature verification (`X-Dalang-Signature-256` or `X-Hub-Signature-256`) on `/api/webhooks/:token` and optional per-automation auto-merge.
- Outside agents over MCP: Claude Code or Codex in a terminal can read projects, sessions, tasks, logs, and automations (`read-only`) or start/stop tasks, merge, reject, and trigger automations (`full-access`) through persistent hashed bearer tokens on the loopback-only `/mcp` endpoint, optionally scoped to one project.
- Managed in **Config → Automation** and over REST (`/api/automations`, `/api/mcp-tokens`), on schema v14. Automated and MCP-started runs each create a Quick session, so they go through the worktree, verify, review, and Gate 2 steps and stay visible in the UI. A trigger that arrives while another session has unfinished work is recorded as skipped.

### v0.14: general tasks (draft plan, 25 Nov 2026)

Status: draft. Nothing in this section is implemented.

#### Intent

DALANG should run work that is not code: writing and editing documents, research written up as a report, data clean-up, or a plan for an event. The team flow stays the same (the Lead plans, executors do the tasks, a checker and the reviewer judge the result, the user accepts). Users who do not write code should not meet coding words in the room, the web UI, or the wizard.

#### Where DALANG assumes code today

Read from source on 25 Nov 2026:

- Role names. The plan task role is `engineer` or `qa` (`PlanTaskRoleSchema`, `packages/shared/src/schemas.ts`). The seeded profiles are `coder-small`, `coder-medium`, and `coder-heavy`. The wizard, Config, and the terminal show "Coder, simple tasks (Bima)" and similar labels (`packages/web/src/i18n/*.ts`, `ROLE_LABEL` in `packages/cli/src/tui/team.ts`).
- Prompts. The Lead is told it is the "Lead architect" in Ask, Quick, and Discuss, and in Auto it may "delegate coding tasks" (`packages/core/src/services/lead.ts`). The seeded Lead role prompt says "the architect and planner of this project, not its coder" and asks for "a verify command that fails when the work is wrong" (`DEFAULT_ROLE_PROMPTS`, `packages/core/src/db/client.ts`).
- Verify is required. The plan task schema requires a non-empty `verify` command, and `tasks.verify` and `runs.verify_command` are `NOT NULL` in the database.
- Git is required. A project folder must be a git repository, or DALANG runs `git init` when the user ticks "Initialize git if missing" (`packages/core/src/services/project.ts`).
- Output is a diff. Every task runs in a git worktree, and the reviewer, the diff view, and Gate 2 all work on the task branch's diff.

A task whose result is a file (a report in Markdown, an edited CSV) already fits this flow in a git folder, apart from the required verify command and the coding words. A task whose result is only an answer, such as "compare these three suppliers", has no file to diff and nothing to merge.

#### Goals

- Neutral names in every user-facing surface, with stored ids unchanged.
- A plan task may have no verify command. The checker and the reviewer then judge the result against the acceptance criteria.
- A plan task may produce an answer instead of files. The answer is shown in the room and the web chat and saved in the project, and accepting it replaces the merge.
- Code projects behave as in v0.13: the same prompts for code work, the same verify, review, and merge.

#### Non-goals

- No project folder without git. DALANG keeps using git for checkpoints, rollback, and history of document work; "Initialize git if missing" stays the way in.
- No new tools for agents (web search, browsers, office files). Agents use what their CLI already offers.
- No renamed ids, profile names, routing keys, or API fields. Renaming stored values needs a migration and breaks saved automations and MCP clients for no user gain.
- No separate "general" product mode. The Lead decides per task.

#### Design

1. **Names (display only).** Labels (decided 25 Nov 2026):

   | Stored id | Label today | New label |
   | --- | --- | --- |
   | role `engineer`, profiles `coder-small`, `coder-medium`, `coder-heavy` | Coder (simple, medium, complex tasks) | Executor (light, medium, heavy tasks) |
   | role `qa`, profile `qa` | QA | Checker |
   | `lead`, `reviewer` | Lead, Reviewer | unchanged |

   The wayang names (Semar, Bima, Gatotkaca, Kresna, Srikandi, Arjuna) stay. Labels change in the web dictionaries (English and Indonesian), the terminal room and wizard, room report lines, `/help`, and the docs. The word "code" stays only where the action is about code, for example the diff of a code change.

2. **Neutral prompts.** The Lead prompts in `lead.ts` stop calling the Lead an architect and stop assuming a repository: Ask answers questions about "this project", Auto may "start tasks". The seeded role prompts are rewritten without coding words. `refreshDefaultRolePrompts` already replaces only prompts still equal to an earlier seed, so prompts the user edited are left alone.

3. **Optional verify.** `verify` becomes optional in the plan task schema and nullable in `tasks.verify` and `runs.verify_command`. With no command, the verify step is recorded as skipped (not passed), and the review prompt tells the checker and the reviewer to judge every acceptance criterion from the result itself. The Lead prompt keeps asking for a verify command whenever the work can be checked by a command, so code tasks keep one.

4. **Answer tasks.** A new plan task field `output`: `files` (default, today's behavior) or `answer`. An answer task:
   - runs in a worktree as now, so it can read the project files;
   - writes its answer to `.dalang/tasks/{id}/answer.md` and reports it in `task_result`;
   - must leave project files unchanged; a change is reported as a scope violation, as for `files_allowed` today;
   - is reviewed on `answer.md` instead of a diff;
   - at Gate 2 asks "accept" instead of "merge". Accepting copies the answer into the session history and to `.dalang/answers/{task-id}.md` in the main checkout, and removes the worktree. Rejecting works as today.
   The room, the web chat, and `/diff` show the answer text for answer tasks.

5. **Data model (schema v16).** `tasks.output_kind` (`files` or `answer`, default `files`); `tasks.verify` and `runs.verify_command` become nullable. Upgrade from v15 keeps every row as a `files` task with its command.

6. **Interfaces.** REST, MCP `start_task`, and automations accept the optional `verify` and `output` fields; omitting both keeps today's behavior.

#### Phases

| Phase | Name | Scope | Depends on | Size |
| --- | --- | --- | --- | --- |
| 1 | Names | Labels in web i18n (EN, ID), terminal room, wizard, Config, room reports, `/help`, docs | none | S |
| 2 | Prompts | Neutral Lead prompts and seeded role prompts, seed refresh for untouched profiles | none | S |
| 3 | Optional verify | Schema v16 nullable verify, skipped verify step, review prompt from acceptance criteria | none | M |
| 4 | Answer tasks | `output` field, `answer.md`, scope check, review on the answer, accept gate, room and web display | 3 | L |
| 5 | Proof and docs | Upgrade test v15 to v16, replay E2E for a no-verify files task and an answer task, live run, docs | 1 to 4 | M |

Milestones: phases 1 and 2 can ship alone as a patch release (names and prompts, no schema change). Phases 3 to 5 complete v0.14.

#### Done when

- A non-code goal in a new git folder (for example "write a two-page summary of these three PDFs, with a short comparison table") runs from plan to accepted result in the terminal room, with at least one answer task and one files task without a verify command.
- A code Quick task from plan to merge behaves as in v0.13, with verify and diff review.
- A search of the web dictionaries and the terminal labels finds no "Coder" or "QA" label.
- An app database upgraded from schema v15 keeps every task and run.

#### Decisions (made with the owner, 25 Nov 2026)

- Labels: Executor for the three task roles and Checker for QA, as in the table above. Lead and Reviewer keep their names.
- Phases 1 and 2 (names and prompts) ship first as a patch release on v0.13, before the schema work.
- Accepted answers live in `.dalang/answers/{task-id}.md` and in the session history, outside the user's files. A result the user wants as a project file is planned as a `files` task (for example `docs/report.md`), so it goes through review and merge like any other change.

### v0.12, v0.13, v0.15, v0.16: terminal room, Auto, and chat apps

The terminal team room shipped in v0.12.0. The Telegram and Slack bridges remain draft plans. [Terminal user guide](USAGE.md#terminal-team-room)

#### Intent

`dalang` opens a chat room in the terminal where the user and every agent profile talk in one timeline, like a team thread. Each profile reports in its own role. The web UI moves to `dalang web`. The same room can then be joined from Telegram and later Slack, with one bot per role.

#### Decisions (made with the user, 24 Nov 2026)

- `dalang` with no subcommand starts the terminal room. The current web server becomes `dalang web`.
- The room is a team discussion: the Lead, coders, and reviewer post their own messages (brief and plan, task start, task finish with diff stats, verify result, review verdict).
- Chat apps: Telegram first (v0.15), Slack after it (v0.16), on one shared bridge core. Renumbered on 25 Nov 2026 when general tasks took v0.14.
- One bot per role on each chat app. Group chats are supported.
- Starting coders and merging are allowed from Telegram and Slack. The user accepted that an allowlisted chat account can run and merge code on the machine.

#### Terminal team room (shipped in v0.12.0)

Implementation:

- The terminal client is a thin client of the server API, as the terminal research above recommends, so session and gate logic stays in core and the two UIs cannot drift. `dalang` checks `/api/health` on its port: it attaches when a server is running and otherwise starts the server in the same process. One server writes the database.
- Ink (React for the terminal) renders the room, reusing the TypeScript stack and the `shared` types.
- Routing: a message without a tag goes to the Lead. `@<profile>` sends it to that profile: an idle profile answers in Ask mode (read-only), and a running coder receives it as a steering message (v0.10).
- Slash commands: `/mode`, `/model`, `/project`, `/resume`, `/new`, `/config`, `/wizard`, `/diff` (opens `$PAGER`), `/merge`, `/reject`, `/stop`, `/run`, `/finish`, `/web` (opens the browser on the same session), `/help`, and `/exit`. Gates are answered with a y/n prompt in the room.
- Compatibility for one release: `dalang --port N` or `dalang --no-open` without a subcommand still starts the web server and prints a deprecation line. When stdin is not a TTY, `dalang` runs `dalang web`. The Docker `CMD` changes to `dalang web --no-open`.
- Schema v15: `messages` gains `author_profile_id` and `kind` (`chat`, `report`, `question`, `gate`, `status`). The web chat shows the same feed.

Done when:

- In a TTY, `dalang` runs a Quick task from plan to merge with no browser.
- `dalang web` behaves like `dalang` in v0.11.
- Tests cover routing: untagged to the Lead, `@reviewer` while idle to Ask mode, `@coder` while running to steering.
- The room renders on Linux, WSL 2, macOS Terminal, and Windows Terminal.

Review against this plan (24 Nov 2026):

- Met: the first three criteria, on Linux. Rendering on WSL 2, macOS Terminal, and Windows Terminal is not yet verified.
- Added beyond the defaults: `dalang room --port <number>` opens the room against a server on another port, since `dalang --port` keeps starting the web server for one release. `/run`, `/finish`, `/help`, and `/exit` join the slash commands. Requested after the first build (24 Nov 2026) and added: the header shows the Dalang mark, the 5 hour and weekly limits per provider, the active Lead model, and the agents running now; the room opens on a new session, and `/resume` and `/new` replace `/sessions`; the first-run wizard, `/wizard`, `/config`, and `/model` work in the terminal; the mouse wheel scrolls the timeline.
- v0.12.0 adds live elapsed time and activity summaries, Markdown replies, keyboard prompt recall, and a configured Lead fallback for Claude quota errors in Ask.
- v0.12.1 streams Ask replies into the room as they are written (`lead.text` events, 50 ms batches), loads React's production build with incremental Ink rendering at 60 fps, and makes new chats follow the Lead set in Config instead of the provider and model copied onto the project. Stack decision and render budgets: [TUI_PERFORMANCE.md](TUI_PERFORMANCE.md).
- Gate answers: `n` leaves the item waiting. For a task waiting for merge, `n` does not reject it; discarding the work takes `/reject`.
- Steering a coder whose CLI session cannot take messages is refused with 409 before anything is written to the room.
- Not yet verified: turning on the Antigravity keyring consent from the wizard, and the braille mark on terminals other than the one used. Editing a role's backup CLI is not in the terminal wizard: it keeps the saved backup, or suggests another ready CLI, and the web Config changes it.
- `/model` applies to the Lead's messages only, not to `@profile` questions or to running coders.
- Seen in the live run, not part of this phase: the Antigravity reviewer could not run `git status` in the task worktree because the worktree's `.git` link pointed to a gitdir it could not see; the review still passed by comparing files. Whether earlier releases show the same is not yet verified.

#### v0.13: Auto mode and terminal improvements

- Auto is the default for new chats. The Lead chooses whether to answer, discuss, plan, or start a validated task plan, and may request approval for sensitive actions. The sensitive-action decision is model-driven, not a deterministic production or data access control.
- Independent tasks can run in parallel. Dependent tasks wait for prerequisite merges, and Auto resumes eligible tasks after a merge. Guard still requires the user's merge decision.
- Auto can commit explicitly selected files in the active checkout after a user request. It preserves unrelated staging and refuses partially staged selected files. Git hooks and commit signing are disabled by DALANG's safe Git configuration.
- Shift+Tab cycles composer modes, `/restart` restores the selected room, and `/mouse` toggles mouse capture. Team fallback targets are editable per role in terminal Config. The terminal and browser render streamed JSON answers as readable text.
- v0.13.2 adds terminal title status: a spinner while the selected session works and `*` while input is needed. Free-form question detection is heuristic; restoration of the previous title depends on terminal support.
- v0.13.3 adds `Esc` in the terminal room to stop all running agents, tasks, subtasks, and Lead turns, enables `auto_stop` in Auto mode, allows `/stop` while a Lead turn is in flight, hardens process-exit settlement on abort/timeout, and adds `/update [check|clis|all]` (plus `dalang update --clis|--all` and `POST /api/providers/update-all`) with a persistent restart notification after Dalang updates. The terminal room header, running-agent row, `/model`, `/config`, and setup wizard show resolved model names (for example `Claude Opus 5.5`) instead of CLI aliases.
- v0.13.4 runs the terminal title spinner at the room spinner's 120 ms pace and includes the v0.13.3 changes; v0.13.3 was published to npm without a GitHub release.
- v0.13.5 sets the process name to `dalang`, so terminals that append the running command to the tab title no longer show the full `node` path.
- v0.13.6 shows the chat title and project in the terminal title (`Fix login · shop`) without the `DALANG ·` prefix, since such terminals already append `dalang`.
- This release does not add a database migration. Live provider behavior and non-Linux terminals still require separate verification.

#### v0.15: Telegram bridge

Checked against the Telegram Bot FAQ and Bot API pages on 24 Nov 2026 (Bot API changelog dated 22 Nov 2026). Items marked "not yet verified" need the probe phase.

- Delivery: long polling with `getUpdates`, so the server stays loopback-only and needs no public URL. `getUpdates` does not work while a webhook is set, so the bridge calls `deleteWebhook` on start. Updates wait at most 24 hours. Two processes polling one token confirm each other's updates; Dalang warns when a second poller is seen (detection method not yet verified).
- One bot per role, each with its own BotFather token, stored in the database like automation secrets (SANDBOX documents this).
- Receiving in groups: a bot in privacy mode receives only commands addressed to it, replies to its messages, and messages sent through it, and bots never see other bots' messages (Bot FAQ). A plain `@lead_bot ...` message may therefore not reach a privacy-mode bot. Default: each role bot is a group admin or has privacy mode turned off (BotFather, or `setMySettings` with `can_read_all_group_messages` since Bot API 10.5; the bot is re-added to the group). Every poller then receives the same message; the server keeps one copy per chat id and message id and routes it by the mention entities and `reply_to_message`. The opt-in bot-to-bot mode is not needed, since the server sends every bot's messages itself.
- Group rules: a message without a tag gets no reply. A tag or a reply to a role bot's message goes to that role. A direct message to a role bot goes to that role.
- Sessions: in a forum supergroup each session gets its own topic (`createForumTopic` needs the bot to be an admin with `can_manage_topics`). In other chats one session is active per chat, switched with `/session`.
- Gates: inline keyboard buttons. `callback_data` holds 1 to 64 bytes, so buttons carry short ids. Merge and coder start are allowed.
- Access: pairing with a one-time code shown in the terminal room or the web UI, then an allowlist of Telegram user ids per chat. Messages and button presses from other users are ignored.
- Limits (Bot FAQ): about one message per second per chat and 20 messages per minute per bot in a group. Each bot gets a send queue, and coder progress edits one status message instead of posting new ones. Long diffs go as a document (uploads up to 50 MB).
- Not yet verified: whether typing `@` in a group suggests bot usernames.

#### v0.16: Slack bridge

Checked against Slack developer docs and Slack help articles on 24 Nov 2026.

- Socket Mode: the app connects out over a WebSocket and needs no public request URL. Each app needs an app-level `xapp-` token and a bot `xoxb-` token. Socket Mode apps cannot be listed in the Slack Marketplace, so each user creates the role apps in their own workspace.
- One Slack app per role, so each role is a real bot user that can be mentioned. Rejected: one app posting under custom names with `chat:write.customize`, because those names cannot be mentioned and Slack limits that scope to user-approved use.
- Sessions map to threads (`thread_ts`). Mentions arrive as `app_mention` events; whether a mention inside a thread fires that event is not stated in the docs (not yet verified).
- Gates: Block Kit buttons. Merge and coder start are allowed, with the same user allowlist as Telegram.
- Limits: about one message per second per channel for `chat.postMessage`. Free workspaces allow up to 10 apps (the role apps use three or four) and show 90 days of history; Dalang keeps its own history.
- Install: by default members can install apps. Workspaces with app approval turned on need an owner to approve each role app.

#### Phases

| Phase | Name                                                                                                             | Depends On | Size |
| ----- | ---------------------------------------------------------------------------------------------------------------- | ---------- | ---- |
| 0     | Probe: Ink rendering per platform; Telegram group delivery to admin bots; `@` suggestions; Slack thread mentions | none       | S    |
| 1     | Room feed in core: author and kind on messages, role reports, schema v15                                         | none       | M    |
| 2     | Mention routing: untagged to Lead, idle profile to Ask, running coder to steering                                | 1          | M    |
| 3     | Terminal client: timeline, composer with `@` completion, slash commands, y/n gates, `$PAGER` diff                | 0, 2       | L    |
| 4     | Command rename: `dalang web`, compatibility alias, Docker `CMD`, `doctor`                                        | 3          | S    |
| 5     | Bridge core and Telegram adapter: pairing, allowlist, dedupe, topics, buttons, send queue                        | 0, 2       | L    |
| 6     | Slack adapter on the bridge core                                                                                 | 5          | M    |
| 7     | Docs and release for each milestone                                                                              | 4, 5, 6    | S    |

Milestones: v0.12 is phases 0 to 4 (the terminal room), v0.13 is Auto mode, v0.15 is phase 5 (Telegram), and v0.16 is phase 6 (Slack). Phases 3 and 5 can run in parallel after phase 2.

### Not planned

Remote access, relays, and companion phone apps require a separate deployment and authentication design. The optional DALANG password covers the local instance. The Telegram and Slack bridges (v0.15, v0.16) are outbound connections from the local server, not inbound access.

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
| macOS and Windows | Execution refuses to start on a platform without a sandbox unless the user opts in for that request, and the UI shows a warning. `sandbox-exec` is built in v0.5 and unit-tested; it has not run on an Apple host yet. | macOS is a P0 platform, so blocking it now would make the tool unusable there. Execution is where unconfined writes become real damage. |
| UI components | shadcn/ui, copied into the repo and restyled to `docs/DESIGN.md`. | Matches the stack in this PRD. Owning the component code keeps the design direction intact. |

