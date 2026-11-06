import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, test } from "vitest";
import { AutoRoutedModelTrigger } from "@/components/auto-routed-model-trigger";

const tiers = {
  fast: { id: "fast", provider: "anthropic", displayName: "Claude Haiku 5.5" },
  normal: {
    id: "normal",
    provider: "anthropic",
    displayName: "Claude Sonnet 5.5",
  },
  smart: { id: "smart", provider: "anthropic", displayName: "Claude Opus 5.5" },
} as const;

describe("AutoRoutedModelTrigger", () => {
  test("names the routing in short text and lists each routed model on hover", async () => {
    const user = userEvent.setup();
    render(<AutoRoutedModelTrigger tiers={tiers} />);

    const trigger = screen.getByRole("button", { name: /Auto routed/ });
    expect(trigger).toHaveAttribute("aria-disabled", "true");
    expect(trigger).not.toHaveTextContent("Claude");

    await user.hover(trigger);

    const tooltip = await screen.findByRole("tooltip");
    for (const [model, tier] of [
      ["Claude Haiku 5.5", "Fast"],
      ["Claude Sonnet 5.5", "Normal"],
      ["Claude Opus 5.5", "Smart"],
    ]) {
      expect(tooltip).toHaveTextContent(model);
      expect(tooltip).toHaveTextContent(tier);
    }
    expect(tooltip).toHaveTextContent("Add a provider API key to pick one.");
  });
});
