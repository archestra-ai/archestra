import { Writable } from "node:stream";
import { APICallError, RetryError } from "ai";
import { DrizzleQueryError } from "drizzle-orm/errors";
import { describe, expect, test } from "vitest";
import { createLogger } from "./create-logger";

/**
 * Builds a production-configured logger writing into an in-memory sink so
 * tests can assert on the exact records that would reach any logger stream.
 */
function createCapturingLogger(contentMode: "full" | "metadata_only" = "full") {
  const records: Record<string, unknown>[] = [];
  const sink = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      records.push(JSON.parse(chunk.toString()));
      callback();
    },
  });
  const logger = createLogger({
    streams: [{ stream: sink }],
    level: "info",
    contentMode,
  });
  return { logger, records };
}

describe("log redaction", () => {
  test("censors native Grok session authentication metadata", () => {
    const { logger, records } = createCapturingLogger();
    for (const name of ["x-authenticateresponse", "X-AuthenticateResponse"]) {
      logger.info({
        [name]: "synthetic-session-proof",
        headers: { [name]: "synthetic-session-proof" },
        request: { headers: { [name]: "synthetic-session-proof" } },
      });
    }
    expect(JSON.stringify(records)).not.toContain("synthetic-session-proof");
    expect(JSON.stringify(records)).toContain("[Redacted]");
  });

  test("censors runtime bindings in request headers and launch secrets", () => {
    const { logger, records } = createCapturingLogger();
    logger.info({
      request: { headers: { "x-archestra-runtime-binding": "runtime-proof" } },
      spec: { secretEnv: { ARCHESTRA_AGENT_RUNTIME_BINDING: "runtime-proof" } },
      bindingToken: "runtime-proof",
      workspaceId: "workspace",
    });
    expect(JSON.stringify(records)).not.toContain("runtime-proof");
    expect(records[0].workspaceId).toBe("workspace");
  });

  test("censors installed-client capabilities before HTTP handler evidence consumption", () => {
    const { logger, records } = createCapturingLogger();
    logger.info({
      request: {
        headers: {
          "x-archestra-client-runtime-token":
            "example-private-runtime-capability",
        },
      },
    });
    logger.info({
      headers: {
        "X-Archestra-Client-Runtime-Token":
          "example-private-runtime-capability",
      },
    });
    expect(JSON.stringify(records)).not.toContain(
      "example-private-runtime-capability",
    );
  });

  test("censors credential keys at the top level", () => {
    const { logger, records } = createCapturingLogger();

    logger.info(
      {
        authorization: "Bearer abc",
        token: "tok_123",
        deviceCode: "private-polling-proof",
        userId: "u1",
      },
      "msg",
    );

    expect(records[0].authorization).toBe("[Redacted]");
    expect(records[0].token).toBe("[Redacted]");
    expect(records[0].deviceCode).toBe("[Redacted]");
    expect(records[0].userId).toBe("u1");
  });

  test("censors credential keys one level deep", () => {
    const { logger, records } = createCapturingLogger();

    logger.info(
      {
        tokenAuth: { tokenId: "t1", rawToken: "eyJhbGciOi..." },
        request: { headers: { authorization: "Bearer abc" } },
      },
      "msg",
    );

    const tokenAuth = records[0].tokenAuth as Record<string, unknown>;
    expect(tokenAuth.rawToken).toBe("[Redacted]");
    expect(tokenAuth.tokenId).toBe("t1");
    const request = records[0].request as {
      headers: Record<string, unknown>;
    };
    expect(request.headers.authorization).toBe("[Redacted]");
  });

  test("censors passthroughHeaders wholesale", () => {
    const { logger, records } = createCapturingLogger();

    logger.info(
      { tokenAuth: { passthroughHeaders: { "x-custom": "secret-value" } } },
      "msg",
    );

    const tokenAuth = records[0].tokenAuth as Record<string, unknown>;
    expect(tokenAuth.passthroughHeaders).toBe("[Redacted]");
  });
});

