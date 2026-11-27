import type { ProviderId } from '@dalang/shared';

export type MessageDirection = 'stdin' | 'stdout' | 'request' | 'response' | 'notification';

export type DynamicFieldMode = 'correlate' | 'ignore';

export type CorrelationScope = 'endpoint' | 'shared';

export interface DynamicFieldRule {
  /**
   * Explicit path to the dynamic field inside a message, using dot/bracket notation
   * (for example `"id"`, `"response.request_id"`, `"params.threadId"`, or `"items[*].id"`).
   */
  path: string;
  /**
   * `"correlate"` (default) enforces a 1-to-1 bidirectional mapping between expected and actual
   * values across messages. `"ignore"` skips value comparison for this explicitly named field.
   */
  mode?: DynamicFieldMode;
  /**
   * Correlation group name. Defaults to `path` so identical paths correlate automatically across
   * requests and responses; distinct paths (such as `"request_id"` and `"response.request_id"`)
   * can share a group name to correlate with each other.
   */
  correlateAs?: string;
  /**
   * Correlation scoping for bidirectional transports (`stdin` / `stdout`):
   * - `"endpoint"` scopes request IDs by originating endpoint and associates responses with the
   *   opposite endpoint (default for `"id"`, `"request_id"`, `"response.request_id"`).
   * - `"shared"` correlates across all directions (default for session/thread/turn entity IDs).
   */
  scope?: CorrelationScope;
  /** Optional filter limiting this rule to messages with a matching method, type, or direction. */
  when?: {
    method?: string;
    type?: string;
    direction?: MessageDirection;
  };
}

export interface ReplayMatchOptions {
  /** Explicitly named dynamic fields. Only listed paths are mapped; all other fields are compared strictly. */
  dynamicFields?: Array<string | DynamicFieldRule>;
  /** Optional additional object key names considered structural and safe to display in mismatch paths. */
  safeKeys?: string[];
  /** Optional message direction for sequence diagnostics and `when` rule filtering. */
  direction?: MessageDirection;
  /** Optional zero-based message index for diagnostics. */
  messageIndex?: number;
}

export interface ReplaySequenceMessage {
  direction: MessageDirection;
  /** Raw JSON line or parsed JSON payload. */
  payload: unknown;
}

export type ReplayMismatchKind =
  | 'value_mismatch'
  | 'type_mismatch'
  | 'missing_key'
  | 'unexpected_key'
  | 'array_length_mismatch'
  | 'id_correlation_mismatch'
  | 'direction_mismatch'
  | 'missing_message'
  | 'unexpected_message'
  | 'invalid_json';

export interface ReplayMismatchLocation {
  messageIndex?: number;
  direction?: MessageDirection;
  path: string;
}

export interface ReplayMismatchDetail {
  expectedType?: string;
  actualType?: string;
  expectedLength?: number;
  actualLength?: number;
  expectedDirection?: MessageDirection;
  actualDirection?: MessageDirection;
  correlationGroup?: string;
}

export interface ReplayMismatch {
  kind: ReplayMismatchKind;
  location: ReplayMismatchLocation;
  /** Structural diagnosis without raw payload values or untrusted key names. */
  summary: string;
  detail?: ReplayMismatchDetail;
}

export interface ReplayMatchResult {
  matched: boolean;
  mismatches: ReplayMismatch[];
  /** Human-readable diagnosis showing mismatch locations without raw payloads or untrusted keys. */
  diagnosis: string;
}

export type ParsedJsonLine =
  | { ok: true; value: unknown }
  | { ok: false; lineIndex: number };

type PathSegment = string | number;
type DisplaySegment = string | number | { redacted: string };
type RuleSegment = string | number | '*';
type MessageRole = 'request' | 'response' | 'notification';

interface NormalizedRule {
  segments: RuleSegment[];
  mode: DynamicFieldMode;
  correlateAs: string;
  scope: CorrelationScope;
  when?: DynamicFieldRule['when'];
}

