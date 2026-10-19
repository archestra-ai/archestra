import {
  type AnyValue,
  type LogAttributes,
  type LogRecord,
  SeverityNumber,
} from "@opentelemetry/api-logs";
import pino from "pino";

/**
 * Convert a parsed pino JSON record into an OTEL log record.
 *
 * Mirrors `@opentelemetry/instrumentation-pino`'s `OTelPinoStream`:
 * - Strips redundant fields (hostname, pid, trace context injected by mixin)
 * - Maps pino levels to OTEL severity numbers
 *
 * Unlike it, attributes are bounded. Log backends store every attribute as
 * indexed metadata with tight limits (Loki defaults to 128 entries and 64KB
 * per line, counting each nested leaf as one entry), and a record over them is
 * rejected outright. So error stacks move into the body, and the remaining
 * attributes are capped in depth, per-value length, leaf count, and total size.
 */
export function toOtelLogRecord(record: Record<string, unknown>): LogRecord {
  const {
    time,
    msg,
    level,
    // Strip fields redundant with OTEL resource attributes
    hostname: _hostname,
    pid: _pid,
    // Strip trace context fields added by mixin (redundant — the OTEL SDK
    // captures the active span context automatically via `context.active()`)
    trace_id: _traceId,
    span_id: _spanId,
    trace_flags: _traceFlags,
    ...rest
  } = record;
  const { attributes, stacks } = extractErrorStacks(rest);

  const timestamp = millisToHrTime(
    typeof time === "number" ? time : Date.now(),
  );
  const pinoLevel = typeof level === "number" ? level : 30;

  return {
    timestamp,
    observedTimestamp: timestamp,
    severityNumber: PINO_TO_OTEL_SEVERITY[pinoLevel] ?? SeverityNumber.INFO,
    severityText: pino.levels.labels[pinoLevel] ?? "INFO",
    body: buildBody(msg, stacks),
    attributes: boundAttributes(attributes),
  };
}

// === Internal ===

/** Leaf attributes kept per record — half of Loki's default entry limit,
 * leaving room for the resource attributes it stores alongside. */
const MAX_ATTRIBUTE_ENTRIES = 64;
/** Total attribute size per record — half of Loki's default 64KB. */
const MAX_ATTRIBUTE_BYTES = 32 * 1024;
const MAX_ATTRIBUTE_VALUE_LENGTH = 2_048;
/** Nesting kept as structure; deeper subtrees become one JSON string. */
const MAX_ATTRIBUTE_DEPTH = 3;
const MAX_STACK_LENGTH = 16 * 1024;
/** Fields the logger's error serializer writes (see `create-logger.ts`). */
const ERROR_KEYS = ["err", "error"];
/**
 * The OTEL Logs API exposes no dropped-attribute count on emit, and the
 * semantic-convention registry has no attribute for it, hence a custom name.
 */
const DROPPED_ATTRIBUTES_KEY = "archestra.log.dropped_attributes_count";
const TRUNCATED_SUFFIX = "…[truncated]";

type AttributeBudget = { entries: number; bytes: number; dropped: number };

/** Pull serialized error stacks out of the attributes so they can ride in the
 * body, which log backends store as the line itself rather than metadata. */
function extractErrorStacks(attributes: Record<string, unknown>): {
  attributes: Record<string, unknown>;
  stacks: string[];
} {
  const stacks: string[] = [];
  const result = { ...attributes };
  for (const key of ERROR_KEYS) {
    const value = result[key];
    if (!isPlainObject(value) || typeof value.stack !== "string") continue;
    const { stack, ...withoutStack } = value;
    stacks.push(truncate(stack, MAX_STACK_LENGTH));
    result[key] = withoutStack;
  }
  return { attributes: result, stacks };
}

function buildBody(msg: unknown, stacks: string[]): AnyValue {
  if (stacks.length === 0) return msg as AnyValue;
  return [msg, ...stacks]
    .filter((part) => typeof part === "string" && part.length > 0)
    .join("\n");
}

function boundAttributes(attributes: Record<string, unknown>): LogAttributes {
  const budget: AttributeBudget = { entries: 0, bytes: 0, dropped: 0 };
  const result: LogAttributes = {};
  // Error fields first so they are the last to be dropped.
  const keys = [
    ...ERROR_KEYS.filter((key) => key in attributes),
    ...Object.keys(attributes).filter((key) => !ERROR_KEYS.includes(key)),
  ];
  for (const key of keys) {
    const value = boundValue({
      value: attributes[key],
      keyBytes: byteLength(key),
      depth: 1,
      budget,
    });
    if (value !== undefined) result[key] = value;
  }
  if (budget.dropped > 0) result[DROPPED_ATTRIBUTES_KEY] = budget.dropped;
  return result;
}

/**
 * Bound one attribute value, charging its leaves to the shared budget.
 * Returns `undefined` when the value is dropped. `keyBytes` is the length of
 * the full flattened key path, which backends store with every leaf.
 */
function boundValue({
  value,
  keyBytes,
  depth,
  budget,
}: {
  value: unknown;
  keyBytes: number;
  depth: number;
  budget: AttributeBudget;
}): AnyValue | undefined {
  if (isPlainObject(value) && depth < MAX_ATTRIBUTE_DEPTH) {
    const entries = Object.entries(value);
    const result: Record<string, AnyValue> = {};
    for (const [key, child] of entries) {
      const bounded = boundValue({
        value: child,
        keyBytes: keyBytes + 1 + byteLength(key),
        depth: depth + 1,
        budget,
      });
      if (bounded !== undefined) result[key] = bounded;
    }
    return entries.length > 0 && Object.keys(result).length === 0
      ? undefined
      : result;
  }

  const leaf =
    typeof value === "string"
      ? truncate(value, MAX_ATTRIBUTE_VALUE_LENGTH)
      : typeof value === "object" && value !== null
        ? boundJson(value)
        : value;
  const cost =
    keyBytes + byteLength(typeof leaf === "string" ? leaf : String(leaf));
  if (
    budget.entries + 1 > MAX_ATTRIBUTE_ENTRIES ||
    budget.bytes + cost > MAX_ATTRIBUTE_BYTES
  ) {
    budget.dropped++;
    return undefined;
  }
  budget.entries++;
  budget.bytes += cost;
  return leaf as AnyValue;
}

/** Arrays and too-deep objects are stored as a single JSON leaf. Small arrays
 * keep their type; anything over the value limit becomes a truncated string. */
function boundJson(value: object): AnyValue {
  const json = JSON.stringify(value);
  if (Array.isArray(value) && json.length <= MAX_ATTRIBUTE_VALUE_LENGTH) {
    return value as AnyValue;
  }
  return truncate(json, MAX_ATTRIBUTE_VALUE_LENGTH);
}

function truncate(value: string, maxLength: number): string {
  return value.length > maxLength
    ? `${value.slice(0, maxLength)}${TRUNCATED_SUFFIX}`
    : value;
}

function byteLength(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Map pino log levels → OTEL severity numbers */
const PINO_TO_OTEL_SEVERITY: Record<number, SeverityNumber> = {
  10: SeverityNumber.TRACE,
  20: SeverityNumber.DEBUG,
  30: SeverityNumber.INFO,
  40: SeverityNumber.WARN,
  50: SeverityNumber.ERROR,
  60: SeverityNumber.FATAL,
};

/** Convert epoch milliseconds to `[seconds, nanoseconds]` HrTime tuple */
function millisToHrTime(millis: number): [number, number] {
  return [Math.trunc(millis / 1000), (millis % 1000) * 1_000_000];
}
