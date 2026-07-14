import { describe, expect, it } from "vitest";
import { classifyChatSubmitAction } from "@/lib/chat/chat-submit-action";

describe("classifyChatSubmitAction", () => {
  it("sends when idle with an empty pipeline", () => {
    expect(
      classifyChatSubmitAction({
        status: "ready",
        queueEnabled: true,
        directSendPending: false,
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
      }),
    ).toBe("send");
  });
});
