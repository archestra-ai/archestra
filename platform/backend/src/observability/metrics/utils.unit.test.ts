import { context, ROOT_CONTEXT, trace } from "@opentelemetry/api";
import { Histogram, type OpenMetricsContentType, Registry } from "prom-client";
import { afterEach, describe, expect, test, vi } from "vitest";
import { SESSION_ID_KEY } from "../request-context";
import { getExemplarLabels, sanitizeLabelKey } from "./utils";

afterEach(() => vi.restoreAllMocks());

describe("getExemplarLabels", () => {
  test.each([
    undefined,
    "session",
    "x".repeat(58),
    "x".repeat(59),
    "x".repeat(240),
  ])("records a real histogram without throwing for session %s", (sessionId) => {
    const spanContext = {
      traceId: "a".repeat(32),
      spanId: "b".repeat(16),
      traceFlags: 1,
    };
    const active = trace
      .setSpanContext(ROOT_CONTEXT, spanContext)
      .setValue(SESSION_ID_KEY, sessionId);
    vi.spyOn(context, "active").mockReturnValue(active);
    const labels = getExemplarLabels();
    expect(labels.traceID).toBe(spanContext.traceId);
    expect(labels.spanID).toBe(spanContext.spanId);
    expect(labels.sessionID).toBe(
      sessionId && sessionId.length <= 58 ? sessionId : undefined,
    );
    const registry = new Registry<OpenMetricsContentType>();
    registry.setContentType(Registry.OPENMETRICS_CONTENT_TYPE);
    const histogram = new Histogram({
      name: "test_exemplar_duration_seconds",
      help: "Test exemplar bounds",
      enableExemplars: true,
      registers: [registry],
    });
    expect(() =>
      histogram.observe({ value: 1, exemplarLabels: labels }),
    ).not.toThrow();
  });
});

describe("sanitizeLabelKey", () => {
  test("passes through valid label keys unchanged", () => {
    expect(sanitizeLabelKey("environment")).toBe("environment");
    expect(sanitizeLabelKey("team_name")).toBe("team_name");
    expect(sanitizeLabelKey("abc123")).toBe("abc123");
  });

  test("replaces invalid characters with underscores", () => {
    expect(sanitizeLabelKey("my-label")).toBe("my_label");
    expect(sanitizeLabelKey("my.label")).toBe("my_label");
    expect(sanitizeLabelKey("my label")).toBe("my_label");
    expect(sanitizeLabelKey("my@label!")).toBe("my_label_");
  });

  test("prefixes with underscore if starts with a digit", () => {
    expect(sanitizeLabelKey("1abc")).toBe("_1abc");
    expect(sanitizeLabelKey("99bottles")).toBe("_99bottles");
  });

  test("handles keys that need both fixes", () => {
    expect(sanitizeLabelKey("1-bad-key")).toBe("_1_bad_key");
  });

  test("handles empty string", () => {
    expect(sanitizeLabelKey("")).toBe("");
  });
});
