# Install Dalang

Dalang runs a terminal team room and a local browser workspace. For npm or source installs, set up Node.js, Git, and one coding-agent CLI. The Docker image includes all three CLIs and starts the browser workspace. [Docker setup](#run-with-docker)

## Requirements

- [Node.js](https://nodejs.org/en/download) **24 or newer**, with npm. Check with `node --version` and `npm --version`.
- **Git** in your terminal’s PATH. Check with `git --version`.
- At least one installed and signed-in **Claude Code**, **Codex CLI**, or **Antigravity CLI**. [Provider setup](PROVIDERS.md)
- The platform sandbox below, or explicit unconfined consent on native Windows. For GitHub pull requests, also install [GitHub CLI](https://cli.github.com/) and run `gh auth login`.

### Linux

On Debian or Ubuntu, install Git and bubblewrap with APT.

```bash
sudo apt update
sudo apt install git bubblewrap
```

On Fedora, use DNF.

```bash
sudo dnf install git bubblewrap
```

Antigravity in the Linux sandbox also needs `xdg-dbus-proxy`, an active desktop session, and explicit permission to read the keyring. [Antigravity setup](PROVIDERS.md#antigravity-cli-on-linux)

### macOS

Run `xcode-select --install` if Git is missing, then install a supported Node.js version. Dalang uses the built-in `/usr/bin/sandbox-exec`.

### Windows with WSL 2

1. In PowerShell, run `wsl --install -d Ubuntu` and finish Ubuntu’s setup.
2. In the Ubuntu shell, install Node.js 24+, Git, and `bubblewrap` as described above. Install and sign in to your agent CLI in that shell too.
3. Run `dalang` in Ubuntu for the terminal team room. For the browser workspace, run `dalang web --no-open` and visit `http://127.0.0.1:4173` in Windows.

### Native Windows

Install Node.js 24+, Git, and at least one signed-in provider CLI in Windows. Use PowerShell to install the latest release:

```powershell
npm install -g dalang-cli@latest
dalang doctor
dalang
```

Run `dalang web --no-open` to serve the browser workspace at `http://127.0.0.1:4173`. SQLite uses the native binary for the supported installation. The pinned pnpm version also works in PowerShell. [Build from source](#build-from-source)

For native confinement, install Codex with its Windows MXC backend and check for **Sandbox (Windows MXC)** in `dalang doctor`. If MXC is unavailable, Dalang asks for explicit unconfined consent before starting a task. Verification commands use `cmd.exe`, so configure commands with Windows-compatible syntax. When symlink privileges are unavailable, new `CLAUDE.md` and `AGENTS.md` files refer agents to `PROJECT.md`. Existing user instruction files are preserved. Claude's npm installation is detected through its native executable.

Verification on Windows on 2026-11-21 covered installation from a standalone npm tarball, production build, type checking, SQLite, HTTP health, CLI detection, project creation, shell commands including executable paths with spaces, and the Edge browser scenarios for setup, navigation, Ask, Quick merge, and promotion to Full. All 104 applicable tests passed in staged runs (87 core, 12 server/browser, 5 CLI). Five file-symlink/FIFO tests were skipped because the OS facilities or privileges were unavailable; directory-link confinement was tested with Windows junctions.

A live Codex Quick task also passed planning, coding, verification, read-only review, merge, and post-merge integration on an isolated repository with a seeded arithmetic bug. Required `result.json` orchestration metadata is explicitly distinguished from application scope in the review prompt.

Linux regression in a container passed 107 tests, with the two Windows-only tests skipped. macOS sandbox profile and detection tests passed, but no native macOS machine was available for an end-to-end run. Platform-specific Windows behavior is gated on `win32`; Linux and macOS retain their existing shells and sandbox engines.

## Start Dalang

Install the latest release on any supported platform:

```bash
npm install -g dalang-cli@latest
dalang doctor
dalang
```

Alternatively, run Dalang without a global installation:

```bash
npx dalang-cli@latest doctor
npx dalang-cli@latest
```

`doctor` checks Node.js, Git, the sandbox, the data directory, GitHub CLI, and provider login status. Fix any issues affecting the features you plan to use. [Troubleshooting](TROUBLESHOOTING.md)

In an interactive terminal, `dalang` opens the team room and starts with the setup wizard on a fresh install. For the browser workspace, run `dalang web` and open the URL it prints, normally `http://127.0.0.1:4173`. Keep the terminal running while you use the app. [Terminal walkthrough](USAGE.md#terminal-team-room) · [Browser walkthrough](USAGE.md#browser-workspace)

| Command | When to use it |
| --- | --- |
| `dalang` | Open the interactive terminal team room (falls back to `dalang web` when stdin/stdout is not a TTY) |
| `dalang room --port 4180` | Open the terminal team room against a server on another port |
| `dalang web` | Start the local web server and open the browser UI |
| `dalang web --no-open` | Start the web server without opening a browser tab |
| `dalang web --port 4180` | Use another loopback port if 4173 is busy |
| `dalang doctor [--json]` | Check Node, Git, sandbox, data directory, TTY, and provider logins |
| `dalang update [--check\|--clis\|--all] [--json]` | Check/install the latest Dalang release via npm and/or update all connected agent CLIs |
| `dalang --version` | Check the installed version |

Use `npx dalang-cli` in place of `dalang` without a global install. Passing `--port` or `--no-open` directly to `dalang` without `web` remains supported with a deprecation notice for one release. You can also set `DALANG_PORT` to choose a default port.

## Run with Docker

Install Docker with Compose v2. From the DALANG source checkout, build and start the service.

```bash
docker compose up --build -d
```

Open `http://127.0.0.1:4173`. The image includes Claude Code, Codex CLI, Antigravity CLI, Git, and bubblewrap. The port is published on localhost. The service runs as the unprivileged `node` user with all container capabilities dropped. Compose relaxes Docker's seccomp, AppArmor, and system-path masking so bubblewrap can create its per-project namespaces and mount a private `/proc`. The host must allow unprivileged user namespaces.

Sign in to the agents you use inside the container. Follow the URL or code printed by each CLI from your browser.

```bash
docker compose exec dalang claude auth login
docker compose exec dalang codex login --device-auth
docker compose exec dalang agy acp --login
```

For Antigravity, also enable **Config → Security → Allow Antigravity to read the desktop keyring**. The container supplies its own Secret Service and persistent keyring. **Config → Agents → Update CLI** runs each provider's updater. The `dalang-home` volume keeps database state, provider sign-ins, and updated CLI binaries across container replacement.

Add projects under `/workspace`. To mount existing checkouts, set `DALANG_PROJECTS` to their parent directory before running Compose and open them by their container paths, such as `/workspace/my-repo`. Mounted repositories need write access for UID 1000.

## Require a DALANG password

Login starts off. In the browser, open **Config → Security → DALANG login**, set a password of at least 12 characters, and select **Enable login**. The terminal room prompts for the same password when it connects. In the browser, use **Sign out** in the sidebar footer. Sessions expire after 24 hours or when the server restarts. **Disable login** in web Config restores password-free access. Provider accounts use their own sign-in commands. [How the login protects local access](SANDBOX.md#optional-app-login)

## Update Dalang

If an older `dalang` reports that the database schema is newer than the build, do not delete the database. `dalang update` is unavailable in older builds, so install the latest release directly:

```bash
npm install -g dalang-cli@latest
dalang --version
dalang
```

Check that the installed version supports your schema in the [upgrade table](#database-upgrades). If it is still older, check which executable your shell runs (`command -v dalang` on Linux/macOS or `where.exe dalang` in PowerShell).

Let active tasks finish or stop them. Close the terminal room with `/exit` and stop a separately running server with Ctrl+C or `docker compose stop`. Back up the Dalang data directory and any project checkout you may need to restore. Use the command that matches your installation:

```bash
npx dalang-cli@latest
dalang update
dalang update --clis
dalang update --all
npm install -g dalang-cli@latest
```

`dalang update --check` only reports whether a newer release exists. `dalang update --clis` updates every connected agent CLI (`claude`, `codex`, `agy`), and `dalang update --all` updates both Dalang and all connected CLIs. Inside the terminal room, run `/update`, `/update check`, `/update clis`, or `/update all`; after a Dalang update installs, the room shows a restart notification banner so you can apply it with `/restart`. With a global installation, start the updated app with `dalang`. For Docker, update the source checkout and rerun `docker compose up --build -d`. Keep the `dalang-home` volume to retain app data, provider sign-ins, and CLI updates.

If the npm registry does not have the newest release yet, install the tarball attached to its [GitHub release](https://github.com/azmifauzan/dalang/releases) (`npm install -g <tarball URL>`).

### Database upgrades

Dalang upgrades its database the first time a newer version starts, from any earlier release, and keeps your projects, sessions, briefs, plans, tasks, settings, and profiles. The current schema is v17:

| Release | Schema | What the upgrade does |
| --- | --- | --- |
| v0.7.0 | v9 | Moves each project's history into a **Full** session and its saved artifacts into `.dalang/sessions/<session-id>/` |
| v0.7.2 | v10 | Adds stored chat images |
| v0.7.4 | v11 | Adds the `coder-medium` and `qa` profiles and points the medium and checker routing rules at them |
| v0.8.0 | v12 | Adds the delegation fields on tasks |
| v0.9.0 | v13 | Adds per-repo task and checkpoint records for workspace projects |
| v0.11.0 | v14 | Adds schedules, webhooks, their run history, and outside-agent MCP tokens |
| v0.12.0 | v15 | Adds `author_profile_id` and `kind` to messages for role reports and team-room feeds |
| v0.14.0 | v16 | Adds `output_kind` (`files` or `answer`) to tasks and automations, makes `verify` nullable across tasks, reviews, and automations, and refreshes untouched default role prompts |
| v0.14.5 | v17 | Adds indexes on the foreign keys that pages read most, `client_request_id` on tasks, `delivery_id` on automation runs, and a `webhook_deliveries` table, all additive. Turns on `busy_timeout` and `synchronous = NORMAL` |

An upgrade is one way. An older build refuses a newer database with `Database schema vN is newer than this DALANG build`, so restore your pre-upgrade backup to go back. A server that is still running keeps the old code and schema in memory, so restart it after updating.

Use **Config → About → Check now** to check for a release. Dalang can also notify you about updates when version checks are enabled in **Config → General**. [Release notes](https://github.com/azmifauzan/dalang/releases)

## Data and uninstall

| Location | Contents |
| --- | --- |
| `~/.dalang/dalang.db` | Projects, chat transcripts and images, settings, run history, automations with their webhook signing secrets, and hashes of outside-agent MCP tokens. Set `DALANG_HOME` to relocate the data directory. |
| `~/.dalang/worktrees/` | Isolated task checkouts managed by Dalang. |
| `<repo>/.dalang/sessions/<session-id>/` | Session briefs, plans, task results, reviews, and logs. |
| `<repo>/.dalang/tmp/` | Temporary files including Ask technical logs. |
| Project Git repository | Dalang task branches, checkpoint refs, and approved merges. |

Stop Dalang before copying its data directory for a backup. Keep the project repository, including its Git history, and any uncommitted work you need from task worktrees.

On native Windows, `~/.dalang` is `%USERPROFILE%\.dalang`. To choose another location for the current PowerShell session, set `$env:DALANG_HOME = 'D:\DalangData'` before starting `dalang`.

To uninstall the global command, run `npm uninstall -g dalang-cli`. Your local data and project artifacts remain available after uninstalling.

## Build from source

Install the pinned pnpm version before cloning and building Dalang. The commands below work in PowerShell and POSIX shells.

```bash
npm install -g pnpm@10.34.9
git clone https://github.com/azmifauzan/dalang.git
cd dalang
pnpm install --frozen-lockfile
pnpm build
pnpm --filter dalang-cli doctor
pnpm start
```

To update a source checkout, run `git pull`, `pnpm install --frozen-lockfile`, and `pnpm build`, then restart. Run `pnpm typecheck` and `pnpm test` to verify the build without using model quota. The browser scenarios use a built web app and Chromium or Chrome on Linux, or Edge or Chrome on Windows. Windows tests run serially with longer Git/worktree timeouts. File-symlink tests probe the available privilege; FIFO tests apply only to POSIX platforms.
