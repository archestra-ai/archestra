import { describe, expect, test } from "vitest";
import { ThroughputError } from "@/services/llm-throughput";
import { ApiError } from "@/types";
import { UpstreamStreamIncompleteError } from "@/utils/upstream-stream-incomplete-error";
import { classifyProxyFailure } from "./llm-proxy-helpers";

describe("logical proxy failure classification", () => {
  test.each([
    [
      new UpstreamStreamIncompleteError(
        "Provider stream ended before final usage was confirmed",
      ),
      502,
      "provider",
      "error",
    ],
    [
      Object.assign(new Error("provider throttled"), { status: 429 }),
      429,
      "provider",
      "throttled",
    ],
    [
      Object.assign(new Error("provider unavailable"), {
        $metadata: { httpStatusCode: 503 },
      }),
      503,
      "provider",
      "overloaded",
    ],
    [
      new ThroughputError({
        status: 429,
        code: "archestra_quota_exceeded",
        message: "quota exhausted",
      }),
      429,
      "archestra",
      "throttled",
    ],
    [
      new ThroughputError({
        status: 402,
        code: "token_cost_limit_exceeded",
        message: "budget exhausted",
      }),
      402,
      "archestra",
      "denied",
    ],
    [
      new ThroughputError({
        status: 503,
        code: "archestra_quota_storage_unavailable",
        message: "storage unavailable",
      }),
      503,
      "archestra",
      "error",
    ],
    [new ApiError(503, "internal unavailable"), 503, "archestra", "error"],
    [new ApiError(403, "policy denied"), 403, "archestra", "denied"],
    [
      new ApiError(429, "credential validation throttled"),
      429,
      "archestra",
      "throttled",
    ],
    [
      Object.assign(new Error("request timed out"), {
        name: "APIConnectionTimeoutError",
      }),
      504,
      "provider",
      "timeout",
    ],
    [
      Object.assign(new Error("connection closed"), {
        name: "APIConnectionError",
      }),
      502,
      "provider",
      "error",
    ],
    [
      Object.assign(new Error("cancelled"), { name: "AbortError" }),
      499,
      "client",
      "cancelled",
    ],
    [new Error("internal failure"), 500, "archestra", "error"],
  ])("classifies %s", (error, statusCode, origin, outcome) => {
    expect(classifyProxyFailure(error)).toEqual({
      statusCode,
      origin,
      outcome,
    });
  });
});
