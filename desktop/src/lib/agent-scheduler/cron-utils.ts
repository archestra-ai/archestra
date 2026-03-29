/**
 * Cron parsing and next-run computation utilities for the "agent-scheduler" module.
 *
 * Supported syntax: standard 5-field POSIX cron (minute hour dom month dow).
 */

// ---------------------------------------------------------------------------
// Field definitions
// ---------------------------------------------------------------------------

interface FieldDef {
  min: number;
  max: number;
  name: string;
}

const FIELDS: FieldDef[] = [
  { min: 0, max: 59, name: "minute" },
  { min: 0, max: 23, name: "hour" },
  { min: 1, max: 31, name: "day-of-month" },
  { min: 1, max: 12, name: "month" },
  { min: 0, max: 6,  name: "day-of-week" },
];

// ---------------------------------------------------------------------------
// Field parser
// ---------------------------------------------------------------------------

/**
 * Expand a single cron field token into the set of matching integers within
 * [fieldMin, fieldMax].
 *
 * Returns `null` when the token contains a non-numeric value, a value outside
 * [fieldMin, fieldMax], an invalid step/range, or any other malformed syntax.
 * This prevents NaN from entering value sets and avoids incorrect validation
 * results or non-terminating behavior in getNextCronDate.
 */
function parseField(
  token: string,
  fieldMin: number,
  fieldMax: number
): Set<number> | null {
  const values = new Set<number>();

  for (const part of token.split(",")) {
    // Wildcard
    if (part === "*") {
      for (let v = fieldMin; v <= fieldMax; v++) values.add(v);
      continue;
    }

    // Step: */step  or  start/step  or  start-end/step
    const stepMatch = part.match(/^(\*|\d+(?:-\d+)?)\/(\d+)$/);
    if (stepMatch) {
      const stepVal = parseInt(stepMatch[2], 10);
      // Reject NaN, zero, or negative step values
      if (isNaN(stepVal) || stepVal <= 0) return null;

      let rangeMin = fieldMin;
      let rangeMax = fieldMax;

      if (stepMatch[1] !== "*") {
        const dashParts = stepMatch[1].split("-");
        if (dashParts.length === 2) {
          rangeMin = parseInt(dashParts[0], 10);
          rangeMax = parseInt(dashParts[1], 10);
        } else {
          rangeMin = parseInt(stepMatch[1], 10);
          rangeMax = fieldMax;
        }

        if (
          isNaN(rangeMin) ||
          isNaN(rangeMax) ||
          rangeMin < fieldMin ||
          rangeMax > fieldMax ||
          rangeMin > rangeMax
        ) {
          return null;
        }
      }

      for (let v = rangeMin; v <= rangeMax; v += stepVal) values.add(v);
      continue;
    }

    // Range: start-end
    const rangeMatch = part.match(/^(\d+)-(\d+)$/);
    if (rangeMatch) {
      const lo = parseInt(rangeMatch[1], 10);
      const hi = parseInt(rangeMatch[2], 10);

      // Reject NaN and out-of-range bounds
      if (
        isNaN(lo) ||
        isNaN(hi) ||
        lo < fieldMin ||
        hi > fieldMax ||
        lo > hi
      ) {
        return null;
      }

      for (let v = lo; v <= hi; v++) values.add(v);
      continue;
    }

    // Single integer value — must be purely numeric and within range
    if (!/^\d+$/.test(part)) return null;
    const num = parseInt(part, 10);

    if (isNaN(num) || num < fieldMin || num > fieldMax) return null;
    values.add(num);
  }

  // An empty set means no values matched (e.g. empty string after split)
  if (values.size === 0) return null;
  return values;
}

// ---------------------------------------------------------------------------
// Cron expression parser
// ---------------------------------------------------------------------------

export interface ParsedCron {
  minutes: Set<number>;
  hours: Set<number>;
  daysOfMonth: Set<number>;
  months: Set<number>;
  daysOfWeek: Set<number>;
}

