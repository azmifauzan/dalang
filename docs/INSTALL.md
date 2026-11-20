# Install Dalang

Dalang runs a local web app on your machine. Set up Node.js, Git, and one coding-agent CLI before starting it.

## Requirements

- [Node.js](https://nodejs.org/en/download) **24 or newer**, with npm. Check with `node --version` and `npm --version`.
- **Git** in your terminal’s PATH. Check with `git --version`.
- At least one installed and signed-in **Claude Code**, **Codex CLI**, or **Antigravity CLI**. [Provider setup](PROVIDERS.md)
- The platform sandbox below. For GitHub pull requests, also install [GitHub CLI](https://cli.github.com/) and run `gh auth login`.

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

## Start Dalang

Run directly with npm.

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

Use `dalang` in place of `npx dalang-cli` after a global install. You can also set `DALANG_PORT` to choose a default port.

## Update Dalang

Let active tasks finish or stop them, then stop the server with Ctrl+C. Back up your Dalang data directory and project checkout before upgrading from v0.6 or earlier. Use the command that matches your installation.

```bash
npx dalang-cli@latest
npm install -g dalang-cli@latest
```

With a global installation, start the updated app with `dalang`. On first launch, v0.7 upgrades the database to schema v9. A project with existing history gets a **Full** session in the sidebar. Dalang moves its saved artifacts into `.dalang/sessions/<session-id>/` and adds ignore rules for session logs and temporary files. Older builds may refuse to open the upgraded database.

Use **Config → About → Check now** to check for a release. Dalang can also notify you about updates when version checks are enabled in **Config → General**. [Release notes](https://github.com/azmifauzan/dalang/releases)

## Data and uninstall

| Location | Contents |
| --- | --- |
| `~/.dalang/dalang.db` | Projects, chat transcripts, settings, and run history. Set `DALANG_HOME` to relocate the data directory. |
| `~/.dalang/worktrees/` | Isolated task checkouts managed by Dalang. |
| `<repo>/.dalang/sessions/<session-id>/` | Session briefs, plans, task results, reviews, and logs. |
| `<repo>/.dalang/tmp/` | Temporary files including Ask technical logs. |
| Project Git repository | Dalang task branches, checkpoint refs, and approved merges. |

Stop Dalang before copying its data directory for a backup. Keep the project repository, including its Git history, and any uncommitted work you need from task worktrees.

To uninstall the global command, run `npm uninstall -g dalang-cli`. Your local data and project artifacts remain available after uninstalling.

## Build from source

Install pnpm before cloning and building Dalang. [pnpm installation](https://pnpm.io/installation)

```bash
git clone https://github.com/azmifauzan/dalang.git
cd dalang
pnpm install --frozen-lockfile
pnpm build
pnpm --filter dalang-cli doctor
pnpm start
```

To update a source checkout, run `git pull`, `pnpm install --frozen-lockfile`, and `pnpm build`, then restart. Run `pnpm typecheck` and `pnpm test` to verify the build without using model quota. The browser scenarios use a built web app and an installed Chromium or Chrome.
