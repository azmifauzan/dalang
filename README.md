# DALANG

> One goal in, a running app out. A local web tool that orchestrates Claude Code, Codex, and Antigravity CLI as a small team.

**Status: v0.2 (Jalan) is implemented: projects, Discuss, Agree, List, Assign (routing & dispatch), Navigate (sequential execution, live logs, git checkpoints, stop/retry/resume, rollback), and provider status. Reviewer/fix loop and merge gate arrive in v0.3. See [docs/PRD.md](docs/PRD.md) for the full plan.**

DALANG is named after the traditional Javanese puppeteer who directs the whole show. The name is also an acronym for the workflow:

**D**iscuss · **A**gree · **L**ist · **A**ssign · **N**avigate · **G**uard

## What it does

You write one general goal in a chat. A Lead agent discusses it with you, confirms the scope, and breaks it into small tasks. A dispatcher then hands each task to an agent based on role, subscription, and the model you configured. A reviewer checks the result before anything is merged.

Everything runs on your machine and uses the official CLI logins you already have. No API keys, no extra tokens. You only step in at two gates: approving the brief and approving the merge.

| Step | What happens |
| --- | --- |
| Discuss | The Lead asks structured questions and clarifies the goal |
| Agree | The Lead writes a brief. You edit and approve it (gate 1) |
| List | The Lead splits the brief into milestones and tasks on a kanban board |
| Assign | The dispatcher routes each task to an agent profile, within per-provider limits |
| Navigate | Agents run headless, one task at a time, with live logs and a git checkpoint before and after each task |
| Guard | A reviewer runs the verify command and writes a review. You approve the merge (gate 2). Planned for v0.3 |

## Why

Developers with several coding-agent subscriptions run them by hand, one after another: plan in one tool, code in another, review in a third. That means manual handoffs, serial babysitting, uneven quota use, and no audit trail. DALANG automates the handoffs, spreads work across subscriptions, falls back when one hits a limit, and keeps every artifact (brief, plan, task, log, review) in your repo.

## Design at a glance

- **Local only.** The server binds to `127.0.0.1`. Not a SaaS, not multi-user.
- **One global instance, many projects.** Quota is shared across projects, so limits and fallback must see all of them. Global state lives in `~/.dalang/` (SQLite); per-project artifacts live in `<repo>/.dalang/` and are versioned in git.
- **Official CLIs only.** DALANG spawns the `claude`, `codex`, and `agy` binaries. It never calls model APIs directly and never reuses their OAuth tokens.
- **Provider and model are separate settings.** Each agent profile sets provider, model, effort, role prompt, permission mode, timeouts, and parallelism. Routing rules map task role and complexity to a profile, with a fallback.
- **Decisions come from files, not stdout.** Agents write JSON to `.dalang/`, validated with Zod. Invalid output is sent back for up to two retries.
- **Sandboxed runs (Linux).** Each CLI runs inside a `bwrap` wrapper so it can only write inside the project folder, with credential folders such as `~/.ssh` hidden. macOS and Windows have no sandbox yet, so runs there are unconfined and the UI says so. The known gaps are listed in the PRD.

Stack: TypeScript 7, Node.js 26 LTS, Fastify 5 + WebSocket, React 19 + Vite 8 + shadcn/ui on Tailwind 4, SQLite (better-sqlite3) + Drizzle, Zod 4, simple-git. The UI follows [docs/DESIGN.md](docs/DESIGN.md).

## Repository layout

| Package | Role |
| --- | --- |
| `packages/shared` | Zod schemas and DTO types shared by the server and the UI |
| `packages/core` | SQLite schema, provider adapters (`claude`, `codex`, `agy`), sandbox wrapper, Lead and execution services, git checkpoints |
| `packages/server` | Fastify API and WebSocket event stream, bound to loopback |
| `packages/web` | React UI (shadcn/ui on Tailwind, styled by `docs/DESIGN.md`) |
| `packages/cli` | The `dalang` command that starts the server and opens the browser |

## Run it

Requires Node.js 26, pnpm 12, and at least one logged-in CLI (`claude`, `codex`, or `agy`). On Linux, install `bubblewrap` so agent runs are confined to the project folder.

```bash
pnpm install
pnpm build
pnpm start        # serves http://127.0.0.1:4173 and opens the browser
```

