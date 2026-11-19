# DALANG

> One goal in, a running app out. A local web tool that orchestrates Claude Code, Codex, and Antigravity CLI as a small team.

**Status: v0.5.0 (Polish & Distribution) is implemented: `npx dalang` packaging and `dalang doctor`, multiple accounts per provider (`configDir`), rich model details from the CLIs (display names, `[1m]` variants, effort levels up to `max`, unavailable saved model indicator), token & API-equivalent cost statistics, process-level replay tests (quota reroute, review fix round, parallel merge, and headless browser E2E), side-effect-free health checks, hybrid hidden checkpoint refs (`refs/dalang/checkpoints/*`), optional push and GitHub PR after merge (`gh`), macOS `sandbox-exec` confinement, and full documentation. Next: v0.6 (UI revamp with a first-run wizard and Indonesian). See [docs/PRD.md](docs/PRD.md) for the full roadmap.**

DALANG is named after the traditional Javanese puppeteer who directs the whole show. The name is also an acronym for the workflow:

**D**iscuss · **A**gree · **L**ist · **A**ssign · **N**avigate · **G**uard

## What it does

You write one general goal in a chat. A Lead agent discusses it with you, confirms the scope, and breaks it into small tasks. A dispatcher then hands each task to an agent based on role, subscription, and the model you configured. A reviewer checks the result before anything is merged.

Everything runs on your machine and uses the official CLI logins you already have. No API keys, no extra tokens. You only step in at two gates: approving the brief and approving the merge.

| Step | What happens |
| --- | --- |
| Discuss | The Lead asks structured questions and clarifies the goal |
| Agree | The Lead writes a brief. You edit and approve it (gate 1) |
| List | The Lead splits the brief into milestones and tasks on a kanban board or topological dependency graph |
| Assign | The dispatcher groups tasks into waves, flags file overlaps, and routes each task with proactive quota fallback |
| Navigate | Non-overlapping agents run concurrently in isolated git worktrees within per-provider limits, with live logs and checkpoints |
| Guard | A reviewer runs the verify command and writes a review; you inspect diffs, approve merge onto main, or reject (gate 2), followed by post-merge integration tests |

## Why

Developers with several coding-agent subscriptions run them by hand, one after another: plan in one tool, code in another, review in a third. That means manual handoffs, serial babysitting, uneven quota use, and no audit trail. DALANG automates the handoffs, spreads work across subscriptions, falls back when one hits a limit, and keeps every artifact (brief, plan, task, log, review) in your repo.

## Design at a glance

- **Local only.** The server binds to `127.0.0.1`. Not a SaaS, not multi-user.
- **One global instance, many projects.** Quota is shared across projects, so limits and fallback must see all of them. Global state lives in `~/.dalang/` (SQLite); per-project artifacts live in `<repo>/.dalang/` and are versioned in git.
- **Official CLIs only.** DALANG spawns the `claude`, `codex`, and `agy` binaries. It never calls model APIs directly and never reuses their OAuth tokens.
- **Provider and model are separate settings.** Each agent profile sets provider, model, effort, role prompt, permission mode, timeouts, and parallelism. Routing rules map task role and complexity to a profile, with a fallback.
- **Decisions come from files, not stdout.** Agents write JSON to `.dalang/`, validated with Zod. Invalid output is sent back for up to two retries.
- **Sandboxed runs (Linux & macOS).** Each CLI runs inside `bwrap` (Linux) or `sandbox-exec` (macOS) so it can only write inside the project folder and its own config dir, with credential folders such as `~/.ssh` hidden. Windows runs through WSL 2 in v0.5. See [docs/SANDBOX.md](docs/SANDBOX.md).

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

Requires Node.js 24+ (Node.js 26 LTS recommended; checked on 24 and 26), git, and at least one logged-in CLI (`claude`, `codex`, or `agy`). On Linux, install `bubblewrap` (and `xdg-dbus-proxy` if you use agy); on macOS `/usr/bin/sandbox-exec` is used automatically; on Windows run inside WSL 2.

```bash
# Check environment, sandbox, and CLI logins
npx dalang doctor

# Start the local server (http://127.0.0.1:4173) and open the browser
npx dalang
```

Or run from a local clone:

```bash
pnpm install
pnpm build
pnpm --filter dalang doctor
pnpm start        # serves http://127.0.0.1:4173 and opens the browser
```

`pnpm test` runs the unit, replay, browser E2E, and CLI doctor tests without spending model quota. See [docs/INSTALL.md](docs/INSTALL.md) for full platform setup.

### A first run

