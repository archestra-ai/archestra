import { describe, expect, test } from "@/test";
import { logRingBuffer } from "./log-ring-buffer";

function write(record: Record<string, unknown>): void {
  const stream = logRingBuffer.createStream();
  stream.write(Buffer.from(`${JSON.stringify(record)}\n`));
}

describe("logRingBuffer", () => {
  test("returns recent records in chronological order, trimmed to fields", () => {
    write({ time: 1, level: 30, msg: "first", trace_id: "t1" });
    write({ time: 2, level: 50, msg: "second", trace_id: "t1" });

    const recent = logRingBuffer.getRecent({ traceId: "t1", limit: 10 });
    expect(recent).toEqual([
      { time: 1, level: 30, levelLabel: "info", msg: "first", traceId: "t1" },
      {
        time: 2,
        level: 50,
        levelLabel: "error",
        msg: "second",
        traceId: "t1",
      },
    ]);
  });

  test("filters by trace id and session id", () => {
    write({ time: 1, level: 30, msg: "trace-a", trace_id: "trace-a" });
    write({ time: 2, level: 30, msg: "trace-b", trace_id: "trace-b" });
    write({ time: 3, level: 30, msg: "session-x", session_id: "sess-x" });

    expect(
      logRingBuffer
        .getRecent({ traceId: "trace-b", limit: 10 })
        .map((r) => r.msg),
    ).toEqual(["trace-b"]);
    expect(
      logRingBuffer
        .getRecent({ sessionId: "sess-x", limit: 10 })
        .map((r) => r.msg),
    ).toEqual(["session-x"]);
  });

  test("caps the returned records to the requested limit (newest kept)", () => {
    for (let i = 1; i <= 5; i++) {
      write({ time: i, level: 30, msg: `msg-${i}`, trace_id: "t-limit" });
    }

    expect(
      logRingBuffer
        .getRecent({ traceId: "t-limit", limit: 2 })
        .map((r) => r.msg),
    ).toEqual(["msg-4", "msg-5"]);
  });

  test("ignores non-JSON and shape-invalid chunks", () => {
    const stream = logRingBuffer.createStream();
    stream.write(Buffer.from("not json\n"));
    stream.write(Buffer.from(`${JSON.stringify({ msg: "no level" })}\n`));

    expect(
      logRingBuffer.getRecent({ traceId: "does-not-exist", limit: 10 }),
    ).toEqual([]);
  });
});
