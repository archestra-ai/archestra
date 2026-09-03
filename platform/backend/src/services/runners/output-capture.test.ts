import { describe, expect, test, vi } from "@/test";
import type { AgentRun } from "@/types";
import type { RunnerBackend } from "./backends";
import { RETAINED_LOG_BYTES, RunnerOutputCapture } from "./output-capture";

describe("RunnerOutputCapture", () => {
  test("recovers the complete transcript after the live stream ends early", async () => {
    const onTextDelta = vi.fn();
    const backend = outputBackend({
      live: "session protected\n",
      snapshot: "session protected\nwork completed\n",
    });
    const capture = new RunnerOutputCapture({
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
    const capture = new RunnerOutputCapture({ backend, session });

    await capture.follow();
    await capture.recoverSnapshot();

    expect(capture.transcript).toBe("partial but useful\n");
    expect(capture.retainedLogs).toBe("partial but useful\n");
  });

  test("keeps the final tail but marks the complete transcript unavailable past the safety ceiling", async () => {
    const capture = new RunnerOutputCapture({
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
    const capture = new RunnerOutputCapture({
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
});

const session = {
  id: "run-1",
} as AgentRun;

function outputBackend(params: {
  live: string;
  snapshot?: string;
  snapshotError?: Error;
}): Pick<RunnerBackend, "streamOutput" | "snapshotOutput"> {
  return {
    async streamOutput({ destination }) {
      destination.end(params.live);
    },
    async snapshotOutput({ destination }) {
      if (params.snapshotError) throw params.snapshotError;
      destination.end(params.snapshot ?? "");
    },
  };
}
