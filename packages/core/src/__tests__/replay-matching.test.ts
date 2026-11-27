import { describe, expect, it } from 'vitest';
import {
  compareReplayMessages,
  compareReplaySequence,
  getProviderReplayDynamicFields,
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

  it('does not misclassify raw messages containing payload as sequence wrappers', () => {
    const rawExpected = [
      {
        type: 'token_usage_record',
        payload: { usage: { input_tokens: 100 } },
        prompt: 'KEEP_THIS_PROMPT_STRICT',
      },
    ];
    const rawChangedPrompt = [
      {
        type: 'token_usage_record',
        payload: { usage: { input_tokens: 100 } },
        prompt: 'ALTERED_PROMPT_MUST_FAIL',
      },
    ];
    const rawResult = compareReplaySequence(rawExpected, rawChangedPrompt);
    expect(rawResult.matched).toBe(false);
    expect(rawResult.mismatches).toHaveLength(1);
    expect(rawResult.mismatches[0]).toMatchObject({
      kind: 'value_mismatch',
      location: { messageIndex: 0, path: 'prompt' },
    });
    expect(rawResult.diagnosis).not.toContain('KEEP_THIS_PROMPT_STRICT');
    expect(rawResult.diagnosis).not.toContain('ALTERED_PROMPT_MUST_FAIL');

    // Even when `direction` and `payload` both exist alongside other interactive fields, treat as raw message.
    const rawWithDirectionExpected = [
      { direction: 'stdin', payload: { ok: true }, prompt: 'RAW_PROMPT_A' },
    ];
    const rawWithDirectionChanged = [
      { direction: 'stdin', payload: { ok: true }, prompt: 'RAW_PROMPT_B' },
    ];
    const rawDirResult = compareReplaySequence(rawWithDirectionExpected, rawWithDirectionChanged);
    expect(rawDirResult.matched).toBe(false);
    expect(rawDirResult.mismatches[0]).toMatchObject({
      kind: 'value_mismatch',
      location: { messageIndex: 0, path: 'prompt' },
    });
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

    const unmapped = compareReplayMessages(expected, { ...expected, id: 100 });
    expect(unmapped.matched).toBe(false);
    expect(unmapped.mismatches[0].location.path).toBe('id');

    const mappedTopIdOnly = compareReplayMessages(
      expected,
      { ...expected, id: 100 },
      { dynamicFields: ['id'] },
    );
    expect(mappedTopIdOnly.matched).toBe(true);

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

  it('still binds IDs when expected and actual share the same request object reference', () => {
    const sharedReq = {
      jsonrpc: '2.0',
      id: 1,
      method: 'session/prompt',
      params: { prompt: [{ type: 'text', text: 'Check shared reference' }] },
    };

    const expected: ReplaySequenceMessage[] = [
      { direction: 'stdin', payload: sharedReq },
      { direction: 'stdout', payload: { jsonrpc: '2.0', id: 1, result: { stopReason: 'end_turn' } } },
    ];
    const mismatchedResponse: ReplaySequenceMessage[] = [
      { direction: 'stdin', payload: sharedReq },
      { direction: 'stdout', payload: { jsonrpc: '2.0', id: 2, result: { stopReason: 'end_turn' } } },
    ];

    const result = compareReplaySequence(expected, mismatchedResponse, { dynamicFields: ['id'] });
    expect(result.matched).toBe(false);
    expect(result.mismatches).toHaveLength(1);
    expect(result.mismatches[0]).toMatchObject({
      kind: 'id_correlation_mismatch',
      location: { messageIndex: 1, direction: 'stdout', path: 'id' },
    });
  });

  it('scopes bidirectional JSON-RPC request IDs by originating endpoint and associates responses with the opposite endpoint', () => {
    const recorded: ReplaySequenceMessage[] = [
      {
        direction: 'stdin',
        payload: {
          jsonrpc: '2.0',
          id: 1,
          method: 'session/prompt',
          params: { prompt: [{ type: 'text', text: 'Run task' }] },
        },
      },
      {
        direction: 'stdout',
        payload: {
          jsonrpc: '2.0',
          id: 1,
          method: 'session/request_permission',
          params: { toolCall: { toolCallId: 'tc-1', title: 'Run test' } },
        },
      },
      {
        direction: 'stdin',
        payload: {
          jsonrpc: '2.0',
          id: 1,
          result: { outcome: { outcome: 'selected', optionId: 'allow_once' } },
        },
      },
      {
        direction: 'stdout',
        payload: {
          jsonrpc: '2.0',
          id: 1,
          result: { stopReason: 'end_turn' },
        },
      },
    ];

    // Live run uses id 101 for client -> server request and id 500 for server -> client permission request.
    const validLive: ReplaySequenceMessage[] = [
      {
        direction: 'stdin',
        payload: {
          jsonrpc: '2.0',
          id: 101,
          method: 'session/prompt',
          params: { prompt: [{ type: 'text', text: 'Run task' }] },
        },
      },
      {
        direction: 'stdout',
        payload: {
          jsonrpc: '2.0',
          id: 500,
          method: 'session/request_permission',
          params: { toolCall: { toolCallId: 'tc-1', title: 'Run test' } },
        },
      },
      {
        direction: 'stdin',
        payload: {
          jsonrpc: '2.0',
          id: 500,
          result: { outcome: { outcome: 'selected', optionId: 'allow_once' } },
        },
      },
      {
        direction: 'stdout',
        payload: {
          jsonrpc: '2.0',
          id: 101,
          result: { stopReason: 'end_turn' },
        },
      },
    ];

    expect(compareReplaySequence(recorded, validLive, { dynamicFields: ['id'] }).matched).toBe(true);

    // If the client's permission response echoes the client's own request ID (101) instead of the server's (500), it must fail.
    const swappedClientResp = structuredClone(validLive);
    (swappedClientResp[2].payload as Record<string, unknown>).id = 101;
    const swappedClientRes = compareReplaySequence(recorded, swappedClientResp, { dynamicFields: ['id'] });
    expect(swappedClientRes.matched).toBe(false);
    expect(swappedClientRes.mismatches).toHaveLength(1);
    expect(swappedClientRes.mismatches[0]).toMatchObject({
      kind: 'id_correlation_mismatch',
      location: { messageIndex: 2, direction: 'stdin', path: 'id' },
    });

    // If the server's prompt response echoes the server's request ID (500) instead of the client's (101), it must fail.
    const swappedServerResp = structuredClone(validLive);
    (swappedServerResp[3].payload as Record<string, unknown>).id = 500;
    const swappedServerRes = compareReplaySequence(recorded, swappedServerResp, { dynamicFields: ['id'] });
    expect(swappedServerRes.matched).toBe(false);
    expect(swappedServerRes.mismatches).toHaveLength(1);
    expect(swappedServerRes.mismatches[0]).toMatchObject({
      kind: 'id_correlation_mismatch',
      location: { messageIndex: 3, direction: 'stdout', path: 'id' },
    });
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

    const failedProbe = matcher.tryMatchMessage(expectedReq, {
      type: 'control_request',
      request_id: 'wrong-probe-id',
      request: { subtype: 'can_use_tool', tool_name: 'Bash', input: { command: 'rm -rf .' } },
    });
    expect(failedProbe.matched).toBe(false);

    const realReqMatch = matcher.tryMatchMessage(expectedReq, {
      type: 'control_request',
      request_id: 'live-perm-1',
      request: { subtype: 'can_use_tool', tool_name: 'Bash', input: { command: 'git status' } },
    });
    expect(realReqMatch.matched).toBe(true);

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

  it('redacts untrusted payload keys and values from mismatch locations and diagnosis', () => {
    const result = compareReplaySequence(
      [
        {
          direction: 'stdin',
          payload: {
            params: {
              input: {
                'secret-api-token': 'SECRET_TOKEN_VALUE',
                'nested-private-obj': { 'inner-secret-key': 'INNER_VAL_A' },
              },
            },
          },
        },
      ],
      [
        {
          direction: 'stdin',
          payload: {
            params: {
              input: {
                'nested-private-obj': { 'inner-secret-key': 'INNER_VAL_B' },
                'unexpected-auth-header': 'UNEXPECTED_VAL',
              },
            },
          },
        },
      ],
    );

    expect(result.matched).toBe(false);
    expect(result.mismatches.map((m) => [m.kind, m.location.path])).toEqual([
      ['value_mismatch', 'params.input[key#0][key#0]'],
      ['missing_key', 'params.input[key#1]'],
      ['unexpected_key', 'params.input[extra-key#0]'],
    ]);
    expect(result.diagnosis).toContain('params.input[key#0][key#0]');
    expect(result.diagnosis).toContain('params.input[key#1]');
    expect(result.diagnosis).toContain('params.input[extra-key#0]');

    const serialized = JSON.stringify(result);
    for (const secret of [
      'secret-api-token',
      'SECRET_TOKEN_VALUE',
      'nested-private-obj',
      'inner-secret-key',
      'INNER_VAL_A',
      'INNER_VAL_B',
      'unexpected-auth-header',
      'UNEXPECTED_VAL',
    ]) {
      expect(serialized).not.toContain(secret);
    }
  });

  it('reports structural diagnosis (array lengths, directions, unexpected messages, invalid JSON) without raw payloads', () => {
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
        { direction: 'stdin', payload: { params: { prompt: ['SECRET_A', 'SECRET_B'] } } },
        { direction: 'stdout', payload: { result: { status: 'ok' } } },
      ],
      [
        { direction: 'stdin', payload: { params: { prompt: ['SECRET_A'] } } },
        { direction: 'stdin', payload: { result: { status: 'ok' } } },
        { direction: 'stdout', payload: { result: { status: 'EXTRA_MSG_SECRET' } } },
      ],
    );
    expect(structuralRes.matched).toBe(false);
    expect(structuralRes.mismatches.map((m) => [m.kind, m.location.messageIndex, m.location.path])).toEqual([
      ['array_length_mismatch', 0, 'params.prompt'],
      ['direction_mismatch', 1, '(root)'],
      ['unexpected_message', 2, '(root)'],
    ]);
    const serialized = JSON.stringify(structuralRes);
    expect(serialized).not.toContain('SECRET_A');
    expect(serialized).not.toContain('SECRET_B');
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

  it('provides bounded per-provider dynamic ID rules and rewrites correlated inbound IDs without loosening non-ID fields', () => {
    // 1. Codex: correlates JSON-RPC id + threadId + turnId, keeps prompt/steering text strict.
    const codexMatcher = new ReplayMessageMatcher({
      dynamicFields: getProviderReplayDynamicFields('codex'),
    });
    expect(
      codexMatcher.matchMessage(
        {
          jsonrpc: '2.0',
          id: 10,
          method: 'thread/resume',
          params: { threadId: 'thread-rec-1', cwd: '/repo' },
        },
        {
          jsonrpc: '2.0',
          id: 1,
          method: 'thread/resume',
          params: { threadId: 'thread-live-9', cwd: '/repo' },
        },
        { direction: 'stdin' },
      ).matched,
    ).toBe(true);

    // Inbound response rewrites both request id (10 -> 1) and correlated threadId (thread-rec-1 -> thread-live-9).
    const rewrittenThreadResp = codexMatcher.rewriteCorrelatedFrame(
      {
        jsonrpc: '2.0',
        id: 10,
        result: { thread: { id: 'thread-rec-1' } },
      },
      { direction: 'stdout' },
    );
    expect(rewrittenThreadResp).toEqual({
      jsonrpc: '2.0',
      id: 1,
      result: { thread: { id: 'thread-live-9' } },
    });

    // Server-originated turn.id is bound on emit, so outbound steer must echo it and keep text strict.
    const rewrittenTurnResp = codexMatcher.rewriteCorrelatedFrame(
      {
        jsonrpc: '2.0',
        id: 20,
        result: { turn: { id: 'turn-srv-1' } },
      },
      { direction: 'stdout' },
    );
    expect(rewrittenTurnResp).toEqual({
      jsonrpc: '2.0',
      id: 20,
      result: { turn: { id: 'turn-srv-1' } },
    });

    const wrongTurnSteer = codexMatcher.tryMatchMessage(
      {
        jsonrpc: '2.0',
        id: 30,
        method: 'turn/steer',
        params: {
          threadId: 'thread-rec-1',
          expectedTurnId: 'turn-srv-1',
          input: [{ type: 'text', text: 'Keep tests' }],
        },
      },
      {
        jsonrpc: '2.0',
        id: 2,
        method: 'turn/steer',
        params: {
          threadId: 'thread-live-9',
          expectedTurnId: 'turn-WRONG',
          input: [{ type: 'text', text: 'Keep tests' }],
        },
      },
      { direction: 'stdin' },
    );
    expect(wrongTurnSteer.matched).toBe(false);
    expect(wrongTurnSteer.mismatches[0]).toMatchObject({
      kind: 'id_correlation_mismatch',
      location: { direction: 'stdin', path: 'params.expectedTurnId' },
    });

    const mutatedSteerText = codexMatcher.tryMatchMessage(
      {
        jsonrpc: '2.0',
        id: 30,
        method: 'turn/steer',
        params: {
          threadId: 'thread-rec-1',
          expectedTurnId: 'turn-srv-1',
          input: [{ type: 'text', text: 'ORIGINAL_STEER' }],
        },
      },
      {
        jsonrpc: '2.0',
        id: 2,
        method: 'turn/steer',
        params: {
          threadId: 'thread-live-9',
          expectedTurnId: 'turn-srv-1',
          input: [{ type: 'text', text: 'MUTATED_STEER' }],
        },
      },
      { direction: 'stdin' },
    );
    expect(mutatedSteerText.matched).toBe(false);
    expect(mutatedSteerText.mismatches[0]).toMatchObject({
      kind: 'value_mismatch',
      location: { direction: 'stdin', path: 'params.input[0].text' },
    });

    // 2. Claude: correlates steering uuid -> user_message_uuid and control request_id -> response.request_id.
    const claudeMatcher = new ReplayMessageMatcher({
      dynamicFields: getProviderReplayDynamicFields('claude-code'),
    });
    expect(
      claudeMatcher.matchMessage(
        {
          type: 'user',
          uuid: 'rec-steer-uuid',
          priority: 'now',
          parent_tool_use_id: null,
          message: { role: 'user', content: 'Keep tests' },
        },
        {
          type: 'user',
          uuid: 'live-steer-uuid',
          priority: 'now',
          parent_tool_use_id: null,
          message: { role: 'user', content: 'Keep tests' },
        },
        { direction: 'stdin' },
      ).matched,
    ).toBe(true);
    expect(
      claudeMatcher.rewriteCorrelatedFrame(
        {
          type: 'result',
          subtype: 'success',
          session_id: 'claude-rec-1',
          user_message_uuid: 'rec-steer-uuid',
          user_message_uuids: ['rec-steer-uuid'],
          result: 'done',
        },
        { direction: 'stdout' },
      ),
    ).toEqual({
      type: 'result',
      subtype: 'success',
      session_id: 'claude-rec-1',
      user_message_uuid: 'live-steer-uuid',
      user_message_uuids: ['live-steer-uuid'],
      result: 'done',
    });

    // 3. Antigravity: correlates id, sessionId, toolCallId; keeps permission outcome strict.
    const agyMatcher = new ReplayMessageMatcher({
      dynamicFields: getProviderReplayDynamicFields('antigravity'),
    });
    expect(
      agyMatcher.rewriteCorrelatedFrame(
        {
          jsonrpc: '2.0',
          id: 77,
          method: 'session/request_permission',
          params: { sessionId: 'agy-rec-1', toolCall: { toolCallId: 'tc-1' } },
        },
        { direction: 'stdout' },
      ),
    ).toEqual({
      jsonrpc: '2.0',
      id: 77,
      method: 'session/request_permission',
      params: { sessionId: 'agy-rec-1', toolCall: { toolCallId: 'tc-1' } },
    });
    const wrongPermDecision = agyMatcher.tryMatchMessage(
      { jsonrpc: '2.0', id: 77, result: { outcome: { outcome: 'cancelled' } } },
      { jsonrpc: '2.0', id: 77, result: { outcome: { outcome: 'selected' } } },
      { direction: 'stdin' },
    );
    expect(wrongPermDecision.matched).toBe(false);
    expect(wrongPermDecision.mismatches[0]).toMatchObject({
      kind: 'value_mismatch',
      location: { direction: 'stdin', path: 'result.outcome.outcome' },
    });
  });
});