describe("bounded error serialization", () => {
  test("omits attached request bodies without mutating the provider error", () => {
    const { logger, records } = createCapturingLogger();
    const requestBody = {
      messages: [{ role: "user", content: "private-prompt" }],
    };
    const error = Object.assign(
      new APICallError({
        message: "Invalid model",
        url: "https://provider.example/v1/chat/completions",
        requestBodyValues: requestBody,
        statusCode: 400,
        responseBody: '{"error":"Invalid model"}',
      }),
      { requestBody: JSON.stringify(requestBody) },
    );

    logger.error(error);
    logger.error({ err: error }, "Chat stream failed");
    logger.error({ error }, "Chat request failed");

    expect(records).toHaveLength(3);
    expect(JSON.stringify(records)).not.toContain("private-prompt");
    expect(records[0].err).toMatchObject({
      message: "Invalid model",
      statusCode: 400,
      isRetryable: false,
      responseBody: '{"error":"Invalid model"}',
      stack: expect.any(String),
    });
    expect(error.requestBodyValues).toBe(requestBody);
    expect(error.requestBody).toContain("private-prompt");
  });

  test("omits request bodies inside exhausted retries and aggregate errors", () => {
    const { logger, records } = createCapturingLogger();
    const error = new APICallError({
      message: "Provider unavailable",
      url: "https://provider.example/v1/chat/completions",
      requestBodyValues: { messages: [{ content: "private-retry-prompt" }] },
      statusCode: 503,
    });
    const retryError = new RetryError({
      message: "Failed after retries",
      reason: "maxRetriesExceeded",
      errors: [error, error],
    });
    logger.error({ err: retryError });
    logger.error({
      error: new AggregateError([retryError], "Provider failed"),
    });

    expect(JSON.stringify(records)).not.toContain("private-retry-prompt");
    expect(records[0].err).toMatchObject({
      reason: "maxRetriesExceeded",
      lastError: { statusCode: 503, isRetryable: true },
      aggregateErrors: [{ statusCode: 503 }, { statusCode: 503 }],
      errors: [{ statusCode: 503 }, { statusCode: 503 }],
    });
    expect(error.requestBodyValues).toEqual({
      messages: [{ content: "private-retry-prompt" }],
    });
    expect(retryError.errors).toEqual([error, error]);
  });

  test("drops headers/config and truncates responseBody on logged errors", () => {
    const { logger, records } = createCapturingLogger();

    const error = new Error("upstream failed") as Error & {
      headers: Record<string, string>;
      config: Record<string, string>;
      responseBody: string;
      statusCode: number;
    };
    error.headers = { authorization: "Bearer abc" };
    error.config = { apiKey: "sk-123" };
    error.responseBody = "x".repeat(5_000);
    error.statusCode = 502;

    logger.error(error);

    const err = records[0].err as Record<string, unknown>;
    expect(err.message).toBe("upstream failed");
    expect(err.statusCode).toBe(502);
    expect(err.headers).toBeUndefined();
    expect(err.config).toBeUndefined();
    expect((err.responseBody as string).length).toBeLessThan(2_100);
    expect(err.responseBody).toContain("…[truncated]");
  });

  test("passes non-Error values through the error key untouched", () => {
    const { logger, records } = createCapturingLogger();

    logger.warn({ error: "plain failure message" }, "msg");

    expect(records[0].error).toBe("plain failure message");
  });
});

