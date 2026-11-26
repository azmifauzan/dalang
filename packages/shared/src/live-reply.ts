export interface LiveReplyParts {
  /** Progress text emitted before a JSON reply, or an empty string. */
  progress: string;
  /** Readable answer text decoded so far (plain Markdown or decoded JSON `answer` field). */
  answer: string;
}

interface JsonObjectScan {
  complete: boolean;
  foundAnswer: boolean;
  answer: string;
  endIndex: number;
}

const JSON_ESCAPES: Record<string, string> = { n: '\n', t: '\t', r: '', b: '', f: '' };
const JSON_PRIMITIVE_RE = /^(?:-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null)$/;
const INCOMPLETE_FENCE_AT_EOF_RE = /^(?:`{1,2}|```(?:j(?:s(?:o(?:n)?)?)?)?[ \t]*)$/i;
const FENCE_OPEN_RE = /^(`{3,})([^\r\n]*)$/;

function skipWs(text: string, i: number): number {
  while (i < text.length && /\s/.test(text[i])) i += 1;
  return i;
}

function decodeJsonString(
  text: string,
  contentStart: number,
): { value: string; closed: boolean; endIndex: number } {
  let out = '';
  let i = contentStart;
  while (i < text.length) {
    const ch = text[i];
    if (ch === '"') {
      return { value: out, closed: true, endIndex: i + 1 };
    }
    if (ch !== '\\') {
      out += ch;
      i += 1;
      continue;
    }
    const next = text[i + 1];
    if (next === undefined) break;
    if (next === 'u') {
      const hex = text.slice(i + 2, i + 6);
      if (!/^[0-9a-fA-F]{4}$/.test(hex)) break;
      out += String.fromCharCode(parseInt(hex, 16));
      i += 6;
      continue;
    }
    out += JSON_ESCAPES[next] ?? next;
    i += 2;
  }
  return { value: out, closed: false, endIndex: text.length };
}

function skipJsonString(text: string, quoteIndex: number): number | null {
  let i = quoteIndex + 1;
  while (i < text.length) {
    const ch = text[i];
    if (ch === '"') return i + 1;
    if (ch === '\\') {
      if (i + 1 >= text.length) return null;
      i += 2;
      continue;
    }
    i += 1;
  }
  return null;
}

/** Returns next index after value, `null` when truncated at EOF, or `-1` on invalid JSON syntax. */
function skipJsonValue(text: string, start: number): number | null {
  const first = text[start];
  if (first === '"') {
    return skipJsonString(text, start);
  }
  if (first === '{' || first === '[') {
    let depth = 0;
    let i = start;
    while (i < text.length) {
      const ch = text[i];
      if (ch === '"') {
        const next = skipJsonString(text, i);
        if (next === null) return null;
        i = next;
        continue;
      }
      if (ch === '{' || ch === '[') depth += 1;
      else if (ch === '}' || ch === ']') {
        depth -= 1;
        if (depth === 0) return i + 1;
      }
      i += 1;
    }
    return null;
  }
  let i = start;
  while (i < text.length && !/[\s,}\]]/.test(text[i])) i += 1;
  if (i === text.length) return null;
  const token = text.slice(start, i);
  return JSON_PRIMITIVE_RE.test(token) ? i : -1;
}

function scanJsonReplyObject(text: string, braceIndex: number): JsonObjectScan | null {
  if (text[braceIndex] !== '{') return null;
  let i = skipWs(text, braceIndex + 1);
  let foundAnswer = false;
  let answer = '';
  let expectCommaOrEnd = false;

  while (i < text.length) {
    if (text[i] === '}') {
      return { complete: true, foundAnswer, answer, endIndex: i + 1 };
    }
    if (expectCommaOrEnd) {
      if (text[i] !== ',') return null;
      i = skipWs(text, i + 1);
      if (i >= text.length) break;
    }
    if (text[i] !== '"') return null;
    const keyRes = decodeJsonString(text, i + 1);
    if (!keyRes.closed) {
      return { complete: false, foundAnswer, answer, endIndex: text.length };
    }
    i = skipWs(text, keyRes.endIndex);
    if (i >= text.length) break;
    if (text[i] !== ':') return null;
    i = skipWs(text, i + 1);
    if (i >= text.length) break;

    if (keyRes.value === 'answer' && text[i] === '"' && !foundAnswer) {
      const valRes = decodeJsonString(text, i + 1);
      foundAnswer = true;
      answer = valRes.value;
      if (!valRes.closed) {
        return { complete: false, foundAnswer: true, answer, endIndex: text.length };
      }
      i = skipWs(text, valRes.endIndex);
    } else {
      const next = skipJsonValue(text, i);
      if (next === -1) return null;
      if (next === null) {
        return { complete: false, foundAnswer, answer, endIndex: text.length };
      }
      i = skipWs(text, next);
    }
    expectCommaOrEnd = true;
  }

  return { complete: false, foundAnswer, answer, endIndex: text.length };
}

function findClosingFenceLineEnd(raw: string, searchFrom: number, fenceLen: number): number | null {
  let pos = searchFrom;
  while (pos <= raw.length) {
    const nl = raw.indexOf('\n', pos);
    const lineEnd = nl === -1 ? raw.length : nl;
    let indentEnd = pos;
    while (indentEnd < lineEnd && (raw[indentEnd] === ' ' || raw[indentEnd] === '\t')) indentEnd += 1;
    let ticks = 0;
    while (indentEnd + ticks < lineEnd && raw[indentEnd + ticks] === '`') ticks += 1;
    if (ticks >= fenceLen) {
      const tail = raw.slice(indentEnd + ticks, lineEnd).trim();
      if (tail === '') return nl === -1 ? raw.length : nl + 1;
    }
    if (nl === -1) break;
    pos = nl + 1;
  }
  return null;
}

