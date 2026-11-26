# Troubleshooting

Start every diagnosis by running:

```bash
dalang doctor
```

It verifies Node.js, git, sandbox confinement, the data directory, `gh`, and every agent CLI, and prints a direct fix command for each warning or failure.

## Common issues

Find the message or symptom you see:

- [Database schema is newer than this Dalang build](#database-schema-is-newer-than-this-dalang-build)
- [Browser did not open or the port is busy](#browser-did-not-open-or-the-port-is-busy)
- [dalang starts the web server instead of the terminal room](#dalang-starts-the-web-server-instead-of-the-terminal-room)
- [Text in the terminal room cannot be selected](#text-in-the-terminal-room-cannot-be-selected)
- [Up and Down move through suggestions instead of prompts](#up-and-down-move-through-suggestions-instead-of-prompts)
- [A Windows provider is installed but Dalang cannot find it](#a-windows-provider-is-installed-but-dalang-cannot-find-it)
- [Docker fails to start](#docker-fails-to-start)
- [Provider shows LOGIN NEEDED or runs fail with login_expired](#provider-shows-login-needed-or-runs-fail-with-login_expired)
- [Claude reached its limit and the Lead fallback did not run](#claude-reached-its-limit-and-the-lead-fallback-did-not-run)
- [Update CLI fails](#update-cli-fails)
- [A schedule or webhook run was skipped](#a-schedule-or-webhook-run-was-skipped)
- [An outside agent cannot reach /mcp](#an-outside-agent-cannot-reach-mcp)

### Database schema is newer than this Dalang build

If `dalang` prints an error such as `Database schema v15 is newer than this DALANG build (v14)`, the installed CLI is older than the database. Older builds can show the same error for `dalang update`. Install the latest version directly:

```bash
npm install -g dalang-cli@latest
dalang --version
dalang
```

The [upgrade table](INSTALL.md#database-upgrades) lists the release that supports each schema. If `dalang --version` still shows an older version, check which executable your terminal uses: `command -v dalang` on Linux/macOS or `where.exe dalang` in PowerShell. If you use Docker, update the source checkout and rebuild the container instead.

Do not delete the database to fix this error. To return to an older build, restore a backup created before the schema upgrade. [Update and backup](INSTALL.md#update-dalang)

### Browser did not open or the port is busy

Open the URL printed in the terminal, normally `http://127.0.0.1:4173`. If startup reports `EADDRINUSE`, use another loopback port:

```bash
dalang web --port 4180 --no-open
```

Then open `http://127.0.0.1:4180`. To use the terminal room against that server, run `dalang room --port 4180` in another terminal.

### dalang starts the web server instead of the terminal room

`dalang` opens the terminal room only when both stdin and stdout are a terminal. Piped output, a service manager, or `docker compose` start `dalang web` instead. `dalang --port` and `dalang --no-open` without a subcommand also start the web server, with a deprecation notice. Run `dalang doctor`: the **Terminal room (TTY)** check reports what Dalang detected.

### Terminal title does not change or restore

The room updates the title of the active terminal with an animated spinner during work and `*` for pending input. Some terminal emulators or multiplexers do not support these title commands or restoring a previous title. Some terminals also limit how often a tab title may change, so the title spinner can look less smooth than the status-line spinner. The room's on-screen status and gates remain available. Free-form question detection relies on punctuation, so it can miss a question or show `*` for a rhetorical one.

### Text in the terminal room cannot be selected

The room asks the terminal to report the mouse wheel so it can scroll older messages, and that stops plain click-and-drag selection. Hold `Shift` while you drag (most terminals), run `/mouse` to toggle capture, or start Dalang with `DALANG_NO_MOUSE=1 dalang` to leave the mouse to the terminal. `PageUp` and `PageDown` scroll either way. If a crash leaves the terminal printing odd characters when you move the mouse, run `reset`.

### Up and Down move through suggestions instead of prompts

While the `/` or `@` suggestions are open, arrow keys move the selection. When idle, press `Esc` to clear the composer (when agents or tasks are running, `Esc` stops all running work first), then use `↑` to recall prompts. Use `/resume` first if the prompt is in an older session. [Terminal shortcuts](USAGE.md#commands-and-keyboard-shortcuts)

### Windows source install asks for C++ Build Tools

Use the pinned pnpm version (`npm install -g pnpm@10.34.9`) and rerun `pnpm install --frozen-lockfile`. The workspace skips an unnecessary SQLite build because better-sqlite3 ships native binaries for the supported platforms. For a standalone installation, follow the [Windows setup](INSTALL.md#native-windows).

### A Windows provider is installed but Dalang cannot find it

Check `Get-Command claude,codex,agy -All`, restart the terminal after changing PATH, then run `dalang doctor`. Native executables are required; an npm `.cmd` or PowerShell `.ps1` launcher alone is insufficient. Claude Code's standard npm-native executable location is also searched. [Windows providers](PROVIDERS.md#native-windows-providers)

### Verification commands fail on native Windows

Commands run through `cmd.exe`, so POSIX syntax such as `VAR=value command` or `/bin/sh` is not a Windows verification command. Use a portable script command such as `node src/math.test.mjs` or `npm test`, and quote paths containing spaces. Store the same command in the task and project integration settings. For POSIX-only projects, use WSL 2.

### Windows project instructions report a link problem

Since v0.7.3, Dalang creates instruction pointers when file-symlink privilege is unavailable. Existing `CLAUDE.md` or `AGENTS.md` files remain user-owned and are not replaced. Review those files and `PROJECT.md` from the project header. Developer Mode or administrator access is not required to use the instruction-pointer fallback.

### Docker fails to start

Check `docker compose logs dalang`. If bubblewrap cannot create a namespace or mount `/proc`, confirm that the host allows unprivileged user namespaces and that the service uses the security settings in `compose.yaml`. To run the diagnostics inside the running container, use `docker compose exec dalang node /app/bin/dalang.js doctor`. [Docker setup](INSTALL.md#run-with-docker)

### The DALANG login page asks for a password

Use the password you set in **Config → Security → DALANG login**. The same password unlocks the terminal room. Restarting the server expires existing logins. A signed-in browser can disable the password from the same menu. [App login](INSTALL.md#require-a-dalang-password)

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

Sign in again with the official CLI, then recheck CLI status in `/config` or refresh it in the browser under **Config → Agents**.

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

Wait for that provider's active turns to finish (or press `Esc` / run `/stop`), then retry **Update CLI**, `/update clis`, or `dalang update --clis`. If the message points to an installation managed by a package manager or a permissions error, use that installation's update command and refresh CLI status. [Provider updates](PROVIDERS.md#update-provider-clis)

### Provider stays in cooldown after quota resets

DALANG automatically expires a cached "0% remaining" reading at its reset time (or after 15 minutes if no reset time is reported), and reactive rate-limit cooldowns last 5 minutes. You can clear a cooldown immediately from **Config → Agents** using **Clear cooldown** (or **Refresh CLI status**).

### Claude reached its limit and the Lead fallback did not run

Check the Lead's fallback in the browser under **Config → Agents → Team**. A backup model on the same Claude account shares the account limit. Choose another provider or a separate signed-in account directory. If you need to continue the current chat with a specific provider, use `/model` in the terminal or the browser's model picker. [Configure an Ask fallback](PROVIDERS.md#fallback-for-the-lead-in-ask)

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

### A project opens into an empty chat after upgrading

The terminal room opens a new chat. Use `/resume` to find an earlier session for the project. In the browser, the sidebar lists saved sessions. For a v0.6 upgrade, open the saved **Full** session to find the original conversation, brief, and tasks. [Work with saved chats](USAGE.md#continue-or-manage-a-chat)

### Verify fails with `command not found` in a task worktree

A task worktree holds only the files tracked by git. For a JavaScript project with a lockfile, DALANG installs dependencies in the worktree before the agent starts, and builds a workspace that has a root `build` script. The run log shows `[dalang] Preparing worktree: ...`. The install downloads packages into a throwaway cache inside the sandbox, so it needs network access. If it shows `Skipping dependency install`, add `node_modules/` to `.gitignore`. If the install failed, the lines above the failure say why; a lockfile that no longer matches `package.json` is the usual cause. Other ecosystems (Python, Ruby, Go modules) are not set up automatically yet.

### Another session has unfinished work

Open the session named in the message and finish reviewing its remaining tasks, or use **Discard work** in that session's header. Archiving is available after you finish or discard the work. You can keep using Ask in other sessions while you decide. [Work with saved chats](USAGE.md#continue-or-manage-a-chat)

### A schedule or webhook run was skipped

An automated run starts a new Quick session, and only one session can have unfinished work at a time. When another session still has a task waiting in **Review & merge**, or a task is running, the trigger is recorded as **Skipped** in the automation's **Runs** list. Merge or discard that work, then use **Run now** or wait for the next trigger. Turn on auto-merge for an automation if its passing tasks should not wait for you. [Automation](USAGE.md#automation-and-outside-agents-over-mcp)

A webhook call that returns `401` has a missing or wrong signature or timestamp. With `X-Dalang-Signature-256`, sign `<timestamp>.<raw body>` with the current secret, send the same Unix time in `X-Dalang-Timestamp`, and check that both clocks agree within 5 minutes. A `409` means the automation is paused or the same signed request already started a run; sign it again with a new timestamp.

### An outside agent cannot reach /mcp

- `401 Unauthorized`: the token is wrong, revoked, or was deleted. Create a new one in **Config → Automation** and update the agent's MCP settings.
- `403 Forbidden: /mcp is loopback-only`: the request did not come from the same machine. In Docker, run the agent inside the container with `docker compose exec`.
- The agent lists only read tools: the token is `read-only`. Create a `full-access` token to start or merge tasks.
- Codex reports a timeout while `start_task` runs: set `tool_timeout_sec` in its `[mcp_servers.dalang]` block (the generated snippet uses 3600), or call `start_task` with `mode: "async"` and check progress with `get_task`.

### Record provider CLI sessions for a bug report or replay test

Start Dalang with `DALANG_RECORD_DIR` set. The terminal room and the browser both use it:

```bash
DALANG_RECORD_DIR=~/.dalang/recordings dalang
```

Every `claude`, `codex`, and `agy` invocation is saved as one JSON file: its arguments, stdout lines with the time each arrived, stderr, stdin writes, exit code, and whether it timed out. Values of environment variables whose names contain `TOKEN`, `SECRET`, `PASSWORD`, `API_KEY`, or `AUTH` are replaced with `[REDACTED]`. Prompts and code are kept, so the files are readable only by you; review them before sharing.

From a source checkout, summarize timings and failures, or turn recordings into a replay transcript for `ReplayCliRunner`:

```bash
node packages/core/scripts/recordings.mjs summary ~/.dalang/recordings
node packages/core/scripts/recordings.mjs transcript ~/.dalang/recordings my-case > transcript.json
```

Replay does not yet drive session protocols (`codex app-server`, `agy acp`, Claude stream-json input), so a transcript of those runs replays only through the one-shot path.
