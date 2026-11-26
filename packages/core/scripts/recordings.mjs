#!/usr/bin/env node
// Reads CLI recordings saved with DALANG_RECORD_DIR.
//   node packages/core/scripts/recordings.mjs summary <dir>
//   node packages/core/scripts/recordings.mjs transcript <dir> <name> [--provider codex] > transcript.json
import fs from 'node:fs';
import path from 'node:path';

const [cmd, dir, name, ...rest] = process.argv.slice(2);
if (!cmd || !dir || !fs.existsSync(dir)) {
  console.error('usage: recordings.mjs summary <dir> | transcript <dir> <name> [--provider <id>]');
  process.exit(2);
}

const recordings = fs
  .readdirSync(dir)
  .filter((f) => f.endsWith('.json'))
  .sort()
  .map((f) => ({ file: f, ...JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')) }));

const pct = (values, p) => {
  const v = values.filter((x) => typeof x === 'number').sort((a, b) => a - b);
  return v.length ? v[Math.min(v.length - 1, Math.floor((p / 100) * v.length))] : null;
};
// Health checks (version, models, auth, usage) are short probes, not turns.
const isTurn = (r) => !/--version|^models$|auth status|login status|debug models|\/usage|--bare/.test(r.args.join(' '));

if (cmd === 'summary') {
  const groups = new Map();
  for (const r of recordings) {
    const key = `${r.provider} ${isTurn(r) ? r.command + ' ' + (r.args[0] ?? '') : 'health'}`;
    groups.set(key, [...(groups.get(key) ?? []), r]);
  }
  const rows = [...groups].map(([key, rs]) => ({
    key,
    n: rs.length,
    failed: rs.filter((r) => r.exitCode !== 0 || r.timedOut || r.idleTimedOut).length,
    first_out_p50_ms: pct(rs.map((r) => r.firstStdoutMs), 50),
    first_out_max_ms: pct(rs.map((r) => r.firstStdoutMs), 100),
    total_p50_s: (pct(rs.map((r) => r.durationMs), 50) ?? 0) / 1000,
    total_max_s: (pct(rs.map((r) => r.durationMs), 100) ?? 0) / 1000,
  }));
  console.table(rows);
  const bad = recordings.filter((r) => r.exitCode !== 0 || r.timedOut || r.idleTimedOut);
  for (const r of bad) {
    console.log(`\n${r.file}: exit=${r.exitCode} timedOut=${r.timedOut} idle=${r.idleTimedOut}`);
    for (const line of r.stderrLines.slice(-3)) console.log(`  stderr: ${line.slice(0, 240)}`);
  }
} else if (cmd === 'transcript') {
  const pi = rest.indexOf('--provider');
  const only = pi >= 0 ? rest[pi + 1] : null;
  const turns = recordings
    .filter((r) => isTurn(r) && (!only || r.provider === only))
    .map((r) => ({ id: r.file.replace(/\.json$/, ''), match: r.match, stdoutLines: r.stdoutLines, stderrLines: r.stderrLines, exitCode: r.exitCode }));
  process.stdout.write(`${JSON.stringify({ name: name ?? 'recorded', description: `Recorded from ${dir}`, turns }, null, 2)}\n`);
} else {
  console.error(`unknown command ${cmd}`);
  process.exit(2);
}
