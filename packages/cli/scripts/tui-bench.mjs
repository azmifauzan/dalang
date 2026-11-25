// Terminal-room render benchmark. Run after `pnpm build`:  node packages/cli/scripts/tui-bench.mjs
// It renders a room-sized screen (220x60, 2,000-message history) on a virtual terminal with the same
// Ink options as `dalang`, types while a reply streams, four agents spin, and a diff panel scrolls,
// then fails when a budget in docs/TUI_PERFORMANCE.md is exceeded.
const userNodeEnv = process.env.NODE_ENV;
if (userNodeEnv === undefined) process.env.NODE_ENV = 'production';
const { PassThrough } = await import('node:stream');
const React = (await import('react')).default;
const { Box, Text, render, useAnimation, useInput } = await import('ink');
const { markdownRows } = await import('../dist/tui/markdown.js');
const { createLiveReplyStore, LiveReply } = await import('../dist/tui/LiveReply.js');

const h = React.createElement;
const COLS = 220;
const ROWS = 60;
const BUDGET = { frameP95: 16, keyP95: 80 };
const MD = ['## Result', 'Some **bold** and `code`.', '- item one that is long '.repeat(3), '```ts', 'const x = 1;', '```', 'Para '.repeat(40)].join('\n');
const HISTORY = Array.from({ length: 2000 }, (_, i) => markdownRows(i % 2 ? MD : `user question ${i} `.repeat(4), COLS - 74)).flat();
const DIFF = Array.from({ length: 2000 }, (_, i) => (i % 3 === 0 ? `+ added line ${i}` : i % 3 === 1 ? `- removed line ${i}` : `  context ${i}`));

const Timeline = React.memo(({ height }) => h(Box, { flexDirection: 'column', height, overflow: 'hidden' },
  HISTORY.slice(-height).map((row, i) => h(Text, { key: i, wrap: 'truncate-end' }, row))));
const Agent = React.memo(({ name }) => {
  const { frame } = useAnimation({ interval: 120 });
  return h(Text, { color: 'yellow' }, `${'⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏'[frame % 10]} @${name} working`);
});
function DiffPanel({ height }) {
  const [offset, setOffset] = React.useState(0);
  React.useEffect(() => { const t = setInterval(() => setOffset((o) => (o + 1) % 1900), 200); return () => clearInterval(t); }, []);
  return h(Box, { flexDirection: 'column', width: 70, height, borderStyle: 'single', overflow: 'hidden' },
    DIFF.slice(offset, offset + height - 2).map((line, i) => h(Text, { key: i, wrap: 'truncate-end' }, line)));
}
function Composer() {
  const [input, setInput] = React.useState('');
  useInput((ch, key) => setInput((s) => (key.backspace ? s.slice(0, -1) : s + ch)));
  return h(Box, { borderStyle: 'round' }, h(Text, null, `> ${input}`));
}
function App({ heavy, store }) {
  const live = heavy ? 12 : 0;
  const timeline = ROWS - 1 - 5 - 3 - (heavy ? 4 : 0) - live - 1;
  return h(Box, { flexDirection: 'column', width: COLS, height: ROWS - 1 },
    h(Box, { borderStyle: 'round', height: 5 }, h(Text, null, 'DALANG header')),
    h(Box, null,
      h(Box, { flexDirection: 'column', flexGrow: 1 },
        h(Timeline, { height: timeline }),
        heavy ? h(LiveReply, { store, sessionId: 's', rows: live, width: COLS - 76 }) : null),
      heavy ? h(DiffPanel, { height: timeline + live + 1 }) : null),
    heavy ? [0, 1, 2, 3].map((i) => h(Agent, { key: i, name: `coder-${i}` })) : null,
    h(Composer));
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pct = (values, q) => [...values].sort((a, b) => a - b)[Math.min(values.length - 1, Math.floor(values.length * q))] ?? 0;

async function scenario(label, heavy) {
  const stdout = Object.assign(new PassThrough(), { columns: COLS, rows: ROWS, isTTY: true });
  const stdin = Object.assign(new PassThrough(), { isTTY: true, setRawMode() {}, ref() {}, unref() {} });
  let bytes = 0;
  let lastOut = 0;
  stdout.on('data', (chunk) => { bytes += chunk.length; lastOut = performance.now(); });
  const frames = [];
  const store = createLiveReplyStore();
  const inst = render(h(App, { heavy, store }), {
    stdout, stdin, exitOnCtrlC: false, patchConsole: false,
    incrementalRendering: true, maxFps: 60, onRender: (m) => frames.push(m.renderTime),
  });
  // A reply streaming at 200 tokens a second, delivered in 50 ms batches like `lead.text`.
  let pending = '';
  const tokens = heavy ? setInterval(() => { pending += `token${Math.floor(Math.random() * 99)} ${Math.random() < 0.05 ? '\n\n' : ''}`; }, 5) : null;
  const batches = heavy ? setInterval(() => { if (pending) { store.append('s', 'ask', pending, false); pending = ''; } }, 50) : null;
  await sleep(800);
  frames.length = 0;
  const startBytes = bytes;
  const cpu0 = process.cpuUsage();
  const t0 = performance.now();
  const keys = [];
  for (const ch of 'typing a message while agents stream output!!') {
    const sent = performance.now();
    const before = lastOut;
    stdin.write(ch);
    while (lastOut === before && performance.now() - sent < 500) await sleep(1);
    keys.push(lastOut - sent);
    await sleep(80);
  }
  const wall = performance.now() - t0;
  const cpu = process.cpuUsage(cpu0);
  clearInterval(tokens);
  clearInterval(batches);
  inst.unmount();
  const result = { frameP95: pct(frames, 0.95), keyP95: pct(keys, 0.95) };
  console.log(`${label.padEnd(36)} key p50 ${pct(keys, 0.5).toFixed(1)} ms, p95 ${result.keyP95.toFixed(1)} ms | frame p95 ${result.frameP95.toFixed(1)} ms | CPU ${(((cpu.user + cpu.system) / 1000 / wall) * 100).toFixed(0)}% | ${(((bytes - startBytes) / wall) * 1000 / 1024).toFixed(0)} KB/s`);
  return result;
}

console.log(`React ${React.version} (${process.env.NODE_ENV}), ${COLS}x${ROWS}, budgets: frame p95 <= ${BUDGET.frameP95} ms, key p95 <= ${BUDGET.keyP95} ms`);
const results = [await scenario('typing only', false), await scenario('typing + stream + 4 agents + diff', true)];
const over = results.some((r) => r.frameP95 > BUDGET.frameP95 || r.keyP95 > BUDGET.keyP95);
if (over) console.error('Over budget. See docs/TUI_PERFORMANCE.md before adding more to the room.');
process.exit(over ? 1 : 0);
