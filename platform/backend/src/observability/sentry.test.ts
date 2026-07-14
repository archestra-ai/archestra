import { ArchestraInternalErrorCode } from "@archestra/shared";
import type { ErrorEvent, EventHint } from "@sentry/core";
import { describe, expect, test } from "@/test";
import { ApiError, SECRETS_MANAGER_UNAVAILABLE_INTERNAL_CODE } from "@/types";
import { buildRawProviderError, filterErrorEvent } from "./sentry";

function makeEvent(): ErrorEvent {
  return {} as ErrorEvent;
}

function hintFor(error: unknown): EventHint {
  return { originalException: error } as EventHint;
}

describe("buildRawProviderError", () => {
  test("attaches the upstream status code to the error", () => {
    const error = buildRawProviderError({
      statusCode: 429,
      errorMessage: "rate limit exceeded",
    });
    expect((error as Error & { statusCode?: number }).statusCode).toBe(429);
    expect(error.message).toBe("rate limit exceeded");
    expect(error.name).toBe("RawProviderError");
  });

  test("leaves statusCode unset when the upstream status is unknown", () => {
    const error = buildRawProviderError({
      statusCode: undefined,
      errorMessage: "unknown provider failure",
    });
    expect("statusCode" in error).toBe(false);
  });
});

describe("filterErrorEvent", () => {
  test("drops an upstream provider client error (4xx)", () => {
    // 429 rate limit, 401 invalid credentials, 403 provider block — all
    // reflect the request/config, not a bug in our code.
    for (const statusCode of [400, 401, 403, 429]) {
      const error = buildRawProviderError({
        statusCode,
        errorMessage: `provider ${statusCode}`,
      });
      expect(filterErrorEvent(makeEvent(), hintFor(error))).toBeNull();
    }
  });

  test("keeps an upstream provider server error (5xx)", () => {
    for (const statusCode of [500, 502, 503]) {
      const error = buildRawProviderError({
        statusCode,
        errorMessage: `provider ${statusCode}`,
      });
      const event = makeEvent();
      expect(filterErrorEvent(event, hintFor(error))).toBe(event);
    }
  });

  test("keeps a provider error with no status code", () => {
    const error = buildRawProviderError({
      statusCode: undefined,
      errorMessage: "provider failure",
    });
    const event = makeEvent();
    expect(filterErrorEvent(event, hintFor(error))).toBe(event);
  });

  test("drops ApiError instances with a 4xx status code", () => {
    expect(
      filterErrorEvent(makeEvent(), hintFor(new ApiError(404, "not found"))),
    ).toBeNull();
  });

  test("keeps ApiError instances with a 5xx status code", () => {
    const event = makeEvent();
    expect(filterErrorEvent(event, hintFor(new ApiError(500, "boom")))).toBe(
      event,
    );
  });

  test("groups transient DB connectivity failures by root cause", () => {
    // A DNS lookup failure the ORM wrapped per-query: fingerprint by the
    // root cause so an outage groups into one issue, not one per statement.
    const dbError = new Error(
      'Failed query: select "id" from "agents" where "slug" = $1',
      { cause: new Error("getaddrinfo ENOTFOUND postgresql.archestra-dev") },
    );
    const event = makeEvent();
    const result = filterErrorEvent(event, hintFor(dbError));
    expect(result).toBe(event);
    expect(result?.fingerprint).toEqual(["db-transient", "ENOTFOUND"]);
    expect(result?.tags?.error_type).toBe("db_transient");
    expect(result?.tags?.db_error_code).toBe("ENOTFOUND");
  });

  test("groups secrets-backend outages by the root condition", () => {
    const error = new ApiError(
      503,
      "secrets manager unavailable",
      SECRETS_MANAGER_UNAVAILABLE_INTERNAL_CODE,
    );
    const event = makeEvent();
    const result = filterErrorEvent(event, hintFor(error));
    expect(result).toBe(event);
    expect(result?.fingerprint).toEqual([
      SECRETS_MANAGER_UNAVAILABLE_INTERNAL_CODE,
    ]);
  });

  test("drops handled upstream-empty-response conditions", () => {
    const error = new ApiError(
      500,
      "provider streamed an empty completion",
      ArchestraInternalErrorCode.UpstreamEmptyResponse,
    );
    expect(filterErrorEvent(makeEvent(), hintFor(error))).toBeNull();
  });

  test("keeps a genuine server-side bug (generic 500)", () => {
    const event = makeEvent();
    expect(
      filterErrorEvent(
        event,
        hintFor(new Error("undefined is not a function")),
      ),
    ).toBe(event);
  });
});
