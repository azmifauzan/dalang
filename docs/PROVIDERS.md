# Providers, Models, and Multi-Account Setup

DALANG never calls model APIs directly and never reads or copies CLI OAuth tokens. It spawns the official `claude`, `codex`, and `agy` binaries headless and parses their structured output.

## Supported providers

| Provider | Binary | Login command | Model discovery | Quota check |
| --- | --- | --- | --- | --- |
| Claude Code | `claude` | `claude auth login` | `initialize` control request over stream-json (`--bare`) | `claude -p /usage` |
| Codex CLI | `codex` | `codex login` | `codex debug models` | `codex app-server` (`account/rateLimits/read`) |
| Antigravity CLI | `agy` | `agy` (interactive sign-in) | `agy models` | `agy -p=/usage --output-format json` |

## Side-effect-free health checks

All provider status probes follow one strict rule: checking CLI health must never run user/project hooks, start MCP servers, mutate workspaces, or incur a model API call.

- **Claude Code**: model discovery runs from `os.tmpdir()` with `--bare --no-session-persistence`, which skips hooks, plugins, and MCP servers and sends a single `initialize` control message (verified by automated test).
- **Codex CLI**: probes run `--version`, `login status`, `debug models`, and a read-only `app-server` JSON-RPC query from `os.tmpdir()`.
- **Antigravity CLI**: probes run `--version`, `models`, and `-p=/usage --output-format json` from `os.tmpdir()`.
- Results are cached in the server until you click **Refresh CLI status** in Config → Agents.

## Model details and reasoning effort

Nothing is hardcoded. On startup and on **Refresh CLI status**, DALANG reads rich model metadata directly from each CLI:

- **Claude Code**: display name, description, `supportedEffortLevels` (including `max`), fast mode and thinking flags. Context variants such as `claude-fable-5-2[1m]` attach as an option ("Use 1M context") on their base model instead of duplicating the model dropdown.
- **Codex CLI**: display name, description, `default_reasoning_level`, and `supported_reasoning_levels` (including `max`).
- **Antigravity CLI**: display name and per-model effort levels extracted from the model ids (`gemini-4-neon-high` -> base `gemini-4-neon`, effort `high`). Models without effort levels disable the effort selector.

In the profile editor:

- Selecting a model preselects its CLI-reported default effort level and restricts the effort dropdown to levels that model actually supports.
- If a saved profile references a model the CLI no longer returns, the editor keeps the saved value and marks it `(unavailable)` instead of silently dropping it.

## Multiple accounts per provider

Each agent profile has an optional **Account config directory** (`configDir`). When set, DALANG:

1. Passes the provider's config environment variable for that run and for usage/status checks:
   - **Claude Code**: `CLAUDE_CONFIG_DIR=<configDir>`
   - **Codex CLI**: `CODEX_HOME=<configDir>`
   - **Antigravity CLI**: `AGY_CONFIG_DIR=<configDir>` (and `XDG_CONFIG_HOME=<configDir>`)
2. Mounts `<configDir>` writable inside the sandbox (`bwrap` or `sandbox-exec`).
3. Tracks parallel slots (`maxParallel`), cached quota readings, and rate-limit cooldowns **per account** (`<provider>:<configDir>`), not globally per provider.

Because the directory is writable inside the sandbox, DALANG refuses a `configDir` that is `/`, your home directory or a parent of it, a credential folder the sandbox hides (`~/.ssh`, `~/.aws`, and so on) or a folder containing one, or a git checkout. Use a dedicated folder such as `~/.claude-work`.

This lets you set a fallback on the same provider backed by a second subscription account (the fallback's account directory). To sign in a second account before configuring it in DALANG:

```bash
# Example: second Claude Code account
CLAUDE_CONFIG_DIR=~/.claude-work claude auth login

# Example: second Codex account
CODEX_HOME=~/.codex-work codex login
```

Then enter `~/.claude-work` or `~/.codex-work` in the profile's **Account config directory** field and select that profile as the fallback of your primary profile (or in a routing rule).

## Token counts and API-equivalent cost

DALANG extracts token usage from the stream events it already captures during runs:

- **Claude Code**: reads `usage` (`input_tokens`, `output_tokens`, `cache_read_input_tokens`, `cache_creation_input_tokens`), `modelUsage`, and `total_cost_usd` from the `result` event.
- **Codex CLI**: reads `usage` (`input_tokens`, `cached_input_tokens`, `output_tokens`) from `turn.completed` events.
- **Antigravity CLI**: reads token counts when present in `result` / `usage` / `stats` stream events.

When a CLI does not emit a dollar amount, DALANG computes an **API-equivalent estimate** from token counts and reference model rates. Every cost figure in the UI is labeled as an API-equivalent estimate, not your subscription bill.
