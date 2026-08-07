import type { InMemoryLogRecordExporter } from "@opentelemetry/sdk-logs";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import config from "@/config";
import { rumExporter } from "./exporter.ee";

vi.mock("@/config", async () =>
  (await import("@/test/mocks/config")).configModuleMock({
    enterpriseFeatures: { core: true },
    observability: {
      rum: {
        enabled: true,
        logExporter: { url: "http://localhost:4318/v1/logs" },
        // Distinctive values so the wiring test below can prove the tuning
        // knobs reach the batch processor (defaults would pass vacuously).
        batchProcessor: {
          maxQueueSize: 1111,
          maxExportBatchSize: 222,
          scheduledDelayMillis: 3333,
        },
      },
    },
  }),
);

// `captured.logExporter` is the in-memory exporter backing the CURRENT
// pipeline (null until initialize() builds one); assigned by the mocks below,
// which also record the constructor configs the pipeline was built with.
const captured = vi.hoisted(() => ({
  logExporter: null as InMemoryLogRecordExporter | null,
  otlpConfig: null as { url?: string; compression?: string } | null,
  batchConfig: null as unknown,
}));

// initialize() builds its own BatchLogRecordProcessor(OTLPLogExporter(...))
// internally, so substitute just the batching processor with a synchronous
// in-memory pipeline: the real LoggerProvider, attribute mapping, and emit
// code all run, and tests assert on the exact ReadableLogRecords produced.
vi.mock("@opentelemetry/sdk-logs", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@opentelemetry/sdk-logs")>();
  class InMemoryBatchLogRecordProcessor extends actual.SimpleLogRecordProcessor {
    constructor(_exporter: unknown, batchConfig: unknown) {
      const logExporter = new actual.InMemoryLogRecordExporter();
      super(logExporter);
      captured.logExporter = logExporter;
      captured.batchConfig = batchConfig;
    }
  }
  return {
    ...actual,
    BatchLogRecordProcessor:
      InMemoryBatchLogRecordProcessor as unknown as typeof actual.BatchLogRecordProcessor,
  };
});

vi.mock("@opentelemetry/exporter-logs-otlp-http", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("@opentelemetry/exporter-logs-otlp-http")
    >();
  class CapturingOTLPLogExporter extends actual.OTLPLogExporter {
    constructor(...args: ConstructorParameters<typeof actual.OTLPLogExporter>) {
      super(...args);
      captured.otlpConfig = args[0] ?? null;
    }
  }
  return { ...actual, OTLPLogExporter: CapturingOTLPLogExporter };
});

beforeEach(() => {
  // The singleton reads config at call time; make each test self-determining.
  config.observability.rum.enabled = true;
});

afterEach(async () => {
  vi.restoreAllMocks();
  // Reset the module-level singleton so tests stay order-independent.
  await rumExporter.shutdown();
  captured.logExporter = null;
  captured.otlpConfig = null;
  captured.batchConfig = null;
});

describe("initialize", () => {
  test("is a no-op that does not throw when RUM export is disabled", () => {
    config.observability.rum.enabled = false;

    expect(() => rumExporter.initialize()).not.toThrow();

    expect(captured.logExporter).toBeNull();
    expect(rumExporter.emit([makeEvent()], { userId: USER_ID })).toBe(0);
  });

  test("builds the pipeline with the configured endpoint, gzip, and batch tuning", () => {
    rumExporter.initialize();

    // The env-var contract: ARCHESTRA_RUM_EXPORTER_* tuning and gzip
    // compression must reach the OTel constructors, not just config.
    expect(captured.otlpConfig).toMatchObject({
      url: "http://localhost:4318/v1/logs",
      compression: "gzip",
    });
    expect(captured.batchConfig).toEqual({
      maxQueueSize: 1111,
      maxExportBatchSize: 222,
      scheduledDelayMillis: 3333,
    });
  });

  test("keeps the existing pipeline when called again", () => {
    rumExporter.initialize();
    rumExporter.emit([makeEvent()], { userId: USER_ID });
    rumExporter.initialize();
    rumExporter.emit([makeEvent()], { userId: USER_ID });

    // A recreated pipeline would leave the current exporter with one record.
    expect(emittedRecords()).toHaveLength(2);
  });
});