function findClosingInlineTicks(raw: string, start: number, lineEnd: number, tickCount: number): number | null {
  let i = start;
  while (i < lineEnd) {
    if (raw[i] === '`') {
      let run = 0;
      while (i + run < lineEnd && raw[i + run] === '`') run += 1;
      if (run === tickCount) return i + run;
      i += run;
      continue;
    }
    i += 1;
  }
  return null;
}

/**
 * Splits a streaming reply into `progress` (any text emitted before a JSON contract) and `answer`
 * (plain Markdown as-is, or the decoded `answer` string from a plain or fenced JSON contract).
 */
export function parseLiveReply(raw: string): LiveReplyParts {
  let lineStart = 0;
  while (lineStart < raw.length) {
    const nl = raw.indexOf('\n', lineStart);
    const lineEnd = nl === -1 ? raw.length : nl;
    const rawLineEnd = lineEnd > lineStart && raw[lineEnd - 1] === '\r' ? lineEnd - 1 : lineEnd;

    let indentEnd = lineStart;
    while (indentEnd < rawLineEnd && (raw[indentEnd] === ' ' || raw[indentEnd] === '\t')) {
      indentEnd += 1;
    }

    if (raw[indentEnd] === '`') {
      const lineContent = raw.slice(indentEnd, rawLineEnd);
      if (lineEnd === raw.length && INCOMPLETE_FENCE_AT_EOF_RE.test(lineContent)) {
        return { progress: raw.slice(0, lineStart).trim(), answer: '' };
      }

      const fenceMatch = FENCE_OPEN_RE.exec(lineContent);
      if (fenceMatch) {
        const fenceLen = fenceMatch[1].length;
        const afterTicks = indentEnd + fenceLen;
        const afterLine = nl === -1 ? raw.length : nl + 1;
        const fenceTag = fenceMatch[2].trim();
        const isJsonTag = /^json(?=$|[\s{])/i.test(fenceTag);

        if (isJsonTag || fenceTag === '' || fenceTag.startsWith('{')) {
          const contentStart = isJsonTag
            ? skipWs(raw, afterTicks + fenceMatch[2].search(/json/i) + 4)
            : fenceTag === ''
              ? skipWs(raw, afterLine)
              : skipWs(raw, afterTicks);

          if (contentStart >= raw.length) {
            return { progress: raw.slice(0, lineStart).trim(), answer: '' };
          }
          if (raw[contentStart] === '{') {
            const scan = scanJsonReplyObject(raw, contentStart);
            if (scan && (!scan.complete || scan.foundAnswer)) {
              return { progress: raw.slice(0, lineStart).trim(), answer: scan.answer };
            }
          }
        }

        const closedAt = findClosingFenceLineEnd(raw, afterLine, fenceLen);
        if (closedAt === null) {
          return { progress: '', answer: raw };
        }
        lineStart = closedAt;
        continue;
      }
    }

    if (raw[indentEnd] === '{') {
      const scan = scanJsonReplyObject(raw, indentEnd);
      if (scan) {
        if (!scan.complete || scan.foundAnswer) {
          return { progress: raw.slice(0, lineStart).trim(), answer: scan.answer };
        }
        if (scan.endIndex > rawLineEnd) {
          const nextNl = raw.indexOf('\n', scan.endIndex);
          if (nextNl === -1) break;
          lineStart = nextNl + 1;
          continue;
        }
      }
    }

    let i = indentEnd;
    let jumpedToNextLine = false;
    while (i < rawLineEnd) {
      if (raw[i] === '`') {
        let ticks = 0;
        while (i + ticks < rawLineEnd && raw[i + ticks] === '`') ticks += 1;
        const closed = findClosingInlineTicks(raw, i + ticks, rawLineEnd, ticks);
        if (closed === null) break;
        i = closed;
        continue;
      }
      if (raw[i] === '{') {
        const afterBrace = skipWs(raw, i + 1);
        const looksLikeJsonStart =
          raw[afterBrace] === '"' || (afterBrace >= raw.length && (i === 0 || /\s/.test(raw[i - 1])));
        if (looksLikeJsonStart) {
          const scan = scanJsonReplyObject(raw, i);
          if (scan) {
            if (!scan.complete || scan.foundAnswer) {
              return { progress: raw.slice(0, i).trim(), answer: scan.answer };
            }
            if (scan.endIndex > rawLineEnd) {
              const nextNl = raw.indexOf('\n', scan.endIndex);
              if (nextNl === -1) return { progress: '', answer: raw };
              lineStart = nextNl + 1;
              jumpedToNextLine = true;
              break;
            }
            i = scan.endIndex;
            continue;
          }
        }
      }
      i += 1;
    }

    if (jumpedToNextLine) continue;
    if (nl === -1) break;
    lineStart = nl + 1;
  }

  return { progress: '', answer: raw };
}

/**
 * The readable answer part of an Ask/Auto reply that is still being written.
 */
export function liveReplyText(raw: string): string {
  return parseLiveReply(raw).answer;
}
