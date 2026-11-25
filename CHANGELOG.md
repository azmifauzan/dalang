# Changelog

Dates are 2026. Versions follow the phases in [docs/PRD.md](docs/PRD.md).

## 0.13.4 (Smoother terminal title spinner), 25 Nov

- The terminal title spinner now advances every 120 ms, the same pace as the status-line spinner in the room, instead of every 250 ms. Terminals that throttle title updates can still show it less smoothly.
- Includes the 0.13.3 changes (`Esc` stop-all, `/update`, readable model labels). Version 0.13.3 was published to npm without a GitHub release. No database migration is required.

## 0.13.3 (Stop all with Esc and /update command), 25 Nov

- **Stop all running work reliably.** Pressing `Esc` in the terminal room immediately stops all running agents, tasks, subtasks, and in-flight Lead or `@<profile>` turns (the live status bar shows `Esc to stop`; when idle, `Esc` still clears the composer). `/stop` and `/exit` remain submittable while the Lead is mid-turn, `POST /api/projects/:id/execution/stop` cancels both task queues and active Lead turns, and `NodeCliRunner` no longer hangs waiting for stdio `close` if a grandchild holds pipes open after abort or timeout.
- **Auto mode can stop running tasks.** Asking the Lead in Auto mode to stop active coders can now trigger `auto_stop` to stop running tasks in the session directly.
- **`/update` command and connected CLI updates.** Added `/update [check|clis|all]` in the terminal room and `dalang update [--check|--clis|--all] [--json]` in the shell. `/update` checks npm for the latest release, installs it, and shows both a timeline notice and a persistent restart banner prompting `/restart`. `/update clis` (and `POST /api/providers/update-all`) updates every connected provider CLI (`installed && loggedIn`) in sequence with per-CLI version reporting and isolated error handling. Startup also announces an available DALANG update once when version checks are enabled. No database migration is required.
- **Readable model labels in the terminal room.** The header, running-agent row, `/model`, `/config`, and setup wizard now display resolved model names (such as `Claude Opus 5.5` or `GPT-5`) instead of raw CLI aliases.

## 0.13.2 (Terminal title status), 25 Nov

- The terminal title shows an animated spinner while the selected session is processing and `*` when a question or gate is waiting for input. Free-form questions are detected from punctuation; title restoration depends on terminal support.
- Includes the web screenshot and Auto composer hint changes from the unpublished 0.13.1 snapshot. No database migration is required.

## 0.13.1 (Unpublished snapshot), 25 Nov

- Replaced the browser walkthrough screenshots with the current v0.13 interface, using isolated demo projects and replayed responses. The README now shows the Auto composer.
- Corrected the browser composer hint for Auto, which previously described the Full workflow.

## 0.13.0 (Auto mode and terminal controls), 25 Nov

- **Auto mode.** New chats default to Auto. The Lead chooses between answering, brainstorming, planning, and starting a validated task plan. Independent tasks can run in parallel; dependent tasks continue after their prerequisites are merged. Task review and merge approval remain in Guard.
- **Sensitive actions.** The Lead is instructed to request approval for actions involving production, data, credentials, billing, and other sensitive operations. This decision depends on the model and does not enforce a production or data security boundary.
- **Commit selected files.** Auto can handle an explicit request to commit files in the active checkout. Unrelated staged changes are preserved. A selected file with both staged and unstaged changes is refused. DALANG disables Git hooks and signing for the commit under its safe Git configuration.
- **Terminal controls.** Shift+Tab cycles modes, `/restart` restores the selected room, and `/mouse` toggles mouse capture for selection. JSON answers stream as readable text, including fenced output.
- **Fallback and language.** Every team role's fallback can be configured in the TUI, including provider, model, effort, and account. Ask and Auto support the configured Lead fallback on quota errors. The Lead follows the language of the user's latest question.
- **Documentation.** Updated the guides and added a terminal room screenshot with demonstration data. No database migration is required.

## 0.12.1 (Live replies in the terminal room), 25 Nov

- **Replies stream in the terminal room.** An Ask reply from the Lead or an `@<profile>` now shows its latest lines under the timeline while it is written, instead of appearing only when the turn ends. Claude Code runs Ask with `--include-partial-messages`; Codex streams through its app-server text deltas; Antigravity streams its message chunks. For a reply written as the JSON answer contract, the room shows the `answer` text, not the JSON. The server sends the text as `lead.text` WebSocket events in 50 ms batches. Partial-message events are not written to the turn log. The browser chat still shows the reply when each message finishes. Verified live in a pseudo-terminal with Claude Code (a 30-line reply arriving line by line) and Codex (a one-sentence reply); Antigravity streaming has not run live yet.
- **Faster typing in the terminal room.** The CLI now loads React's production build (0.12.0 loaded the development build), redraws only the rows that change, and allows 60 frames a second. On a 160×50 virtual terminal with a 300-message session, CPU for 40 keystrokes fell from 308 ms to 56 ms and output per keystroke from 4,893 to 273 bytes. `NODE_ENV` is restored before agents and verify commands run. Measured inside Node, not in a terminal emulator. [Stack decision, rules, and budgets](docs/TUI_PERFORMANCE.md)
- **Fix: the Lead set in Config is the one that answers.** New chats copied the CLI and model saved on the project when it was created, so changing the Lead under `/config` or **Config → Agents → Team** changed the header but not the CLI that ran. New chats, Full planning, and the browser composer now start from the Lead profile, with its effort when the chat runs on that CLI. A chat already started keeps its CLI and model; switch it with `/model` or the composer's model picker.
- **Known issue (since 0.12.0 or earlier, still open in 0.12.1; Claude CLI behavior): Haiku answers Ask as Sonnet.** Ask runs Claude read-only with `--permission-mode plan`, and in plan mode Claude Code answers with Sonnet even when `--model haiku` is set (checked with Claude Code on 25 Nov: the `init` event names Haiku, the reply comes from Sonnet). Quick and Full coding runs are not affected. Choose Sonnet or another provider for the Lead if you need the model to match.
- **Room benchmark.** `node packages/cli/scripts/tui-bench.mjs` checks frame time and keystroke latency against fixed budgets under streaming, four agents, and a diff panel.

