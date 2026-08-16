import type { UIMessage } from "@ai-sdk/react";
import { DUAL_LLM_ANALYSIS_PART_TYPE } from "@archestra/shared";
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  TRANSPORT_STALL_THRESHOLD_SECONDS,
  UPSTREAM_IDLE_THRESHOLD_SECONDS,
  useStreamStall,
} from "./stream-stall.hook";

/** Matches the backend's `data-heartbeat` cadence while a run is open. */
const HEARTBEAT_SECONDS = 5;

type StallProps = {
  status: "ready" | "submitted" | "streaming" | "error";
  transportActivitySequence: number;
  responseProgressSequence: number;
  messages: UIMessage[];
};

function userTurn(): UIMessage[] {
  return [
    {
      id: "user-1",
      role: "user",
      parts: [{ type: "text", text: "hi" }],
    } as UIMessage,
  ];
}

function assistantTurn(parts: unknown[]): UIMessage[] {
  return [
    ...userTurn(),
    { id: "assistant-1", role: "assistant", parts } as unknown as UIMessage,
  ];
}

function answeredTurn(text = "Hey! What can I help you with today?") {
  return assistantTurn([{ type: "text", text }]);
}

function renderStall(props: StallProps) {
  return renderHook((next: StallProps) => useStreamStall(next), {
    initialProps: props,
  });
}

/**
 * Advances the clock the way a live run does: the backend writes a heartbeat
 * every 5s, which advances the transport signal only. Response progress stays
 * where the caller left it.
 */
function beat(
  rerender: (props: StallProps) => void,
  props: StallProps,
  seconds: number,
): StallProps {
  let current = props;
  for (let elapsed = 0; elapsed < seconds; elapsed += HEARTBEAT_SECONDS) {
    act(() => vi.advanceTimersByTime(HEARTBEAT_SECONDS * 1000));
    current = {
      ...current,
      transportActivitySequence: current.transportActivitySequence + 1,
    };
    rerender(current);
  }
  return current;
}

describe("useStreamStall", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it("reports a stalled transport when nothing at all arrives", () => {
    const { result } = renderStall({
      status: "streaming",
      transportActivitySequence: 0,
      responseProgressSequence: 0,
      messages: userTurn(),
    });

    act(() =>
      vi.advanceTimersByTime(TRANSPORT_STALL_THRESHOLD_SECONDS * 1000 - 1),
    );
    expect(result.current.isTransportStalled).toBe(false);

    act(() => vi.advanceTimersByTime(1));
    expect(result.current.isTransportStalled).toBe(true);
    // A dead connection is only reported once, by the loud banner.
    expect(result.current.isUpstreamIdle).toBe(false);
  });

  it("reports an idle upstream when heartbeats flow but the turn has not started", () => {
    const props: StallProps = {
      status: "submitted",
      transportActivitySequence: 0,
      responseProgressSequence: 0,
      messages: userTurn(),
    };
    const { result, rerender } = renderStall(props);

    const beaten = beat(
      rerender,
      props,
      UPSTREAM_IDLE_THRESHOLD_SECONDS - HEARTBEAT_SECONDS,
    );
    expect(result.current.isUpstreamIdle).toBe(false);

    beat(rerender, beaten, HEARTBEAT_SECONDS);
    expect(result.current.isTransportStalled).toBe(false);
    expect(result.current.isUpstreamIdle).toBe(true);
  });

  it("stays quiet once the answer has rendered, however long the run then hangs", () => {
    // The reported bug: the model streams a complete reply, the run stays open,
    // and heartbeats — which are not response progress — hold it open. The old
    // warning appeared above the finished answer and never went away.
    const props: StallProps = {
      status: "streaming",
      transportActivitySequence: 5,
      responseProgressSequence: 5,
      messages: answeredTurn(),
    };
    const { result, rerender } = renderStall(props);

    beat(rerender, props, UPSTREAM_IDLE_THRESHOLD_SECONDS * 5);

    expect(result.current.isTransportStalled).toBe(false);
    expect(result.current.isUpstreamIdle).toBe(false);
  });

  it("clears an already-visible idle notice the moment the first token lands", () => {
    const props: StallProps = {
      status: "streaming",
      transportActivitySequence: 1,
      responseProgressSequence: 1,
      messages: userTurn(),
    };
    const { result, rerender } = renderStall(props);

    const beaten = beat(rerender, props, UPSTREAM_IDLE_THRESHOLD_SECONDS);
    expect(result.current.isUpstreamIdle).toBe(true);

    rerender({
      ...beaten,
      transportActivitySequence: beaten.transportActivitySequence + 1,
      responseProgressSequence: beaten.responseProgressSequence + 1,
      messages: answeredTurn("Hey"),
    });
    expect(result.current.isUpstreamIdle).toBe(false);
  });

  it("ignores an empty assistant shell opened before any content arrives", () => {
    const props: StallProps = {
      status: "streaming",
      transportActivitySequence: 1,
      responseProgressSequence: 1,
      messages: assistantTurn([]),
    };
    const { result, rerender } = renderStall(props);

    beat(rerender, props, UPSTREAM_IDLE_THRESHOLD_SECONDS);
    expect(result.current.isUpstreamIdle).toBe(true);
  });

  it.each([
    [
      "a pending tool call",
      {
        type: "dynamic-tool",
        toolName: "search",
        toolCallId: "call-1",
        state: "input-available",
        input: {},
      },
    ],
    [
      "a dual LLM analysis block",
      {
        type: DUAL_LLM_ANALYSIS_PART_TYPE,
        id: "call-1",
        data: {
          toolCallId: "call-1",
          toolName: "search",
          status: "analyzing",
          rounds: [],
        },
      },
    ],
  ])("treats %s as rendered output", (_label, part) => {
    const props: StallProps = {
      status: "streaming",
      transportActivitySequence: 1,
      responseProgressSequence: 1,
      messages: assistantTurn([part]),
    };
    const { result, rerender } = renderStall(props);

    beat(rerender, props, UPSTREAM_IDLE_THRESHOLD_SECONDS);
    expect(result.current.isUpstreamIdle).toBe(false);
  });

  it("drops both signals as soon as the run ends", () => {
    const props: StallProps = {
      status: "streaming",
      transportActivitySequence: 0,
      responseProgressSequence: 0,
      messages: userTurn(),
    };
    const { result, rerender } = renderStall(props);

    act(() => vi.advanceTimersByTime(TRANSPORT_STALL_THRESHOLD_SECONDS * 1000));
    expect(result.current.isTransportStalled).toBe(true);

    rerender({ ...props, status: "ready", messages: answeredTurn() });
    expect(result.current.isTransportStalled).toBe(false);
    expect(result.current.isUpstreamIdle).toBe(false);
  });
});
