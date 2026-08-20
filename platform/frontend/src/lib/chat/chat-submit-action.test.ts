import { describe, expect, it } from "vitest";
import { classifyChatSubmitAction } from "@/lib/chat/chat-submit-action";

describe("classifyChatSubmitAction", () => {
  it("sends when idle with an empty pipeline", () => {
    expect(
      classifyChatSubmitAction({
        status: "ready",
        queueEnabled: true,
        directSendPending: false,
        isCompacting: false,
      }),
    ).toBe("send");
  });

  it("queues a submit made while a turn is streaming", () => {
    for (const status of ["submitted", "streaming"]) {
      expect(
        classifyChatSubmitAction({
          status,
          queueEnabled: true,
          directSendPending: false,
          isCompacting: false,
        }),
      ).toBe("queue");
    }
  });

  it("stops instead of queueing when queueing is off and a turn is streaming", () => {
    for (const status of ["submitted", "streaming"]) {
      expect(
        classifyChatSubmitAction({
          status,
          queueEnabled: false,
          directSendPending: false,
          isCompacting: false,
        }),
      ).toBe("stop");
    }
  });

  // The regression: after a direct send fires, the page's `status` still reads
  // "ready" for a render or two. A follow-up submit in that window must queue,
  // not start a second racing direct send (which reaches the model but clobbers
  // the first send's optimistic message so it never renders).
  it("queues a follow-up while a direct send is still settling (status lag)", () => {
    expect(
      classifyChatSubmitAction({
        status: "ready",
        queueEnabled: true,
        directSendPending: true,
        isCompacting: false,
      }),
    ).toBe("queue");
  });

  it("does not treat a settling direct send as reason to queue when queueing is off", () => {
    // With queueing off there is nowhere to queue; the direct-send latch is
    // only ever set when queueing is on, but guard the classification anyway.
    expect(
      classifyChatSubmitAction({
        status: "ready",
        queueEnabled: false,
        directSendPending: true,
        isCompacting: false,
      }),
    ).toBe("send");
  });

  // A manual `/compact` rewrites the thread over REST, so the SDK status stays
  // "ready" for its whole duration. Sending into that races the rewrite; the
  // submit has to queue and drain once compaction settles.
  it("queues a submit made while a compaction is in progress", () => {
    expect(
      classifyChatSubmitAction({
        status: "ready",
        queueEnabled: true,
        directSendPending: false,
        isCompacting: true,
      }),
    ).toBe("queue");
  });

  it("still queues (not stops) when compaction overlaps a streaming turn", () => {
    // Auto-compaction runs inside the turn, so both flags are set at once.
    expect(
      classifyChatSubmitAction({
        status: "streaming",
        queueEnabled: true,
        directSendPending: false,
        isCompacting: true,
      }),
    ).toBe("queue");
  });

  it("sends during compaction when there is no conversation to queue into", () => {
    // Unreachable in practice (compaction needs a conversation), but the
    // classification must never promise a queue that has nowhere to land.
    expect(
      classifyChatSubmitAction({
        status: "ready",
        queueEnabled: false,
        directSendPending: false,
        isCompacting: true,
      }),
    ).toBe("send");
  });
});
