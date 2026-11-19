# Changelog

Dates are 2026. Versions follow the phases in [docs/PRD.md](docs/PRD.md).

## Unreleased

Security
- The git guard also refuses `hook.*`, `trace2.*`, and external diff or merge drivers in the repo config. None of them ran on git 2.53 in a test of the commands DALANG uses; this keeps a newer git from turning them into a way out.
- Docs and the Providers page now say plainly that an agy run can read the whole desktop keyring.
- **Antigravity in the sandbox is now opt-in and off by default.** Tick "Allow Antigravity to read the desktop keyring" on the Providers page to use it. While it is off, a task routed to agy runs on its backup profile (with a note in Assign and in the run log), a task with no usable backup is blocked with a reason, and agy cannot be a Lead. The setting is stored in a new `settings` table (database schema v3).

## 0.3.0 (unreleased)

Kawal milestone, verified on 19 Nov with five real-model projects (15 of 15 tasks passed review within 2 rounds): automated verification + review/fix loop, human Gate 2 diff & merge control, post-merge integration tests, and editable agent profiles + routing rules.

- **Schema & database v4**: Added `integration_command`, `branch_name`, `merge_commit_sha`, `rejection_note`, `max_review_rounds`, `runs.kind`, and `reviews` / `integration_runs` tables with idempotent migration (`migrateToV4`) and seeded `reviewer` routing rule.
- **Sandbox & read-only confinement**: Extended `wrapWithBwrap` with read-only workspace mounts (`--ro-bind`), updated Codex adapter inside bubblewrap for read-only reviews, and added sandboxed shell command execution (`runShellCommand`) for deterministic `verify` and post-merge integration checks.
- **Reviewer & fix loop (F-18)**: Each approved task runs on an isolated `dalang/{externalId}` branch, executes `verify`, runs read-only automated review with cross-model provider preference and `files_allowed` scope enforcement, and retries fixes up to `maxReviewRounds` (default 2, max 3).
- **Guard UI & Gate 2 (F-19, F-20)**: Added `GuardView` with per-round review findings, unified branch diff inspector, Approve & Merge / Reject & send back controls (including override confirmation on failed reviews), auto-detected/configurable `integrationCommand`, and manual integration suite runs on `mainBranch`.
- **Review verdict**: it is read only from the reviewer's reply, never from `review.json` on disk, because the verify command runs agent-written code and could plant a passing file. If the changed files cannot be listed, the review fails instead of skipping the scope check.
- **Profile safety**: a profile cannot be deleted while a routing rule (primary or fallback), a task, or a run refers to it.
- **Profiles & routing CRUD (F-21)**: Added API and UI management for agent profiles (including moving `antigravityKeyringAccess` inside the profile editor for `antigravity` profiles) and priority-ordered routing rules.

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
