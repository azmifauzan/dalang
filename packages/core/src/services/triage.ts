import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  DALANG_VERSION,
  type TriageContextPreviewDTO,
  type TriageDoctorCheckDTO,
} from '@dalang/shared';
import { detectSandboxEngine, NodeCliRunner } from '../adapters/sandbox.js';
import { stderrTail } from '../adapters/session-rpc.js';
import type { CliRunner } from '../adapters/types.js';
import { getDalangHome } from '../paths.js';

export interface CollectTriageOptions {
  dataDir?: string;
  recordDir?: string | null;
  runner?: CliRunner;
  currentVersion?: string;
  secrets?: readonly (string | null | undefined)[];
  maxLogBytes?: number;
}

function readRedactedServerLogTail(
  dataDir: string,
  secrets: readonly (string | null | undefined)[],
  maxBytes: number,
): string {
  const candidates = [
    path.join(dataDir, 'server.log'),
    path.join(dataDir, 'daemon.log'),
    path.join(dataDir, 'dalang.log'),
  ];
  const chunks: string[] = [];
  for (const candidate of candidates) {
    try {
      if (!fs.existsSync(candidate) || !fs.statSync(candidate).isFile()) continue;
      const stat = fs.statSync(candidate);
      const start = Math.max(0, stat.size - maxBytes);
      const fd = fs.openSync(candidate, 'r');
      try {
        const buf = Buffer.alloc(stat.size - start);
        fs.readSync(fd, buf, 0, buf.length, start);
        const text = stderrTail(buf.toString('utf8'), secrets);
        if (text) chunks.push(`=== ${path.basename(candidate)} ===\n${text}`);
      } finally {
        fs.closeSync(fd);
      }
    } catch {
      // Missing or unreadable log file must never block triage.
    }
  }
  return chunks.join('\n\n').slice(-maxBytes);
}

function summarizeRecordingsDir(
  recordDir: string | null | undefined,
  secrets: readonly (string | null | undefined)[],
): string | null {
  if (!recordDir) return null;
  try {
    if (!fs.existsSync(recordDir) || !fs.statSync(recordDir).isDirectory()) return null;
    const files = fs
      .readdirSync(recordDir)
      .filter((f) => f.endsWith('.json'))
      .sort()
      .slice(-20);
    if (files.length === 0) return null;
    const lines: string[] = [`Recordings (${files.length} recent file(s)):`];
    for (const file of files) {
      try {
        const raw = JSON.parse(fs.readFileSync(path.join(recordDir, file), 'utf8')) as {
          provider?: string;
          command?: string;
          exitCode?: number | null;
          timedOut?: boolean;
          idleTimedOut?: boolean;
          durationMs?: number;
        };
        const status = raw.timedOut || raw.idleTimedOut
          ? 'timed_out'
          : raw.exitCode === 0
            ? 'ok'
            : `exit_${raw.exitCode ?? 'unknown'}`;
        lines.push(
          `- ${file}: provider=${raw.provider ?? raw.command ?? 'unknown'} status=${status}${typeof raw.durationMs === 'number' ? ` duration=${raw.durationMs}ms` : ''}`,
        );
      } catch {
        lines.push(`- ${file}: (unreadable recording)`);
      }
    }
    return stderrTail(lines.join('\n'), secrets);
  } catch {
    return null;
  }
}

export async function collectTriageContext(
  opts: CollectTriageOptions = {},
): Promise<TriageContextPreviewDTO> {
  const runner = opts.runner ?? new NodeCliRunner();
  const dataDir = opts.dataDir ?? getDalangHome();
  const version = opts.currentVersion ?? DALANG_VERSION;
  const secrets = opts.secrets ?? [];
  const maxLogBytes = opts.maxLogBytes ?? 4000;
  const doctorChecks: TriageDoctorCheckDTO[] = [];

  const nodeVersion = process.versions.node;
  const nodeMajor = Number(nodeVersion.split('.')[0] ?? 0);
  doctorChecks.push({
    id: 'node',
    label: 'Node.js',
    status: nodeMajor >= 24 ? 'pass' : 'fail',
    detail: `v${nodeVersion}`,
  });

  const gitPath = await runner.which('git').catch(() => null);
  doctorChecks.push({
    id: 'git',
    label: 'Git',
    status: gitPath ? 'pass' : 'fail',
    detail: gitPath ? `found (${path.basename(gitPath)})` : 'git not found in PATH',
  });

  const sandbox = await detectSandboxEngine(runner).catch(() => ({ engine: 'none' as const, binaryPath: null }));
  doctorChecks.push({
    id: 'sandbox',
    label: 'Sandbox',
    status: sandbox.engine !== 'none' ? 'pass' : 'warn',
    detail: sandbox.engine !== 'none' ? `${sandbox.engine} ready` : `none on ${process.platform}`,
  });

  doctorChecks.push({
    id: 'data-dir',
    label: 'Data directory',
    status: fs.existsSync(dataDir) ? 'pass' : 'warn',
    detail: fs.existsSync(dataDir) ? 'present' : 'not created yet',
  });

  const serverLogTail = readRedactedServerLogTail(dataDir, secrets, maxLogBytes);
  const recordingSummary = summarizeRecordingsDir(
    opts.recordDir !== undefined ? opts.recordDir : process.env.DALANG_RECORD_DIR,
    secrets,
  );
  const osLabel = `${os.platform()} ${os.release()} (${os.arch()})`;

  const promptPreview = buildTriagePrompt({
    version,
    os: osLabel,
    nodeVersion,
    doctorChecks,
    serverLogTail,
    recordingSummary,
  });

  return {
    version,
    os: osLabel,
    nodeVersion,
    doctorChecks,
    serverLogTail,
    recordingSummary,
    promptPreview,
  };
}

export function buildTriagePrompt(
  context: Omit<TriageContextPreviewDTO, 'promptPreview'>,
  userNote?: string,
): string {
  const lines = [
    'Local DALANG triage session (read-only Ask mode).',
    'Diagnose the problem from the redacted local diagnostic context below.',
    'IMPORTANT: Do NOT open a GitHub issue or send any data externally on your own. Before suggesting opening an issue, show the exact proposed title, redacted body, destination repository, and impact, and wait for the user to approve explicitly.',
    '',
    `Version: DALANG v${context.version}`,
    `OS: ${context.os}`,
    `Node.js: v${context.nodeVersion}`,
    '',
    'Doctor checks:',
    ...context.doctorChecks.map((c) => `- [${c.status.toUpperCase()}] ${c.label}: ${c.detail}`),
  ];
  if (context.serverLogTail) {
    lines.push('', 'Recent redacted server log tail:', '```', context.serverLogTail, '```');
  } else {
    lines.push('', 'Recent server logs: (none available)');
  }
  if (context.recordingSummary) {
    lines.push('', context.recordingSummary);
  }
  if (userNote?.trim()) {
    lines.push('', 'Problem described by user:', userNote.trim());
  }
  return lines.join('\n');
}
