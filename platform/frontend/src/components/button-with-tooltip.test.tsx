import { fireEvent, render, screen } from "@testing-library/react";
import Link from "next/link";
import { describe, expect, it, vi } from "vitest";
import { ButtonWithTooltip } from "./button-with-tooltip";

describe("ButtonWithTooltip", () => {
  it("refuses the click and describes the reason on the control itself", () => {
    // The reason has to reach keyboard and screen reader users, who never open
    // a hover tooltip, so it is rendered as text and carried as the control's
    // description rather than folded into its name.
    const onClick = vi.fn();

    render(
      <ButtonWithTooltip
        disabled
        disabledText="Available to roles with the Agents (create) permission"
        onClick={onClick}
      >
        Create Agent
      </ButtonWithTooltip>,
    );

    const button = screen.getByRole("button", { name: "Create Agent" });
    fireEvent.click(button);

    expect(onClick).not.toHaveBeenCalled();
    expect(button).toHaveAttribute("aria-disabled", "true");
    expect(button).toHaveAttribute("type", "button");
    expect(button).toHaveAccessibleDescription(
      "Available to roles with the Agents (create) permission",
    );
  });

  it("drops asChild when refused rather than handing Slot two children", () => {
    // The refused button renders its label plus the reason. Radix's Slot takes
    // exactly one child, so forwarding `asChild` here would throw instead of
    // rendering, and there is nothing to navigate to anyway.
    render(
      <ButtonWithTooltip
        asChild
        disabled
        disabledText="Available to roles with the Agents (create) permission"
      >
        <Link href="/agents/new">Create Agent</Link>
      </ButtonWithTooltip>,
    );

    expect(screen.queryByRole("link")).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Create Agent" }),
    ).toBeInTheDocument();
  });

  it("runs the click when it is not disabled", () => {
    const onClick = vi.fn();

    render(<ButtonWithTooltip onClick={onClick}>Add Policy</ButtonWithTooltip>);

    fireEvent.click(screen.getByRole("button", { name: "Add Policy" }));

    expect(onClick).toHaveBeenCalledTimes(1);
  });
});
