<p align="center">
  <img src="./packages/web/public/favicon.svg" width="72" height="72" alt="" />
</p>

<h1 align="center">Dalang</h1>

<p align="center">Run your coding agents as a team, from one local workspace.</p>

<p align="center">
  <a href="#install"><strong>Install</strong></a> ·
  <a href="./docs/USAGE.md">User guide</a> ·
  <a href="./docs/README.md">All docs</a> ·
  <a href="https://github.com/azmifauzan/dalang/releases">Releases</a>
</p>

![Dalang Work view showing a Codex task running on the wayang stage, the activity feed, and the run inspector](docs/images/work.webp)

Dalang brings **Claude Code, Codex CLI, and Antigravity CLI** into one browser workspace on your machine. Describe a change you want to make, then work with a Lead agent to turn it into a brief and a task plan. Dalang assigns tasks to your agents, runs them in separate Git worktrees, and brings the reviews and diffs back for you to decide what to merge.

Start with one signed-in CLI or give planning, coding, and review to different providers. Dalang uses the logins you already have. You can work in English or Indonesian.

## What you get

- **Agree on the scope before work starts.** Answer the Lead’s questions, edit the brief, and approve the task plan.
- **Run independent tasks in parallel.** See dependencies, shared files, and which agent gets each task. Follow live logs and stop, retry, or resume runs from the Work view.
- **Use the models and accounts you choose.** Configure agents by role and task complexity, with a fallback for limits, timeouts, or login failures.
- **Review before you merge.** Read automated findings, test output, and the Git diff. Approve the merge or send the task back with feedback. Run integration tests and optionally push or open a GitHub pull request.
- **Track usage across projects.** See runtimes, captured tokens, quota events, and API-equivalent cost estimates.

## Install

You need **Node.js 24+**, **Git**, and at least one supported agent CLI installed and signed in. On Linux and WSL 2, install `bubblewrap`. On macOS, Dalang uses the built-in `sandbox-exec`. [Platform requirements and CLI sign-in](docs/INSTALL.md)

Use npm to try Dalang without a global install.

```bash
npx dalang-cli doctor
npx dalang-cli
```

Dalang starts at `http://127.0.0.1:4173` and opens your browser. Leave the terminal running while you work.

Install the `dalang` command if you use it regularly.

```bash
npm install -g dalang-cli
dalang doctor
dalang
```

## Your first project

1. Follow the setup wizard to check your CLIs and choose your Lead, coders, and reviewer.
2. Open an existing Git repository or create a new project. In **Discuss**, describe a goal with a clear result.
3. Approve the **Brief**, then generate, edit, and approve the **Plan**.
4. Start **Work** and follow agent activity. Open **Review & merge** to inspect the results and decide what to merge.

[Walk through a project with screenshots](docs/USAGE.md)

## Documentation

| Guide | What it covers |
| --- | --- |
| [Install and update](docs/INSTALL.md) | Linux, macOS, WSL 2, npm, source builds, and data locations |
| [Use Dalang](docs/USAGE.md) | Setup, planning, runs, review, Git, and settings |
| [Providers and accounts](docs/PROVIDERS.md) | CLI sign-in, models, separate accounts, routing, and fallback |
| [Sandbox and permissions](docs/SANDBOX.md) | Local access, filesystem confinement, Antigravity keyring access, and Git safety |
| [Troubleshooting](docs/TROUBLESHOOTING.md) | Startup, login, quota, sandbox, and Git problems |

[All documentation](docs/README.md) · [Changelog](CHANGELOG.md) · [Report an issue](https://github.com/azmifauzan/dalang/issues)

## License

[MIT](LICENSE) · [Wayang artwork credits](packages/web/src/assets/wayang/CREDITS.md)
