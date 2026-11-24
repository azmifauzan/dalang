# Sandbox and Security Model

Dalang uses OS-level confinement where available, Git configuration checks, and a loopback-only server. The Lead requests read-only access for Ask. Quick and Full execute approved tasks in separate Git worktrees and require a human decision before merging task changes.

## Loopback-only server

- Standard installs bind the server to `127.0.0.1`. Docker binds inside the container and publishes the port on host `127.0.0.1`.
- Every HTTP request whose `Host` or `Origin` header is not a loopback address (`127.0.0.1`, `localhost`, `::1`) is refused with `403 Forbidden` to prevent DNS rebinding attacks.
- A run's MCP settings, which contain its delegation token, sit in a private temporary folder that is mounted read-only into the sandbox and deleted when the turn ends. Codex receives the token through an environment variable instead of a file. Antigravity gets no delegation token or MCP settings.
- The `/mcp` endpoint enforces both the loopback `Host`/`Origin` guard and a loopback socket address check (`127.0.0.1`, `::1`, `::ffff:127.0.0.1`). It serves two disjoint bearer-token types:
  - **Run-scoped delegation tokens (v0.8):** issued only for active depth-0 coder runs, verified with constant-time comparison, expire immediately when the run ends, never placed in CLI prompts or logs (adapter loggers scrub the token before writing), and cannot inspect or cancel subtasks belonging to other tasks.
  - **Outside-agent tokens (v0.11):** created in **Config → Automation** as `read-only` or `full-access`, optionally scoped to a single project. Only the SHA-256 hash is stored in SQLite (`mcp_tokens`); the raw token is shown once at creation time and verified with constant-time comparison. Read-only tokens hide and refuse all mutating tools (`start_task`, `stop_task`, `approve_merge`, `reject_task`, `trigger_automation`). Tokens can be revoked immediately.
- **Signed webhooks (`/api/webhooks/:token`):** webhook endpoints skip the DALANG login so local scripts can call them. Each call must carry an HMAC-SHA256 signature, compared in constant time. `X-Dalang-Signature-256` signs `<timestamp>.<raw body>` with the Unix time from `X-Dalang-Timestamp`, and a timestamp more than 5 minutes off is refused, so a captured request stops working. `X-Hub-Signature-256` signs the body alone; DALANG remembers its signatures in memory for 24 hours and refuses a repeat, but that memory is cleared on restart. A missing, malformed, or wrong signature or timestamp returns `401 Unauthorized`, and a repeat of a request that already started a run returns `409`. The body reaches the coder only where the instructions of the automation contain `{{payload}}`, inside a block marked as data that the body cannot close; the coder can still be influenced by it, so leave auto-merge off when the body carries text you do not control. The endpoint is under the same loopback `Host`/`Origin` guard, so a hosted service such as GitHub cannot reach it directly. The UI shows a signing secret only when it is created or rotated. DALANG must keep the secret itself to check signatures, so it is stored as-is in `~/.dalang/dalang.db`, unlike MCP tokens, which are stored as hashes.

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
- `.git/hooks` (main repo) and `.git` (worktree gitdir file) are mounted read-only inside the sandbox for both the workspace root and every top-level nested repository worktree so an agent cannot plant executable git hooks or redirect worktree metadata.

### macOS (`sandbox-exec` / Seatbelt)

On macOS (`darwin`), DALANG wraps runs in `/usr/bin/sandbox-exec` with a dynamically generated Seatbelt (SBPL) profile enforcing the same policy:

- Denies all file writes by default (`(deny file-write*)`).
- Allows file writes only to the active project/worktree (omitted for read-only reviews), `/tmp`, `/private/tmp`, `$TMPDIR`, `/dev/null`, and the active provider state/config directory.
- Explicitly denies file writes to `.git/hooks` and worktree `.git` link files for both the root and any top-level nested repositories.
- Denies reads of the same credential paths and DALANG database files.

### Docker

Compose runs DALANG as an unprivileged user with all container capabilities dropped. Docker's seccomp, AppArmor, and system-path settings are relaxed for bubblewrap, which still creates per-project sandboxes. Compose publishes the port on localhost. The Antigravity Secret Service uses a keyring inside the container. [Docker setup](INSTALL.md#run-with-docker)

### Native Windows

Dalang can use Codex's native Windows MXC backend to launch provider, verify, and integration processes. Install a Codex CLI that supports `codex sandbox` with MXC and run `dalang doctor` to check availability. Dalang checks workspace writes, read-only runs, writes outside the workspace, Git metadata protection, and denied credential reads before reporting MXC ready.

When MXC is unavailable or a confinement check fails, Quick and Full still require explicit unconfined consent for each request. Verify and integration commands use `cmd.exe /d /s /c` and preserve quoted executable paths.

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
