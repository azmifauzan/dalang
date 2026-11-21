# Sandbox and Security Model

Dalang uses OS-level confinement where available, Git configuration checks, and a loopback-only server. The Lead requests read-only access for Ask. Quick and Full execute approved tasks in separate Git worktrees and require a human decision before merging task changes.

## Loopback-only server

- Standard installs bind the server to `127.0.0.1`. Docker binds inside the container and publishes the port on host `127.0.0.1`.
- Every HTTP request whose `Host` or `Origin` header is not a loopback address (`127.0.0.1`, `localhost`, `::1`) is refused with `403 Forbidden` to prevent DNS rebinding attacks.

## Optional app login

DALANG is a local single-user workbench. App login is off by default. Enable it in **Config → Security** to require one password for the workspace APIs, stored images, and live WebSocket updates. DALANG stores a salted `scrypt` hash in SQLite. The browser receives an `HttpOnly`, `SameSite=Strict` session cookie. Logout revokes the session, and sessions expire after 24 hours or when the server restarts. Provider sign-ins continue to use their respective CLIs.

When login is enabled, authenticated requests with an `Origin` header must match the DALANG page's origin. The app login and CLI update endpoints apply the same origin check even with login off. [Set or disable the app password](INSTALL.md#require-a-dalang-password)

## OS sandbox confinement

### Linux (`bwrap` / bubblewrap)

On Linux and WSL 2, Dalang wraps agent turns and verify and integration commands in `bwrap` when available.

- Root filesystem is mounted read-only (`--ro-bind / /`).
- The project folder or isolated task worktree is the workspace mount. Ask and automated review use a read-only workspace mount.
- Fresh `/tmp`, `/dev`, `/proc`, `--unshare-pid`, `--unshare-ipc`, `--new-session`, and `--die-with-parent`.
- `/run/user` and `/run/docker.sock` are hidden so sandboxed agents cannot reach user systemd units or container daemons.
- The sandbox masks the DALANG database and its SQLite sidecar files, Linux keyring files, and credentials under `~/.ssh`, `~/.gnupg`, `~/.aws`, `~/.docker`, `~/.kube`, `~/.config/gcloud`, `~/.git-credentials`, and `~/.netrc`. `~/.npmrc` stays readable for private npm registries.
- Only the active provider's state directory (or the profile's custom `configDir`) is mounted writable for token refresh and session state.
- `.git/hooks` (main repo) and `.git` (worktree gitdir file) are mounted read-only inside the sandbox so an agent cannot plant executable git hooks or redirect worktree metadata.

### macOS (`sandbox-exec` / Seatbelt)

On macOS (`darwin`), DALANG wraps runs in `/usr/bin/sandbox-exec` with a dynamically generated Seatbelt (SBPL) profile enforcing the same policy:

- Denies all file writes by default (`(deny file-write*)`).
- Allows file writes only to the active project/worktree (omitted for read-only reviews), `/tmp`, `/private/tmp`, `$TMPDIR`, `/dev/null`, and the active provider state/config directory.
- Explicitly denies file writes to `.git/hooks` and worktree `.git` link files.
- Denies reads of the same credential paths and DALANG database files.

### Docker

Compose runs DALANG as an unprivileged user with all container capabilities dropped. Docker's seccomp, AppArmor, and system-path settings are relaxed for bubblewrap, which still creates per-project sandboxes. Compose publishes the port on localhost. The Antigravity Secret Service uses a keyring inside the container. [Docker setup](INSTALL.md#run-with-docker)

### Native Windows

v0.7.3 runs directly on Windows without a Dalang OS sandbox. Quick and Full execution require explicit unconfined consent for each request. The Windows runner uses `cmd.exe /d /s /c` for verify and integration commands, preserving quoted executable paths. Provider read-only modes remain requested, and Git guards, isolated worktrees, scope checks, automated review, and the merge approval gate still apply. They do not provide filesystem confinement for unconfined processes.

The Quick merge and Full integration controls forward their explicit consent to post-merge integration. If no sandbox or consent is available, the post-merge check is recorded as skipped; it does not count as a passing integration run. The API field is `allowUnconfined`, defaulting to `false`.

Windows installations without file-symlink privilege receive `CLAUDE.md` and `AGENTS.md` instruction pointers to `PROJECT.md`. Existing regular instruction files are preserved. These pointers are recognized as configured; they do not grant additional filesystem permissions.

### Windows with WSL 2

Run Dalang inside WSL 2 with `bubblewrap` installed so Linux confinement applies. Starting Quick or Full task execution or running integration tests without the platform sandbox requires explicit confirmation. [Windows setup](INSTALL.md#windows-with-wsl-2)

## Antigravity keyring exposure (opt-in)

On Linux, `agy` authenticates through the desktop Secret Service (`org.freedesktop.secrets`). Because exposing the raw session bus would let a sandboxed agent start systemd units on the host, DALANG runs `agy` behind a filtered `xdg-dbus-proxy` that allows only `org.freedesktop.secrets`.

That service exposes the entire desktop keyring, so a sandboxed `agy` run can read any secret stored in your keyring. For that reason:

- **Antigravity in the Linux sandbox is off by default.**
- Tasks routed to `agy` can use their configured fallback until you enable **Allow Antigravity to read the desktop keyring** in **Config → Security**.
- Sandboxed `agy` needs `xdg-dbus-proxy` and a session bus. The Docker image supplies both with its own Secret Service.

## Git config guard and hidden checkpoints

Because DALANG runs `git` on the host (outside the sandbox) against repositories the agent can edit, a malicious `.git/config` entry could execute host commands during `git add`, `git diff`, or `git merge`.

Dalang checks Git configuration with `git config --list --show-scope -z`. The guard refuses these settings in local, worktree, or command scope.

- `filter.*`
- `include.path` or `includeIf.*.path`
- `core.worktree`
- `hook.*`, `trace2.*`, `diff.external`, or external `diff.*.command` / `diff.*.textconv` / `merge.*.driver`

The guard also refuses `extensions.worktreeConfig` in any scope and repositories with `.git/config.worktree`. It checks that each managed worktree's Git metadata points inside the registered repository's worktree metadata directory. Dalang disables hooks, filesystem monitoring, and commit signing on its managed Git commands.

### Hybrid hidden checkpoint refs

To avoid polluting your main branch with noisy `dalang: checkpoint ...` commits:

- Pre-run baselines and failed/stopped run snapshots are written as hidden refs under `refs/dalang/checkpoints/*` using a temporary index (`GIT_INDEX_FILE`), leaving `HEAD` untouched.
- Completed task work is committed on the isolated task branch `dalang/{taskId}` so Guard diffs and `git merge --no-ff` remain clean and auditable.
- One-click rollback verifies that no external commits or uncommitted changes outside `.dalang/` would be lost before resetting.

## Symlink-hardened artifact I/O

Dalang's artifact helpers validate paths against the project root and reject unsafe symlink targets, including directory junctions that lead outside a Windows project. Reads use `O_NOFOLLOW` where available and validate the opened descriptor against the resolved file; platforms without `/proc` use device and inode checks. Writes use a temporary file and atomic rename. Briefs, plans, and task results live under a session-specific directory. [Data locations](INSTALL.md#data-and-uninstall)