interface MessageMeta {
  method?: string;
  type?: string;
  direction?: MessageDirection;
  role: MessageRole;
}

const VALID_DIRECTIONS = new Set<MessageDirection>([
  'stdin',
  'stdout',
  'request',
  'response',
  'notification',
]);

const REQUEST_ID_PATHS = new Set(['id', 'request_id', 'response.request_id']);

/**
 * Known interactive session protocol keys safe to display verbatim in mismatch paths.
 * Untrusted keys outside this set (or `options.safeKeys`) are redacted to positional tags.
 */
const SAFE_PROTOCOL_KEYS = new Set([
  // JSON-RPC 2.0
  'jsonrpc',
  'id',
  'method',
  'params',
  'result',
  'error',
  'code',
  'message',
  'data',
  // Claude stream-json
  'type',
  'subtype',
  'request_id',
  'request',
  'response',
  'session_id',
  'uuid',
  'parent_tool_use_id',
  'priority',
  'role',
  'content',
  'text',
  'source',
  'media_type',
  'behavior',
  'updatedInput',
  'tool_name',
  'is_error',
  'user_message_uuid',
  'user_message_uuids',
  'models',
  // Codex app-server
  'threadId',
  'turnId',
  'expectedTurnId',
  'excludeTurns',
  'cwd',
  'model',
  'effort',
  'approvalPolicy',
  'sandbox',
  'input',
  'text_elements',
  'url',
  'mimeType',
  'thread',
  'turn',
  'item',
  'itemId',
  'status',
  'delta',
  'decision',
  'approved',
  'clientInfo',
  'name',
  'version',
  // Antigravity ACP
  'protocolVersion',
  'clientCapabilities',
  'agentCapabilities',
  'sessionCapabilities',
  'loadSession',
  'sessionId',
  'mcpServers',
  'configOptions',
  'configId',
  'currentValue',
  'category',
  'value',
  'modeId',
  'modelId',
  'modes',
  'prompt',
  'stopReason',
  'update',
  'sessionUpdate',
  'toolCall',
  'toolCallId',
  'title',
  'kind',
  'options',
  'optionId',
  'outcome',
  'command',
  'timestamp',
  'payload',
]);

class CorrelationStore {
  private readonly expectedToActual = new Map<string, Map<string, string>>();
  private readonly actualToExpected = new Map<string, Map<string, string>>();

  clone(): CorrelationStore {
    const copy = new CorrelationStore();
    for (const [group, map] of this.expectedToActual) {
      copy.expectedToActual.set(group, new Map(map));
    }
    for (const [group, map] of this.actualToExpected) {
      copy.actualToExpected.set(group, new Map(map));
    }
    return copy;
  }

  replaceFrom(other: CorrelationStore): void {
    this.expectedToActual.clear();
    this.actualToExpected.clear();
    for (const [group, map] of other.expectedToActual) {
      this.expectedToActual.set(group, new Map(map));
    }
    for (const [group, map] of other.actualToExpected) {
      this.actualToExpected.set(group, new Map(map));
    }
  }

  clear(): void {
    this.expectedToActual.clear();
    this.actualToExpected.clear();
  }

  lookupActual(groupKey: string, expected: string | number): string | number | undefined {
    const encoded = this.expectedToActual.get(groupKey)?.get(scalarKey(expected));
    return encoded !== undefined ? decodeScalarKey(encoded) : undefined;
  }

  correlate(groupKey: string, expected: string | number, actual: string | number): boolean {
    const expKey = scalarKey(expected);
    const actKey = scalarKey(actual);
    let expMap = this.expectedToActual.get(groupKey);
    let actMap = this.actualToExpected.get(groupKey);

    const boundActual = expMap?.get(expKey);
    if (boundActual !== undefined && boundActual !== actKey) {
      return false;
    }

    const boundExpected = actMap?.get(actKey);
    if (boundExpected !== undefined && boundExpected !== expKey) {
      return false;
    }

    if (!expMap) {
      expMap = new Map();
      this.expectedToActual.set(groupKey, expMap);
    }
    if (!actMap) {
      actMap = new Map();
      this.actualToExpected.set(groupKey, actMap);
    }
    expMap.set(expKey, actKey);
    actMap.set(actKey, expKey);
    return true;
  }
}

