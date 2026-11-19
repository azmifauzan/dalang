# Installing DALANG

DALANG runs locally on your machine, binds only to `127.0.0.1`, and uses the official CLI binaries you already log in to (`claude`, `codex`, `agy`).

## Requirements

- **Node.js 24 or newer** (Node.js 26 LTS recommended; the packed install was checked on 24 and 26)
- **Git** (`git --version`)
- **At least one logged-in agent CLI**:
  - Claude Code (`claude auth login`)
  - Codex CLI (`codex login`)
  - Antigravity CLI (`agy`)
- **Platform sandbox** (strongly recommended):
  - **Linux**: `bubblewrap` (`bwrap`), plus `xdg-dbus-proxy` if you enable Antigravity in the sandbox
  - **macOS**: built-in `/usr/bin/sandbox-exec`
  - **Windows**: run inside **WSL 2 (Ubuntu)** with `bubblewrap` installed (native Windows execution is planned for v0.8)
- **Optional**: GitHub CLI (`gh`) logged in via `gh auth login` if you want DALANG to open pull requests after Gate 2 merges.

## Quick start (`npx dalang-cli`)

Check your machine first:

```bash
npx dalang-cli doctor
```

`dalang doctor` checks Node.js, git, the platform sandbox, the writable data directory (`~/.dalang`), `gh`, and every installed CLI's version and login status, printing a concrete fix for any failure.

Start the local server and open the browser UI:

```bash
npx dalang-cli
```

Useful flags:

```bash
npx dalang-cli --port 4173       # Custom loopback port (or set DALANG_PORT)
npx dalang-cli --no-open         # Start the server without opening a browser tab
npx dalang-cli doctor --json     # Machine-readable diagnostics
npx dalang-cli --version         # Print version
```

> **Note on native install scripts (`better-sqlite3`):** newer versions of npm require approving dependency install scripts on first install. `better-sqlite3` bundles prebuilt binaries for Linux, macOS, and Windows so no C++ compiler is needed once approved.

## Platform setup

### Linux (Debian / Ubuntu / Fedora)

```bash
# Debian / Ubuntu
sudo apt update && sudo apt install -y git bubblewrap xdg-dbus-proxy

# Fedora
sudo dnf install -y git bubblewrap xdg-dbus-proxy
```

### macOS

Git ships with Xcode Command Line Tools (`xcode-select --install`) and `/usr/bin/sandbox-exec` is built into macOS. Install Node.js 26 LTS via Homebrew (`brew install node@26`) or `nvm`.

### Windows (via WSL 2)

Native Windows sandboxing is not built in v0.5. Run DALANG inside WSL 2:

1. Install WSL 2 with Ubuntu (`wsl --install -d Ubuntu`).
2. Inside the Ubuntu shell, install Node.js 26 LTS, `git`, and `bubblewrap`:
   ```bash
   sudo apt update && sudo apt install -y git bubblewrap
   ```
3. Install and log in to your agent CLIs inside WSL, then run `npx dalang-cli doctor` and `npx dalang-cli`.
4. Open `http://127.0.0.1:4173` from your Windows browser (WSL forwards loopback ports automatically).

## Updating

Stop the server first (Ctrl+C) and wait for running tasks to finish. Then, depending on how you run DALANG:

```bash
npx dalang-cli@latest              # npx: @latest skips a cached older copy
npm install -g dalang-cli@latest   # global install, then check with: dalang --version
git pull && pnpm install && pnpm build   # from source
```

Your data in `~/.dalang/` and `<repo>/.dalang/` is kept. The database schema is upgraded when the server starts (v6 to v7 is covered by a test). It cannot be downgraded: an older DALANG refuses to start on a newer database. DALANG does not check for new versions itself; watch the [releases page](https://github.com/azmifauzan/dalang/releases) or run `npm view dalang-cli version`.

## Running from source

```bash
git clone https://github.com/azmifauzan/dalang.git
cd dalang
pnpm install
pnpm build
pnpm start
```

## Data locations

| Path | Contents |
| --- | --- |
| `~/.dalang/` (override with `DALANG_HOME`) | Global SQLite database (`dalang.db`) and isolated task worktrees (`worktrees/`) |
| `<repo>/.dalang/` | Per-project brief, plan, discuss rounds, task results, reviews, and run logs |
