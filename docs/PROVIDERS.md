# Providers, models, and accounts

Dalang runs the official coding-agent CLIs with the accounts you sign into on your machine. Each provider’s plan and usage limits still apply.

## Install and sign in

| Provider | Install | Sign in |
| --- | --- | --- |
| Claude Code | [Claude Code setup](https://code.claude.com/docs/en/setup) | `claude auth login` |
| Codex CLI | [Codex CLI setup](https://developers.openai.com/codex/cli) | `codex login` |
| Antigravity CLI | [Antigravity CLI setup](https://antigravity.google/docs/cli/overview) | Run `agy` and follow the interactive sign-in. |

Use the same terminal environment where you will start Dalang. Run `npx dalang-cli doctor` after signing in, or open **Config → Agents → Refresh CLI status** if Dalang is already running. If using WSL 2, install and sign in inside WSL.

### Antigravity CLI on Linux

The Linux sandbox needs `xdg-dbus-proxy` and an active desktop session to connect Antigravity to the Secret Service. Install the package with `sudo apt install xdg-dbus-proxy` or `sudo dnf install xdg-dbus-proxy`. In **Config → Security**, enable **Allow Antigravity to read the desktop keyring** only if you want to grant this access. The service exposes the full desktop keyring. With access disabled, tasks can route to their configured fallback. [Antigravity keyring details](SANDBOX.md#antigravity-keyring-exposure-opt-in)

## Choose a model and route tasks

1. In **Config → Team**, edit a profile or create one. Choose the provider and a model from that CLI. Set reasoning effort if the model supports it.
2. Keep the default parallel limits initially or adjust **Max parallel tasks** to fit the account. The profile also controls role instructions, permissions, and timeouts.
3. In **Config → Task routing**, match a task role and complexity to a primary profile. Put specific rules above broader rules because Dalang uses the first match. A task can also name a profile override in **Plan**.
4. Set a fallback provider, model, and effort on the profile or the routing rule. For example, match low-complexity engineering tasks to a Codex profile, high-complexity engineering tasks to a Claude Code profile, and set a backup for either rule if you have another signed-in account.

Model and effort options come from the CLI. If a saved model is marked **(unavailable)**, refresh status and choose a model the CLI still reports. Some models offer a context variant, such as **Use 1M context**, on the same profile. Use the model chip in the chat composer to choose a CLI, model, and reasoning effort for a Lead turn. Task execution uses the configured routing and profile overrides.

## Use separate accounts

Create a profile per account and give it a dedicated **Account config directory**. Sign in using that same directory before you select the profile in Dalang.

```bash
CLAUDE_CONFIG_DIR="$HOME/.claude-work" claude auth login
CODEX_HOME="$HOME/.codex-work" codex login
AGY_CONFIG_DIR="$HOME/.agy-work" XDG_CONFIG_HOME="$HOME/.agy-work" agy
```

Run the line for your provider. Enter the corresponding directory in the profile. If you want to use this account as a fallback, select the directory on the fallback target for that provider.

Dalang keeps quota readings, cooldowns, and parallel slots separate for each provider and account directory. The sandbox lets the CLI write to its config directory to maintain login state. Use a dedicated folder because Dalang rejects broad or sensitive directories, including the home directory, credential folders, and Git checkouts. [Sandbox and permissions](SANDBOX.md)

## Read quota and cost figures

Open **Details** on the project limits bar to see quota windows and any reset times reported by the CLIs. Open **Config → Agents** to refresh a CLI's login and model status or clear a cooldown. [Settings and statistics](USAGE.md#settings-and-statistics)

Open **Statistics** to compare providers and projects by run time, failures, fallbacks, and captured tokens. The CLI may omit some usage fields. Dalang shows costs on an API-equivalent basis using reported amounts or reference model rates. Check your provider account for actual subscription charges.
