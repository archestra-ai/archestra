import { afterEach, beforeEach, vi } from "vitest";
import { describe, expect, test } from "@/test";
import { probeAnthropicCredit } from "./anthropic-credit-probe";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function anthropicError(type: string, message: string) {
  return { type: "error", error: { type, message } };
}

describe("probeAnthropicCredit", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  test("returns 'usable' on 200 without retrying", async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { id: "msg_1" }));
    await expect(probeAnthropicCredit("sk-key")).resolves.toBe("usable");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test("returns 'exhausted' on 402 billing_error", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(
        402,
        anthropicError("billing_error", "Your credit balance is too low."),
      ),
    );
    await expect(probeAnthropicCredit("sk-key")).resolves.toBe("exhausted");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test("returns 'exhausted' on a legacy 400 'credit balance is too low'", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(
        400,
        anthropicError(
          "invalid_request_error",
          "Your credit balance is too low to access the Anthropic API.",
        ),
      ),
    );
    await expect(probeAnthropicCredit("sk-key")).resolves.toBe("exhausted");
  });

  test("returns 'exhausted' on a 400 usage-limit block (detected off the message)", async () => {
    // A configured usage/spend cap comes back as a plain 400 with a
    // non-standard `api_validation_error` type — only the body message reveals
    // it, so status/type alone would miss it.
    fetchMock.mockResolvedValue(
      jsonResponse(
        400,
        anthropicError(
          "api_validation_error",
          "You have reached your specified API usage limits. You will regain access on 2026-08-01 at 00:00 UTC.",
        ),
      ),
    );
    await expect(probeAnthropicCredit("sk-key")).resolves.toBe("exhausted");
    // Terminal verdict — no retry.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test("returns 'inconclusive' (no retry) on a non-billing 4xx", async () => {
    // e.g. a bad key (401) or an ordinary validation 400 — not a balance block
    // and not transient, so fail open without retrying.
    fetchMock.mockResolvedValue(
      jsonResponse(401, anthropicError("authentication_error", "bad key")),
    );
    await expect(probeAnthropicCredit("sk-key")).resolves.toBe("inconclusive");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test("retries a 500 up to the attempt cap then resolves 'inconclusive'", async () => {
    vi.useFakeTimers();
    fetchMock.mockResolvedValue(
      jsonResponse(500, anthropicError("api_error", "server error")),
    );

    const promise = probeAnthropicCredit("sk-key");
    await vi.runAllTimersAsync();
    await expect(promise).resolves.toBe("inconclusive");
    // 3 total attempts (PROBE_MAX_ATTEMPTS).
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  test("retries a network failure then succeeds when a later attempt returns 200", async () => {
    vi.useFakeTimers();
    fetchMock
      .mockRejectedValueOnce(new Error("network down"))
      .mockResolvedValueOnce(jsonResponse(200, { id: "msg_1" }));

    const promise = probeAnthropicCredit("sk-key");
    await vi.runAllTimersAsync();
    await expect(promise).resolves.toBe("usable");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  test("retries a 429 then resolves 'inconclusive' after the cap", async () => {
    vi.useFakeTimers();
    fetchMock.mockResolvedValue(
      jsonResponse(429, anthropicError("rate_limit_error", "slow down")),
    );

    const promise = probeAnthropicCredit("sk-key");
    await vi.runAllTimersAsync();
    await expect(promise).resolves.toBe("inconclusive");
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
});
