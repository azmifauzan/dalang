# Troubleshooting

Start every diagnosis by running:

```bash
npx dalang-cli doctor
```

It verifies Node.js, git, sandbox confinement, the data directory, `gh`, and every agent CLI, and prints a direct fix command for each warning or failure.

## Common issues

### Browser did not open or the port is busy

Open the URL printed in the terminal, normally `http://127.0.0.1:4173`. If startup reports `EADDRINUSE`, use another loopback port:

```bash
npx dalang-cli --port 4180 --no-open
```

Then open `http://127.0.0.1:4180`.

### "Bubblewrap sandbox is unavailable" or "Sandbox confinement is unavailable"

- **Linux**: install `bubblewrap` (`sudo apt install bubblewrap` or `sudo dnf install bubblewrap`), then verify with `which bwrap` and `npx dalang-cli doctor`.
- **macOS**: `/usr/bin/sandbox-exec` should be present by default. Verify with `ls -l /usr/bin/sandbox-exec`.
- **Windows**: run DALANG inside WSL 2 (Ubuntu) with `bubblewrap` installed.
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

If you see `Database schema v9 is newer than this DALANG build`, start v0.7.0 or later with `npx dalang-cli@latest`. To run an older build with your previous state, restore the backup of both the data directory and project checkout made before migration. [Update and backup](INSTALL.md#update-dalang)

### A project opens into an empty chat after upgrading

Open the project's saved **Full** session in the sidebar to find the conversation, brief, and tasks from v0.6. A project with no saved history opens with an empty composer. [Work with saved chats](USAGE.md#continue-or-manage-a-chat)

### Another session has unfinished work

Open the session named in the message and finish reviewing its remaining tasks, or use **Discard work** in that session's header. Archiving is available after you finish or discard the work. You can keep using Ask in other sessions while you decide. [Work with saved chats](USAGE.md#continue-or-manage-a-chat)