describe("metadata-only application errors", () => {
  test("withholds provider text, stacks and raw diagnostics before fan-out without mutating errors", () => {
    const { logger, records } = createCapturingLogger("metadata_only");
    const marker = "synthetic-private-provider-echo";
    const error = new APICallError({
      message: marker,
      url: `https://provider.example/?prompt=${marker}`,
      requestBodyValues: { prompt: marker },
      statusCode: 503,
      responseBody: marker,
    });
    const retry = new RetryError({
      message: marker,
      reason: "maxRetriesExceeded",
      errors: [error, error],
    });
    logger.error(error);
    logger.error({ err: error });
    logger.error(
      { error: retry, conversationId: "synthetic-id" },
      "Chat stream failed",
    );
    logger.info(
      {
        parsedError: { message: marker },
        errorMessage: marker,
        rawErrorJson: marker,
        statusCode: 503,
      },
      "Mapped provider error",
    );
    logger.error(
      { errorBody: marker, upstreamError: marker, statusCode: 503 },
      "Provider failed",
    );
    logger.warn({ error: marker }, "Helper failed");
    expect(JSON.stringify(records)).not.toContain(marker);
    expect(records[2]).toMatchObject({
      conversationId: "synthetic-id",
      error: {
        reason: "maxRetriesExceeded",
        lastError: { statusCode: 503, isRetryable: true },
        errors: [{ statusCode: 503 }, { statusCode: 503 }],
      },
    });
    expect(records[3].statusCode).toBe(503);
    expect(error.message).toBe(marker);
    expect(error.responseBody).toBe(marker);
  });

  test("handles plain error objects, cycles and unrecognized attached content", () => {
    const { logger, records } = createCapturingLogger("metadata_only");
    const error = {
      name: "ProviderError",
      status: 400,
      message: "private-prompt",
      custom: { prompt: "private-prompt" },
      cause: null as unknown,
    };
    error.cause = error;
    logger.error({ error }, "Provider failed");
    expect(records[0]).toMatchObject({
      error: { status: 400 },
    });
    expect(JSON.stringify(records)).not.toContain("private-prompt");
  });
});

test("metadata-only withholds separate stack and provider-controlled code fields", () => {
  const { logger, records } = createCapturingLogger("metadata_only");
  const marker = "SYNTHETIC_PRIVATE_PROMPT";
  const error = Object.assign(new Error(marker), {
    name: marker,
    type: marker,
    code: marker,
    reason: marker,
  });
  logger.error({ err: error }, "Provider failed");
  logger.error(
    {
      error: error.message,
      code: error.code,
      stack: error.stack,
      statusCode: 500,
    },
    "HTTP 50x request error occurred",
  );
  expect(JSON.stringify(records)).not.toContain(marker);
  expect(records[0]).toMatchObject({ err: { type: "Error" } });
  expect(records[1].statusCode).toBe(500);
});

test("metadata-only classifies terminal status and withholds provider diagnostic aliases", () => {
  const { logger, records } = createCapturingLogger("metadata_only");
  const marker = "synthetic-private-provider-echo";
  for (const status of ["failed", "incomplete", marker]) {
    logger.warn(
      {
        status,
        incompleteReason: marker,
        errorCode: marker,
        errorMessage: marker,
        rawFinishReason: marker,
        usagePresent: true,
      },
      "Codex subscription response ended without completing",
    );
  }
  expect(JSON.stringify(records)).not.toContain(marker);
  expect(records[0]).toMatchObject({ status: "failed", usagePresent: true });
  expect(records[1].status).toBe("incomplete");
});

test("metadata-only sanitizes mapped chat errors and renamed error carriers", () => {
  const { logger, records } = createCapturingLogger("metadata_only");
  const marker = "synthetic-private-echoed-chat-error";
  const mappedError = {
    code: "server_error",
    message: marker,
    isRetryable: true,
    originalError: {
      message: marker,
      type: marker,
      statusCode: 503,
      raw: { responseBody: marker },
    },
  };
  logger.info(
    {
      mappedError,
      originalErrorType: marker,
      willBeSentToFrontend: true,
      trace_id: "synthetic-trace",
    },
    "Returning mapped error to frontend via stream",
  );
  logger.error(
    { stringifyError: new Error(marker), hasError: true },
    "Failed to stringify mapped error",
  );
  expect(JSON.stringify(records)).not.toContain(marker);
  expect(records[0]).toMatchObject({
    mappedError: { isRetryable: true, originalError: { statusCode: 503 } },
    trace_id: "synthetic-trace",
  });
  expect(records[1]).toMatchObject({
    stringifyError: { type: "Error" },
    hasError: true,
  });
  expect(mappedError.message).toBe(marker);
});

