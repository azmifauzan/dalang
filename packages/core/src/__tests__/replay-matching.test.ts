import { describe, expect, it } from 'vitest';
import {
  compareReplayMessages,
  compareReplaySequence,
  parseInteractiveJsonLines,
  ReplayMessageMatcher,
  type ReplaySequenceMessage,
} from '../testing/replay-matching.js';

describe('replay-matching interactive message comparator', () => {
  it('matches identical nested prompt, steering, and permission decision payloads', () => {
    const sequence: ReplaySequenceMessage[] = [
      {
        direction: 'stdin',
        payload: {
          jsonrpc: '2.0',
          id: 1,
          method: 'session/prompt',
          params: {
            sessionId: 'agy-rec-1',
            prompt: [{ type: 'text', text: 'Inspect the auth handler' }],
          },
        },
      },
      {
        direction: 'stdout',
        payload: {
          jsonrpc: '2.0',
          id: 99,
          method: 'session/request_permission',
          params: {
            sessionId: 'agy-rec-1',
            toolCall: { toolCallId: 'tc-1', title: 'Run vitest' },
            options: [{ optionId: 'allow_once', kind: 'allow_once' }],
          },
        },
      },
      {
        direction: 'stdin',
        payload: {
          jsonrpc: '2.0',
          id: 99,
          result: { outcome: { outcome: 'selected', optionId: 'allow_once' } },
        },
      },
      {
        direction: 'stdin',
        payload: {
          jsonrpc: '2.0',
          id: 2,
          method: 'turn/steer',
          params: {
            threadId: 'thread-rec-1',
            expectedTurnId: 'turn-rec-1',
            input: [{ type: 'text', text: 'Keep existing tests intact', text_elements: [] }],
          },
        },
      },
    ];

    const result = compareReplaySequence(sequence, structuredClone(sequence));
    expect(result.matched).toBe(true);
    expect(result.mismatches).toEqual([]);
    expect(result.diagnosis).toBe('Matched');
  });

  it('produces mismatches when prompt, steering, or permission decision values change in nested objects', () => {
    const promptExpected = {
      type: 'user',
      message: {
        role: 'user',
        content: [{ type: 'text', text: 'PROMPT_ORIGINAL_SECRET' }],
      },
    };
    const promptChanged = {
      type: 'user',
      message: {
        role: 'user',
        content: [{ type: 'text', text: 'PROMPT_MUTATED_SECRET' }],
      },
    };
    const promptResult = compareReplayMessages(promptExpected, promptChanged);
    expect(promptResult.matched).toBe(false);
    expect(promptResult.mismatches).toHaveLength(1);
    expect(promptResult.mismatches[0]).toMatchObject({
      kind: 'value_mismatch',
      location: { path: 'message.content[0].text' },
    });
    expect(promptResult.diagnosis).toContain('message.content[0].text');
    expect(promptResult.diagnosis).not.toContain('PROMPT_ORIGINAL_SECRET');
    expect(promptResult.diagnosis).not.toContain('PROMPT_MUTATED_SECRET');

    const steerExpected = {
      jsonrpc: '2.0',
      id: 4,
      method: 'turn/steer',
      params: {
        threadId: 'thread-1',
        expectedTurnId: 'turn-1',
        input: [{ type: 'text', text: 'STEER_ALPHA_VALUE', text_elements: [] }],
      },
    };
    const steerChanged = {
      jsonrpc: '2.0',
      id: 4,
      method: 'turn/steer',
      params: {
        threadId: 'thread-1',
        expectedTurnId: 'turn-1',
        input: [{ type: 'text', text: 'STEER_BETA_VALUE', text_elements: [] }],
      },
    };
    const steerResult = compareReplayMessages(steerExpected, steerChanged);
    expect(steerResult.matched).toBe(false);
    expect(steerResult.mismatches[0]).toMatchObject({
      kind: 'value_mismatch',
      location: { path: 'params.input[0].text' },
    });
    expect(steerResult.diagnosis).toContain('params.input[0].text');
    expect(steerResult.diagnosis).not.toContain('STEER_ALPHA_VALUE');
    expect(steerResult.diagnosis).not.toContain('STEER_BETA_VALUE');

    const acpPermExpected = {
      jsonrpc: '2.0',
      id: 7,
      result: { outcome: { outcome: 'selected', optionId: 'allow_always_secret' } },
    };
    const acpPermChanged = {
      jsonrpc: '2.0',
      id: 7,
      result: { outcome: { outcome: 'selected', optionId: 'reject_once_secret' } },
    };
    const acpPermResult = compareReplayMessages(acpPermExpected, acpPermChanged);
    expect(acpPermResult.matched).toBe(false);
    expect(acpPermResult.mismatches[0]).toMatchObject({
      kind: 'value_mismatch',
      location: { path: 'result.outcome.optionId' },
    });
    expect(acpPermResult.diagnosis).toContain('result.outcome.optionId');
    expect(acpPermResult.diagnosis).not.toContain('allow_always_secret');
    expect(acpPermResult.diagnosis).not.toContain('reject_once_secret');

    const claudePermExpected = {
      type: 'control_response',
      response: {
        subtype: 'success',
        request_id: 'req-1',
        response: {
          behavior: 'allow',
          updatedInput: { command: 'pnpm test' },
        },
      },
    };
    const claudePermChanged = {
      type: 'control_response',
      response: {
        subtype: 'success',
        request_id: 'req-1',
        response: {
          behavior: 'deny',
          updatedInput: { command: 'rm -rf /' },
        },
      },
    };
    const claudePermResult = compareReplayMessages(claudePermExpected, claudePermChanged);
    expect(claudePermResult.matched).toBe(false);
    expect(claudePermResult.mismatches.map((m) => m.location.path)).toEqual([
      'response.response.behavior',
      'response.response.updatedInput.command',
    ]);
    expect(claudePermResult.diagnosis).not.toContain('pnpm test');
    expect(claudePermResult.diagnosis).not.toContain('rm -rf');
  });

  it('maps only explicitly named dynamic fields and keeps all other fields strict', () => {
    const expected = {
      jsonrpc: '2.0',
      id: 1,
      method: 'turn/start',
      params: {
        id: 'inner-id-1',
        threadId: 'thread-rec-1',
        input: [{ type: 'text', text: 'Run checks' }],
      },
    };

    // Without explicit dynamicFields, top-level id mismatch fails.
    const unmapped = compareReplayMessages(expected, { ...expected, id: 100 });
    expect(unmapped.matched).toBe(false);
    expect(unmapped.mismatches[0].location.path).toBe('id');

    // Explicitly mapping top-level "id" allows top-level "id" to vary...
    const mappedTopIdOnly = compareReplayMessages(
      expected,
      { ...expected, id: 100 },
      { dynamicFields: ['id'] },
    );
    expect(mappedTopIdOnly.matched).toBe(true);

    // ...but nested "params.id" and "params.threadId" remain strictly checked!
    const nestedIdChanged = compareReplayMessages(
      expected,
      {
        ...expected,
        id: 100,
        params: { ...expected.params, id: 'inner-id-2' },
      },
      { dynamicFields: ['id'] },
    );
    expect(nestedIdChanged.matched).toBe(false);
    expect(nestedIdChanged.mismatches.map((m) => m.location.path)).toEqual(['params.id']);

    // Explicitly listing params.threadId maps it, while sibling params.id remains strict.
    const mappedSpecific = compareReplayMessages(
      expected,
      {
        ...expected,
        id: 100,
        params: { ...expected.params, threadId: 'thread-live-9' },
      },
      { dynamicFields: ['id', 'params.threadId'] },
    );
    expect(mappedSpecific.matched).toBe(true);

    // Explicit ignore mode only skips the explicitly named field and respects `when` filter.
    const matcher = new ReplayMessageMatcher({
      dynamicFields: [
        { path: 'timestamp', mode: 'ignore', when: { method: 'heartbeat' } },
      ],
    });
    expect(
      matcher.matchMessage(
        { method: 'heartbeat', timestamp: '2026-01-01T00:00:00Z' },
        { method: 'heartbeat', timestamp: '2026-11-26T14:00:00Z' },
      ).matched,
    ).toBe(true);
    const nonMatchingWhen = matcher.matchMessage(
      { method: 'turn/start', timestamp: '2026-01-01T00:00:00Z' },
      { method: 'turn/start', timestamp: '2026-11-26T14:00:00Z' },
    );
    expect(nonMatchingWhen.matched).toBe(false);
    expect(nonMatchingWhen.mismatches[0].location.path).toBe('timestamp');
  });

  it('keeps IDs correlated between requests and responses and across cross-path fields', () => {
    const expectedExchange: ReplaySequenceMessage[] = [
      {
        direction: 'request',
        payload: {
          jsonrpc: '2.0',
          id: 1,
          method: 'thread/start',
          params: { cwd: '/repo' },
        },
      },
      {
        direction: 'response',
        payload: {
          jsonrpc: '2.0',
          id: 1,
          result: { thread: { id: 'thread-rec-1' } },
        },
      },
      {
        direction: 'request',
        payload: {
          jsonrpc: '2.0',
          id: 2,
          method: 'turn/start',
          params: {
            threadId: 'thread-rec-1',
            input: [{ type: 'text', text: 'Write tests' }],
          },
        },
      },
      {
        direction: 'response',
        payload: {
          jsonrpc: '2.0',
          id: 2,
          result: { turn: { id: 'turn-rec-1' } },
        },
      },
    ];

    const dynamicFields = [
      'id',
      { path: 'result.thread.id', correlateAs: 'threadId' },
      { path: 'params.threadId', correlateAs: 'threadId' },
      { path: 'result.turn.id', correlateAs: 'turnId' },
    ];

    // Valid re-numbered IDs and thread/turn IDs correlate 1-to-1.
    const validActual: ReplaySequenceMessage[] = [
      {
        direction: 'request',
        payload: {
          jsonrpc: '2.0',
          id: 101,
          method: 'thread/start',
          params: { cwd: '/repo' },
        },
      },
      {
        direction: 'response',
        payload: {
          jsonrpc: '2.0',
          id: 101,
          result: { thread: { id: 'thread-live-A' } },
        },
      },
      {
        direction: 'request',
        payload: {
          jsonrpc: '2.0',
          id: 102,
          method: 'turn/start',
          params: {
            threadId: 'thread-live-A',
            input: [{ type: 'text', text: 'Write tests' }],
          },
        },
      },
      {
        direction: 'response',
        payload: {
          jsonrpc: '2.0',
          id: 102,
          result: { turn: { id: 'turn-live-X' } },
        },
      },
    ];
    expect(compareReplaySequence(expectedExchange, validActual, { dynamicFields }).matched).toBe(true);

    // Broken response ID correlation (response uses 999 instead of 101).
    const brokenResponseId = structuredClone(validActual);
    (brokenResponseId[1].payload as Record<string, unknown>).id = 999;
    const brokenResResult = compareReplaySequence(expectedExchange, brokenResponseId, { dynamicFields });
    expect(brokenResResult.matched).toBe(false);
    expect(brokenResResult.mismatches).toHaveLength(1);
    expect(brokenResResult.mismatches[0]).toMatchObject({
      kind: 'id_correlation_mismatch',
      location: { messageIndex: 1, direction: 'response', path: 'id' },
      detail: { correlationGroup: 'id' },
    });
    expect(brokenResResult.diagnosis).toContain('[1] (response) id');
    expect(brokenResResult.diagnosis).not.toContain('999');
    expect(brokenResResult.diagnosis).not.toContain('101');

    // Broken cross-path threadId correlation (turn/start sends a different threadId than thread/start returned).
    const brokenThreadId = structuredClone(validActual);
    ((brokenThreadId[2].payload as Record<string, unknown>).params as Record<string, unknown>).threadId =
      'thread-wrong-Z';
    const brokenThreadResult = compareReplaySequence(expectedExchange, brokenThreadId, { dynamicFields });
    expect(brokenThreadResult.matched).toBe(false);
    expect(brokenThreadResult.mismatches[0]).toMatchObject({
      kind: 'id_correlation_mismatch',
      location: { messageIndex: 2, direction: 'request', path: 'params.threadId' },
      detail: { correlationGroup: 'threadId' },
    });
    expect(brokenThreadResult.diagnosis).not.toContain('thread-wrong-Z');
    expect(brokenThreadResult.diagnosis).not.toContain('thread-live-A');

    // Reusing an already-bound actual request ID for a distinct expected request ID also fails.
    const reusedActualId = structuredClone(validActual);
    (reusedActualId[2].payload as Record<string, unknown>).id = 101;
    const reusedResult = compareReplaySequence(expectedExchange, reusedActualId, { dynamicFields });
    expect(reusedResult.matched).toBe(false);
    expect(reusedResult.mismatches.some((m) => m.kind === 'id_correlation_mismatch' && m.location.messageIndex === 2)).toBe(true);
  });

  it('correlates Claude control_request and control_response IDs without polluting state on failed probes', () => {
    const matcher = new ReplayMessageMatcher({
      dynamicFields: [
        { path: 'request_id', correlateAs: 'controlRequestId' },
        { path: 'response.request_id', correlateAs: 'controlRequestId' },
      ],
    });

    const expectedReq = {
      type: 'control_request',
      request_id: 'rec-perm-1',
      request: { subtype: 'can_use_tool', tool_name: 'Bash', input: { command: 'git status' } },
    };

    // Failed candidate probe (different command) must not lock rec-perm-1 -> wrong-probe-id.
    const failedProbe = matcher.tryMatchMessage(expectedReq, {
      type: 'control_request',
      request_id: 'wrong-probe-id',
      request: { subtype: 'can_use_tool', tool_name: 'Bash', input: { command: 'rm -rf .' } },
    });
    expect(failedProbe.matched).toBe(false);

    // Real matching request binds rec-perm-1 <-> live-perm-1.
    const realReqMatch = matcher.tryMatchMessage(expectedReq, {
      type: 'control_request',
      request_id: 'live-perm-1',
      request: { subtype: 'can_use_tool', tool_name: 'Bash', input: { command: 'git status' } },
    });
    expect(realReqMatch.matched).toBe(true);

    // Matching control_response with correlated request_id passes.
    const expectedResp = {
      type: 'control_response',
      response: {
        subtype: 'success',
        request_id: 'rec-perm-1',
        response: { behavior: 'allow' },
      },
    };
    expect(
      matcher.matchMessage(expectedResp, {
        type: 'control_response',
        response: {
          subtype: 'success',
          request_id: 'live-perm-1',
          response: { behavior: 'allow' },
        },
      }).matched,
    ).toBe(true);
  });

  it('reports structural diagnosis (missing/unexpected keys, array lengths, directions, invalid JSON) without raw payloads', () => {
    const secretLine = '{"secretPrompt":"DO_NOT_LEAK_THIS_RAW_TEXT"';
    const invalidRes = compareReplayMessages('{"type":"user"}', secretLine, {
      direction: 'stdin',
      messageIndex: 3,
    });
    expect(invalidRes.matched).toBe(false);
    expect(invalidRes.mismatches[0]).toMatchObject({
      kind: 'invalid_json',
      location: { messageIndex: 3, direction: 'stdin', path: '(root)' },
    });
    expect(invalidRes.diagnosis).toContain('[3] (stdin) (root)');
    expect(invalidRes.diagnosis).not.toContain('DO_NOT_LEAK_THIS_RAW_TEXT');
    expect(JSON.stringify(invalidRes)).not.toContain('DO_NOT_LEAK_THIS_RAW_TEXT');

    const structuralRes = compareReplaySequence(
      [
        { direction: 'stdin', payload: { params: { items: ['SECRET_A', 'SECRET_B'], requiredKey: 'SECRET_VAL' } } },
        { direction: 'stdout', payload: { ok: true } },
      ],
      [
        { direction: 'stdin', payload: { params: { items: ['SECRET_A'], extraKey: 'LEAKY_EXTRA_VAL' } } },
        { direction: 'stdin', payload: { ok: true } },
        { direction: 'stdout', payload: { extra: 'EXTRA_MSG_SECRET' } },
      ],
    );
    expect(structuralRes.matched).toBe(false);
    expect(structuralRes.mismatches.map((m) => [m.kind, m.location.messageIndex, m.location.path])).toEqual([
      ['array_length_mismatch', 0, 'params.items'],
      ['missing_key', 0, 'params.requiredKey'],
      ['unexpected_key', 0, 'params.extraKey'],
      ['direction_mismatch', 1, '(root)'],
      ['unexpected_message', 2, '(root)'],
    ]);
    const serialized = JSON.stringify(structuralRes);
    expect(serialized).not.toContain('SECRET_A');
    expect(serialized).not.toContain('SECRET_B');
    expect(serialized).not.toContain('SECRET_VAL');
    expect(serialized).not.toContain('LEAKY_EXTRA_VAL');
    expect(serialized).not.toContain('EXTRA_MSG_SECRET');

    const parsed = parseInteractiveJsonLines(
      '{"id":1,"method":"initialize"}\n\nnot-json-SECRET_RAW\n{"id":2,"method":"turn/start"}\n',
    );
    expect(parsed).toEqual([
      { ok: true, value: { id: 1, method: 'initialize' } },
      { ok: false, lineIndex: 2 },
      { ok: true, value: { id: 2, method: 'turn/start' } },
    ]);
    expect(JSON.stringify(parsed)).not.toContain('SECRET_RAW');
  });
});