describe("emit", () => {
  test("returns 0 and exports nothing when never initialized", () => {
    expect(rumExporter.emit([makeEvent()], { userId: USER_ID })).toBe(0);
    expect(captured.logExporter).toBeNull();
  });

  test("returns the number of accepted events", () => {
    rumExporter.initialize();

    const accepted = rumExporter.emit(
      [makeEvent(), makeEvent({ name: "session.start" })],
      { userId: USER_ID },
    );

    expect(accepted).toBe(2);
    expect(emittedRecords()).toHaveLength(2);
  });

  test("stamps session.id and user.id, and session.previous_id only when present", () => {
    rumExporter.initialize();

    rumExporter.emit(
      [makeEvent({ previousSessionId: "session-prev" }), makeEvent()],
      { userId: USER_ID },
    );

    const [withPrevious, withoutPrevious] = emittedRecords();
    expect(withPrevious.attributes["session.id"]).toBe(SESSION_ID);
    expect(withPrevious.attributes["user.id"]).toBe(USER_ID);
    expect(withPrevious.attributes["session.previous_id"]).toBe("session-prev");
    expect(withoutPrevious.attributes["session.id"]).toBe(SESSION_ID);
    expect(withoutPrevious.attributes["user.id"]).toBe(USER_ID);
    expect(withoutPrevious.attributes["session.previous_id"]).toBeUndefined();
  });

  test("client attributes cannot spoof the stamped identity or event name", () => {
    rumExporter.initialize();

    rumExporter.emit(
      [
        makeEvent({
          attributes: {
            "session.id": "spoofed-session",
            "user.id": "spoofed-user",
            "event.name": "spoofed-event",
          },
        }),
      ],
      { userId: USER_ID },
    );

    const [record] = emittedRecords();
    // The stamped values win...
    expect(record.attributes["session.id"]).toBe(SESSION_ID);
    expect(record.attributes["user.id"]).toBe(USER_ID);
    expect(record.attributes["event.name"]).toBe("archestra.page_view");
    // ...and the spoofs survive only under the archestra. client namespace.
    expect(record.attributes["archestra.session.id"]).toBe("spoofed-session");
    expect(record.attributes["archestra.user.id"]).toBe("spoofed-user");
    expect(record.attributes["archestra.event.name"]).toBe("spoofed-event");
  });

  test("namespaces custom attribute keys under archestra., passing semconv keys through", () => {
    rumExporter.initialize();

    rumExporter.emit(
      [
        makeEvent({
          attributes: {
            messageLength: 42,
            "url.path": "/chat",
            "archestra.x": true,
          },
        }),
      ],
      { userId: USER_ID },
    );

    const [record] = emittedRecords();
    expect(record.attributes["archestra.messageLength"]).toBe(42);
    expect(record.attributes.messageLength).toBeUndefined();
    expect(record.attributes["url.path"]).toBe("/chat");
    expect(record.attributes["archestra.url.path"]).toBeUndefined();
    // An already-prefixed key is not double-prefixed.
    expect(record.attributes["archestra.x"]).toBe(true);
    expect(record.attributes["archestra.archestra.x"]).toBeUndefined();
  });

  test("web-vital and error semconv keys pass through unprefixed", () => {
    rumExporter.initialize();

    rumExporter.emit(
      [
        makeEvent({
          attributes: {
            "browser.web_vital.name": "LCP",
            "browser.web_vital.value": 2412,
            "browser.web_vital.rating": "good",
            "error.type": "TypeError",
            "http.request.method": "POST",
            "http.response.status_code": 502,
            fingerprint: "a1b2c3d4",
          },
        }),
      ],
      { userId: USER_ID },
    );

    const [record] = emittedRecords();
    expect(record.attributes["browser.web_vital.name"]).toBe("LCP");
    expect(record.attributes["browser.web_vital.value"]).toBe(2412);
    expect(record.attributes["browser.web_vital.rating"]).toBe("good");
    expect(record.attributes["error.type"]).toBe("TypeError");
    expect(record.attributes["http.request.method"]).toBe("POST");
    expect(record.attributes["http.response.status_code"]).toBe(502);
    // The grouping hash is ours, not semconv — it gets the namespace.
    expect(record.attributes["archestra.fingerprint"]).toBe("a1b2c3d4");
    expect(record.attributes.fingerprint).toBeUndefined();
  });

  test("writes the event name to eventName, body, and the event.name attribute", () => {
    const eventName = "archestra.message_sent";
    rumExporter.initialize();

    rumExporter.emit([makeEvent({ name: eventName })], { userId: USER_ID });

    const [record] = emittedRecords();
    expect(record.eventName).toBe(eventName);
    expect(record.body).toBe(eventName);
    expect(record.attributes["event.name"]).toBe(eventName);
  });

  test("emits INFO log records from a dedicated web-client resource", () => {
    rumExporter.initialize();

    rumExporter.emit([makeEvent()], { userId: USER_ID });

    const [record] = emittedRecords();
    expect(record.severityNumber).toBe(9);
    expect(record.severityText).toBe("INFO");
    expect(record.resource.attributes["service.name"]).toBe("Archestra Web");
    expect(record.resource.attributes["service.version"]).toBe(
      config.api.version,
    );
  });

  describe("timestamp clamping", () => {
    // Freeze "now" AHEAD of the real clock: OTel's timeInputToHrTime treats an
    // epoch-ms number smaller than performance.timeOrigin (process start) as a
    // monotonic performance.now() reading, so past-of-process-start timestamps
    // would not round-trip into hrTime verbatim in a freshly started worker.
    const frozenNow = () => {
      const now = Date.now() + 6 * HOUR_MS;
      vi.spyOn(Date, "now").mockReturnValue(now);
      return now;
    };

    test("preserves in-window client timestamps exactly, including both window edges", () => {
      const now = frozenNow();
      rumExporter.initialize();
      const timestamps = [now - HOUR_MS, now - 1234, now + FIVE_MINUTES_MS];

      rumExporter.emit(
        timestamps.map((timestampMs) => makeEvent({ timestampMs })),
        { userId: USER_ID },
      );

      const records = emittedRecords();
      expect(records.map((record) => record.hrTime)).toEqual(
        timestamps.map(msToHrTime),
      );
    });

    test("replaces stale (>1h) and future (>5min) timestamps with server time", () => {
      const now = frozenNow();
      rumExporter.initialize();

      rumExporter.emit(
        [
          makeEvent({ timestampMs: now - HOUR_MS - 1 }),
          makeEvent({ timestampMs: now + FIVE_MINUTES_MS + 1 }),
        ],
        { userId: USER_ID },
      );

      const records = emittedRecords();
      expect(records).toHaveLength(2);
      for (const record of records) {
        expect(record.hrTime).toEqual(msToHrTime(now));
        expect(record.hrTimeObserved).toEqual(msToHrTime(now));
      }
    });
  });
});

