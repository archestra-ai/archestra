import type { Writable } from "node:stream";
import { describe, expect, test, vi } from "@/test";
import type { AgentRunRecord } from "@/types";
import type { AgentRuntimeBackendDriver } from "./backends";
import {
  AgentRuntimeOutputCapture,
  RETAINED_LOG_BYTES,
} from "./output-capture";
import {
  AGENT_RUNTIME_READABLE_TRANSCRIPT_PROTOCOL_END,
  AGENT_RUNTIME_READABLE_TRANSCRIPT_PROTOCOL_START,
} from "./runtime-contract";

describe("AgentRuntimeOutputCapture", () => {
  test("bounds response previews while retaining terminal output and the final answer", async () => {
    const onTextDelta = vi.fn();
    const prefix = "x".repeat(64 * 1024 - 1);
    const final =
      "\n===ARCHESTRA-FINAL-ANSWER===\nThe workflow passed.\n===ARCHESTRA-FINAL-ANSWER-END===\n";
    const chunks = [prefix, "🦞".repeat(20_000), "later repaint", final];
    const transcript = chunks.join("");
    const capture = new AgentRuntimeOutputCapture({
      backend: outputBackend({ liveChunks: chunks, snapshot: transcript }),
      session,
      onTextDelta,
    });

    await capture.follow();
    expect(onTextDelta.mock.calls.flat().join("")).toBe(prefix);
    expect(capture.completeTranscript).toBe(transcript);
    await capture.recoverSnapshot();
    expect(capture.completeTranscript).toBe(transcript);
    expect(capture.retainedLogs).toContain("The workflow passed.");
    expect(onTextDelta).toHaveBeenCalledOnce();
  });

  test("a late live-stream close cannot overwrite the final readable snapshot", async () => {
    const readable = JSON.stringify({
      version: 1,
      provider: "archestra-agent",
      entries: [
        { type: "message", role: "assistant", text: "Retained answer" },
      ],
    });
    let live: Writable | undefined;
    const backend = outputBackend({
      snapshot: `complete${AGENT_RUNTIME_READABLE_TRANSCRIPT_PROTOCOL_START}${Buffer.from(readable).toString("base64")}${AGENT_RUNTIME_READABLE_TRANSCRIPT_PROTOCOL_END}`,
    });
    backend.streamOutput = async ({ destination }) => {
      live = destination;
      destination.write("partial");
    };
    const capture = new AgentRuntimeOutputCapture({ backend, session });
    const following = capture.follow();
    await capture.recoverSnapshot();
    live?.end("late bytes");
    await following;
    expect(capture.completeTranscript).toBe("complete");
    expect(capture.readableTranscript).toBe(readable);
  });

  test("recovers the complete transcript after the live stream ends early", async () => {
    const onTextDelta = vi.fn();
    const backend = outputBackend({
      live: "session protected\n",
      snapshot: "session protected\nwork completed\n",
    });
    const capture = new AgentRuntimeOutputCapture({
      backend,
      session,
      onTextDelta,
    });

    await capture.follow();
    expect(capture.transcript).toBe("session protected\n");

    await capture.recoverSnapshot();

    expect(capture.transcript).toBe("session protected\nwork completed\n");
    expect(capture.retainedLogs).toBe("session protected\nwork completed\n");
    expect(onTextDelta).toHaveBeenCalledOnce();
    expect(onTextDelta).toHaveBeenCalledWith("session protected\n");
  });

  test("retains streamed output when the final snapshot is unavailable", async () => {
    const backend = outputBackend({
      live: "partial but useful\n",
      snapshotError: new Error("pod disappeared"),
    });
    const capture = new AgentRuntimeOutputCapture({ backend, session });

    await capture.follow();
    await capture.recoverSnapshot();

    expect(capture.transcript).toBe("partial but useful\n");
    expect(capture.retainedLogs).toBe("partial but useful\n");
  });

  test("keeps the final tail but marks the complete transcript unavailable past the safety ceiling", async () => {
    const capture = new AgentRuntimeOutputCapture({
      backend: outputBackend({
        live: "first line\nsecond line\nfinal answer\n",
      }),
      session,
      maxTranscriptBytes: 20,
    });

    await capture.follow();

    expect(capture.completeTranscript).toBeNull();
    expect(capture.observedTranscriptBytes).toBe(36);
    expect(capture.transcript).toBe("first line\nsecond line\nfinal answer\n");
    expect(capture.retainedLogs).toBe(
      "first line\nsecond line\nfinal answer\n",
    );
  });

  test("bounds the fallback tail when the complete transcript is too large", async () => {
    const finalLine = "\nfinal answer\n";
    const capture = new AgentRuntimeOutputCapture({
      backend: outputBackend({
        live: `${"x".repeat(RETAINED_LOG_BYTES)}${finalLine}`,
      }),
      session,
      maxTranscriptBytes: 20,
    });

    await capture.follow();

    expect(capture.completeTranscript).toBeNull();
    expect(Buffer.byteLength(capture.retainedLogs)).toBe(RETAINED_LOG_BYTES);
    expect(capture.retainedLogs.endsWith(finalLine)).toBe(true);
  });

  test("separates a normalized readable transcript from terminal output", async () => {
    const readable = JSON.stringify({
      version: 1,
      provider: "claude-code",
      entries: [
        { type: "message", role: "user", text: "Start here" },
        { type: "message", role: "assistant", text: "Finished there" },
      ],
    });
    const encoded = Buffer.from(readable).toString("base64");
    const protocol = `${AGENT_RUNTIME_READABLE_TRANSCRIPT_PROTOCOL_START}${encoded}${AGENT_RUNTIME_READABLE_TRANSCRIPT_PROTOCOL_END}`;
    const onTextDelta = vi.fn();
    const capture = new AgentRuntimeOutputCapture({
      backend: outputBackend({
        liveChunks: [
          `terminal beginning\n${protocol.slice(0, 17)}`,
          protocol.slice(17, -11),
          `${protocol.slice(-11)}terminal end\n`,
        ],
      }),
      session,
      onTextDelta,
    });

    await capture.follow();

    expect(capture.completeTranscript).toBe(
      "terminal beginning\nterminal end\n",
    );
    expect(capture.retainedLogs).toBe("terminal beginning\nterminal end\n");
    expect(JSON.parse(capture.readableTranscript ?? "")).toEqual(
      JSON.parse(readable),
    );
    expect(onTextDelta.mock.calls.flat().join("")).toBe(
      "terminal beginning\nterminal end\n",
    );
  });

  test("ignores malformed readable transcript protocol", async () => {
    const capture = new AgentRuntimeOutputCapture({
      backend: outputBackend({
        live: `before\n${AGENT_RUNTIME_READABLE_TRANSCRIPT_PROTOCOL_START}${Buffer.from("not json").toString("base64")}${AGENT_RUNTIME_READABLE_TRANSCRIPT_PROTOCOL_END}after\n`,
      }),
      session,
    });

    await capture.follow();

    expect(capture.readableTranscript).toBeNull();
    expect(capture.completeTranscript).toBe("before\nafter\n");
  });

  test("discards an unfinished readable frame without leaking it into terminal output", async () => {
    const capture = new AgentRuntimeOutputCapture({
      backend: outputBackend({
        live: `before\n${AGENT_RUNTIME_READABLE_TRANSCRIPT_PROTOCOL_START}${Buffer.from('{"version":1}').toString("base64")}`,
      }),
      session,
    });
    await capture.follow();
    expect(capture.readableTranscript).toBeNull();
    expect(capture.completeTranscript).toBe("before\n");
  });
});

const session = {
  id: "run-1",
} as AgentRunRecord;

function outputBackend(params: {
  live?: string;
  liveChunks?: string[];
  snapshot?: string;
  snapshotError?: Error;
}): Pick<AgentRuntimeBackendDriver, "streamOutput" | "snapshotOutput"> {
  return {
    async streamOutput({ destination }) {
      for (const chunk of params.liveChunks ?? [params.live ?? ""]) {
        destination.write(chunk);
      }
      destination.end();
    },
    async snapshotOutput({ destination }) {
      if (params.snapshotError) throw params.snapshotError;
      destination.end(params.snapshot ?? "");
    },
  };
}
