import { ArchestraInternalErrorCode } from "@archestra/shared";
import { SpanKind } from "@opentelemetry/api";
import { BasicTracerProvider } from "@opentelemetry/sdk-trace-base";
import type { ErrorEvent, EventHint, TransactionEvent } from "@sentry/core";
import * as Sentry from "@sentry/node";
import { SentrySampler, SentrySpanProcessor } from "@sentry/opentelemetry";
import { describe, expect, test } from "vitest";
import config from "@/config";
import { ApiError, SECRETS_MANAGER_UNAVAILABLE_INTERNAL_CODE } from "@/types";
import {
  buildRawProviderError,
  filterErrorEvent,
  filterTransactionEvent,
} from "./sentry";

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
  test("removes request content while retaining error diagnostics", () => {
    const event: ErrorEvent = {
      type: undefined,
      message: "Request failed",
      tags: { component: "api" },
      request: {
        method: "POST",
        url: "https://app.example.com/api/chat?token=private-query#private-fragment",
        headers: {
          Authorization: "Bearer private-token",
          authorization: "private-key",
          Cookie: "session=private-session",
          "X-Api-Key": "private-api-key",
        },
        cookies: { session: "private-session" },
        data: { messages: [{ content: "Private conversation" }] },
        query_string: "token=private-query",
      },
    };

    const result = filterErrorEvent(
      event,
      hintFor(new Error("Request failed")),
    );

    expect(result).toMatchObject({
      message: "Request failed",
      tags: { component: "api" },
      request: { method: "POST", url: "https://app.example.com/api/chat" },
    });
    expect(result?.request).toEqual({
      method: "POST",
      url: "https://app.example.com/api/chat",
    });
    expect(JSON.stringify(result)).not.toContain("private-");
    expect(JSON.stringify(result)).not.toContain("Private conversation");
  });

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

  test("drops upstream-gateway failures surfaced as 502/504 ApiErrors", () => {
    // 502/504 mean a user-configured provider or an external/self-hosted MCP
    // server failed (unreachable, misconfigured, timed out) — not our code.
    // Mirror the request-error handler's exclusion so both sinks agree.
    for (const statusCode of [502, 504]) {
      expect(
        filterErrorEvent(
          makeEvent(),
          hintFor(new ApiError(statusCode, `upstream ${statusCode}`)),
        ),
      ).toBeNull();
    }
  });

  test("keeps a 503 ApiError, which signals our own overload/outage", () => {
    const event = makeEvent();
    expect(filterErrorEvent(event, hintFor(new ApiError(503, "busy")))).toBe(
      event,
    );
  });

  test("drops MCP-server-unreachable errors surfaced by the shared policy", () => {
    const notReady = Object.assign(new Error("server not running yet"), {
      name: "McpServerNotReadyError",
    });
    expect(filterErrorEvent(makeEvent(), hintFor(notReady))).toBeNull();
  });

  test("groups transient DB connectivity failures by root cause", () => {
    // A DNS lookup failure the ORM wrapped per-query: fingerprint by the
    // root cause so an outage groups into one issue, not one per statement.
    const databaseHost = new URL(config.database.url).hostname;
    const dbError = new Error(
      'Failed query: select "id" from "agents" where "slug" = $1',
      { cause: new Error(`getaddrinfo ENOTFOUND ${databaseHost}`) },
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

describe("filterTransactionEvent", () => {
  test("strips request content from retained transactions", () => {
    const event: TransactionEvent = {
      type: "transaction",
      transaction: "POST /api/chat",
      request: {
        method: "POST",
        url: "/api/chat?token=private-token#private-fragment",
        headers: { Authorization: "Bearer private-token" },
        data: { content: "Private request body" },
        cookies: { session: "private-session" },
        query_string: "token=private-token",
      },
    };

    const result = filterTransactionEvent(event);

    expect(result?.transaction).toBe("POST /api/chat");
    expect(result?.request).toEqual({ method: "POST", url: "/api/chat" });
  });

  function mcpGatewayTransaction(method?: string): TransactionEvent {
    return {
      type: "transaction",
      transaction: "POST /v1/mcp/:profileId",
      contexts: {
        trace: {
          trace_id: "0".repeat(32),
          span_id: "0".repeat(16),
          data: method ? { "mcp.method.name": method } : {},
        },
      },
    };
  }

  test("drops a long-lived MCP stream", () => {
    expect(
      filterTransactionEvent(mcpGatewayTransaction("subscriptions/listen")),
    ).toBeNull();
  });

  test("keeps ordinary MCP gateway requests on the same route", () => {
    for (const event of [
      mcpGatewayTransaction("tools/call"),
      mcpGatewayTransaction("tools/list"),
      mcpGatewayTransaction(),
    ]) {
      expect(filterTransactionEvent(event)).toBe(event);
    }
  });

  // Runs server spans through the SDK's own span-to-transaction export. An SDK
  // upgrade that moves span attributes out of `contexts.trace.data` fails here
  // instead of silently sending the streams again.
  test("reads the method from the transaction the SDK builds for a server span", async () => {
    const decisions: Array<[unknown, boolean]> = [];
    const client = new Sentry.NodeClient({
      dsn: "http://public@127.0.0.1:9/1",
      integrations: [],
      tracesSampleRate: 1,
      stackParser: Sentry.defaultStackParser,
      transport: (options) =>
        Sentry.createTransport(options, async () => ({ statusCode: 200 })),
      beforeSendTransaction: (event) => {
        decisions.push([
          event.contexts?.trace?.data?.["mcp.method.name"],
          filterTransactionEvent(event) === null,
        ]);
        return null;
      },
    });
    const provider = new BasicTracerProvider({
      sampler: new SentrySampler(client),
      spanProcessors: [new SentrySpanProcessor()],
    });
    Sentry.setCurrentClient(client);
    client.init();
    try {
      const tracer = provider.getTracer("test");
      for (const method of ["subscriptions/listen", "tools/call"]) {
        const span = tracer.startSpan("POST /v1/mcp/:profileId", {
          kind: SpanKind.SERVER,
          attributes: { "sentry.op": "http.server" },
        });
        span.setAttribute("mcp.method.name", method);
        span.end();
      }
      await provider.forceFlush();
      await client.flush(2_000);
    } finally {
      Sentry.getCurrentScope().setClient(undefined);
      await client.close();
      await provider.shutdown();
    }

    expect(decisions).toEqual([
      ["subscriptions/listen", true],
      ["tools/call", false],
    ]);
  });

  test("still drops noisy transactions by name", () => {
    expect(
      filterTransactionEvent({
        type: "transaction",
        transaction: "GET /v1/mcp/:profileId",
      }),
    ).toBeNull();
  });
});
