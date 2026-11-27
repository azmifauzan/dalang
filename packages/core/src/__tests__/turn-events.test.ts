import { describe, expect, it } from 'vitest';
import { parseTurnLogSignal } from '@dalang/shared';

describe('turn progress events (U1, B8)', () => {
  it('extracts safe targets and phases from Claude, Codex, Antigravity, and dalang log lines', () => {
    expect(parseTurnLogSignal(JSON.stringify({ type: 'system', subtype: 'init' }))).toMatchObject({ phase: 'working' });

    const claudeTool = parseTurnLogSignal(
      JSON.stringify({
        type: 'assistant',
        message: {
          content: [{ type: 'tool_use', id: 'tu-1', name: 'Read', input: { file_path: 'src/index.ts' } }],
        },
      }),
    );
    expect(claudeTool?.step).toMatchObject({ id: 'tu-1', kind: 'read', target: 'src/index.ts', status: 'running' });

    const codexCmd = parseTurnLogSignal(
      JSON.stringify({
        type: 'item.completed',
        item: { id: 'cmd-1', type: 'command_execution', command: 'pnpm test Bearer supersecret123', exit_code: 0 },
      }),
    );
    expect(codexCmd?.step).toMatchObject({ id: 'cmd-1', kind: 'run', status: 'completed', exitCode: 0 });
    expect(codexCmd?.step?.target).not.toContain('supersecret123');
    expect(codexCmd?.step?.target).toContain('[REDACTED]');

    const agyTool = parseTurnLogSignal(
      JSON.stringify({
        sessionUpdate: 'tool_call_update',
        toolCallId: 'tc-9',
        title: 'Search codebase',
        status: 'completed',
      }),
    );
    expect(agyTool?.step).toMatchObject({ id: 'tc-9', status: 'completed', target: 'Search codebase' });

    const progressBeforeJson = parseTurnLogSignal(
      JSON.stringify({
        type: 'assistant',
        message: { content: [{ type: 'text', text: 'Checking files...\n{"answer":"Ready"}' }] },
      }),
    );
    expect(progressBeforeJson).toMatchObject({
      phase: 'streaming',
      progressText: 'Checking files...',
      answerText: 'Ready',
    });

    // Handles timestamp-prefixed log lines too
    const verify = parseTurnLogSignal('2026-11-27T15:00:00.000Z [dalang] Verify command exited with code 1');
    expect(verify?.step).toMatchObject({ id: 'verify', status: 'failed', exitCode: 1 });
  });
});
