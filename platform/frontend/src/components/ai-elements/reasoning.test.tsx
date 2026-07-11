import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
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
});
