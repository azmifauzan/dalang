# Use Dalang

This walkthrough takes a small change through **Discuss**, **Brief**, **Plan**, **Work**, and **Review & merge**. The screenshots show Dalang running a demo project with replayed agent responses. [Install and start Dalang](INSTALL.md)

## Set up your team and project

On your first launch, the wizard checks your agent CLIs, proposes a team, and opens your first project. If an agent shows **LOGIN NEEDED**, sign in from your terminal and refresh the check. One signed-in provider can fill every role.

![Setup wizard with provider, model, and reasoning effort controls for each role](images/setup.webp)

- **Lead (Semar)** asks questions and drafts the brief and task plan.
- **Coders (Bima and Kresna)** implement tasks. You can use different models for simple and complex work.
- **Reviewer (Arjuna)** checks the changes against the task. Pick a different provider from the coder if you want a cross-provider review.
- **Fallback** is an alternate CLI configuration Dalang can use when the primary cannot run.

Choose **New project** to initialize a folder with Git, or **Open existing repo** to work on an existing checkout. Enter the local folder path. Use the sidebar to switch projects or add another one later.

Dalang uses `PROJECT.md` for repository instructions and can link `CLAUDE.md` and `AGENTS.md` to it. Use the **PROJECT.md** button to review the file or check the links. Keep build commands, test commands, and project conventions here.

## 1. Discuss the goal

Open **Discuss** and describe what should change, what must stay in scope, and how you will know it works. You can choose a **Lead CLI** and model for the discussion.

For example, send this goal in a small Node.js project.

> Add a greeting helper that returns a formatted message from a name. Include tests for normal and empty input. Keep the module dependency-free.

Click **Send to Lead**. Answer any question cards, add notes if needed, then click **Submit answers & continue**. When the goal is clear, click **Enough, write the brief**.

## 2. Approve the brief

In **Brief**, check the proposed scope, features, constraints, and assumptions. Edit the draft and click **Save edits**, or use **Revise with Lead** to ask for a new version. Click **Approve brief (Gate 1)** when it matches your intent, then **Generate plan**.

## 3. Approve the plan

In **Plan**, inspect tasks on the **Kanban** board or switch to the **Dependency graph**. Open a task to edit its goal, allowed files, dependencies, profile override, acceptance criteria, and verify command. The verify command should be a command you would run locally, such as `node --test`.

![Plan view showing the kanban board and a task with its assigned profile and verify command](images/plan.webp)

Break broad tasks into smaller ones with clear file boundaries. Use dependencies for work that must happen in order. Dalang queues independent tasks in parallel when capacity permits and holds back tasks with overlapping allowed files. Check all tasks, then click **Approve plan** and open **Work**.

## 4. Run the work

Click **Start work** to run the approved queue. Dalang uses a separate Git worktree for each task. The wayang stage and **Activity feed** show progress. Click a figure or select a task under **Tasks & live logs** to inspect its output, attempts, and changed files. **Routing & queue** shows profile assignments and fallbacks. **Dependency graph** shows execution waves and what is waiting.

![Work view showing an active task on the wayang stage above its activity feed and run inspector](images/work.webp)

- Use **Stop** for an individual task or **Stop all runs** for the queue.
- Use **Retry** for a failed or stopped task. Where **Resume session** is available, use it to continue the provider session.
- To restore a pre-run state, select the run and use **Rollback to pre-run checkpoint**. Dalang can refuse a rollback when it would lose uncommitted work or commits made outside Dalang. [Rollback troubleshooting](TROUBLESHOOTING.md)
- If the sandbox is unavailable, see **Config → Security** for platform setup. Dalang asks for explicit confirmation before running tasks without filesystem confinement. [Sandbox and permissions](SANDBOX.md)

## 5. Review and merge

After a coder finishes, Dalang runs the task’s verification and an automated review. Open **Review & merge** and select a task. Read the review findings, open **Show verify output**, and inspect the **Branch diff** before deciding.

![Review and merge view with an automated review, branch diff, and merge controls](images/review.webp)

- **Approve and merge** adds the task changes to the project’s target branch. Dalang asks for a separate override if automated review failed.
- **Reject and send back** lets you leave feedback and optionally requeue the task for another attempt.
- Set the **Integration command** for project-wide checks, such as `npm test`. Run it after a merge using the checkbox, or manually with **Run integration suite**.

### Push or open a pull request

In **Remote push and pull request**, select the Git remote (usually `origin`). After approving a merge, you can push the branch or push and open a PR. You can also save post-merge defaults for the project. Pushing uses your normal Git credentials. Opening a PR also requires `gh auth login` and a branch with changes relative to the PR base. [Git troubleshooting](TROUBLESHOOTING.md#push-or-pull-request-fails-in-review-and-merge)

## Settings and statistics

| Where | What you can do |
| --- | --- |
| **Config → General** | Choose English or Indonesian for the UI and Lead/Reviewer output, set the theme, reopen the wizard, and manage update notifications. |
| **Config → Agents** | Check CLI versions, logins, model lists, and quotas. Refresh after installing a CLI or signing in again. |
| **Config → Team** | Edit profiles, models, reasoning effort, account directories, fallback targets, timeouts, and parallel slots. |
| **Config → Task routing** | Order rules by role and task complexity. The first matching rule selects the primary and can set a fallback. |
| **Config → Security** | Check sandbox status and manage the Linux Antigravity keyring opt-in. |
| **Config → About** | Check your version, look for updates, and open support docs. |
| **Statistics** | Filter runs by project and time window. See duration, failures, fallback events, token counts when available, and API-equivalent cost estimates. |

For account switching and routing examples, see [Providers and accounts](PROVIDERS.md). For where Dalang saves project data, see [Data and uninstall](INSTALL.md#data-and-uninstall).
