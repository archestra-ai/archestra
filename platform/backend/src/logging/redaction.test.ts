import { Writable } from "node:stream";
import pino from "pino";
import { describe, expect, test } from "@/test";
import { REDACTED_LOG_PATHS, serializeErrorBounded } from "./redaction";

/**
 * Builds a pino logger with the same redact/serializer options the real
 * logger uses (see ./index.ts), writing into an in-memory sink so tests can
 * assert on the exact records that would reach stdout/OTLP.
 */
function createCapturingLogger() {
  const records: Record<string, unknown>[] = [];
  const sink = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      records.push(JSON.parse(chunk.toString()));
      callback();
    },
  });
  const logger = pino(
    {
      redact: { paths: REDACTED_LOG_PATHS, censor: "[Redacted]" },
      serializers: {
        err: serializeErrorBounded,
        error: serializeErrorBounded,
      },
      base: undefined,
    },
    sink,
  );
  return { logger, records };
}

describe("log redaction", () => {
  test("censors credential keys at the top level", () => {
    const { logger, records } = createCapturingLogger();

    logger.info(
      { authorization: "Bearer abc", token: "tok_123", userId: "u1" },
      "msg",
    );

    expect(records[0].authorization).toBe("[Redacted]");
    expect(records[0].token).toBe("[Redacted]");
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
