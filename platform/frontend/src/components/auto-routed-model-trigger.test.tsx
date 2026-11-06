import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type React from "react";
import { describe, expect, test, vi } from "vitest";
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

    const trigger = screen.getByRole("button", { name: /Auto/ });
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
    expect(tooltip).not.toHaveTextContent("provider API key");
  });

  test("does not submit the surrounding agent form when clicked or pressed", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn((event: React.FormEvent) => event.preventDefault());
    render(
      <form onSubmit={onSubmit}>
        <AutoRoutedModelTrigger tiers={tiers} />
      </form>,
    );

    const trigger = screen.getByRole("button", { name: /Auto/ });
    await user.click(trigger);
    trigger.focus();
    await user.keyboard("{Enter}");
    await user.keyboard(" ");

    expect(onSubmit).not.toHaveBeenCalled();
  });
});