## 0.12.0 (Terminal team room), 24 Nov

- **`dalang` opens a team room in the terminal.** The Lead, coders, and reviewer post under their own profile names in one timeline: plans, task start, task finish with diff stats, verify results, review verdicts, merges, and rejections. Gates are answered with `y` or `n`; `n` leaves the item waiting, and only `/reject` discards a task. The header shows the Dalang mark, the 5 hour and weekly limit left for each installed provider as in the web usage bar, the model the Lead will answer with (and whether it was chosen with `/model`, comes from the session, or from the Lead profile), and the agents running now with their models. The room opens on a new session; `/resume` picks an earlier one and `/new` starts another. Slash commands also cover modes, projects, `/diff` in `$PAGER`, merge, reject, stop, `/web` to open the same session in the browser, and `/exit`. The room attaches to a server already running on the port, or starts one and stops it on exit.
- **Live progress in the terminal.** A spinner and elapsed timer show who is working, with a short status such as reading files or running verification. The timeline formats Markdown replies, and `↑` / `↓` recall earlier prompts or restore the draft. `/resume` loads prompt history from the selected chat.
- **Kayon Gapuran mark.** The terminal header uses a redrawn Braille gunungan with a peaked outline, tree, gate, and handle.
- **Claude quota fallback in Ask.** The Lead can retry a quota-limited question on a configured backup provider or another signed-in account. The retry keeps the conversation and uses read-only access.
- **Terminal and browser guides.** The README starts with terminal setup and project commands, with a separate browser walkthrough.
- **Setup wizard in the terminal.** A fresh install (no project yet) opens the same four steps as the web: how Dalang works, the agent CLI check (with the Antigravity keyring consent), the team (provider, model, and effort per role, with a backup CLI kept or suggested), and the first project. `/wizard` opens it again.
- **`/model` and `/config`.** `/model` lists every model of every connected provider, marks the active one, and asks for a reasoning effort; the choice is sent with your next messages. `/config` covers language, provider limits refresh, update checks, the agent CLIs, and the agent team. Theme, the app password, and factory reset stay in the web Config.
- **Mouse wheel and scrolling.** The wheel scrolls older messages 3 rows a notch, and the footer shows the rows above and below. Scrolling past an end no longer leaves offset to undo. Hold `Shift` to select text, or set `DALANG_NO_MOUSE=1`.
- **`dalang web` starts the browser workspace.** Without a terminal (Docker, a service, piped output) `dalang` runs `dalang web`. `dalang --port` and `dalang --no-open` without a subcommand still start the web server for this release and print a deprecation notice. `dalang room --port <number>` opens the room against a server on another port. The Docker image runs `dalang web --no-open`.
- **`@<profile>` routing.** An untagged message or `@lead` goes to the Lead. `@<profile>` asks an idle profile in read-only Ask mode without changing the session mode; for a coder that is running, it becomes a steering message. A run that cannot take steering refuses the message and leaves the room unchanged.
- **Role reports in the browser too.** The web chat shows the same reports with a badge per event.
- **Schema v15** adds `kind` and `author_profile_id` to `messages` and fills them for existing chats. The upgrade runs automatically. Back up `~/.dalang` first; older builds cannot open a v15 database.

## 0.11.1 (Webhook hardening), 24 Nov

- **Webhook replay protection.** `X-Dalang-Signature-256` now signs `<timestamp>.<raw body>` and needs `X-Dalang-Timestamp` (Unix seconds); a timestamp more than 5 minutes off is refused. Scripts written for 0.11.0 must add the timestamp. A request that already started a run is refused with `409`. `X-Hub-Signature-256` still signs the body alone, and a repeat of it is refused for 24 hours while DALANG keeps running.
- **Webhook body kept out of the prompt by default.** The body reaches the coder only where the instructions contain `{{payload}}`, inside a block marked as data that the body cannot close. 0.11.0 appended the body to every webhook task. The `{{event}}` value is reduced to letters, digits, and `_.:/-`.

## 0.11.0 (Automation and outside agents over MCP), 24 Nov

- **Scheduled runs.** A project can run a task on a 5-field cron schedule in local time (`0 2 * * *`, `*/15 * * * *`, `@daily`, `@hourly`, `@weekly`, `@monthly`). Each run is a Quick session that goes through the worktree, verify, and review steps, so it shows up in the sidebar like any other session. Auto-merge after a passing review is optional per automation.
- **Signed webhooks.** A webhook automation gets its own `/api/webhooks/<token>` URL and a signing secret that is shown once. DALANG checks an HMAC-SHA256 signature of the raw body in `X-Dalang-Signature-256` or `X-Hub-Signature-256`. The task instructions can use `{{event}}` and `{{payload}}`. A trigger that arrives while another session still has unfinished work is recorded as skipped.
- **Outside agents over MCP.** Claude Code or Codex in a terminal can connect to the loopback `/mcp` endpoint with a token from **Config → Automation**. A `read-only` token can list and read projects, sessions, tasks, run logs, and automations. A `full-access` token can also start, stop, merge, and reject tasks, and trigger automations. Tokens can be limited to one project. DALANG stores only a hash of each token.
- **Config → Automation.** New tab for schedules, webhooks, run history, and MCP tokens, with setup snippets for Claude Code and Codex.
- **Schema v14** adds `automations`, `automation_runs`, and `mcp_tokens`. The upgrade from v13 runs automatically. Back up `~/.dalang` first; older builds cannot open a v14 database.

