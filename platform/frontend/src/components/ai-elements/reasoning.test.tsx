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

describe("Reasoning across a merged run", () => {
  it("sums the streaming bursts and ignores the pause between them", () => {
    vi.useFakeTimers();
    try {
      const { rerender } = render(
        <Reasoning isStreaming keepOpen>
          <ReasoningTrigger />
        </Reasoning>,
      );

      act(() => {
        vi.advanceTimersByTime(3000);
      });
      rerender(
        <Reasoning isStreaming={false} keepOpen>
          <ReasoningTrigger />
        </Reasoning>,
      );
      // Between bursts the 3s measured so far is a partial sum, so the trigger
      // keeps reading "Thinking…" instead of announcing a total it will revise.
      expect(screen.getByText(/Thinking/)).toBeInTheDocument();
      expect(
        screen.queryByText(/Thought for 3 seconds/),
      ).not.toBeInTheDocument();

      // The tool calls the run spans are not thinking time.
      act(() => {
        vi.advanceTimersByTime(20_000);
      });
      rerender(
        <Reasoning isStreaming keepOpen>
          <ReasoningTrigger />
        </Reasoning>,
      );
      act(() => {
        vi.advanceTimersByTime(4000);
      });
      // Something rendered below the run, so it has settled for good.
      rerender(
        <Reasoning isStreaming={false} keepOpen={false}>
          <ReasoningTrigger />
        </Reasoning>,
      );

      expect(screen.getByText(/Thought for 7 seconds/)).toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it("stays open until the run stops growing, then collapses once", () => {
    vi.useFakeTimers();
    try {
      const { rerender } = render(
        <Reasoning isStreaming keepOpen>
          <ReasoningTrigger />
          <ReasoningContent>first pass</ReasoningContent>
        </Reasoning>,
      );

      const trigger = screen.getByRole("button");
      expect(trigger).toHaveAttribute("aria-expanded", "true");

      // Between blocks: this one has stopped streaming, but more may still join.
      rerender(
        <Reasoning isStreaming={false} keepOpen>
          <ReasoningTrigger />
          <ReasoningContent>first pass</ReasoningContent>
        </Reasoning>,
      );
      act(() => {
        vi.advanceTimersByTime(5000);
      });
      expect(trigger).toHaveAttribute("aria-expanded", "true");

      // Something rendered below the run, so it can no longer grow.
      rerender(
        <Reasoning isStreaming={false} keepOpen={false}>
          <ReasoningTrigger />
          <ReasoningContent>first pass and second pass</ReasoningContent>
        </Reasoning>,
      );
      act(() => {
        vi.advanceTimersByTime(1000);
      });

      expect(trigger).toHaveAttribute("aria-expanded", "false");
    } finally {
      vi.useRealTimers();
    }
  });
});
