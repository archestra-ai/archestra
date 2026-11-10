import {
  InMemoryLogRecordExporter,
  LoggerProvider,
  SimpleLogRecordProcessor,
} from "@opentelemetry/sdk-logs";
import { APICallError, generateText } from "ai";
import { expect, test } from "vitest";
import { createAzureMediaLanguageModel } from "@/clients/azure-media-language-model";
import { createLogger } from "./create-logger";
import { createLogObserverStream } from "./observer-stream";

test.each([
  "full",
  "metadata_only",
] as const)("%s provider failures omit request content from stdout, retained context and OTEL", async (contentMode) => {
  const prompt = "synthetic-private-conversation-content";
  const submitted: unknown[] = [];
  const model = createAzureMediaLanguageModel({
    modelId: "image-model",
    kind: "image",
    baseURL: "https://provider.example/v1",
    fetch: async (_url, init) => {
      submitted.push(JSON.parse(String(init?.body)));
      return new Response('{"error":{"message":"Model unavailable"}}', {
        status: 503,
      });
    },
  });
  let error: unknown;
  try {
    await generateText({ model, prompt, maxRetries: 0 });
  } catch (caught) {
    error = caught;
  }
  expect(APICallError.isInstance(error)).toBe(true);
  expect(submitted).toEqual([
    expect.objectContaining({ model: "image-model", prompt }),
  ]);

  const exporter = new InMemoryLogRecordExporter();
  const provider = new LoggerProvider({
    processors: [new SimpleLogRecordProcessor({ exporter })],
  });
  const retained: Record<string, unknown>[] = [];
  const stdout: string[] = [];
  try {
    const logger = createLogger({
      contentMode,
      level: "info",
      streams: [
        { stream: { write: (record) => stdout.push(record) } },
        {
          stream: createLogObserverStream({
            logger: provider.getLogger("pino"),
            retain: (record) => retained.push(record),
          }),
        },
      ],
    });
    logger.error(
      { err: error, conversationId: "synthetic-id" },
      "Chat stream failed",
    );
    await provider.forceFlush();
    const exported = exporter.getFinishedLogRecords();
    expect(stdout).toHaveLength(1);
    expect(retained).toHaveLength(1);
    expect(exported).toHaveLength(1);
    expect(retained[0]).toEqual(JSON.parse(stdout[0]));
    expect(retained[0]).toMatchObject({
      conversationId: "synthetic-id",
      err: { statusCode: 503, isRetryable: true },
    });
    expect(exported[0].attributes.err).toMatchObject({ statusCode: 503 });
    expect(JSON.stringify([stdout, retained, exported])).not.toContain(prompt);
    expect(error).toMatchObject({ requestBodyValues: { prompt } });
  } finally {
    await provider.shutdown();
  }
});

test("stdout, retained context and exported OTEL records share credential redaction", async () => {
  const exporter = new InMemoryLogRecordExporter();
  const provider = new LoggerProvider({
    processors: [new SimpleLogRecordProcessor({ exporter })],
  });
  const retained: Record<string, unknown>[] = [];
  const stdout: string[] = [];
  const observer = createLogObserverStream({
    logger: provider.getLogger("pino"),
    retain: (record) => retained.push(record),
  });
  try {
    const logger = createLogger({
      level: "info",
      streams: [
        { stream: { write: (record) => stdout.push(record) } },
        { stream: observer },
      ],
      mixin: () => ({ session_id: "session-a", trace_id: "trace-a" }),
    });
    const input = {
      token: "private-token",
      request: { headers: { authorization: "private-header" } },
      result: 42,
    };
    logger
      .child({ apiKey: "private-binding" })
      .info(input, "request completed");
    await provider.forceFlush();
    const [record] = exporter.getFinishedLogRecords();
    expect(record.body).toBe("request completed");
    expect(record.severityNumber).toBe(9);
    expect(record.severityText).toBe("info");
    expect(record.attributes).toMatchObject({
      session_id: "session-a",
      result: 42,
      token: "[Redacted]",
      apiKey: "[Redacted]",
    });
    expect(retained[0].trace_id).toBe("trace-a");
    expect(retained[0]).toEqual(JSON.parse(stdout[0]));
    expect(JSON.stringify([stdout, retained, record])).not.toMatch(/private-/);
    expect(input.token).toBe("private-token");
    expect(input.request.headers.authorization).toBe("private-header");
    observer.write("invalid JSON");
    observer.write("null");
    observer.write("[]");
    expect(retained).toHaveLength(1);
    const failedRetention = createLogObserverStream({
      logger: provider.getLogger("pino"),
      retain: () => {
        throw new Error("Retention is unavailable");
      },
    });
    failedRetention.write(
      JSON.stringify({ level: 50, msg: "export survives" }),
    );
    await provider.forceFlush();
    expect(exporter.getFinishedLogRecords()[1].body).toBe("export survives");
  } finally {
    await provider.shutdown();
  }
});