## 0.10.0 (Session protocols and handoff), 24 Nov

- **Session protocols.** Claude runs keep one `claude` process open over stream-json input, Codex runs use `codex app-server`, and Antigravity runs use ACP (`agy acp`). Each adapter falls back to the one-shot CLI when the protocol is unavailable.
- **Steer and interrupt.** Send a message to a running Claude or Codex task from the Work or Quick view. Stop interrupts the turn and keeps the session, so **Resume session** continues it. Antigravity can be interrupted but not steered.
- **Handoff on fallback.** A backup provider receives the brief, recent run events, and the partial diff instead of starting over.
- **Native Windows confinement.** Codex's MXC backend confines provider, verify, and integration processes after local confinement checks pass. Not yet run on native Windows.
- **No schema change.** The database stays at v13.

## 0.9.2 (Verify commands run in the task worktree), 23 Nov

- **Verify commands no longer check your real checkout.** A planned verify command such as `cd /home/you/project && tail -n1 README.md` ran against the project folder instead of the task worktree, so it could pass or fail on files the task never touched, and agents reported the task as blocked. DALANG now rewrites the project's absolute path to a relative one when a task starts, for stored tasks and delegated subtasks too, and tells the Lead to write relative verify commands.

## 0.9.1 (Antigravity coder fix), 23 Nov

- **Antigravity coder runs start again.** Since 0.8.0 every Antigravity coder run failed at start with `--settings: unknown setting "mcpServers"` on `agy` 1.5.15, so the default coder profiles could not run and fell back to another provider. `agy` takes MCP servers only from its saved config, so DALANG no longer passes delegation settings to it. Agent delegation therefore works from Claude Code and Codex coders; an Antigravity coder works on its task without the delegation tools and without the delegation instructions in its prompt. Delegated subtasks can still run on Antigravity. Antigravity reviews were never affected.

## 0.9.0 (Workspace projects with nested repositories), 23 Nov

Workspace folders whose top-level subdirectories are their own standalone Git repositories (such as a root repo ignoring `frontend/`, `backend/`, and `scheduling-service/`) can now be opened and worked on as a single DALANG project.

- **Schema v13 (`task_repos` and `run_repo_checkpoints`).** Records each task's root and nested repositories (base branch, base SHA, task branch, worktree path, per-repo merge commit, push timestamp, and PR URL) plus per-run checkpoint SHAs and hidden refs per repo, with an automatic v12 to v13 upgrade.
- **Nested worktree lifecycle & sandbox confinement.** Detects top-level standalone repositories (excluding git submodules and deeper repos), creates root and nested worktrees from each repo's currently checked-out branch, removes nested worktrees before root on merge/reject/discard/retry/cleanup/delete, and binds each nested worktree's `.git` link file read-only in both Linux `bwrap` and macOS `sandbox-exec`. Removes the v0.8.0 interim block on nested-repo `files_allowed`.
- **Per-repo checkpoints, scope checks, and labeled diffs.** Runs checkpoint commits, hidden checkpoint refs, changed-file collection, and `files_allowed` scope validation across all repos with root-relative paths. Joins diffs with repository headers for the reviewer and shows repo badges in the **Review & merge** and **Quick** diff views.
- **Per-repo Gate 2 merge, dirty-overlap check, and push/PR.** Refuses merges only when uncommitted edits in a target repo overlap files modified by the task (leaving unrelated uncommitted edits intact, including in the root repo), creates one `--no-ff` merge commit per changed repo, restores earlier merged repos with `git reset --keep` if a later repo fails, and pushes / opens pull requests against each changed repo's own Git remote.
- **Live check.** On 23 Nov a Quick task on the `sei-office` workspace (against a copy of the app data) changed `frontend/` and `scheduling-service/` through a Claude coder with an Antigravity review. Gate 2 merged one commit into `dev` and one into `feat/employee-sync-tanpa-email`, left `backend/` untouched, and kept unrelated uncommitted files. Discarding a task removed every worktree and task branch.
- **Known issue, fixed in 0.9.1.** Antigravity coder runs failed at start with `--settings: unknown setting "mcpServers"` on `agy` 1.5.15.
- **Per-repo rollback and delegation.** Rolls back merged or unmerged runs across every affected repo with dirty/external-commit safety checks, and gives delegated subtasks nested worktrees branched from the parent task's branches that merge back per repo.

## 0.8.0 (Agent delegation), 23 Nov

Running coder tasks can now split independent work into delegated subtasks on other profiles or providers through DALANG's loopback MCP server.