function scalarKey(value: string | number): string {
  return typeof value === 'number' ? `n:${Object.is(value, -0) ? 0 : value}` : `s:${value}`;
}

function decodeScalarKey(encoded: string): string | number {
  return encoded.startsWith('n:') ? Number(encoded.slice(2)) : encoded.slice(2);
}

const PROVIDER_REPLAY_DYNAMIC_FIELDS: Record<ProviderId, readonly DynamicFieldRule[]> = {
  'claude-code': [
    { path: 'request_id', correlateAs: 'controlRequestId', scope: 'endpoint' },
    { path: 'response.request_id', correlateAs: 'controlRequestId', scope: 'endpoint' },
    { path: 'uuid', correlateAs: 'userMessageUuid', scope: 'shared', when: { type: 'user' } },
    { path: 'user_message_uuid', correlateAs: 'userMessageUuid', scope: 'shared', when: { type: 'result' } },
    { path: 'user_message_uuids[*]', correlateAs: 'userMessageUuid', scope: 'shared', when: { type: 'result' } },
    { path: 'session_id', correlateAs: 'sessionId', scope: 'shared' },
  ],
  codex: [
    { path: 'id', correlateAs: 'id', scope: 'endpoint' },
    { path: 'result.thread.id', correlateAs: 'threadId', scope: 'shared' },
    { path: 'params.threadId', correlateAs: 'threadId', scope: 'shared' },
    { path: 'result.turn.id', correlateAs: 'turnId', scope: 'shared' },
    { path: 'params.turnId', correlateAs: 'turnId', scope: 'shared' },
    { path: 'params.expectedTurnId', correlateAs: 'turnId', scope: 'shared' },
    { path: 'params.turn.id', correlateAs: 'turnId', scope: 'shared' },
    { path: 'params.itemId', correlateAs: 'itemId', scope: 'shared' },
    { path: 'params.item.id', correlateAs: 'itemId', scope: 'shared' },
  ],
  antigravity: [
    { path: 'id', correlateAs: 'id', scope: 'endpoint' },
    { path: 'result.sessionId', correlateAs: 'sessionId', scope: 'shared' },
    { path: 'params.sessionId', correlateAs: 'sessionId', scope: 'shared' },
    { path: 'params.toolCall.toolCallId', correlateAs: 'toolCallId', scope: 'shared' },
    { path: 'params.update.toolCallId', correlateAs: 'toolCallId', scope: 'shared' },
  ],
};

/**
 * Returns the bounded per-provider dynamic ID correlation rules for interactive session replay.
 * Only protocol request/session/entity IDs are normalized; prompts, steering text, and permission
 * decisions are always compared strictly.
 */
export function getProviderReplayDynamicFields(provider: ProviderId): DynamicFieldRule[] {
  return PROVIDER_REPLAY_DYNAMIC_FIELDS[provider].map((rule) => ({
    ...rule,
    ...(rule.when ? { when: { ...rule.when } } : {}),
  }));
}

function parseRulePath(rawPath: string): RuleSegment[] {
  const segments: RuleSegment[] = [];
  const trimmed = rawPath.trim();
  if (!trimmed) return segments;

  const tokenRegex = /\[(\*|\d+)\]|[^.[\]]+/g;
  for (const match of trimmed.matchAll(tokenRegex)) {
    const bracket = match[1];
    if (bracket !== undefined) {
      segments.push(bracket === '*' ? '*' : Number(bracket));
    } else {
      const token = match[0];
      if (token === '*') {
        segments.push('*');
      } else if (/^\d+$/.test(token)) {
        segments.push(Number(token));
      } else {
        segments.push(token);
      }
    }
  }
  return segments;
}