`pnpm test` runs the unit and API tests, which use scripted agents and spend no quota.

Planned install for releases: `npx dalang`. The npm package is not published yet; run from a clone for now.

### A first run

1. **Projects:** create a new folder (DALANG runs `git init`) or open an existing repo.
2. **Discuss, Agree:** describe a goal, answer the Lead's question cards, press "Enough, write the brief", edit the brief, and approve it.
3. **List:** generate the plan, adjust tasks on the kanban board, and approve the plan.
4. **Assign, Navigate:** check which profile each task routes to, then start the sequential run. Watch the live log, stop a run, retry or resume a task, or roll a run back to its checkpoint.

Everything DALANG writes for a project lives in `<repo>/.dalang/` (brief, plan, per-task `result.json`, logs). Global state lives in `~/.dalang/`.

## CLI validation (18 Nov 2026)

The core assumptions were tested on Linux with Claude Code, Codex 0.169.0, and Antigravity CLI (`agy`) 1.5.10, all headless without a TTY.

| Check | Claude Code | Codex | agy |
| --- | --- | --- | --- |
| Headless run with JSON output | yes | yes | yes |
| Write files into `.dalang/` | yes | yes | yes |
| Resume a session across turns | yes | yes | yes |
| Output conforming to a simple JSON schema (not used by DALANG, see PRD) | yes | yes | yes |
| Refuses writes outside the project | yes | yes (but `/tmp` is writable) | **no** |
| Refuses outside writes when wrapped in `bwrap` | yes | yes | yes |
| Usage and limits readable before a run | `/usage` | `account/rateLimits/read` via `codex app-server` | `/usage` |

Key findings: `agy` writes outside the workspace even with its sandbox flag, so every adapter is wrapped in `bwrap`. Codex hangs unless stdin is closed, and its own sandbox cannot run inside `bwrap`, so DALANG lets `bwrap` be the boundary. `node-pty` is not required. See the PRD for the full list, including what is still untested (macOS and Windows, prompt-injection attacks on the guard prompt, and the reviewer, which arrives in v0.3).

## Verified with real models

Run on 18 Nov 2026 on Linux, through the HTTP API and the real sandbox, one run per scenario (so it shows the flow works, not how often).

| Phase | Scenario | Result |
| --- | --- | --- |
| v0.1 | Goal to approved brief and plan, one project per Lead provider | 3 of 3 valid, in 117 to 361 seconds |
| v0.2 | Notes REST API planned as 6 tasks and executed on Claude Code, Codex, and agy | 6 of 6 done in about 9.5 minutes, 27 of 27 tests passing, every endpoint checked by hand |
| v0.2 | Codex hit "Selected model is at capacity" mid-run | Idle timeout, then the backup profile finished the task |

## Known limits

- **Linux only for confinement.** `bwrap` keeps agents inside the project folder and hides credential folders. macOS and Windows have no sandbox yet, so execution there needs an explicit opt-in.
- **agy needs the desktop session bus** to sign in, so an agy run can still reach it. Provider state folders (`~/.claude`, `~/.codex`, `~/.gemini`) stay writable for token refresh. Both are listed in the PRD risks.
- **No reviewer yet.** A task is "done" when the agent reports it and its result file is valid. The reviewer, diff view, and merge gate are v0.3.
- **Scope is a warning.** Edits outside a task's `files_allowed` are recorded on the run, not blocked.
- **One task at a time.** Parallel runs and worktrees are v0.4.

## Roadmap

| Phase | Scope | Status |
| --- | --- | --- |
| v0.1 Rembuk | Projects, Lead chat, brief, plan and kanban, provider status page | Released |
| v0.2 Jalan | Routing and dispatch, sequential execution, live logs, git checkpoints, stop, retry, resume, rollback | Released |
| v0.3 Kawal | Reviewer and fix loop, diff view, approve merge, profiles and routing UI | Planned |
| v0.4 Paralel | Worktree per task, dependency graph, per-provider limits, quota fallback, usage stats | Planned |
| v1.0 | Polish, Windows support, docs, npm release | Planned |

## Documentation

- [Product requirements](docs/PRD.md)
- [Design direction](docs/DESIGN.md)
- [Changelog](CHANGELOG.md)

## License

[MIT](LICENSE)
