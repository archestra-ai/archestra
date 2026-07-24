import { act, fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { Reasoning, ReasoningContent, ReasoningTrigger } from "./reasoning";

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

describe("Reasoning auto-collapse", () => {
  it("mounts a persisted block collapsed and never auto-collapses it", () => {
    vi.useFakeTimers();
    try {
      render(
        <Reasoning>
          <ReasoningTrigger />
          <ReasoningContent>persisted thinking</ReasoningContent>
        </Reasoning>,
      );

      const trigger = screen.getByRole("button");
      expect(trigger).toHaveAttribute("aria-expanded", "false");

      act(() => {
        vi.advanceTimersByTime(5000);
      });
      expect(trigger).toHaveAttribute("aria-expanded", "false");
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps a manually expanded persisted block open", () => {
    vi.useFakeTimers();
    try {
      render(
        <Reasoning>
          <ReasoningTrigger />
          <ReasoningContent>persisted thinking</ReasoningContent>
        </Reasoning>,
      );

      const trigger = screen.getByRole("button");
      fireEvent.click(trigger);
      expect(trigger).toHaveAttribute("aria-expanded", "true");

      act(() => {
        vi.advanceTimersByTime(5000);
      });
      expect(trigger).toHaveAttribute("aria-expanded", "true");
    } finally {
      vi.useRealTimers();
    }
  });

  it("mounts a live block open and collapses it shortly after streaming ends", () => {
    vi.useFakeTimers();
    try {
      const { rerender } = render(
        <Reasoning isStreaming>
          <ReasoningTrigger />
          <ReasoningContent>live thinking</ReasoningContent>
        </Reasoning>,
      );

      const trigger = screen.getByRole("button");
      expect(trigger).toHaveAttribute("aria-expanded", "true");

      rerender(
        <Reasoning isStreaming={false}>
          <ReasoningTrigger />
          <ReasoningContent>live thinking</ReasoningContent>
        </Reasoning>,
      );
      expect(trigger).toHaveAttribute("aria-expanded", "true");

      act(() => {
        vi.advanceTimersByTime(1000);
      });
      expect(trigger).toHaveAttribute("aria-expanded", "false");
    } finally {
      vi.useRealTimers();
    }
  });
});