function normalizeRules(rules?: Array<string | DynamicFieldRule>): NormalizedRule[] {
  if (!rules || rules.length === 0) return [];
  return rules.map((entry) => {
    const rule = typeof entry === 'string' ? { path: entry } : entry;
    return {
      segments: parseRulePath(rule.path),
      mode: rule.mode ?? 'correlate',
      correlateAs: rule.correlateAs ?? rule.path,
      scope: rule.scope ?? (REQUEST_ID_PATHS.has(rule.path) ? 'endpoint' : 'shared'),
      when: rule.when,
    };
  });
}

function toDisplayKeySegment(
  key: string,
  index: number,
  prefix: 'key' | 'extra-key',
  safeKeys?: Set<string>,
): DisplaySegment {
  if (SAFE_PROTOCOL_KEYS.has(key) || safeKeys?.has(key)) {
    return key;
  }
  return { redacted: `${prefix}#${index}` };
}

function formatPath(segments: DisplaySegment[]): string {
  if (segments.length === 0) return '(root)';
  let out = '';
  for (const seg of segments) {
    if (typeof seg === 'number') {
      out += `[${seg}]`;
    } else if (typeof seg === 'object') {
      out += `[${seg.redacted}]`;
    } else if (/^[A-Za-z_$][A-Za-z0-9_$-]*$/.test(seg)) {
      out += out ? `.${seg}` : seg;
    } else {
      out += `[${JSON.stringify(seg)}]`;
    }
  }
  return out;
}

function formatLocationPrefix(location: ReplayMismatchLocation): string {
  const parts: string[] = [];
  if (location.messageIndex !== undefined) {
    parts.push(`[${location.messageIndex}]`);
  }
  if (location.direction !== undefined) {
    parts.push(`(${location.direction})`);
  }
  parts.push(location.path);
  return parts.join(' ');
}

function valueType(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isCorrelatableId(value: unknown): value is string | number {
  return typeof value === 'string' || (typeof value === 'number' && Number.isFinite(value));
}

function classifyMessageRole(value: unknown): MessageRole {
  if (!isPlainObject(value)) return 'notification';
  if (value.type === 'control_request') return 'request';
  if (value.type === 'control_response') return 'response';

  const hasMethod = typeof value.method === 'string';
  const hasId = Object.hasOwn(value, 'id') && value.id !== undefined;
  if (hasMethod && hasId) return 'request';
  if (!hasMethod && hasId) return 'response';
  return 'notification';
}

function extractMessageMeta(value: unknown, direction?: MessageDirection): MessageMeta {
  if (!isPlainObject(value)) return { direction, role: 'notification' };
  return {
    method: typeof value.method === 'string' ? value.method : undefined,
    type: typeof value.type === 'string' ? value.type : undefined,
    direction,
    role: classifyMessageRole(value),
  };
}

function resolveCorrelationKey(rule: NormalizedRule, meta: MessageMeta): string {
  if (rule.scope === 'shared') {
    return `shared:${rule.correlateAs}`;
  }
  if (meta.direction === 'stdin' || meta.direction === 'stdout') {
    const endpoint =
      meta.role === 'response'
        ? meta.direction === 'stdin'
          ? 'stdout'
          : 'stdin'
        : meta.direction;
    return `endpoint:${endpoint}:${rule.correlateAs}`;
  }
  return `endpoint:default:${rule.correlateAs}`;
}

function whenMatches(rule: NormalizedRule, meta: MessageMeta): boolean {
  if (!rule.when) return true;
  if (rule.when.method !== undefined && rule.when.method !== meta.method) return false;
  if (rule.when.type !== undefined && rule.when.type !== meta.type) return false;
  if (rule.when.direction !== undefined && rule.when.direction !== meta.direction) return false;
  return true;
}

function segmentsMatchPrefix(ruleSegments: RuleSegment[], segments: PathSegment[]): boolean {
  for (let i = 0; i < segments.length; i++) {
    const pattern = ruleSegments[i];
    const actual = segments[i];
    if (pattern === '*') {
      if (typeof actual !== 'number') return false;
      continue;
    }
    if (pattern !== actual) return false;
  }
  return true;
}

function ruleMatches(rule: NormalizedRule, segments: PathSegment[], meta: MessageMeta): boolean {
  if (!whenMatches(rule, meta)) return false;
  if (rule.segments.length === 0 || rule.segments.length !== segments.length) return false;
  return segmentsMatchPrefix(rule.segments, segments);
}

function hasPotentialDescendantRule(
  rules: NormalizedRule[],
  segments: PathSegment[],
  meta: MessageMeta,
): boolean {
  return rules.some(
    (rule) =>
      rule.mode === 'correlate' &&
      whenMatches(rule, meta) &&
      rule.segments.length > segments.length &&
      segmentsMatchPrefix(rule.segments, segments),
  );
}

function parseJsonPayload(input: unknown): { ok: true; value: unknown } | { ok: false } {
  if (typeof input !== 'string') return { ok: true, value: input };
  try {
    return { ok: true, value: JSON.parse(input) as unknown };
  } catch {
    return { ok: false };
  }
}

/**
 * Splits a JSONL chunk (such as recorded `stdinWrites` data) into parsed messages without exposing
 * raw payload content in parse errors.
 */
export function parseInteractiveJsonLines(chunk: string): ParsedJsonLine[] {
  const results: ParsedJsonLine[] = [];
  const lines = chunk.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    if (!trimmed) continue;
    try {
      results.push({ ok: true, value: JSON.parse(trimmed) as unknown });
    } catch {
      results.push({ ok: false, lineIndex: i });
    }
  }
  return results;
}