- **Loopback MCP endpoint (`/mcp`) with run-scoped bearer tokens.** Each depth-0 coder run receives a cryptographically random bearer token scoped to that run (validated with constant-time comparison) that expires as soon as the run ends. Adapters wire the MCP server via `--mcp-config` (Claude Code), `mcp_servers.dalang` with `DALANG_MCP_TOKEN` env var (Codex), or `--settings` (Antigravity), delete temporary config files on exit, and redact the token before writing logs or emitting events so it never enters logs.
- **MCP delegation tools (`delegate_task`, `task_status`, `task_cancel`).** Supports `wait` and `async` modes, optional profile or provider/model/effort selection, and strict `files_allowed` subset validation against the parent task's allowed globs.
- **Real DALANG subtasks merging into the parent branch (schema v12).** Adds `delegated_by_run_id`, `delegation_depth`, and `merge_target_branch` on `tasks` with an automatic v11 to v12 migration. Each subtask runs in its own worktree branched from the parent task branch, runs verify and automated review, and merges back into the parent branch (never directly into main), so the parent's own review and Gate 2 diff include the combined changes.
- **Delegation limits and lifecycle.** Enforces depth 1 (subtasks receive no MCP config and cannot delegate further), a configurable subtask cap per task (default 6), global `ProviderLimiter` accounting with deadlock-safe slot yielding for same-account `wait` calls, serialization of overlapping sibling subtasks, and automatic cancellation of child subtasks whenever the parent task stops.
- **Work UI and read-only native subagents.** Groups delegated subtasks under their parent task in **Work** and **Quick**, marks subtask nodes in **Dependency graph**, streams delegation/merge events into the **Activity feed**, and parses native CLI subagents (Claude `Task`/`Agent` tool calls and Antigravity batches) into a read-only panel in the run inspector.
- **Model versions and wizard fallback.** Claude models are listed with their versions (for example Claude Opus 5.5) in every model list. The first-run wizard's fallback now has model and effort selects in the same layout as the primary row, and saving it keeps the model, effort, and account already set in Config.
- **Workspace folders with nested repositories.** A task whose `files_allowed` points into a top-level folder that is its own git repository now fails before any agent runs, with a message naming the folder. Full support for such workspaces is planned for v0.9. [Roadmap](docs/PRD.md#v09-workspace-projects-with-nested-repositories-released-23-nov-2026)
- **Upgrading.** Databases from v0.7.0 and later upgrade to schema v12 on first start with projects, sessions, settings, and profiles kept. Back up the data directory first; older builds cannot open a v12 database. [Update and backup](docs/INSTALL.md#database-upgrades)

## 0.7.4, 23 Nov

- Support database schema v11 and preserve the v11 profile and routing upgrades when reopening a database.
- Add the `dalang update` command and improve the settings and setup experience.
- If an older CLI cannot start with a newer database, install this release directly instead of running `dalang update` from that older CLI. Do not delete or downgrade the database.

## 0.7.3 (Native Windows support), 21 Nov

- Fix native Windows PATH lookup, executable discovery, and quoted verification commands through `cmd.exe`.
- Use instruction pointers when Windows cannot create `CLAUDE.md` and `AGENTS.md` symlinks, preserving user-owned files.
- Normalize task artifact paths in agent prompts and JSON repair requests. Clarify that required task result metadata is exempt from application file scope.
- Forward explicit unconfined consent to post-merge integration runs. Linux and macOS retain their platform shells and sandbox behavior.
- Pin the source package manager and use SQLite's packaged native binaries without an unnecessary C++ build.
- Ship through GitHub Releases with an npm-installable tarball and `SHA256SUMS`. The npm registry remains on v0.7.2.
- Verify 104 applicable Windows tests in staged runs, 107 Linux regression tests, and a live Codex Quick flow through review, merge, and post-merge integration. Five Windows file-symlink/FIFO tests and two Linux Windows-only tests are skipped according to available OS facilities. Native macOS execution remains unverified.

## 0.7.2 (Chat images, local sign-in, and Docker), 20 Nov

- **Images in Ask, Quick, and Full.** Pick files with the paperclip or paste screenshots into the composer when using Claude Code or Codex. Send up to three PNG, JPEG, or WebP images per message, each up to 4 MiB. Reopen the saved chat to see its images. [Attach images](docs/USAGE.md#attach-images)
- **Optional local password.** Enable DALANG login in **Config → Security**. It starts off. When enabled, the gunungan marks the sign-in screen and the Sign out icon appears at the far right of the sidebar footer. [Set a password](docs/INSTALL.md#require-a-dalang-password)
- **Docker Compose.** Build and run a localhost container with Claude Code, Codex, Antigravity CLI, Git, and bubblewrap installed. The data volume retains DALANG state, provider sign-ins, and updated binaries. [Docker setup](docs/INSTALL.md#run-with-docker)
- **CLI updates.** In **Config → Agents**, run the installed provider's updater and see its refreshed version. This works for all three providers. [Provider updates](docs/PROVIDERS.md#update-provider-clis)
- **Upgrade.** Schema v10 adds stored chat images. Back up your data before upgrading if you may need to return to an older build. The npm package also includes the clearer `doctor` command guidance from v0.7.1. [Update and back up](docs/INSTALL.md#update-dalang)

## 0.7.1, 20 Nov

`doctor` now shows the `npx dalang-cli` commands for starting DALANG and rerunning checks. It explains that the standalone `dalang` command is available after `npm install -g dalang-cli`.

## 0.7.0 (Session modes and chat), 20 Nov

A project opens into a chat with three modes. **Ask** answers repository questions, **Quick** takes a one-task fix from plan to merge in the chat, and **Full** guides a larger change through discussion, brief, plan, work, and review. Every task still runs in a worktree with verification, automated review, and a human merge decision. [User guide](docs/USAGE.md)

Linux verification covered typecheck, build, and 102 automated tests (88 core, 9 server, 5 CLI). The server tests run the built UI in headless Chromium with replayed agent output for all three modes, the v0.6 upgrade, and Indonesian UI strings. Live progress was checked against Antigravity logs. Real CLI runs for Quick and Full and a macOS run are still open.

**Sessions and modes**
- **Chat first.** Opening a project shows a heading with the composer in the middle and creates no session. The first message creates one. A chat with messages keeps the composer pinned to the bottom of the window.
- **Choosing a mode changes nothing until you send.** The Ask, Quick, and Full buttons decide what the next message does. A session moves up when a message is sent in a higher mode, and the Lead may suggest a switch with a button but never switches on its own. A question can be asked in any session at any time without changing its mode. Quick is not offered inside a Full session until its work is finished.
- **Quick.** The Lead returns one mini plan (a single task and its allowed files, no brief). One click on `Run`, then verify, review, and the merge approval on one screen. A request the Lead judges too large offers `Switch to Full (keeps findings)`.
- **Saved sessions.** Each project lists its sessions in the sidebar (newest first, mode mark, a pulsing dot while the Lead answers). Reopening one restores its conversation, brief, plan, and board. Sessions can be renamed, archived, or deleted after a confirmation that never touches merged code.
- **One working session per project.** While a session has running tasks, a task awaiting review, or an unmerged branch, no other session in the project can start work (HTTP 409 naming the first). Other sessions can still ask questions. `Discard work` returns a session to idle.
- **Database schema v9.** `sessions` gains `title`, `mode`, `work_state`, and `archived_at`, with a partial unique index allowing one `working` session per project. `briefs` and `plans` move to a `session_id`, and `plans.brief_id` can be null for Quick. Upgrading a v0.6 database turns each project that has data into one Full session, removes empty legacy sessions, and moves `.dalang/` artifacts into `.dalang/sessions/<session id>/`. The upgrade also adds `sessions/*/tmp/` and `sessions/*/logs/` to `.dalang/.gitignore` and keeps lines you added.

**One chat surface in all three modes**
- **Transcript.** Your messages on the right, Lead replies on the left as formatted text (headings, lists, code, tables, links) through `react-markdown` and `remark-gfm`. Raw HTML is never rendered, only web and mail links are clickable, and `file://` links show as code. A new reply is scrolled to its first line.
- **Running panel.** Your question appears at once, then the real CLI name, elapsed time, the current step (reading a file, searching, running a command), and the answer as it streams. The raw log is folded under `Show technical log`.
- **Running state survives switching chats.** The server reports the Lead turn running in a session (`turn` on the session summary), so a chat you leave and reopen still shows the panel with the right clock, the composer stays busy, and live progress is kept per chat.
- **Model picker.** One chip opens a picker modeled on T3 Code: a provider rail with the real Claude, OpenAI, and Antigravity marks, model search, Claude models named with their versions (for example `Claude Opus 5.5`), and a reasoning column. It starts from the project's Lead setting. The chosen model and effort reach the CLI for Ask, Quick, and Full (`effort` on `POST /api/projects/:id/chat`).
- **Header.** The page header names the CLI chosen in the composer, not the project's default id. The Full discuss step no longer has its own Lead CLI and model fields.

**Around the chat**
- **Provider limits bar.** A slim bar shows the tightest 5 hour and weekly limit left per connected CLI, and `Details` lists every window with its reset time. It refreshes every 5 minutes while the page is visible (choose 3, 5, or 10 in Config, General, stored as `usageRefreshMinutes`), and when a run finishes.
- **Lead usage in Statistics.** Ask, Quick planning, and Full discussion and planning contribute to run counts, token totals, and estimated API-equivalent costs. On upgrade Dalang can recover usage from readable Lead logs.
- **Minimizable sidebar.** The sidebar shrinks to an icon rail on desktop and the choice is remembered. The project panel is full width.
- **Fewer duplicate controls.** The Full flow no longer has the `Next step` card, and the plan step shows one `Generate plan now` button instead of three.
- **Layout fix.** The top bar and sidebar now switch at the same `lg` breakpoint, so Config and Statistics no longer disappear between 768 and 1023 px.
- **Bilingual.** All new screens exist in Indonesian and English and pass the leak scan.

**Documentation.** The README and user guide have new screenshots from the built v0.7 app. The install guide explains the schema v9 upgrade and where sessions and logs live. [Install and update](docs/INSTALL.md)

**Dependencies.** The web package adds `react-markdown` and `remark-gfm` for formatted chat replies.

## 0.6.0 (UI revamp), 19 Nov

Guided UI revamp focused on first-run clarity, bilingual Indonesian/English support, archival-derived wayang kulit & gunungan artwork, and update visibility without losing a single v0.5 action.

Verified on Linux with 92 automated tests (79 core, 8 server including two headless Chromium scenarios on a real server, and 5 CLI `doctor` tests). The Chromium run walks every step, Statistics, and all six Config tabs in Indonesian and fails on any English dictionary string or raw status identifier. Not run: a clean macOS host, and a real Lead or reviewer turn in Indonesian (language instructions are covered by prompt tests).

- **Indonesian and English i18n (`id` / `en`)**: Added typed `en.ts` and `id.ts` translation dictionaries with `I18nProvider`, browser default detection (`id*` -> `id`, else `en`), instant `ID | EN` sidebar switcher, and server-side persistence in `settings` (`language`). The chosen language is also passed into Lead prompts (Discuss, Brief, Revise, Plan, Needs-Split) and Reviewer prompts so agent prose matches the UI language while JSON keys, code, file paths, and verify commands remain English.
- **Theme toggle & follow system**: Added `ThemeProvider` supporting Light, Dark, and Follow system (`prefers-color-scheme`), with an inline FOUC-prevention script in `index.html`, a sun/moon toggle in the sidebar footer, and a 3-way selector in `Config -> General`.
- **New sidebar shell & 5-step guided stepper**: Replaced the top-bar 6-tab layout with a persistent left sidebar (`+ New project`, project list, and a footer row with Statistics and Config icon buttons, the `ID | EN` switch, and a sun/moon theme icon, plus the update notice; collapses into a modal drawer behind a labeled `Menu` button on phones), a 5-step project stepper (`1 Discuss`, `2 Brief`, `3 Plan`, `4 Work`, `5 Review & merge`), and a single-sentence `"Next step"` guidance card with one primary CTA.
- **Config page (6 sidebar tabs) & dedicated Statistics page**: Entering `Config` swaps the sidebar to `<- Back` and six tabs (`General`, `Agents`, `Team`, `Task routing`, `Security`, `About`). `Team` renders agent profiles as sungging wayang cards with the full v0.5 profile editor (display names, `[1m]` variants, `max` effort, custom account `configDir`, fallback); `Task routing` renders plain-sentence rules with full reorder/edit/delete; `Statistics` moved to its own sidebar page.
- **First-run wizard**: Added a 4-screen onboarding wizard (How DALANG works, Check agent CLIs with copyable fix commands and explicit `agy` keyring warning, Recommended cross-provider team, Create first project landing directly in Step 1 Discuss). Launches automatically on fresh installs (`0` projects), is skipped automatically on upgrades with existing projects, and can be reopened anytime from `Config -> General` or `Config -> About`.
- **Wayang kulit & Gunungan artwork**: Derived articulated SVG figures for Semar (`TMnr 8-251`), Bima (`TMnr 8-265`, simple tasks), Kresna (`TMnr 8-239`, complex tasks), Arjuna (`TMnr 8-307`), Gatotkaca (`TMnr 8-273`), and Gunungan (`TMnr 8-225`) from Tropenmuseum / Wereldmuseum Wikimedia Commons photographs (CC BY-SA 3.0), split at shoulder and elbow joints with exact pin pivots, attributed in `packages/web/src/assets/wayang/CREDITS.md` and `Config -> About`, and used to redraw the sidebar mark and `favicon.svg`.
- **Work stage (Step 4) & factual Activity Feed**: Combined Assign and Navigate into `WorkView` with a lit kelir stage + debog base driven by real active runs (multiple Bimas for parallel coders, Arjuna for reviewer, Gatotkaca for fallback, dimmed figures for cooldown/quota), clickable figures opening the task log, a factual Activity Feed parsed from real run events, and automatic pausing on hidden tabs, `prefers-reduced-motion: reduce`, and a visible Pause/Play button.
- **Fallback is a CLI, model, and effort (schema v8)**: a fallback is no longer another profile. Routing rules and profiles name a CLI, model, effort, and optional account, and the fallback run keeps the primary profile's role instructions. The wizard, Config → Team, and Config → Task routing edit it that way, and upgrading converts existing fallback profiles. The same upgrade puts the seeded engineer rules in low, medium, high order (an older upgrade left medium after high).
- **Detailed default role instructions**: the four seeded profiles (`lead`, `coder-small`, `coder-heavy`, `reviewer`) now carry full working rules (scope, verification, blocked-instead-of-guessing, severity discipline) instead of one-line summaries. Installs that still hold the old text are upgraded on start; a profile you edited is left alone.
- **New-version notice (`dalang-cli`)**: Added `UpdateCheckService` and `GET /api/update-status`, checking `https://registry.npmjs.org/dalang-cli/latest` at most once per 24 hours (cached in `settings`, zero telemetry, toggleable in `Config -> General`, silent when offline). Shows copyable `npx dalang-cli@latest` and `npm install -g dalang-cli@latest` commands in the sidebar, `Config -> About`, and `dalang doctor`.

## 0.5.0 (Polish and distribution), 19 Nov

Polish and distribution milestone. Published to npm as `dalang-cli@0.5.0`. Verified on Linux with 81 automated tests (71 core, 7 server including a headless Chromium browser scenario on a real server with `ReplayCliRunner`, and 3 CLI `doctor` tests). macOS `sandbox-exec` profile generation and wrapping are unit-tested for parity with Linux `bwrap`, but live execution on macOS hardware has not been tested on this Linux host.

- **npm package & `dalang doctor`**: Added `dalang doctor` (`--json` supported) checking Node.js >= 24, git, sandbox (`bwrap` on Linux / `sandbox-exec` on macOS), data directory writability (`DALANG_HOME`), optional `gh` CLI, and all three provider CLIs with actionable fix hints. Added `packages/cli/scripts/prepare-pack.mjs` to bundle `web-dist/`, `README.md`, and `LICENSE` for npm packaging, plus `--version` / `--help`.
- **Several accounts per provider (schema v7)**: Agent profiles accept an optional `configDir` (`CLAUDE_CONFIG_DIR`, `CODEX_HOME`, or `AGY_CONFIG_DIR` / `XDG_CONFIG_HOME`), mounted writable in the sandbox. Usage caches, rate-limit cooldowns, and `ProviderLimiter` concurrency slots are tracked per account (`provider::configDir`) so a second account on the same provider can act as a fallback. `POST /api/providers/:provider/clear-cooldown` accepts an optional `accountKey`.
- **Rich model details from CLIs**: Model lists are now structured `ProviderModelInfo` objects (`id`, `value`, `resolvedModel`, `displayName`, `description`, `supportedEffortLevels` including `max`, `defaultEffort`, `supportsFastMode`, `supportsThinking`, `variants`). Claude reads models from one `initialize` control request on stream-json and groups `[1m]` 1M context variants onto their base model; Codex parses `codex debug models`; Antigravity parses tab-separated `agy models` display names. The profile editor shows display names, descriptions, variant checkboxes, model-scoped effort levels with the model's default preselected, and marks unavailable saved models instead of dropping them.
- **Side-effect-free health checks**: Verified on host that `claude --bare --no-session-persistence` does not execute `SessionStart` hooks during model discovery; health checks run from `os.tmpdir()` and results remain cached until Refresh CLI status.
- **Token and cost statistics**: Stream-json events from Claude, Codex, and Antigravity are parsed for input/output/cache tokens and CLI-reported cost, persisted per run (`runs` columns in schema v7), and aggregated per model, per provider, per project, and overall in `GET /api/statistics` and the Providers view. Estimated fallback pricing is explicitly labeled as API-equivalent, not the subscription bill.
- **Hybrid hidden checkpoint refs**: Pre-run baselines and failed/stopped snapshots are stored in hidden refs (`refs/dalang/checkpoints/*`) using a temporary `GIT_INDEX_FILE` so `mainBranch` stays free of noise commits, while each task's `dalang/{id}` branch commit is preserved for reviewer diffs and `git merge --no-ff`.
- **Push and pull request after merge**: Added per-project `pushAfterMerge`, `createPrAfterMerge`, and `gitRemote` settings plus manual `POST /api/projects/:id/tasks/:taskId/push-pr` (`git push` and `gh pr create` using the task brief and review summary as the PR body) in `GuardView`.
- **macOS `sandbox-exec` wrapper**: Added Seatbelt SBPL confinement (`wrapWithSandboxExec`) and unified `wrapWithSandbox` alongside Linux `bwrap`, with parity tests for read-only workspace mounts, `.git/hooks` write denial, `/tmp` isolation, and per-account config mounts.
- **Replay tests & headless browser scenario**: Added process-level `ReplayCliRunner` and recorded replay fixtures covering (1) quota reroute to a backup account, (2) failed review + fix round + merge + push/PR, and (3) two parallel tasks merging, plus a real-server Chromium CDP E2E test (`browser-replay.test.ts`).
- **Documentation**: Added [docs/INSTALL.md](docs/INSTALL.md), [docs/PROVIDERS.md](docs/PROVIDERS.md), [docs/SANDBOX.md](docs/SANDBOX.md), and [docs/TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md), and updated [README.md](README.md).
- **Fixed**: `branchExists` in `git.ts` previously passed `--quiet` to `git show-ref --verify`, causing `simple-git` to resolve without throwing on missing refs and falsely return `true`. Also fixed `pushRefToRemote` to resolve revision expressions (such as `<sha>^2`) via `git rev-parse` before pushing.
- **Roadmap**: v1.0 is dropped for now. After research on T3 Code the PRD plans v0.5 (this release), v0.6 (UI revamp), v0.7 (agent delegation over MCP), v0.8 (session protocols and context handoff), and v0.9 (scheduled runs and outside agents).

## 0.4.0 (Paralel), 19 Nov

Paralel milestone. Verified with scripted tests and one real Claude Code run (two independent tasks ran at the same time and merged cleanly); the quota reroute is scripted-only.

- **Profile editor:** the model is a dropdown filled from the selected provider (nothing hardcoded: for Claude, DALANG runs `claude -p "/model"` to get the aliases the CLI accepts, then asks the CLI which model each alias resolves to (the `init` event names it before any API call), so the list shows versioned ids and aliases; Codex and Antigravity use their own model commands. It is read when the server starts and again on Refresh CLI status). Antigravity model ids carry the reasoning level (`gemini-4-neon-high`), so its dropdown lists the base models (`gemini-4-neon`) and the effort field picks the level (low, medium, high, xhigh, only the levels that model has); DALANG builds the full id. A model with no levels disables the effort field, and `--effort` is only passed when no model is chosen. Effort now also allows `xhigh`. Each profile can also have its own fallback profile (schema v6, `agent_profiles.fallback_profile_id`); a routing rule's fallback still wins, and a profile that is another profile's fallback cannot be deleted.
- **Fixed in review:** opening a database from v0.2.1 or older failed with `no such column: "max_review_rounds"` because seeding ran before the column migrations; columns are now added first (regression test `db-upgrade.test.ts`, and a copy of a real v3 database upgraded to v5). Also: a cached "quota exhausted" reading never expired, so a provider stayed rerouted after its quota reset. It now expires at the reset time, or after 15 minutes without one. The usage table no longer shows an em dash for missing durations.

- **Schema & database v5**: Added `runs.worktree_path` (`migrateToV5`), exposed `getDbDataDir(db)`, and isolated worktree storage under `<dataDir>/worktrees/<projectId>/<externalId>` (with automatic cleanup on task rejection, branch cleanup, and project deletion).
- **Worktree per task (F-16)**: Tasks whose `files_allowed` globs do not overlap run concurrently on independent `dalang/{externalId}` worktrees, while overlapping tasks serialize safely. Added `assertWorktreeSafe` (checking `.git` file points inside `<main>/.git/worktrees/` and inspecting all git config scopes) and read-only `--ro-bind` mounting of worktree `.git` link files inside `bwrap`.
- **Dependency graph (F-16 / UI)**: Added topological wave calculation (`computeTaskWaves`) and interactive SVG + wave-column `DependencyGraph` view in both **List** and **Assign**, highlighting upstream/downstream edges, file-overlap serialization warnings, and quota fallback routing.
- **Per-provider parallel limits (F-12)**: Added global in-process `ProviderLimiter` concurrency pool enforced across all projects and runs (coder + reviewer turns), with live slot occupancy and cooldown status in `ExecutionStateDTO`, Assign, Navigate, and Providers views.
- **Quota fallback (F-13)**: Added proactive quota checking (`ProviderRegistry.getCachedUsage` + `isUsageExhausted`) and recent `rate_limit` / `login_expired` cooldown rerouting before dispatch, Claude `rate_limit_event` stream detection, reactive slot-waiting fallback to backup profiles, and `POST /api/providers/:provider/clear-cooldown`.
- **Per-task stop & usage statistics (F-24)**: Added optional `taskId` filtering on `/api/projects/:id/execution/stop` plus `POST /api/projects/:id/tasks/:taskId/stop`, `StatisticsService` (`GET /api/statistics` with per-project & time-window filters), and a Usage Statistics & Limit Events dashboard section on Providers showing run breakdowns, durations, fallback counts, and `provider_events`.

## 0.3.0, 19 Nov

Kawal milestone, verified on 19 Nov with five real-model projects (15 of 15 tasks passed review within 2 rounds): automated verification + review/fix loop, human Gate 2 diff & merge control, post-merge integration tests, and editable agent profiles + routing rules.

- **Schema & database v4**: Added `integration_command`, `branch_name`, `merge_commit_sha`, `rejection_note`, `max_review_rounds`, `runs.kind`, and `reviews` / `integration_runs` tables with idempotent migration (`migrateToV4`) and seeded `reviewer` routing rule.
- **Sandbox & read-only confinement**: Extended `wrapWithBwrap` with read-only workspace mounts (`--ro-bind`), updated Codex adapter inside bubblewrap for read-only reviews, and added sandboxed shell command execution (`runShellCommand`) for deterministic `verify` and post-merge integration checks.
- **Reviewer & fix loop (F-18)**: Each approved task runs on an isolated `dalang/{externalId}` branch, executes `verify`, runs read-only automated review with cross-model provider preference and `files_allowed` scope enforcement, and retries fixes up to `maxReviewRounds` (default 2, max 3).
- **Guard UI & Gate 2 (F-19, F-20)**: Added `GuardView` with per-round review findings, unified branch diff inspector, Approve & Merge / Reject & send back controls (including override confirmation on failed reviews), auto-detected/configurable `integrationCommand`, and manual integration suite runs on `mainBranch`.
- **Review verdict**: it is read only from the reviewer's reply, never from `review.json` on disk, because the verify command runs agent-written code and could plant a passing file. If the changed files cannot be listed, the review fails instead of skipping the scope check.
- **Profile safety**: a profile cannot be deleted while a routing rule (primary or fallback), a task, or a run refers to it.
- **Profiles & routing CRUD (F-21)**: Added API and UI management for agent profiles (including moving `antigravityKeyringAccess` inside the profile editor for `antigravity` profiles) and priority-ordered routing rules.

Security (also in this release)
- The git guard also refuses `hook.*`, `trace2.*`, and external diff or merge drivers in the repo config. None of them ran on git 2.53 in a test of the commands DALANG uses; this keeps a newer git from turning them into a way out.
- Docs and the Providers page now say plainly that an agy run can read the whole desktop keyring.
- **Antigravity in the sandbox is now opt-in and off by default.** Tick "Allow Antigravity to read the desktop keyring" on the Providers page to use it. While it is off, a task routed to agy runs on its backup profile (with a note in Assign and in the run log), a task with no usable backup is blocked with a reason, and agy cannot be a Lead. The setting is stored in a new `settings` table (database schema v3).

## 0.2.1, 18 Nov

A security release. Everyone on 0.2.0 should upgrade: the git guard shipped there could be bypassed.

Security
- The git guard introduced in 0.2.0 could be bypassed: a clean filter in `.git/config.worktree` (with `extensions.worktreeConfig`) or in an included file still ran on the host at `git add`, and a git error let the check pass. It now reads every config scope git uses and fails closed. Confirmed with a test before the fix.
- agy no longer gets the real desktop session bus, which can start units outside the sandbox. It runs behind a filtered `xdg-dbus-proxy` that allows only the Secret Service (`org.freedesktop.secrets`), and `/run/user` is hidden for every provider. That service is the whole desktop keyring, so an agy run can still read every secret in it.
- Deleting a task result no longer follows a planted folder link outside the project.

## 0.2.0 (Jalan), 18 Nov

Tasks now run. The Lead's plan is dispatched to agents one task at a time.

Added
- **Assign:** routing rules (first match wins) pick a profile per task, with a per-task override and a backup profile.
- **Navigate:** sequential execution in dependency order, live logs over WebSocket, stop, retry, resume with the saved CLI session, and one-click rollback.
- **Git checkpoints** before and after every run, and a per-run record (profile, provider, model, duration, exit code, commits, log path, scope warnings).
- **`result.json` contract** per task, validated with Zod with one repair turn.
- **Fallback** to the backup profile on a provider-level failure (rate limit, expired login, timeout, CLI error) and a per-profile parallel limit, pulled forward from v0.4.
- A root `.gitignore` for new projects, so a checkpoint never commits dependencies or secrets.

Security
- DALANG refuses to run git when the repo-local config defines a clean filter, an include, or a worktree, because a filter planted by an agent would run on the host at `git add`. Confirmed with a test before the fix.
- Rollback is refused when the repo has commits or edits DALANG did not make since the last run.
- Starting a run reserves the project before the first await, so two quick requests cannot both start.

Fixed
- A failed or blocked task no longer triggers a fallback run on another provider.
- A task on a read-only profile (the seeded reviewer) can now write its `result.json`.
- Routing follows the PRD: the first matching rule in order wins.
- Failing to compute changed files is recorded as a scope warning instead of being hidden.

Known limits: Linux-only confinement, no reviewer yet, scope violations are warnings, one task at a time. See the README.

## 0.1.0 (Rembuk), 18 Nov

Projects, Discuss, Agree, List, and the provider status page, with a loopback-only server, a `bwrap` sandbox on Linux, symlink-hardened artifact I/O, and shadcn/ui components styled by [docs/DESIGN.md](docs/DESIGN.md).
