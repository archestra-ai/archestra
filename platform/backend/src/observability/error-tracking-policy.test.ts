import { ArchestraInternalErrorCode } from "@archestra/shared";
import { describe, expect, test } from "@/test";
import { ApiError, SECRETS_MANAGER_UNAVAILABLE_INTERNAL_CODE } from "@/types";
import { classifyErrorForTracking } from "./error-tracking-policy";

/** A generic Error whose `.name` marks it as an MCP-connectivity failure. */
function namedError(name: string, message = "boom"): Error {
  const error = new Error(message);
  error.name = name;
  return error;
}

/** A generic Error carrying an HTTP `statusCode` property. */
function statusError(statusCode: number): Error & { statusCode: number } {
  return Object.assign(new Error(`status ${statusCode}`), { statusCode });
}

describe("classifyErrorForTracking", () => {
  test("reports a genuine server-side bug (generic 500) without grouping", () => {
    const decision = classifyErrorForTracking(
      new Error("undefined is not a function"),
    );
    expect(decision.report).toBe(true);
    expect(decision.fingerprint).toBeUndefined();
  });

  test("reports our own 5xx ApiErrors (500, 503)", () => {
    for (const statusCode of [500, 503]) {
      expect(
        classifyErrorForTracking(new ApiError(statusCode, "boom")).report,
      ).toBe(true);
    }
  });

  test("drops 4xx ApiErrors as expected client errors", () => {
    for (const statusCode of [400, 401, 403, 404, 429]) {
      expect(
        classifyErrorForTracking(new ApiError(statusCode, "client error"))
          .report,
      ).toBe(false);
    }
  });

  test("drops 502/504 ApiErrors as upstream failures", () => {
    for (const statusCode of [502, 504]) {
      expect(
        classifyErrorForTracking(new ApiError(statusCode, "upstream")).report,
      ).toBe(false);
    }
  });

  test("drops the handled upstream-empty-response condition", () => {
    const error = new ApiError(
      500,
      "provider streamed an empty completion",
      ArchestraInternalErrorCode.UpstreamEmptyResponse,
    );
    expect(classifyErrorForTracking(error).report).toBe(false);
  });

  test("drops a generic error carrying a 4xx client status", () => {
    for (const statusCode of [400, 404, 429]) {
      expect(classifyErrorForTracking(statusError(statusCode)).report).toBe(
        false,
      );
    }
  });

  test("keeps a generic error carrying a 5xx status", () => {
    // Unlike ApiError 502/504 (our upstream-gateway mapping, dropped), a
    // generic 5xx is a provider's own server error surfaced via the
    // raw-provider-error path — a diagnostic signal we keep reporting.
    for (const statusCode of [500, 502, 503, 504]) {
      expect(classifyErrorForTracking(statusError(statusCode)).report).toBe(
        true,
      );
    }
  });

  test("drops MCP-server-unreachable errors by name", () => {
    for (const name of [
      "McpServerNotReadyError",
      "McpServerConnectionTimeoutError",
    ]) {
      expect(classifyErrorForTracking(namedError(name)).report).toBe(false);
    }
  });

  test("groups transient DB connectivity failures by root cause", () => {
    const dbError = new Error(
      'Failed query: select "id" from "agents" where "slug" = $1',
      { cause: new Error("connect ECONNREFUSED 10.0.0.1:5432") },
    );
    const decision = classifyErrorForTracking(dbError);
    expect(decision.report).toBe(true);
    expect(decision.fingerprint).toEqual(["db-transient", "ECONNREFUSED"]);
    expect(decision.tags).toMatchObject({
      error_type: "db_transient",
      db_error_code: "ECONNREFUSED",
    });
  });

  test("groups secrets-backend outages by the root condition", () => {
    const error = new ApiError(
      503,
      "secrets manager unavailable",
      SECRETS_MANAGER_UNAVAILABLE_INTERNAL_CODE,
    );
    const decision = classifyErrorForTracking(error);
    expect(decision.report).toBe(true);
    expect(decision.fingerprint).toEqual([
      SECRETS_MANAGER_UNAVAILABLE_INTERNAL_CODE,
    ]);
  });
});