test("delayed observer export preserves the record's originating span rather than the current context", async () => {
  const exporter = new InMemoryLogRecordExporter();
  const provider = new LoggerProvider({
    processors: [new SimpleLogRecordProcessor({ exporter })],
  });
  try {
    const stream = createLogObserverStream({
      logger: provider.getLogger("test"),
      retain: () => {},
    });
    stream.write(
      JSON.stringify({
        level: 30,
        msg: "completed",
        trace_id: "11111111111111111111111111111111",
        span_id: "2222222222222222",
        trace_flags: "01",
        session_id: "session-a",
      }),
    );
    await provider.forceFlush();
    expect(exporter.getFinishedLogRecords()[0].spanContext).toMatchObject({
      traceId: "11111111111111111111111111111111",
      spanId: "2222222222222222",
      traceFlags: 1,
    });
  } finally {
    await provider.shutdown();
  }
});

test("metadata-only suppresses echoed provider response text in stdout and OTEL", async () => {
  const exporter = new InMemoryLogRecordExporter();
  const provider = new LoggerProvider({
    processors: [new SimpleLogRecordProcessor({ exporter })],
  });
  const stdout: string[] = [];
  const retained: Record<string, unknown>[] = [];
  const marker = "synthetic-private-echoed-payload";
  try {
    const logger = createLogger({
      level: "info",
      contentMode: "metadata_only",
      streams: [
        { stream: { write: (record) => stdout.push(record) } },
        {
          stream: createLogObserverStream({
            logger: provider.getLogger("pino"),
            retain: (record) => retained.push(record),
          }),
        },
      ],
    });
    logger.error(
      new APICallError({
        message: marker,
        url: "https://provider.example",
        requestBodyValues: { prompt: marker },
        responseBody: marker,
        statusCode: 400,
      }),
    );
    logger.error(
      { statusCode: 400, errorBody: marker, upstreamError: marker },
      "Provider rejected request",
    );
    logger.info(
      {
        rawErrorJson: marker,
        parsedError: { message: marker },
        errorMessage: marker,
      },
      "Mapped provider error",
    );
    logger.error(
      {
        error: marker,
        stack: `Error: ${marker}`,
        code: marker,
        statusCode: 500,
      },
      "HTTP 50x request error occurred",
    );
    logger.warn(
      {
        status: marker,
        incompleteReason: marker,
        errorCode: marker,
        errorMessage: marker,
      },
      "Codex subscription response ended without completing",
    );
    logger.info(
      {
        mappedError: {
          message: marker,
          isRetryable: true,
          originalError: { message: marker, statusCode: 503, raw: marker },
        },
        originalErrorType: marker,
        willBeSentToFrontend: true,
      },
      "Returning mapped error to frontend via stream",
    );
    await provider.forceFlush();
    const exported = exporter.getFinishedLogRecords();
    expect(stdout).toHaveLength(6);
    expect(retained).toHaveLength(6);
    expect(exported).toHaveLength(6);
    expect(JSON.stringify([stdout, retained, exported])).not.toContain(marker);
    expect(exported[0].attributes.err).toMatchObject({ statusCode: 400 });
  } finally {
    await provider.shutdown();
  }
});
