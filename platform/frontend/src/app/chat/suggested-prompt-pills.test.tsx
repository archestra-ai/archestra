import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { SuggestedPromptPills } from "./suggested-prompt-pills";

const PROMPTS = [
  {
    summaryTitle: "Draw something",
    prompt: "Draw me a diagram of how our MCP gateway routes a tool call.",
  },
  {
    summaryTitle: "What's in beta",
    prompt: "Summarize what shipped in the current beta release line.",
  },
];

describe("SuggestedPromptPills", () => {
  it("previews the hovered suggestion's full prompt and drops it on leave", async () => {
    const user = userEvent.setup();
    const onPreviewChange = vi.fn();

    render(
      <SuggestedPromptPills
        prompts={PROMPTS}
        onSelect={vi.fn()}
        onPreviewChange={onPreviewChange}
      />,
    );

    const pill = screen.getByRole("button", { name: "Draw something" });
    await user.hover(pill);

    expect(onPreviewChange).toHaveBeenLastCalledWith(PROMPTS[0].prompt);

    await user.unhover(pill);

    expect(onPreviewChange).toHaveBeenLastCalledWith(null);
  });

  it("drops the preview when another agent's suggestions replace the pills", async () => {
    const user = userEvent.setup();
    const onPreviewChange = vi.fn();

    const { rerender } = render(
      <SuggestedPromptPills
        key="agent-a"
        prompts={PROMPTS}
        onSelect={vi.fn()}
        onPreviewChange={onPreviewChange}
      />,
    );

    await user.hover(screen.getByRole("button", { name: "Draw something" }));

    expect(onPreviewChange).toHaveBeenLastCalledWith(PROMPTS[0].prompt);

    rerender(
      <SuggestedPromptPills
        key="agent-b"
        prompts={[
          { summaryTitle: "Plan a sprint", prompt: "Plan our sprint." },
        ]}
        onSelect={vi.fn()}
        onPreviewChange={onPreviewChange}
      />,
    );

    expect(onPreviewChange).toHaveBeenLastCalledWith(null);
  });

  it("sends the full prompt on click and clears the preview with it", async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    const onPreviewChange = vi.fn();

    render(
      <SuggestedPromptPills
        prompts={PROMPTS}
        onSelect={onSelect}
        onPreviewChange={onPreviewChange}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Draw something" }));

    expect(onSelect).toHaveBeenCalledWith(PROMPTS[0]);
    expect(onPreviewChange).toHaveBeenLastCalledWith(null);
  });
});