test("metadata-only withholds standalone error aliases while retaining numeric and boolean metadata", () => {
  const { logger, records } = createCapturingLogger("metadata_only");
  const marker = "SYNTHETIC_PRIVATE_PROVIDER_NAME";
  logger.info(
    {
      lastErrorType: marker,
      providerErrorDetails: { message: marker, statusCode: 400 },
      error_description: marker,
      errorCount: 2,
      hasError: true,
    },
    "Provider retry diagnostic",
  );
  expect(JSON.stringify(records)).not.toContain(marker);
  expect(records[0]).toMatchObject({
    errorCount: 2,
    hasError: true,
    providerErrorDetails: { statusCode: 400 },
  });
});

test("metadata-only withholds raw stream and payload diagnostics while full mode retains them", () => {
  const marker = "synthetic-private-malformed-provider-frame";
  const { logger, records } = createCapturingLogger("metadata_only");
  logger.warn(
    {
      error: new SyntaxError(marker),
      line: `data: ${marker}`,
      dataLength: marker.length,
    },
    "Failed to parse SSE chunk from Zhipu",
  );
  logger.info(
    {
      data: marker,
      linePreview: marker,
      event: marker,
      chunk: { text: marker },
      body: marker,
      request: { messages: [marker] },
      response: { content: marker },
    },
    "Unparseable provider frame",
  );
  expect(JSON.stringify(records)).not.toContain(marker);
  expect(records[0]).toMatchObject({
    error: { type: "SyntaxError" },
    dataLength: marker.length,
  });
  const full = createCapturingLogger("full");
  full.logger.warn(
    { error: new SyntaxError(marker), line: marker },
    "Failed to parse SSE chunk",
  );
  expect(JSON.stringify(full.records)).toContain(marker);
});

test("metadata-only withholds raw provider usage without mutating accounting input", () => {
  const marker = "synthetic-private-malformed-usage";
  const usage = {
    prompt_tokens: marker,
    completion_tokens: 7,
    total_tokens: marker,
  };
  const { logger, records } = createCapturingLogger("metadata_only");
  logger.warn(
    {
      usage,
      usagePresent: true,
      status: "failed",
      incompleteReason: "unknown",
    },
    "Codex subscription response ended without completing",
  );
  expect(JSON.stringify(records)).not.toContain(marker);
  expect(records[0]).toMatchObject({ usagePresent: true, status: "failed" });
  expect(usage).toEqual({
    prompt_tokens: marker,
    completion_tokens: 7,
    total_tokens: marker,
  });
  const full = createCapturingLogger("full");
  full.logger.warn({ usage }, "Provider failed");
  expect(JSON.stringify(full.records)).toContain(marker);
});