describe("shutdown", () => {
  test("tears the pipeline down; emit reports 0 until re-initialized", async () => {
    rumExporter.initialize();
    expect(rumExporter.emit([makeEvent()], { userId: USER_ID })).toBe(1);

    await rumExporter.shutdown();

    expect(rumExporter.emit([makeEvent()], { userId: USER_ID })).toBe(0);

    // The exporter can be brought back up after a shutdown.
    rumExporter.initialize();
    expect(rumExporter.emit([makeEvent()], { userId: USER_ID })).toBe(1);
    expect(emittedRecords()).toHaveLength(1);
  });
});

// === Test helpers ===

type RumEvent = Parameters<(typeof rumExporter)["emit"]>[0][number];

const USER_ID = "user-1";
const SESSION_ID = "session-abc";
const HOUR_MS = 60 * 60 * 1000;
const FIVE_MINUTES_MS = 5 * 60 * 1000;

function makeEvent(overrides: Partial<RumEvent> = {}): RumEvent {
  return {
    name: "archestra.page_view",
    timestampMs: Date.now(),
    sessionId: SESSION_ID,
    ...overrides,
  };
}

function emittedRecords() {
  return captured.logExporter?.getFinishedLogRecords() ?? [];
}

/** Epoch milliseconds → OTel HrTime ([seconds, nanoseconds]); exact for integer ms. */
function msToHrTime(epochMs: number): [number, number] {
  return [Math.trunc(epochMs / 1000), (epochMs % 1000) * 1e6];
}
