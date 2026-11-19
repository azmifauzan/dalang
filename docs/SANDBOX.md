# Sandbox and Security Model

DALANG runs coding agents automatically on your local repositories. Prompts alone are not a security boundary, so DALANG enforces OS-level confinement, git config validation, and loopback-only HTTP checks.

## Loopback-only server

- The server binds exclusively to `127.0.0.1`.
- Every HTTP request whose `Host` or `Origin` header is not a loopback address (`127.0.0.1`, `localhost`, `::1`) is refused with `403 Forbidden` to prevent DNS rebinding attacks.
- DALANG is a local single-user workbench with no remote relay or multi-user authentication layer.

## OS sandbox confinement

### Linux (`bwrap` / bubblewrap)

Every CLI turn and every verify/integration shell command runs inside `bwrap`:

- Root filesystem is mounted read-only (`--ro-bind / /`).
- Only the active project folder (or isolated task worktree) is mounted read-write (`--bind`), or read-only (`--ro-bind`) for review turns.
- Fresh `/tmp`, `/dev`, `/proc`, `--unshare-pid`, `--unshare-ipc`, `--new-session`, and `--die-with-parent`.
- `/run/user` and `/run/docker.sock` are hidden so sandboxed agents cannot reach user systemd units or container daemons.
- Sensitive credential directories and files are masked: `~/.ssh`, `~/.gnupg`, `~/.aws`, `~/.docker`, `~/.kube`, `~/.config/gcloud`, `~/.git-credentials`, and `~/.netrc`. (`~/.npmrc` stays readable for private npm registries.)
- Only the active provider's state directory (or the profile's custom `configDir`) is mounted writable for token refresh and session state.
- `.git/hooks` (main repo) and `.git` (worktree gitdir file) are mounted read-only inside the sandbox so an agent cannot plant executable git hooks or redirect worktree metadata.

### macOS (`sandbox-exec` / Seatbelt)

On macOS (`darwin`), DALANG wraps runs in `/usr/bin/sandbox-exec` with a dynamically generated Seatbelt (SBPL) profile enforcing the same policy:

- Denies all file writes by default (`(deny file-write*)`).
- Allows file writes only to the active project/worktree (omitted for read-only reviews), `/tmp`, `/private/tmp`, `$TMPDIR`, `/dev/null`, and the active provider state/config directory.
- Explicitly denies file writes to `.git/hooks` and worktree `.git` link files.
- Explicitly denies file reads on `~/.ssh`, `~/.gnupg`, `~/.aws`, `~/.docker`, `~/.kube`, `~/.config/gcloud`, `~/.git-credentials`, and `~/.netrc`.

### Windows (WSL 2)

Native Windows has no sandbox in v0.5. Run DALANG inside WSL 2 with `bubblewrap` installed so Linux confinement applies. Starting runs on a host with no sandbox requires an explicit unconfined opt-in per request.

## Antigravity keyring exposure (opt-in)

On Linux, `agy` authenticates through the desktop Secret Service (`org.freedesktop.secrets`). Because exposing the raw session bus would let a sandboxed agent start systemd units on the host, DALANG runs `agy` behind a filtered `xdg-dbus-proxy` that allows only `org.freedesktop.secrets`.

That service exposes the entire desktop keyring, so a sandboxed `agy` run can read any secret stored in your keyring. For that reason:

- **Antigravity in the Linux sandbox is off by default.**
- Tasks routed to `agy` fall back to their backup profile until you explicitly tick **"Allow Antigravity to read the desktop keyring"** in an Antigravity profile.
- Without `xdg-dbus-proxy` or an active desktop session bus, sandboxed `agy` runs are refused.

## Git config guard and hidden checkpoints

Because DALANG runs `git` on the host (outside the sandbox) against repositories the agent can edit, a malicious `.git/config` entry could execute host commands during `git add`, `git diff`, or `git merge`.

Before every git operation, DALANG runs `git config --list --show-scope -z` and refuses to proceed if local, worktree, or command scope defines:

- `filter.*`
- `include.path` or `includeIf.*.path`
- `core.worktree` or `extensions.worktreeConfig` (or if `.git/config.worktree` exists)
- `hook.*`, `trace2.*`, `diff.external`, or external `diff.*.command` / `diff.*.textconv` / `merge.*.driver`

All DALANG git commands run with `core.hooksPath=/dev/null`, `core.fsmonitor=false`, `commit.gpgsign=false`, and `--no-verify`.

### Hybrid hidden checkpoint refs

To avoid polluting your main branch with noisy `dalang: checkpoint ...` commits:

- Pre-run baselines and failed/stopped run snapshots are written as hidden refs under `refs/dalang/checkpoints/*` using a temporary index (`GIT_INDEX_FILE`), leaving `HEAD` untouched.
- Completed task work is committed on the isolated task branch `dalang/{taskId}` so Guard diffs and `git merge --no-ff` remain clean and auditable.
- One-click rollback verifies that no external commits or uncommitted changes outside `.dalang/` would be lost before resetting.

## Symlink-hardened artifact I/O

Every read, write, or delete DALANG performs on agent-reachable files (`.dalang/` artifacts, `PROJECT.md`, run logs) refuses symlinks and paths resolving outside the project root, opens files with `O_NOFOLLOW`, and writes atomically via temp file + rename.
