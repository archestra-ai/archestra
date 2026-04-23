import { SpanKind, SpanStatusCode, trace } from "@opentelemetry/api";
import { vi } from "vitest";
import { describe, expect, test } from "@/test";

const { setSpanErrorMock } = vi.hoisted(() => ({
  setSpanErrorMock: vi.fn(),
}));

vi.mock("@/observability/tracing/attributes", () => ({
  setSpanError: setSpanErrorMock,
}));

describe("memory telemetry spans", () => {
  test("withMemorySpan sets attributes and marks success", async () => {
    const span = makeSpan();
    const startActiveSpan = vi.fn(async (_name, _options, callback) => {
      return await callback(span);
    });
    vi.spyOn(trace, "getTracer").mockReturnValue({
      startActiveSpan,
    } as never);

    const { withMemorySpan } = await import("./spans");
    const result = await withMemorySpan(
      "inject",
      async () => {
        return "ok";
      },
      {
        scopeType: "user",
        scopeId: "user-1",
        candidatesProposed: 3,
        candidatesAcceptedByPolicyScreen: 2,
        injectedCount: 2,
        injectedTokensApprox: 128,
      },
    );

    expect(result).toBe("ok");
    expect(startActiveSpan).toHaveBeenCalledWith(
      "memory inject",
      {
        kind: SpanKind.INTERNAL,
        attributes: {
          "archestra.memory.operation": "inject",
        },
      },
      expect.any(Function),
    );
    expect(span.setAttribute).toHaveBeenCalledWith(
      "archestra.memory.scope_type",
      "user",
    );
    expect(span.setAttribute).toHaveBeenCalledWith(
      "archestra.memory.scope_id",
      "user-1",
    );
    expect(span.setAttribute).toHaveBeenCalledWith(
      "archestra.memory.candidates_proposed",
      3,
    );
    expect(span.setAttribute).toHaveBeenCalledWith(
      "archestra.memory.candidates_accepted_by_policy_screen",
      2,
    );
    expect(span.setAttribute).toHaveBeenCalledWith(
      "archestra.memory.injected_count",
      2,
    );
    expect(span.setAttribute).toHaveBeenCalledWith(
      "archestra.memory.injected_tokens_approx",
      128,
    );
    expect(span.setStatus).toHaveBeenCalledWith({ code: SpanStatusCode.OK });
    expect(span.end).toHaveBeenCalledTimes(1);
  });

  test("withMemorySpan forwards errors through setSpanError", async () => {
    const span = makeSpan();
    const startActiveSpan = vi.fn(async (_name, _options, callback) => {
      return await callback(span);
    });
    vi.spyOn(trace, "getTracer").mockReturnValue({
      startActiveSpan,
    } as never);

    const { withMemorySpan } = await import("./spans");
    const error = new Error("boom");

    await expect(
      withMemorySpan("extract", async () => {
        throw error;
      }),
    ).rejects.toThrow("boom");

    expect(setSpanErrorMock).toHaveBeenCalledWith(span, error);
    expect(span.end).toHaveBeenCalledTimes(1);
  });
});

function makeSpan() {
  return {
    setAttribute: vi.fn(),
    setStatus: vi.fn(),
    end: vi.fn(),
  };
}
