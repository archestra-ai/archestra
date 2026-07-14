import { act, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { Reasoning, ReasoningTrigger } from "./reasoning";

describe("Reasoning trigger label", () => {
  it("does not stay pinned on 'Thinking…' for a non-streaming block with no duration", () => {
    render(
      <Reasoning>
        <ReasoningTrigger />
      </Reasoning>,
    );

    expect(screen.queryByText("Thinking...")).not.toBeInTheDocument();
    expect(screen.getByText(/Thought for/)).toBeInTheDocument();
  });

  it("shows 'Thinking…' while the block is streaming", () => {
    render(
      <Reasoning isStreaming>
        <ReasoningTrigger />
      </Reasoning>,
    );

    expect(screen.getByText("Thinking...")).toBeInTheDocument();
  });

  it("switches to the measured duration once streaming ends", () => {
    vi.useFakeTimers();
    try {
      const { rerender } = render(
        <Reasoning isStreaming>
          <ReasoningTrigger />
        </Reasoning>,
      );
      expect(screen.getByText("Thinking...")).toBeInTheDocument();

      act(() => {
        vi.advanceTimersByTime(3000);
      });
      rerender(
        <Reasoning isStreaming={false}>
          <ReasoningTrigger />
        </Reasoning>,
      );

      expect(screen.getByText(/Thought for 3 seconds/)).toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });
});
