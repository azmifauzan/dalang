<p align="center">
  <img src="./packages/web/public/favicon.svg" width="72" height="72" alt="" />
</p>

<h1 align="center">Dalang</h1>

<p align="center">Ask about your code, plan changes, and review agent work in one local workspace.</p>

<p align="center">
  <a href="#install"><strong>Install</strong></a> ·
  <a href="./docs/USAGE.md">User guide</a> ·
  <a href="./docs/TROUBLESHOOTING.md">Common errors</a> ·
  <a href="./docs/README.md">All docs</a> ·
  <a href="https://github.com/azmifauzan/dalang/releases">Releases</a> ·
  <a href="https://www.npmjs.com/package/dalang-cli">npm</a>
</p>

> [!IMPORTANT]
> **Dalang does not start because the database schema is newer than your build?**
> Older versions may also fail when you run `dalang update`. Stop Dalang and install the latest version directly:
>
> ```sh
> npm install -g dalang-cli@latest
> dalang --version
> dalang
> ```
>
> The installed version must be 0.7.4 or newer for database schema v11. Do not delete your database. [More help](docs/TROUBLESHOOTING.md#database-schema-is-newer-than-this-dalang-build)

![Dalang in Ask mode with an attached screenshot, saved chats, and a paperclip button in the composer](docs/images/ask.webp)

Dalang runs **Claude Code, Codex CLI, and Antigravity CLI** from a browser workspace on your machine. Open a Git repository and start a chat with the Lead. Ask a question, plan a small fix, or work through a larger feature. When agents change code, Dalang runs each task in a separate Git worktree and brings the verification output, review, and diff back for your merge decision.

Start with one signed-in CLI or give planning, coding, and review to different providers. Dalang uses the logins you already have. You can work in English or Indonesian.

## Choose a mode

| Mode | What you can do |
| --- | --- |
| **Ask** | Get a read-only answer about the repository. |
| **Quick** | Review a one-task plan, run it, and decide whether to merge in the same chat. |
| **Full** | Discuss a larger change, approve a brief and plan, run independent tasks in parallel, and review each diff before merging. A running coder can also hand independent parts of its task to another profile or CLI through a local MCP server. Each part is reviewed and merged into the task branch before you review the whole. |

The composer lets you choose a mode, CLI, model, and reasoning effort. Attach or paste screenshots when using Claude Code or Codex. Reopen saved chats and their images from the project sidebar. In **Config**, manage provider updates, team roles, account directories, and fallback targets. The project header shows reported quota windows, and **Statistics** summarizes runs, tokens, and API-equivalent cost estimates.

## Install

You need **Node.js 24+**, **Git**, and at least one supported agent CLI installed and signed in. Linux and WSL 2 use `bubblewrap`; macOS uses `sandbox-exec`. Native Windows runs directly in PowerShell with explicit consent for task execution without a Dalang sandbox. [Platform requirements and CLI sign-in](docs/INSTALL.md)

Install the latest release from npm:

```bash
npm install -g dalang-cli@latest
dalang doctor
dalang
```

Dalang starts at `http://127.0.0.1:4173` and opens your browser. Leave the terminal running while you work.

On Windows, task verification uses `cmd.exe`; use Windows-compatible commands. Existing repository instructions are preserved, and installations without symlink privileges use files that point agents to `PROJECT.md`. [Windows setup](docs/INSTALL.md#native-windows)

### Docker

From the source checkout, run `docker compose up --build -d` and open `http://127.0.0.1:4173`. The image includes all three CLIs. Sign in to the providers you use from inside the container. [Docker setup](docs/INSTALL.md#run-with-docker)

Dalang opens without an app password by default. Enable one in **Config → Security → DALANG login**. [Set up a DALANG password](docs/INSTALL.md#require-a-dalang-password)

## Your first project

1. Follow the setup wizard to check your CLIs and choose your Lead, coders, and reviewer.
2. Open an existing Git repository or create a project. Ask the Lead about the code, or choose **Quick** or **Full** before sending a change request.
3. For Quick and Full work, inspect the review and Git diff before merging. The Full flow also lets you run integration tests, push, or open a GitHub pull request from **Review & merge**.

[Walk through a project with screenshots](docs/USAGE.md) · [Upgrade from an earlier release](docs/INSTALL.md#update-dalang)

## Documentation

| Guide | What it covers |
| --- | --- |
| [Install and update](docs/INSTALL.md) | npm, Docker, platform requirements, upgrades, and backups |
| [Use Dalang](docs/USAGE.md) | Chat, image attachments, planning, runs, review, Git, and settings |
| [Providers and accounts](docs/PROVIDERS.md) | CLI sign-in and updates, models, separate accounts, routing, and fallback |
| [Sandbox and permissions](docs/SANDBOX.md) | Local access, optional password, filesystem confinement, Antigravity keyring access, and Git safety |
| [Troubleshooting](docs/TROUBLESHOOTING.md) | Startup, login, quota, sandbox, and Git problems |

[All documentation](docs/README.md) · [Changelog](CHANGELOG.md) · [Report an issue](https://github.com/azmifauzan/dalang/issues)

## License

[MIT](LICENSE) · [Wayang artwork credits](packages/web/src/assets/wayang/CREDITS.md) · [Provider mark credits](packages/web/src/assets/providers/CREDITS.md)
