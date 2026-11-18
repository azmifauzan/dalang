# Changelog

Dates are 2026. Versions follow the phases in [docs/PRD.md](docs/PRD.md).

## Unreleased (security fixes after 0.2.0)

Security
- The git guard introduced in 0.2.0 could be bypassed: a clean filter in `.git/config.worktree` (with `extensions.worktreeConfig`) or in an included file still ran on the host at `git add`, and a git error let the check pass. It now reads every config scope git uses and fails closed. Confirmed with a test before the fix.
- agy no longer gets the real desktop session bus, which can start units outside the sandbox. It runs behind a filtered `xdg-dbus-proxy` that allows only the keyring (`org.freedesktop.secrets`), and `/run/user` is hidden for every provider.
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