/**
 * Formats mismatches into a concise diagnostic message showing exact locations without raw payloads.
 */
export function formatReplayDiagnosis(mismatches: ReplayMismatch[]): string {
  if (mismatches.length === 0) return 'Matched';
  return mismatches.map((m) => `${m.kind} at ${formatLocationPrefix(m.location)}: ${m.summary}`).join('\n');
}

function isSequenceMessage(entry: unknown): entry is ReplaySequenceMessage {
  if (!isPlainObject(entry)) return false;
  const keys = Object.keys(entry);
  if (keys.length !== 2) return false;
  return (
    Object.hasOwn(entry, 'payload') &&
    typeof entry.direction === 'string' &&
    VALID_DIRECTIONS.has(entry.direction as MessageDirection)
  );
}

function toSequenceMessage(entry: unknown): { direction?: MessageDirection; payload: unknown } {
  return isSequenceMessage(entry) ? entry : { payload: entry };
}

/**
 * Stateful comparator for interactive replay messages (stream-json, Codex app-server, Antigravity ACP).
 * Only explicitly named dynamic fields are mapped or correlated; all other fields, including nested
 * prompts, steering text, and permission decisions, are compared strictly.
 */
export class ReplayMessageMatcher {
  private readonly defaultRules: NormalizedRule[];
  private readonly defaultSafeKeys: Set<string>;
  private readonly correlations = new CorrelationStore();

  constructor(options: { dynamicFields?: Array<string | DynamicFieldRule>; safeKeys?: string[] } = {}) {
    this.defaultRules = normalizeRules(options.dynamicFields);
    this.defaultSafeKeys = new Set(options.safeKeys ?? []);
  }

  reset(): void {
    this.correlations.clear();
  }

  /**
   * Compares one expected and one actual message, committing any newly established ID correlations.
   */
  matchMessage(expected: unknown, actual: unknown, options?: ReplayMatchOptions): ReplayMatchResult {
    return this.compareOne(expected, actual, options, true);
  }

  /**
   * Probes whether `actual` matches `expected`, committing ID correlations only when matched.
   */
  tryMatchMessage(expected: unknown, actual: unknown, options?: ReplayMatchOptions): ReplayMatchResult {
    return this.compareOne(expected, actual, options, false);
  }

