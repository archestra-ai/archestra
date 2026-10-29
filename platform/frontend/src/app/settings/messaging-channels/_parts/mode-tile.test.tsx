import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Globe } from "lucide-react";
import { describe, expect, it, vi } from "vitest";
import { ModeTile } from "./mode-tile";

describe("ModeTile", () => {
  it("calls onSelect when clicked", async () => {
    const onSelect = vi.fn();
    render(
      <ModeTile
        selected={false}
        onSelect={onSelect}
        icon={Globe}
        title="Webhook"
        description="Requires a public URL"
      />,
    );

    await userEvent.click(screen.getByRole("button", { name: /webhook/i }));
    expect(onSelect).toHaveBeenCalledOnce();
  });

  it("exposes selection state via aria-pressed", () => {
    const { rerender } = render(
      <ModeTile
        selected={false}
        onSelect={() => {}}
        icon={Globe}
        title="Webhook"
        description="Requires a public URL"
      />,
    );
    expect(screen.getByRole("button")).toHaveAttribute("aria-pressed", "false");

    rerender(
      <ModeTile
        selected
        onSelect={() => {}}
        icon={Globe}
        title="Webhook"
        description="Requires a public URL"
      />,
    );
    expect(screen.getByRole("button")).toHaveAttribute("aria-pressed", "true");
  });

  it("renders the badge when provided", () => {
    render(
      <ModeTile
        selected={false}
        onSelect={() => {}}
        icon={Globe}
        title="WebSocket"
        badge="Recommended"
        description="No public URL needed"
      />,
    );
    expect(screen.getByText("Recommended")).toBeInTheDocument();
  });
});
