# Changelog

Dates are 2026. Versions follow the phases in [docs/PRD.md](docs/PRD.md).

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