/**
 * Parse a 5-field cron expression into its constituent value sets.
 *
 * Returns `null` for any malformed, non-numeric, or out-of-range expression so
 * that callers can reject invalid triggers before persisting them.
 */
export function parseCronExpression(expr: string): ParsedCron | null {
  const fields = expr.trim().split(/\s+/);
  if (fields.length !== 5) return null;

  const results: Set<number>[] = [];
  for (let i = 0; i < 5; i++) {
    const parsed = parseField(fields[i], FIELDS[i].min, FIELDS[i].max);
    if (parsed === null) return null;
    results.push(parsed);
  }

  return {
    minutes: results[0],
    hours: results[1],
    daysOfMonth: results[2],
    months: results[3],
    daysOfWeek: results[4],
  };
}

// ---------------------------------------------------------------------------
// Next-run computation
// ---------------------------------------------------------------------------

/**
 * Compute the next Date at which a cron expression fires after `after`.
 *
 * Returns `null` when:
 *  - the expression cannot be parsed (invalid syntax / out-of-range values), OR
 *  - no matching time exists within a 4-year look-ahead window.
 *
 * Callers must treat `null` as an invalid/unsatisfiable trigger and must not
 * schedule or persist it.
 */
export function getNextCronDate(expr: string, after: Date = new Date()): Date | null {
  const parsed = parseCronExpression(expr);
  if (!parsed) return null;

  const { minutes, hours, daysOfMonth, months, daysOfWeek } = parsed;

  // Start one minute after `after` to avoid re-firing at the current minute.
  const cursor = new Date(after);
  cursor.setSeconds(0, 0);
  cursor.setMinutes(cursor.getMinutes() + 1);

  const limitDate = new Date(after);
  limitDate.setFullYear(limitDate.getFullYear() + 4);

  while (cursor < limitDate) {
    // Month check (cron: 1-based; JS Date: 0-based)
    if (!months.has(cursor.getMonth() + 1)) {
      cursor.setDate(1);
      cursor.setHours(0, 0, 0, 0);
      cursor.setMonth(cursor.getMonth() + 1);
      continue;
    }

    // Day-of-month and day-of-week check
    if (!daysOfMonth.has(cursor.getDate()) || !daysOfWeek.has(cursor.getDay())) {
      cursor.setDate(cursor.getDate() + 1);
      cursor.setHours(0, 0, 0, 0);
      continue;
    }

    // Hour check
    if (!hours.has(cursor.getHours())) {
      cursor.setHours(cursor.getHours() + 1, 0, 0, 0);
      continue;
    }

    // Minute check
    if (!minutes.has(cursor.getMinutes())) {
      cursor.setMinutes(cursor.getMinutes() + 1, 0, 0);
      continue;
    }

    return new Date(cursor);
  }

  // No matching time within look-ahead — return null, not the limit date.
  return null;
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/**
 * Validate a 5-field cron expression string.
 *
 * Returns `{ valid: true }` on success, or `{ valid: false; error: string }`
 * with a human-readable description of the problem on failure.
 *
 * Because parseField now rejects NaN and out-of-range values, this function
 * will correctly report malformed expressions as invalid rather than silently
 * accepting them.
 */
export function validateCronExpression(
  expr: string
): { valid: true } | { valid: false; error: string } {
  const fields = expr.trim().split(/\s+/);
  if (fields.length !== 5) {
    return {
      valid: false,
      error: `Expected 5 cron fields (minute hour dom month dow), got ${fields.length}.`,
    };
  }

  for (let i = 0; i < 5; i++) {
    const result = parseField(fields[i], FIELDS[i].min, FIELDS[i].max);
    if (result === null) {
      return {
        valid: false,
        error:
          `Invalid ${FIELDS[i].name} field "${fields[i]}". ` +
          `Allowed range: [${FIELDS[i].min}–${FIELDS[i].max}].`,
      };
    }
  }

  return { valid: true };
}