describe("metadata-only database failures", () => {
  test("keeps database diagnostics, not SQL values, under error aliases and nested causes", () => {
    const { logger, records } = createCapturingLogger("metadata_only");
    const marker = "synthetic-private-database-value";
    const cause = Object.assign(new Error(`invalid input: ${marker}`), {
      code: "23514",
      severity: "ERROR",
      constraint: "messages_content_check",
      detail: marker,
      where: marker,
      internalQuery: `select '${marker}'`,
    });
    const error = new DrizzleQueryError(
      `insert into messages (content) values ($1) /* ${marker} */`,
      [marker, { text: marker }],
      cause,
    );
    const original = {
      message: error.message,
      stack: error.stack,
      params: error.params,
    };
    logger.error(
      { err: error, conversationId: "synthetic-id" },
      "Persistence failed",
    );
    logger.error({ error }, "Persistence failed");
    logger.error({ persistError: error }, "Persistence failed");
    logger.error(
      { error: new Error(`wrapper ${marker}`, { cause: error }) },
      "Persistence failed",
    );
    logger.error(error);
    expect(JSON.stringify(records)).not.toContain(marker);
    const expected = {
      type: "DrizzleQueryError",
      statement: "INSERT",
      parameterCount: 2,
      cause: {
        code: "23514",
        severity: "ERROR",
        constraint: "messages_content_check",
      },
    };
    expect(records[0]).toMatchObject({
      conversationId: "synthetic-id",
      err: expected,
    });
    expect(records[1].error).toMatchObject(expected);
    expect(records[2].persistError).toMatchObject(expected);
    expect(records[3].error).toMatchObject({ cause: expected });
    expect(records[4].err).toMatchObject(expected);
    expect(error).toMatchObject(original);
    expect(error.cause).toBe(cause);
    expect(cause.detail).toBe(marker);
  });

  test("withholds failed-query values copied into messages, other keys, nested values and child bindings", () => {
    const { logger, records } = createCapturingLogger("metadata_only");
    const marker = "synthetic-private-chat-text";
    const error = new DrizzleQueryError(
      'insert into "messages" ("content") values ($1)',
      [JSON.stringify({ parts: [{ type: "text", text: marker }] })],
      Object.assign(new Error("canceling statement due to statement timeout"), {
        code: "57014",
      }),
    );
    const expected = {
      type: "DrizzleQueryError",
      statement: "INSERT",
      parameterCount: 1,
      cause: { code: "57014" },
    };
    logger.error({ err: error }, error.message);
    logger.error(`Error updating limit: ${error}`);
    logger.error("Persist failed: %s (%o)", error, { cause: error });
    logger.warn({
      e: error,
      persistErr: error,
      reason: error.message,
      results: [{ status: "rejected", reason: error }],
      conversationId: "synthetic-id",
    });
    logger
      .child({ dbErr: error })
      .child({ reason: `${error}` })
      .info("run");
    expect(JSON.stringify(records)).not.toContain(marker);
    expect(records[0]).toMatchObject({
      err: expected,
      msg: "Failed query: INSERT [not stored: log content mode]",
    });
    expect(records[1].msg).toBe(
      "Error updating limit: Error: Failed query: INSERT [not stored: log content mode]",
    );
    expect(records[2].msg).toContain(
      "Persist failed: DrizzleQueryError: [not stored: log content mode]",
    );
    expect(records[3]).toMatchObject({
      e: expected,
      persistErr: expected,
      reason: "Failed query: INSERT [not stored: log content mode]",
      results: [{ status: "rejected", reason: expected }],
      conversationId: "synthetic-id",
    });
    expect(records[4]).toMatchObject({
      dbErr: expected,
      reason: "Error: Failed query: INSERT [not stored: log content mode]",
    });
  });

  test("leaves ordinary context untouched while scrubbing nested values", () => {
    const { logger, records } = createCapturingLogger("metadata_only");
    const circular: Record<string, unknown> = { id: "synthetic-id" };
    circular.self = circular;
    logger.info(
      {
        conversationId: "synthetic-id",
        ids: [1, 2],
        at: new Date(0),
        circular,
      },
      "Synced %d rows for %s",
      2,
      "synthetic-run",
    );
    expect(records[0]).toMatchObject({
      conversationId: "synthetic-id",
      ids: [1, 2],
      at: "1970-01-01T00:00:00.000Z",
      circular: { id: "synthetic-id" },
      msg: "Synced 2 rows for synthetic-run",
    });
  });

  test("does not treat provider codes or malformed database fields as safe metadata", () => {
    const { logger, records } = createCapturingLogger("metadata_only");
    const cause = Object.assign(new Error("private"), {
      code: "private-value",
      severity: "private-value",
      constraint: "private value",
    });
    logger.error({
      err: new DrizzleQueryError("unknown private SQL", [], cause),
    });
    logger.error({
      err: Object.assign(new Error("provider"), { code: "ABCDE" }),
    });
    expect(records[0].err).toEqual({
      type: "DrizzleQueryError",
      parameterCount: 0,
      cause: { type: "Error" },
    });
    expect(records[1].err).toEqual({ type: "Error" });
  });

  test("preserves existing full-mode database diagnostics", () => {
    const { logger, records } = createCapturingLogger("full");
    const marker = "synthetic-full-mode-db-value";
    const error = new DrizzleQueryError(
      "select $1",
      [marker],
      new Error("failed"),
    );
    logger.error({ err: error });
    logger.error(`Lookup failed: ${error}`);
    logger.child({ dbErr: error }).error("Lookup failed");
    expect(records).toHaveLength(3);
    for (const record of records)
      expect(JSON.stringify(record)).toContain(marker);
  });
});