  /**
   * Rewrites correlated IDs in a recorded frame (typically `emit_inbound` on `stdout`) to the
   * actual live IDs bound during prior messages, and registers newly introduced server IDs so
   * subsequent outbound frames must echo them consistently.
   */
  rewriteCorrelatedFrame(
    frame: unknown,
    options?: Pick<ReplayMatchOptions, 'direction' | 'dynamicFields'>,
  ): unknown {
    const rules = options?.dynamicFields
      ? [...this.defaultRules, ...normalizeRules(options.dynamicFields)]
      : this.defaultRules;
    if (rules.length === 0) return frame;
    const meta = extractMessageMeta(frame, options?.direction);
    return this.rewriteValue(frame, [], rules, meta);
  }

  private rewriteValue(
    value: unknown,
    segments: PathSegment[],
    rules: NormalizedRule[],
    meta: MessageMeta,
  ): unknown {
    const matchingRule = rules.find((rule) => ruleMatches(rule, segments, meta));
    if (matchingRule && matchingRule.mode === 'correlate' && isCorrelatableId(value)) {
      const groupKey = resolveCorrelationKey(matchingRule, meta);
      const boundActual = this.correlations.lookupActual(groupKey, value);
      if (boundActual !== undefined) {
        return boundActual;
      }
      this.correlations.correlate(groupKey, value, value);
      return value;
    }

    if (Array.isArray(value)) {
      if (!hasPotentialDescendantRule(rules, segments, meta)) {
        return value;
      }
      let changed = false;
      const next = value.map((item, idx) => {
        const rewritten = this.rewriteValue(item, [...segments, idx], rules, meta);
        if (rewritten !== item) changed = true;
        return rewritten;
      });
      return changed ? next : value;
    }

    if (isPlainObject(value)) {
      if (!hasPotentialDescendantRule(rules, segments, meta)) {
        return value;
      }
      let changed = false;
      const next: Record<string, unknown> = {};
      for (const [key, entry] of Object.entries(value)) {
        const rewritten = this.rewriteValue(entry, [...segments, key], rules, meta);
        if (rewritten !== entry) changed = true;
        next[key] = rewritten;
      }
      return changed ? next : value;
    }

    return value;
  }

  /**
   * Compares an ordered sequence of expected and actual messages under a shared ID correlation state.
   */
  matchSequence(
    expected: Array<ReplaySequenceMessage | unknown>,
    actual: Array<ReplaySequenceMessage | unknown>,
    options?: ReplayMatchOptions,
  ): ReplayMatchResult {
    const mismatches: ReplayMismatch[] = [];
    const commonLength = Math.min(expected.length, actual.length);

    for (let i = 0; i < commonLength; i++) {
      const expItem = toSequenceMessage(expected[i]);
      const actItem = toSequenceMessage(actual[i]);
      const direction = expItem.direction ?? actItem.direction ?? options?.direction;

      if (expItem.direction && actItem.direction && expItem.direction !== actItem.direction) {
        mismatches.push({
          kind: 'direction_mismatch',
          location: { messageIndex: i, direction: actItem.direction, path: '(root)' },
          summary: `Expected ${expItem.direction} message but received ${actItem.direction}`,
          detail: { expectedDirection: expItem.direction, actualDirection: actItem.direction },
        });
        continue;
      }

      const stepResult = this.compareOne(
        expItem.payload,
        actItem.payload,
        {
          dynamicFields: options?.dynamicFields,
          safeKeys: options?.safeKeys,
          direction,
          messageIndex: i,
        },
        true,
      );
      mismatches.push(...stepResult.mismatches);
    }

    for (let i = commonLength; i < expected.length; i++) {
      const expItem = toSequenceMessage(expected[i]);
      const direction = expItem.direction ?? options?.direction;
      mismatches.push({
        kind: 'missing_message',
        location: { messageIndex: i, ...(direction ? { direction } : {}), path: '(root)' },
        summary: direction ? `Missing expected ${direction} message` : 'Missing expected message',
      });
    }

    for (let i = commonLength; i < actual.length; i++) {
      const actItem = toSequenceMessage(actual[i]);
      const direction = actItem.direction ?? options?.direction;
      mismatches.push({
        kind: 'unexpected_message',
        location: { messageIndex: i, ...(direction ? { direction } : {}), path: '(root)' },
        summary: direction ? `Unexpected ${direction} message` : 'Unexpected message',
      });
    }

    return {
      matched: mismatches.length === 0,
      mismatches,
      diagnosis: formatReplayDiagnosis(mismatches),
    };
  }

