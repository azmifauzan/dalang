# Install Dalang

Dalang runs a local web app on your machine. For npm or source installs, set up Node.js, Git, and one coding-agent CLI. The Docker image includes all three CLIs. [Docker setup](#run-with-docker)

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
3. Run Dalang in Ubuntu. If a tab does not open, visit `http://127.0.0.1:4173` in your Windows browser.

### Native Windows

Install Node.js 24+, Git, and at least one signed-in provider CLI in Windows. Use PowerShell to install the latest release:

```powershell
npm install -g dalang-cli@latest
dalang doctor
dalang --no-open
```

Open `http://127.0.0.1:4173`. SQLite uses the binary shipped in the package; C++ Build Tools are not needed for this configuration. For a source checkout, follow [Build from source](#build-from-source); the pinned pnpm version also works in PowerShell.

Native Windows has no Dalang sandbox. Agent execution requires explicit unconfined opt-in. Verification commands use `cmd.exe`, so configure commands with Windows-compatible syntax. When symlink privileges are unavailable, new `CLAUDE.md` and `AGENTS.md` files refer agents to `PROJECT.md`; existing user instruction files are preserved. Dalang recognizes these instruction pointers as configured. Claude's npm installation is detected through its native executable; arbitrary `.cmd` launchers are not supported.

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
npx dalang-cli doctor
npx dalang-cli
```

For a global installation, install the package first.

```bash
npm install -g dalang-cli
dalang doctor
dalang
```

`doctor` checks Node.js, Git, the sandbox, the data directory, GitHub CLI, and provider login status. Fix any issues affecting the features you plan to use. [Troubleshooting](TROUBLESHOOTING.md)

Open the URL printed in the terminal, normally `http://127.0.0.1:4173`. Keep the terminal running while you use the app. Once open, follow [the first-project guide](USAGE.md).

| Command | When to use it |
| --- | --- |
| `npx dalang-cli --version` | Check the installed version |
| `npx dalang-cli --no-open` | Start without opening a browser tab |
| `npx dalang-cli --port 4180` | Use another loopback port if 4173 is busy |
| `npx dalang-cli doctor --json` | Get machine-readable diagnostics |
| `dalang update --check` | Check whether a newer version is available |
| `dalang update` | Check and install the latest global release via npm |

Use `dalang` in place of `npx dalang-cli` after a global install. You can also set `DALANG_PORT` to choose a default port.

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

Login starts off. In **Config → Security → DALANG login**, set a password of at least 12 characters and select **Enable login**. With login enabled, the **Sign out** icon appears at the far right of the sidebar footer, after the theme switch. Sign in again after signing out, after the 24-hour session expires, or after restarting DALANG. **Disable login** in Config returns the app to password-free access. Provider accounts still use their own sign-in commands. [How the login protects local access](SANDBOX.md#optional-app-login)

## Update Dalang

If an older `dalang` reports that database schema v11 is newer than the build, do not delete the database. Install a release that supports v11 directly; `dalang update` is unavailable in older builds:

```bash
npm install -g dalang-cli@latest
dalang --version
dalang
```

Confirm the installed version is v0.7.4 or newer before starting. If it is still older, check which executable your shell runs (`command -v dalang` on Linux/macOS or `where.exe dalang` in PowerShell).

Let active tasks finish or stop them, then stop the server with Ctrl+C or `docker compose stop`. Back up the Dalang data directory and any project checkout you may need to restore. To update a global installation:

```bash
npm install -g dalang-cli@latest
```

Alternatively, use the command that matches your installation:

```bash
npx dalang-cli@latest
dalang update
npm install -g dalang-cli@latest
```

With a global installation, start the updated app with `dalang`. For Docker, update the source checkout and rerun `docker compose up --build -d`. Keep the `dalang-home` volume to retain app data, provider sign-ins, and CLI updates.

v0.7.4 upgrades the database to schema v11. Earlier builds cannot open it; keep a backup if you may need to return to an older build.

Dalang v0.7.2 upgrades the database to schema v10 for chat images. When upgrading from v0.6 or earlier, it also organizes existing project history into a **Full** session and moves saved artifacts into `.dalang/sessions/<session-id>/`. Use your pre-upgrade backup to return to a build that requires an older schema.

Use **Config → About → Check now** to check for a release. Dalang can also notify you about updates when version checks are enabled in **Config → General**. [Release notes](https://github.com/azmifauzan/dalang/releases)

## Data and uninstall

| Location | Contents |
| --- | --- |
| `~/.dalang/dalang.db` | Projects, chat transcripts and images, settings, and run history. Set `DALANG_HOME` to relocate the data directory. |
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
