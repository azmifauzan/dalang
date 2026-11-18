# DALANG

> One goal in, a running app out. A local web tool that orchestrates Claude Code, Codex, and Antigravity CLI as a small team.

**Status: v0.1 (Rembuk) is implemented: projects, Discuss, Agree, List, and the provider status page. Nothing executes tasks yet; that starts in v0.2. See [docs/PRD.md](docs/PRD.md) for the full plan.**

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
| Navigate | Agents run headless in sandboxed git worktrees, with live logs |
| Guard | A reviewer runs the verify command and writes a review. You approve the merge (gate 2) |

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
| `packages/core` | SQLite schema, provider adapters (`claude`, `codex`, `agy`), sandbox wrapper, Lead services |
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

Planned install for releases: `npx dalang`.

## CLI validation (18 Nov 2026)

The core assumptions were tested on Linux with Claude Code, Codex 0.169.0, and Antigravity CLI (`agy`) 1.5.10, all headless without a TTY.

| Check | Claude Code | Codex | agy |
| --- | --- | --- | --- |
| Headless run with JSON output | yes | yes | yes |
| Write files into `.dalang/` | yes | yes | yes |
| Resume a session across turns | yes | yes | yes |
| Output conforming to a JSON schema | yes | yes | yes |
| Refuses writes outside the project | yes | yes (but `/tmp` is writable) | **no** |
| Refuses outside writes when wrapped in `bwrap` | yes | yes | yes |
| Usage and limits readable before a run | `/usage` | `account/rateLimits/read` via `codex app-server` | `/usage` |

Key findings: `agy` writes outside the workspace even with its sandbox flag, so every adapter is wrapped in `bwrap`. Codex hangs unless stdin is closed, and its own sandbox cannot run inside `bwrap`, so DALANG lets `bwrap` be the boundary. `node-pty` is not required. See the PRD for the full list, including what is still untested (behavior when a limit is actually hit, prompt-injection attacks on the guard prompt).

## Roadmap

| Phase | Scope |
| --- | --- |
| v0.1 Rembuk | Projects, Lead chat, brief, plan and kanban, provider status page. No execution yet |
| v0.2 Jalan | Sequential execution, all three adapters, live logs, checkpoints, stop/retry |
| v0.3 Kawal | Reviewer and fix loop, diff view, approve merge, profiles and routing UI |
| v0.4 Paralel | Worktree per task, dependency graph, per-provider limits, quota fallback, usage stats |
| v1.0 | Polish, Windows support, docs, npm release |

## Documentation

- [Product requirements](docs/PRD.md)
- [Design direction](docs/DESIGN.md)

## License

[MIT](LICENSE)