  private compareOne(
    expectedRaw: unknown,
    actualRaw: unknown,
    options: ReplayMatchOptions | undefined,
    commitOnMismatch: boolean,
  ): ReplayMatchResult {
    const mismatches: ReplayMismatch[] = [];
    const baseLocation = (path: string): ReplayMismatchLocation => ({
      ...(options?.messageIndex !== undefined ? { messageIndex: options.messageIndex } : {}),
      ...(options?.direction !== undefined ? { direction: options.direction } : {}),
      path,
    });

    const parsedExp = parseJsonPayload(expectedRaw);
    if (!parsedExp.ok) {
      mismatches.push({
        kind: 'invalid_json',
        location: baseLocation('(root)'),
        summary: 'Expected payload is not valid JSON',
      });
    }
    const parsedAct = parseJsonPayload(actualRaw);
    if (!parsedAct.ok) {
      mismatches.push({
        kind: 'invalid_json',
        location: baseLocation('(root)'),
        summary: 'Actual payload is not valid JSON',
      });
    }

    if (!parsedExp.ok || !parsedAct.ok) {
      return {
        matched: false,
        mismatches,
        diagnosis: formatReplayDiagnosis(mismatches),
      };
    }

    const rules = options?.dynamicFields
      ? [...this.defaultRules, ...normalizeRules(options.dynamicFields)]
      : this.defaultRules;
    const safeKeys = options?.safeKeys
      ? new Set([...this.defaultSafeKeys, ...options.safeKeys])
      : this.defaultSafeKeys;
    const workingStore = this.correlations.clone();
    const meta = extractMessageMeta(parsedExp.value, options?.direction);

    this.diffValue(
      parsedExp.value,
      parsedAct.value,
      [],
      [],
      rules,
      safeKeys,
      meta,
      workingStore,
      baseLocation,
      mismatches,
    );

    if (mismatches.length === 0 || commitOnMismatch) {
      this.correlations.replaceFrom(workingStore);
    }

    return {
      matched: mismatches.length === 0,
      mismatches,
      diagnosis: formatReplayDiagnosis(mismatches),
    };
  }