1. **Projects:** create a new folder (DALANG runs `git init`) or open an existing repo.
2. **Discuss, Agree:** describe a goal, answer the Lead's question cards, press "Enough, write the brief", edit the brief, and approve it.
3. **List:** generate the plan, adjust tasks on the kanban board, and approve the plan.
4. **Assign, Navigate:** inspect the dependency graph, file overlaps, and routed profiles, then start the parallel run. Watch concurrent worktree logs, stop individual tasks or the whole queue, retry or resume a session, or roll back to a checkpoint.

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

Key findings: `agy` writes outside the workspace even with its sandbox flag, so every adapter is wrapped in `bwrap`. Codex hangs unless stdin is closed, and its own sandbox cannot run inside `bwrap`, so DALANG lets `bwrap` be the boundary. `node-pty` is not required. See the PRD for the full list, including what is still untested (macOS and Windows, prompt-injection attacks on the guard prompt, and a real quota-limit reroute).

## Verified with real models

Run on 18 and 19 Nov 2026 on Linux, through the HTTP API and the real sandbox, one run per scenario (so it shows the flow works, not how often).

| Phase | Scenario | Result |
| --- | --- | --- |
| v0.1 | Goal to approved brief and plan, one project per Lead provider | 3 of 3 valid, in 117 to 361 seconds |
| v0.2 | Notes REST API planned as 6 tasks and executed on Claude Code, Codex, and agy | 6 of 6 done in about 9.5 minutes, 27 of 27 tests passing, every endpoint checked by hand |
| v0.2 | Codex hit "Selected model is at capacity" mid-run | Idle timeout, then the backup profile finished the task |
| v0.3 | Five small projects (15 tasks), each task executed, verified, reviewed by another provider, diffed, and merged | 15 of 15 passed review within 2 rounds (13 on round 1, 2 on round 2), 96 of 96 tests passing |
| v0.4 | Two independent tasks on Claude Code, each in its own worktree | Both ran at the same time, passed review on round 1, merged cleanly, 6 of 6 tests passing |

## Known limits

- **Linux only for confinement.** `bwrap` keeps agents inside the project folder and hides credential folders. macOS and Windows have no sandbox yet, so execution there needs an explicit opt-in.
- **agy can read your desktop keyring.** It signs in through the Secret Service, and the filtered bus it gets (`xdg-dbus-proxy`, needed along with a desktop session) allows that whole service, so an agy run can read every secret stored there. Claude Code and Codex runs cannot. This is **off by default**: until you tick "Allow Antigravity to read the desktop keyring" on the Providers page, a task routed to agy runs on its backup profile instead, and agy cannot be a Lead inside the sandbox. Provider state folders (`~/.claude`, `~/.codex`, `~/.gemini`) stay writable for token refresh, which is listed in the PRD risks.
- **The review sample is small.** 15 tasks in five small projects passed review; larger code bases and the agy reviewer are untested. Windows and macOS hosts are untested. Parallel worktrees were tried once with real Claude Code (two tasks); a real quota-limit reroute has not been observed (verified via scripted runner tests).
- **Scope is checked after the fact.** Edits outside a task's `files_allowed` are not blocked while the agent works, but they fail the review (whatever the reviewer says), so the task cannot be merged without your override. Tasks with overlapping `files_allowed` are serialized rather than run concurrently.

## Roadmap

| Phase | Scope | Status |
| --- | --- | --- |
| v0.1 Rembuk | Projects, Lead chat, brief, plan and kanban, provider status page | Released |
| v0.2 Jalan | Routing and dispatch, sequential execution, live logs, git checkpoints, stop, retry, resume, rollback | Released |
| v0.3 Kawal | Reviewer and fix loop, diff view, approve merge, post-merge integration, profiles and routing in UI | Released |
| v0.4 Paralel | Worktree per task, dependency graph, per-provider limits, quota fallback, usage stats | Released (one real two-task parallel run; quota reroute scripted only) |
| v0.5 | `npx dalang` and `dalang doctor`, several accounts per provider, model details, token & cost statistics, replay & browser tests, hidden checkpoint refs, macOS sandbox, push and pull request, docs | Implemented |
| v0.6 | UI revamp: first-run wizard, guided five-step flow, wayang stage during work, Config page, Indonesian and English | Planned |
| v0.7 | Agent delegation: a running agent splits its task into subtasks on other profiles over MCP | Planned |
| v0.8 | Session protocols, steering, context handoff on fallback, native Windows | Planned |
| v0.9 | Scheduled and webhook runs, outside agents over MCP | Planned |

## Documentation

- [Installation & platform setup](docs/INSTALL.md)
- [Providers, models & multi-account setup](docs/PROVIDERS.md)
- [Sandbox & security model](docs/SANDBOX.md)
- [Troubleshooting](docs/TROUBLESHOOTING.md)
- [Product requirements](docs/PRD.md)
- [Design direction](docs/DESIGN.md)
- [Changelog](CHANGELOG.md)

## License

[MIT](LICENSE)
