# Troubleshooting

Start every diagnosis by running:

```bash
dalang doctor
```

It verifies Node.js, git, sandbox confinement, the data directory, `gh`, and every agent CLI, and prints a direct fix command for each warning or failure.

## Common issues

### Browser did not open or the port is busy

Open the URL printed in the terminal, normally `http://127.0.0.1:4173`. If startup reports `EADDRINUSE`, use another loopback port:

```bash
dalang --port 4180 --no-open
```

Then open `http://127.0.0.1:4180`.

### Windows source install asks for C++ Build Tools

Use the pinned pnpm version (`npm install -g pnpm@10.34.9`) and rerun `pnpm install --frozen-lockfile`. The workspace skips an unnecessary SQLite build because better-sqlite3 ships native binaries for the supported platforms. Use the [v0.7.3 GitHub tarball](INSTALL.md#native-windows) for a standalone install; `npm install -g dalang-cli` and `npx dalang-cli` currently select the older npm registry release.

### A Windows provider is installed but Dalang cannot find it

Check `Get-Command claude,codex,agy -All`, restart the terminal after changing PATH, then run `dalang doctor`. Native executables are required; an npm `.cmd` or PowerShell `.ps1` launcher alone is insufficient. Claude Code's standard npm-native executable location is also searched. [Windows providers](PROVIDERS.md#native-windows-providers)

### Verification commands fail on native Windows

Commands run through `cmd.exe`, so POSIX syntax such as `VAR=value command` or `/bin/sh` is not a Windows verification command. Use a portable script command such as `node src/math.test.mjs` or `npm test`, and quote paths containing spaces. Store the same command in the task and project integration settings. For POSIX-only projects, use WSL 2.

### Windows project instructions report a link problem

v0.7.3 creates instruction pointers when file-symlink privilege is unavailable. Existing `CLAUDE.md` or `AGENTS.md` files remain user-owned and are not replaced. Review those files and `PROJECT.md` from the project header. Developer Mode or administrator access is not required to use the instruction-pointer fallback.

### Docker fails to start

Check `docker compose logs dalang`. If bubblewrap cannot create a namespace or mount `/proc`, confirm that the host allows unprivileged user namespaces and that the service uses the security settings in `compose.yaml`. To run the diagnostics inside the running container, use `docker compose exec dalang node /app/bin/dalang.js doctor`. [Docker setup](INSTALL.md#run-with-docker)

### The DALANG login page asks for a password

Use the password you set in **Config → Security → DALANG login**. Restarting DALANG ends existing browser sessions. A signed-in browser can disable the password from the same menu. The DALANG password and provider account credentials are separate. [App login](INSTALL.md#require-a-dalang-password)

### The image attachment icon is disabled

Choose Claude Code or Codex in the composer. Wait for the current turn to finish, or remove a preview if you already have three files attached. Each file must be PNG, JPEG, or WebP and at most 4 MiB. [Attach images](USAGE.md#attach-images)

### "Bubblewrap sandbox is unavailable" or "Sandbox confinement is unavailable"

- **Linux**: install `bubblewrap` (`sudo apt install bubblewrap` or `sudo dnf install bubblewrap`), then verify with `which bwrap` and `dalang doctor`.
- **macOS**: `/usr/bin/sandbox-exec` should be present by default. Verify with `ls -l /usr/bin/sandbox-exec`.
- **Windows**: native execution requires explicit unconfined consent. To use Dalang OS confinement, run inside WSL 2 (Ubuntu) with `bubblewrap` installed.
- The Quick run card, Full Work view, and integration controls prompt for confirmation when their actions would run without OS confinement. [Sandbox and permissions](SANDBOX.md)

### Antigravity tasks keep falling back to another provider

On Linux, sandboxed Antigravity runs require desktop keyring access via `xdg-dbus-proxy` and are **off by default**.

1. Install `xdg-dbus-proxy` (`sudo apt install xdg-dbus-proxy`).
2. Ensure DALANG is started from a desktop session with `DBUS_SESSION_BUS_ADDRESS` set.
3. Open **Config → Security** and tick **Allow Antigravity to read the desktop keyring**.

### Provider shows "LOGIN NEEDED" or runs fail with `login_expired`

Sign in again with the official CLI, then click **Refresh CLI status** in Config → Agents:

```bash
claude auth login
codex login
agy
```

If you use a profile with a custom **Account config directory**, run the login command with that same environment variable:

```bash
CLAUDE_CONFIG_DIR=/path/to/dir claude auth login
CODEX_HOME=/path/to/dir codex login
AGY_CONFIG_DIR=/path/to/dir XDG_CONFIG_HOME=/path/to/dir agy
```

For Docker, sign in inside the container using the [Docker sign-in commands](INSTALL.md#run-with-docker).

### Update CLI fails

Wait for that provider's active turns to finish, then retry **Update CLI**. If the message points to an installation managed by a package manager or a permissions error, use that installation's update command and refresh CLI status. [Provider updates](PROVIDERS.md#update-provider-clis)

### Provider stays in cooldown after quota resets

DALANG automatically expires a cached "0% remaining" reading at its reset time (or after 15 minutes if no reset time is reported), and reactive rate-limit cooldowns last 5 minutes. You can clear a cooldown immediately from **Config → Agents** using **Clear cooldown** (or **Refresh CLI status**).

### "Repository config defines settings that can run commands"

DALANG refuses to run host git commands if your repo-local `.git/config` defines `filter.*`, `include.path`, `core.worktree`, `hook.*`, `trace2.*`, or external diff/merge drivers (system and global git configs such as Git LFS remain allowed).

Inspect your repo config with:

```bash
git config --local --list
```

Move legitimate filters (like Git LFS) to `--global` config or remove unused local entries, then retry.

### "Rollback refused: uncommitted changes would be lost" or "commits DALANG did not create"

DALANG refuses destructive `git reset --hard` rollbacks when you have uncommitted edits outside `.dalang/` or manual commits added after DALANG's last run. Commit or stash your work, or roll back manually with `git`.

### Push or Pull Request fails in Review and merge

- **"No git remote is configured"**: add a remote in your repo (`git remote add origin <url>`) or set the remote name in the **Remote push and pull request** panel.
- **"GitHub CLI (gh) is not installed"**: install `gh` from https://cli.github.com and run `gh auth login`.
- **Push authentication failed**: git push runs on the host using your normal SSH keys or git credential helper. Test `git push` manually in that repository once to verify remote credentials.

### Saved model shows "(unavailable)" in Profile Editor

CLIs periodically retire or rename model ids. Click **Refresh CLI status** to reload the latest list from the CLI, then pick a current model in the profile editor. DALANG keeps the saved value visible until you change it.

### Database schema version error after downgrading

If DALANG reports that the database schema is newer than the build, install the [current release tarball](INSTALL.md#update-dalang) or update your Docker checkout. Schema v10 requires v0.7.2 or later. To resume using an older build, restore the pre-migration backup of the data directory and project checkout. [Update and backup](INSTALL.md#update-dalang)

### A project opens into an empty chat after upgrading

Open the project's saved **Full** session in the sidebar to find the conversation, brief, and tasks from v0.6. A project with no saved history opens with an empty composer. [Work with saved chats](USAGE.md#continue-or-manage-a-chat)

### Another session has unfinished work

Open the session named in the message and finish reviewing its remaining tasks, or use **Discard work** in that session's header. Archiving is available after you finish or discard the work. You can keep using Ask in other sessions while you decide. [Work with saved chats](USAGE.md#continue-or-manage-a-chat)
