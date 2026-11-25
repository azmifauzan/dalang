# Terminal room performance

The terminal room (`dalang`) is built on Ink 8 and React 19. This page records why it stays on that stack, the settings and patterns every room change must keep, and the budgets that decide when to look at another renderer.

## Stack decision (25 Nov)

The room stays on Ink and React. Keystroke lag reported in 0.12.0 came from configuration, not from Ink:

- **React ran its development build.** React picks its build from `NODE_ENV` when it first loads, and the CLI never set it. In the development build, React's own checks made up most of the time spent per keystroke.
- **Every frame redrew the whole screen.** Ink rewrote every row on each keystroke (about 4.5 to 5 KB at 160×50) instead of only the rows that changed.

Measured on a 160×50 virtual terminal with a 300-message session, 40 keystrokes:

| Build | CPU for 40 keys | Keystroke latency p50 | Bytes per key |
| --- | --- | --- | --- |
| 0.12.0 (React development, full redraw) | 308 ms | 7.6 ms | 4,893 |
| React production | 84 ms | 3.2 ms | 4,507 |
| React production, incremental rendering | 56 ms | 2.7 ms | 273 |

A heavier load was then measured with React production and incremental rendering: a 220×60 screen, 2,000 messages of history, a reply streaming at 200 tokens a second in 50 ms batches, four agents with spinners, and a 2,000-line diff panel scrolling beside the timeline. One frame took at most 7 ms at p95 and keystroke latency stayed under 41 ms at p95 with 60 frames a second. At Ink's default 30 frames a second, a keystroke waited behind the streaming redraws (56 ms at p95). Streaming each token as its own render, instead of in batches, raised CPU use from about 20% to 56%.

These runs use a virtual terminal inside Node. They measure render work and output size, not the time a terminal emulator takes to draw. Native Windows terminals and replies longer than about 8 KB were not measured.

### Alternatives that were checked

| Option | Why not now |
| --- | --- |
| OpenTUI (Zig core, TypeScript bindings; used by OpenCode) | Bun is its main runtime. On Node, its renderer needs exactly Node 26.4.0 with `--experimental-ffi`, while Dalang supports Node 24 and newer and ships on npm. |
| Rust with ratatui (Codex CLI moved from TypeScript and Ink to Rust) | A native binary per platform and architecture, a second language, hand-copied types from `@dalang/shared`, and a full rewrite of the room. |
| Go with Bubble Tea | The same costs as Rust. OpenCode moved from Bubble Tea to OpenTUI. |

Claude Code and Gemini CLI also render with React in the terminal. Their fixes for flicker and lag were renderer changes (a fullscreen or viewport mode), not a move to another language.

The room is a client of the same HTTP and WebSocket API as the browser. A later move to another renderer replaces only `packages/cli/src/tui`.

## Required settings

These are set in code. Do not remove them.

| Setting | Where | Why |
| --- | --- | --- |
| `NODE_ENV=production` while the app loads, then restored | `packages/cli/bin/dalang.js` | Loads React's production build. The variable is put back before `main()` runs so agent CLIs, `npm install`, and verify commands see the user's own value (`npm install` skips dev dependencies under `production`). A value the user already set is kept. |
| `incrementalRendering: true` | `packages/cli/src/tui/index.ts` | Rewrites only changed rows. |
| `maxFps: 60` | `packages/cli/src/tui/index.ts` | A keystroke is not held behind a streaming redraw for a full 33 ms frame. |

## Rules for room changes

1. **Batch fast updates.** A stream of events reaches the room in batches. Ask replies arrive as `lead.text` events, at most one every 50 ms, from `LeadService.askTextStream`. Do not render once per token or per log line.
2. **Keep fast-changing state out of `RoomApp`.** A value that changes many times a second (live reply text, a spinner, a scrolling panel) lives in its own component, or in an external store read with `useSyncExternalStore` as in `LiveReply.tsx`. `RoomApp` re-renders only when the layout changes, such as when the live reply box appears.
3. **Window every long list.** The timeline renders only the rows that fit. A new diff, log, or task panel does the same. Never render a whole history and let Ink clip it.
4. **Memoize formatted rows.** Markdown and wrapping run once per message (`formattedMessages` and `flattened` in `RoomApp`). The live reply re-parses its text on each batch. If replies grow past tens of KB, keep the finished paragraphs and parse only the last one.
5. **Keep logic out of components.** Server calls go through `client.ts` and events through the WebSocket, so the renderer stays replaceable.
6. **Strip terminal control codes** from any text an agent or the server writes before it is drawn. `markdownRows` and `stripControl` already do this.

## Budgets and the benchmark

After `pnpm build`, run:

```bash
node packages/cli/scripts/tui-bench.mjs
```

It renders the 220×60 heavy load described above with the room's Ink settings and the real `LiveReply` component, and exits with status 1 when a budget is exceeded:

| Budget | Limit |
| --- | --- |
| Frame render time, p95 | 16 ms |
| Keystroke latency, p95 | 80 ms |

Run it before merging any change that adds a panel, a stream, or an animation to the room, and add the new element to the benchmark when it changes what a frame draws.

## When to reconsider the stack

Look at another renderer only when one of these holds after the rules above are followed:

- the benchmark stays over budget on the production build;
- the room needs something Ink cannot draw, such as images in the terminal or several independently scrolling panes that each stream.

Measure the candidate against this benchmark before deciding.