  private diffValue(
    expected: unknown,
    actual: unknown,
    segments: PathSegment[],
    displaySegments: DisplaySegment[],
    rules: NormalizedRule[],
    safeKeys: Set<string>,
    meta: MessageMeta,
    store: CorrelationStore,
    makeLocation: (path: string) => ReplayMismatchLocation,
    mismatches: ReplayMismatch[],
  ): void {
    const path = formatPath(displaySegments);
    const matchingRule = rules.find((rule) => ruleMatches(rule, segments, meta));

    if (matchingRule) {
      if (matchingRule.mode === 'ignore') {
        return;
      }
      const expType = valueType(expected);
      const actType = valueType(actual);
      if (expType !== actType) {
        mismatches.push({
          kind: 'type_mismatch',
          location: makeLocation(path),
          summary: `Expected ${expType}, got ${actType}`,
          detail: { expectedType: expType, actualType: actType, correlationGroup: matchingRule.correlateAs },
        });
        return;
      }
      if (expected === null && actual === null) {
        return;
      }
      if (!isCorrelatableId(expected) || !isCorrelatableId(actual)) {
        mismatches.push({
          kind: 'type_mismatch',
          location: makeLocation(path),
          summary: `Correlated field must be a string or number (got ${actType})`,
          detail: { expectedType: expType, actualType: actType, correlationGroup: matchingRule.correlateAs },
        });
        return;
      }
      const groupKey = resolveCorrelationKey(matchingRule, meta);
      if (!store.correlate(groupKey, expected, actual)) {
        mismatches.push({
          kind: 'id_correlation_mismatch',
          location: makeLocation(path),
          summary: `Correlated ID in group "${matchingRule.correlateAs}" conflicts with prior request or response`,
          detail: { expectedType: expType, actualType: actType, correlationGroup: matchingRule.correlateAs },
        });
      }
      return;
    }

    const isContainer = Array.isArray(expected) || isPlainObject(expected);
    if (
      (expected === actual && (!isContainer || !hasPotentialDescendantRule(rules, segments, meta))) ||
      (Number.isNaN(expected) && Number.isNaN(actual))
    ) {
      return;
    }

    const expType = valueType(expected);
    const actType = valueType(actual);
    if (expType !== actType) {
      mismatches.push({
        kind: 'type_mismatch',
        location: makeLocation(path),
        summary: `Expected ${expType}, got ${actType}`,
        detail: { expectedType: expType, actualType: actType },
      });
      return;
    }

    if (Array.isArray(expected) && Array.isArray(actual)) {
      const common = Math.min(expected.length, actual.length);
      for (let i = 0; i < common; i++) {
        this.diffValue(
          expected[i],
          actual[i],
          [...segments, i],
          [...displaySegments, i],
          rules,
          safeKeys,
          meta,
          store,
          makeLocation,
          mismatches,
        );
      }
      if (expected.length !== actual.length) {
        mismatches.push({
          kind: 'array_length_mismatch',
          location: makeLocation(path),
          summary: `Expected ${expected.length} item(s), got ${actual.length}`,
          detail: { expectedLength: expected.length, actualLength: actual.length },
        });
      }
      return;
    }

    if (isPlainObject(expected) && isPlainObject(actual)) {
      const expectedKeys = Object.keys(expected)
        .filter((key) => expected[key] !== undefined)
        .sort();
      for (let i = 0; i < expectedKeys.length; i++) {
        const key = expectedKeys[i];
        const nextSegments = [...segments, key];
        const nextDisplaySegments = [...displaySegments, toDisplayKeySegment(key, i, 'key', safeKeys)];
        const nextPath = formatPath(nextDisplaySegments);
        if (!Object.hasOwn(actual, key) || actual[key] === undefined) {
          mismatches.push({
            kind: 'missing_key',
            location: makeLocation(nextPath),
            summary: 'Missing expected key',
          });
          continue;
        }
        this.diffValue(
          expected[key],
          actual[key],
          nextSegments,
          nextDisplaySegments,
          rules,
          safeKeys,
          meta,
          store,
          makeLocation,
          mismatches,
        );
      }

      const extraKeys = Object.keys(actual)
        .filter((key) => actual[key] !== undefined && (!Object.hasOwn(expected, key) || expected[key] === undefined))
        .sort();
      for (let i = 0; i < extraKeys.length; i++) {
        const key = extraKeys[i];
        mismatches.push({
          kind: 'unexpected_key',
          location: makeLocation(
            formatPath([...displaySegments, toDisplayKeySegment(key, i, 'extra-key', safeKeys)]),
          ),
          summary: 'Unexpected key',
        });
      }
      return;
    }

    mismatches.push({
      kind: 'value_mismatch',
      location: makeLocation(path),
      summary: `Value differs (expected ${expType}, got ${actType})`,
      detail: { expectedType: expType, actualType: actType },
    });
  }
}

export function compareReplayMessages(
  expected: unknown,
  actual: unknown,
  options?: ReplayMatchOptions,
): ReplayMatchResult {
  return new ReplayMessageMatcher().matchMessage(expected, actual, options);
}

export function compareReplaySequence(
  expected: Array<ReplaySequenceMessage | unknown>,
  actual: Array<ReplaySequenceMessage | unknown>,
  options?: ReplayMatchOptions,
): ReplayMatchResult {
  return new ReplayMessageMatcher().matchSequence(expected, actual, options);
}
