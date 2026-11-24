/**
 * Zero-dependency 5-field cron expression parser and next-run calculator (local machine time).
 * Supports standard syntax: `minute hour day-of-month month day-of-week`
 * plus `@hourly`, `@daily`, `@midnight`, `@weekly`, `@monthly`.
 * - Ranges (`a-b`), steps (`*\/n`, `a-b/n`, `a/n`), comma lists (`a,b,c`)
 * - Month names (`JAN`–`DEC`), weekday names (`SUN`–`SAT`), and `0` or `7` for Sunday.
 */

export interface ParsedCron {
  raw: string;
  minutes: Set<number>;
  hours: Set<number>;
  daysOfMonth: Set<number>;
  months: Set<number>;
  daysOfWeek: Set<number>;
  domWildcard: boolean;
  dowWildcard: boolean;
}

const CRON_MACROS: Record<string, string> = {
  '@hourly': '0 * * * *',
  '@daily': '0 0 * * *',
  '@midnight': '0 0 * * *',
  '@weekly': '0 0 * * 0',
  '@monthly': '0 0 1 * *',
};

const MONTH_NAMES: Record<string, number> = {
  jan: 1,
  feb: 2,
  mar: 3,
  apr: 4,
  may: 5,
  jun: 6,
  jul: 7,
  aug: 8,
  sep: 9,
  oct: 10,
  nov: 11,
  dec: 12,
};

const DOW_NAMES: Record<string, number> = {
  sun: 0,
  mon: 1,
  tue: 2,
  wed: 3,
  thu: 4,
  fri: 5,
  sat: 6,
};

function parseAtom(
  token: string,
  min: number,
  max: number,
  names?: Record<string, number>,
  allowSevenAsZero = false,
): number {
  const lower = token.trim().toLowerCase();
  if (names && Object.prototype.hasOwnProperty.call(names, lower)) {
    return names[lower];
  }
  if (!/^\d+$/.test(lower)) {
    throw new Error(`Invalid cron value "${token}"`);
  }
  const n = Number(lower);
  if (allowSevenAsZero && n === 7) return 0;
  if (!Number.isInteger(n) || n < min || n > max) {
    throw new Error(`Cron value "${token}" is out of range (${min}-${max})`);
  }
  return n;
}

function parseField(
  field: string,
  min: number,
  max: number,
  label: string,
  names?: Record<string, number>,
  allowSevenAsZero = false,
): { values: Set<number>; wildcard: boolean } {
  const trimmed = field.trim();
  if (!trimmed) {
    throw new Error(`Empty cron ${label} field`);
  }
  const values = new Set<number>();
  const wildcard = trimmed === '*';

  for (const part of trimmed.split(',')) {
    const piece = part.trim();
    if (!piece) {
      throw new Error(`Invalid empty list entry in cron ${label} field "${field}"`);
    }
    const stepParts = piece.split('/');
    if (stepParts.length > 2) {
      throw new Error(`Invalid step syntax "${piece}" in cron ${label} field`);
    }
    const base = stepParts[0];
    let step = 1;
    if (stepParts.length === 2) {
      if (!/^\d+$/.test(stepParts[1])) {
        throw new Error(`Invalid step "${stepParts[1]}" in cron ${label} field`);
      }
      step = Number(stepParts[1]);
      if (!Number.isInteger(step) || step <= 0) {
        throw new Error(`Cron step must be positive in "${piece}"`);
      }
    }

    if (base === '*') {
      for (let v = min; v <= max; v += step) {
        values.add(v);
      }
      continue;
    }

    if (base.includes('-')) {
      const rangeParts = base.split('-');
      if (rangeParts.length !== 2) {
        throw new Error(`Invalid range "${base}" in cron ${label} field`);
      }
      let start = parseAtom(rangeParts[0], min, max, names, allowSevenAsZero);
      let end = parseAtom(rangeParts[1], min, max, names, allowSevenAsZero);
      // Support SUN-SAT / MON-SUN where 7 was normalized to 0 at range end.
      if (allowSevenAsZero && rangeParts[1].trim() === '7' && end === 0) {
        end = 7;
      }
      if (start > end) {
        throw new Error(`Cron range start (${start}) exceeds end (${end}) in "${piece}"`);
      }
      for (let v = start; v <= end; v += step) {
        values.add(allowSevenAsZero && v === 7 ? 0 : v);
      }
      continue;
    }

    const single = parseAtom(base, min, max, names, allowSevenAsZero);
    if (stepParts.length === 2) {
      for (let v = single; v <= max; v += step) {
        values.add(allowSevenAsZero && v === 7 ? 0 : v);
      }
    } else {
      values.add(single);
    }
  }

  if (values.size === 0) {
    throw new Error(`Cron ${label} field "${field}" matched no values`);
  }

  return { values, wildcard };
}

