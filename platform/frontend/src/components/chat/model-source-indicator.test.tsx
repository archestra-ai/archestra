import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";
import { ModelSourceIndicator } from "./model-source-indicator";

/**
 * The indicator carries no visible words, so its meaning has to reach screen
 * readers through the accessible name, and a model the user picked has to stay
 * resettable from the glyph itself.
 */
describe("ModelSourceIndicator", () => {
  it("names where a default model comes from", () => {
    const { rerender } = render(
      <TooltipProvider>
        <ModelSourceIndicator source="agent" inConversation={false} />
      </TooltipProvider>,
    );
    expect(
      screen.getByRole("img", { name: /configured on this agent/i }),
    ).toBeInTheDocument();

    rerender(
      <TooltipProvider>
        <ModelSourceIndicator source="organization" inConversation />
      </TooltipProvider>,
    );
    expect(
      screen.getByRole("img", { name: /organization's default model/i }),
    ).toBeInTheDocument();
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });

  it("resets a model the user picked", async () => {
    const onReset = vi.fn();
    render(
      <TooltipProvider>
        <ModelSourceIndicator source="user" inConversation onReset={onReset} />
      </TooltipProvider>,
    );

    await userEvent.click(
      screen.getByRole("button", { name: "Reset to the default model" }),
    );
    expect(onReset).toHaveBeenCalledOnce();
  });
});
