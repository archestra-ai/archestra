import type { SpanContext } from "@opentelemetry/api";
import { TraceFlags, trace } from "@opentelemetry/api";
import { describe, expect, test, vi } from "@/test";
import { getExemplarLabels, sanitizeLabelKey } from "./utils";

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

describe("getExemplarLabels", () => {
  test("truncates long sessionID to fit 128-char exemplar budget", async () => {
    const longSessionId =
      "chatops:ms-teams:a:15T7kNVP8YbByYGI_Fpc-Ci4cqqlrOfJiumEhUcnvNEZtyranEbXyAUqrNC9jGpSyulMgLurq6nD51ASEEq7sXfK3zetvCvC_XYj37IVz-tFUihy9HjP6YdqWnMw0URwu";
    vi.spyOn(
      await import("@/observability/request-context"),
      "getActiveSessionId",
    ).mockReturnValue(longSessionId);

    const validSpanContext: SpanContext = {
      traceId: "d7016c05fd08aab5d6cc0df9ebd13180",
      spanId: "3411dd4999b25680",
      traceFlags: TraceFlags.SAMPLED,
    };
    const mockSpan = { spanContext: () => validSpanContext };
    vi.spyOn(trace, "getSpan").mockReturnValue(mockSpan as never);

    const labels = getExemplarLabels();

    expect(labels.sessionID.length).toBe(58);
    // Total budget: all key lengths + all value lengths <= 128
    const totalSize = Object.entries(labels).reduce(
      (sum, [k, v]) => sum + k.length + v.length,
      0,
    );
    expect(totalSize).toBeLessThanOrEqual(128);
  });

  test("keeps short sessionID as-is", async () => {
    vi.spyOn(
      await import("@/observability/request-context"),
      "getActiveSessionId",
    ).mockReturnValue("short-session");

    const validSpanContext: SpanContext = {
      traceId: "d7016c05fd08aab5d6cc0df9ebd13180",
      spanId: "3411dd4999b25680",
      traceFlags: TraceFlags.SAMPLED,
    };
    const mockSpan = { spanContext: () => validSpanContext };
    vi.spyOn(trace, "getSpan").mockReturnValue(mockSpan as never);

    const labels = getExemplarLabels();
    expect(labels.sessionID).toBe("short-session");
  });
});
