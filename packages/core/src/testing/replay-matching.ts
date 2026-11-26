export type MessageDirection = 'stdin' | 'stdout' | 'request' | 'response' | 'notification';

export type DynamicFieldMode = 'correlate' | 'ignore';

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
  /** Optional message direction for sequence diagnostics and `when` rule filtering. */
  direction?: MessageDirection;
  /** Optional zero-based message index for diagnostics. */
  messageIndex?: number;
}

export interface ReplaySequenceMessage {
  direction?: MessageDirection;
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
  /** Structural diagnosis without raw payload values. */
  summary: string;
  detail?: ReplayMismatchDetail;
}

export interface ReplayMatchResult {
  matched: boolean;
  mismatches: ReplayMismatch[];
  /** Human-readable diagnosis showing mismatch locations without raw payloads. */
  diagnosis: string;
}

export type ParsedJsonLine =
  | { ok: true; value: unknown }
  | { ok: false; lineIndex: number };

type PathSegment = string | number;
type RuleSegment = string | number | '*';

interface NormalizedRule {
  segments: RuleSegment[];
  mode: DynamicFieldMode;
  correlateAs: string;
  when?: DynamicFieldRule['when'];
}

interface MessageMeta {
  method?: string;
  type?: string;
  direction?: MessageDirection;
}

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

  correlate(group: string, expected: string | number, actual: string | number): boolean {
    const expKey = scalarKey(expected);
    const actKey = scalarKey(actual);
    let expMap = this.expectedToActual.get(group);
    let actMap = this.actualToExpected.get(group);

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
      this.expectedToActual.set(group, expMap);
    }
    if (!actMap) {
      actMap = new Map();
      this.actualToExpected.set(group, actMap);
    }
    expMap.set(expKey, actKey);
    actMap.set(actKey, expKey);
    return true;
  }
}

function scalarKey(value: string | number): string {
  return typeof value === 'number' ? `n:${Object.is(value, -0) ? 0 : value}` : `s:${value}`;
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
      when: rule.when,
    };
  });
}

function formatPath(segments: PathSegment[]): string {
  if (segments.length === 0) return '(root)';
  let out = '';
  for (const seg of segments) {
    if (typeof seg === 'number') {
      out += `[${seg}]`;
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

function extractMessageMeta(value: unknown, direction?: MessageDirection): MessageMeta {
  if (!isPlainObject(value)) return { direction };
  return {
    method: typeof value.method === 'string' ? value.method : undefined,
    type: typeof value.type === 'string' ? value.type : undefined,
    direction,
  };
}

function ruleMatches(rule: NormalizedRule, segments: PathSegment[], meta: MessageMeta): boolean {
  if (rule.when) {
    if (rule.when.method !== undefined && rule.when.method !== meta.method) return false;
    if (rule.when.type !== undefined && rule.when.type !== meta.type) return false;
    if (rule.when.direction !== undefined && rule.when.direction !== meta.direction) return false;
  }
  if (rule.segments.length === 0 || rule.segments.length !== segments.length) return false;
  for (let i = 0; i < rule.segments.length; i++) {
    const pattern = rule.segments[i];
    const actual = segments[i];
    if (pattern === '*') {
      if (typeof actual !== 'number') return false;
      continue;
    }
    if (pattern !== actual) return false;
  }
  return true;
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
  return isPlainObject(entry) && Object.hasOwn(entry, 'payload') && (
    entry.direction === undefined || typeof entry.direction === 'string'
  );
}

function toSequenceMessage(entry: unknown): ReplaySequenceMessage {
  return isSequenceMessage(entry) ? entry : { payload: entry };
}

/**
 * Stateful comparator for interactive replay messages (stream-json, Codex app-server, Antigravity ACP).
 * Only explicitly named dynamic fields are mapped or correlated; all other fields, including nested
 * prompts, steering text, and permission decisions, are compared strictly.
 */
export class ReplayMessageMatcher {
  private readonly defaultRules: NormalizedRule[];
  private readonly correlations = new CorrelationStore();

  constructor(options: { dynamicFields?: Array<string | DynamicFieldRule> } = {}) {
    this.defaultRules = normalizeRules(options.dynamicFields);
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
    const workingStore = this.correlations.clone();
    const meta = extractMessageMeta(parsedExp.value, options?.direction);

    this.diffValue(
      parsedExp.value,
      parsedAct.value,
      [],
      rules,
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
    rules: NormalizedRule[],
    meta: MessageMeta,
    store: CorrelationStore,
    makeLocation: (path: string) => ReplayMismatchLocation,
    mismatches: ReplayMismatch[],
  ): void {
    const path = formatPath(segments);
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
      if (!store.correlate(matchingRule.correlateAs, expected, actual)) {
        mismatches.push({
          kind: 'id_correlation_mismatch',
          location: makeLocation(path),
          summary: `Correlated ID in group "${matchingRule.correlateAs}" conflicts with prior request or response`,
          detail: { expectedType: expType, actualType: actType, correlationGroup: matchingRule.correlateAs },
        });
      }
      return;
    }

    if (expected === actual || (Number.isNaN(expected) && Number.isNaN(actual))) {
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
        this.diffValue(expected[i], actual[i], [...segments, i], rules, meta, store, makeLocation, mismatches);
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
      for (const key of Object.keys(expected)) {
        const expVal = expected[key];
        if (expVal === undefined) continue;
        const nextSegments = [...segments, key];
        const nextPath = formatPath(nextSegments);
        if (!Object.hasOwn(actual, key) || actual[key] === undefined) {
          mismatches.push({
            kind: 'missing_key',
            location: makeLocation(nextPath),
            summary: `Missing expected key`,
          });
          continue;
        }
        this.diffValue(expVal, actual[key], nextSegments, rules, meta, store, makeLocation, mismatches);
      }

      for (const key of Object.keys(actual)) {
        if (actual[key] === undefined) continue;
        if (!Object.hasOwn(expected, key) || expected[key] === undefined) {
          mismatches.push({
            kind: 'unexpected_key',
            location: makeLocation(formatPath([...segments, key])),
            summary: `Unexpected key`,
          });
        }
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
