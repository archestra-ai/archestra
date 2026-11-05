import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import {
  resolveSuggestionPreview,
  SuggestedPromptPills,
} from "./suggested-prompt-pills";

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

describe("resolveSuggestionPreview", () => {
  it("keeps a hovered prompt that the agent still offers", () => {
    expect(resolveSuggestionPreview(PROMPTS, PROMPTS[1].prompt)).toBe(
      PROMPTS[1].prompt,
    );
  });

  it("drops a hovered prompt once the suggestions no longer offer it", () => {
    expect(
      resolveSuggestionPreview(
        [{ summaryTitle: "Plan a sprint", prompt: "Plan our sprint." }],
        PROMPTS[0].prompt,
      ),
    ).toBeNull();
    expect(resolveSuggestionPreview(undefined, PROMPTS[0].prompt)).toBeNull();
  });
});
