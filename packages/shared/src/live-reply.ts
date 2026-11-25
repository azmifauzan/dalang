/**
 * The readable part of an Ask reply that is still being written. A reply may be plain text or the
 * JSON contract `{"answer": "...", ...}`; for JSON, the `answer` string decoded so far is returned,
 * and an empty string until that field starts.
 */
export function liveReplyText(raw: string): string {
  const text = raw.trimStart();
  if (!text.startsWith('{')) return raw;
  const start = /"answer"\s*:\s*"/.exec(text);
  if (!start) return '';
  let out = '';
  for (let i = start.index + start[0].length; i < text.length; i++) {
    const ch = text[i];
    if (ch === '"') break;
    if (ch !== '\\') {
      out += ch;
      continue;
    }
    const next = text[i + 1];
    if (next === undefined) break;
    if (next === 'u') {
      const hex = text.slice(i + 2, i + 6);
      if (!/^[0-9a-fA-F]{4}$/.test(hex)) break;
      out += String.fromCharCode(parseInt(hex, 16));
      i += 5;
      continue;
    }
    out += ({ n: '\n', t: '\t', r: '', b: '', f: '' } as Record<string, string>)[next] ?? next;
    i += 1;
  }
  return out;
}
