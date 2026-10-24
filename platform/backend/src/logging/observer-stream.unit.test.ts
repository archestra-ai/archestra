import {
  InMemoryLogRecordExporter,
  LoggerProvider,
  SimpleLogRecordProcessor,
} from "@opentelemetry/sdk-logs";
import { expect, test } from "vitest";
import { createLogger } from "./create-logger";
import { createLogObserverStream } from "./observer-stream";

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
  } finally {
    await provider.shutdown();
  }
});
