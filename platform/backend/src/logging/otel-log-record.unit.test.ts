import { Writable } from "node:stream";
import type { AnyValue } from "@opentelemetry/api-logs";
import { describe, expect, test } from "vitest";
import { createLogger } from "./create-logger";
import { toOtelLogRecord } from "./otel-log-record";

describe("toOtelLogRecord", () => {
  test("keeps an oversized error log within Loki's structured metadata limits", () => {
    const error = Object.assign(new Error("upstream exploded"), {
      code: "E_UPSTREAM",
      // Enumerable error properties are copied by the err serializer.
      details: buildWideNestedObject({ depth: 6, width: 6 }),
      payload: "x".repeat(200_000),
    });
    const extraFields = Object.fromEntries(
      Array.from({ length: 300 }, (_, i) => [`field${i}`, `value-${i}`]),
    );

    const record = toOtelLogRecord(
      captureRecord((logger) =>
        logger.error(
          {
            err: error,
            request: { body: "y".repeat(100_000) },
            ...extraFields,
          },
          "provider call failed",
        ),
      ),
    );

    const entries = flattenLikeLoki(record.attributes ?? {});
    expect(entries.length).toBeLessThanOrEqual(LOKI_MAX_ENTRIES);
    const size = entries.reduce((sum, [k, v]) => sum + k.length + v.length, 0);
    expect(size).toBeLessThanOrEqual(LOKI_MAX_SIZE_BYTES);

    // The key error facts survive: identity as attributes, the full stack in
    // the body (log line), which Loki does not count as structured metadata.
    const attributes = Object.fromEntries(entries);
    expect(attributes.err_type).toBe("Error");
    expect(attributes.err_message).toBe("upstream exploded");
    expect(attributes.err_code).toBe("E_UPSTREAM");
    expect(
      Number(attributes["archestra.log.dropped_attributes_count"]),
    ).toBeGreaterThan(0);
    expect(record.body).toEqual(
      expect.stringContaining("provider call failed"),
    );
    expect(record.body).toEqual(
      expect.stringContaining(error.stack?.split("\n")[1] ?? "missing stack"),
    );
  });

  test("passes small records through with their nested shape intact", () => {
    const record = toOtelLogRecord(
      captureRecord((logger) =>
        logger.warn(
          {
            agentId: "agent-1",
            retry: { attempt: 2, delayMs: 500 },
            ok: false,
          },
          "retrying",
        ),
      ),
    );

    expect(record.body).toBe("retrying");
    expect(record.severityText).toBe("warn");
    expect(record.attributes).toEqual({
      agentId: "agent-1",
      retry: { attempt: 2, delayMs: 500 },
      ok: false,
    });
  });
});

// === Internal ===

/** Loki defaults for `max_structured_metadata_entries_count` / `_size`. */
const LOKI_MAX_ENTRIES = 128;
const LOKI_MAX_SIZE_BYTES = 64 * 1024;

function captureRecord(
  write: (logger: ReturnType<typeof createLogger>) => void,
): Record<string, unknown> {
  const records: Record<string, unknown>[] = [];
  const sink = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      records.push(JSON.parse(chunk.toString()));
      callback();
    },
  });
  write(createLogger({ streams: [{ stream: sink }], level: "info" }));
  return records[0];
}

/**
 * Loki's OTLP ingester turns every attribute into structured metadata,
 * flattening nested maps into `parent_child` keys and stringifying the rest.
 */
function flattenLikeLoki(
  attributes: Record<string, AnyValue>,
  prefix = "",
): [string, string][] {
  return Object.entries(attributes).flatMap(([key, value]) => {
    const name = prefix ? `${prefix}_${key}` : key;
    if (value && typeof value === "object" && !Array.isArray(value)) {
      return flattenLikeLoki(value as Record<string, AnyValue>, name);
    }
    return [
      [name, typeof value === "string" ? value : JSON.stringify(value)],
    ] as [string, string][];
  });
}

function buildWideNestedObject({
  depth,
  width,
}: {
  depth: number;
  width: number;
}): Record<string, unknown> {
  return Object.fromEntries(
    Array.from({ length: width }, (_, i) => [
      `k${i}`,
      depth <= 1
        ? `leaf-${i}`
        : buildWideNestedObject({ depth: depth - 1, width }),
    ]),
  );
}