export function parseCronExpression(expression: string): ParsedCron {
  const trimmed = expression.trim();
  if (!trimmed) {
    throw new Error('Cron expression cannot be empty.');
  }
  const expanded = CRON_MACROS[trimmed.toLowerCase()] ?? trimmed;
  const fields = expanded.split(/\s+/);
  if (fields.length !== 5) {
    throw new Error(
      `Cron expression must have 5 fields (minute hour day-of-month month day-of-week), got ${fields.length}: "${expression}"`,
    );
  }

  const minute = parseField(fields[0], 0, 59, 'minute');
  const hour = parseField(fields[1], 0, 23, 'hour');
  const dom = parseField(fields[2], 1, 31, 'day-of-month');
  const month = parseField(fields[3], 1, 12, 'month', MONTH_NAMES);
  const dow = parseField(fields[4], 0, 7, 'day-of-week', DOW_NAMES, true);

  return {
    raw: trimmed,
    minutes: minute.values,
    hours: hour.values,
    daysOfMonth: dom.values,
    months: month.values,
    daysOfWeek: dow.values,
    domWildcard: dom.wildcard,
    dowWildcard: dow.wildcard,
  };
}

export function validateCronExpression(expression: string): { ok: true; parsed: ParsedCron } | { ok: false; error: string } {
  try {
    return { ok: true, parsed: parseCronExpression(expression) };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export function matchesCronDate(parsed: ParsedCron, date: Date): boolean {
  if (!parsed.months.has(date.getMonth() + 1)) return false;
  if (!parsed.hours.has(date.getHours())) return false;
  if (!parsed.minutes.has(date.getMinutes())) return false;

  const domMatch = parsed.daysOfMonth.has(date.getDate());
  const dowMatch = parsed.daysOfWeek.has(date.getDay());

  // Standard Vixie cron semantics: when both DOM and DOW are restricted, either matching fires.
  if (!parsed.domWildcard && !parsed.dowWildcard) {
    return domMatch || dowMatch;
  }
  return domMatch && dowMatch;
}

/**
 * Computes the next local-time Date strictly after `after` matching `expression`.
 * Searches up to 4 years forward (handles Feb 29 schedules).
 */
export function getNextCronRun(expression: string | ParsedCron, after: Date = new Date()): Date {
  const parsed = typeof expression === 'string' ? parseCronExpression(expression) : expression;
  const cursor = new Date(after.getTime());
  cursor.setSeconds(0, 0);
  cursor.setMinutes(cursor.getMinutes() + 1);

  const maxYear = cursor.getFullYear() + 4;
  while (cursor.getFullYear() <= maxYear) {
    const month = cursor.getMonth() + 1;
    if (!parsed.months.has(month)) {
      cursor.setMonth(cursor.getMonth() + 1, 1);
      cursor.setHours(0, 0, 0, 0);
      continue;
    }

    const domMatch = parsed.daysOfMonth.has(cursor.getDate());
    const dowMatch = parsed.daysOfWeek.has(cursor.getDay());
    const dayMatches =
      !parsed.domWildcard && !parsed.dowWildcard ? domMatch || dowMatch : domMatch && dowMatch;
    if (!dayMatches) {
      cursor.setDate(cursor.getDate() + 1);
      cursor.setHours(0, 0, 0, 0);
      continue;
    }

    if (!parsed.hours.has(cursor.getHours())) {
      cursor.setHours(cursor.getHours() + 1, 0, 0, 0);
      continue;
    }

    if (!parsed.minutes.has(cursor.getMinutes())) {
      cursor.setMinutes(cursor.getMinutes() + 1, 0, 0);
      continue;
    }

    return new Date(cursor.getTime());
  }

  throw new Error(`Cron expression "${parsed.raw}" has no matching date within the next 4 years.`);
}
