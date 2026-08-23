import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";
import { useHasPermissions } from "@/lib/auth/auth.query";
import { type TableRowAction, TableRowActions } from "./table-row-actions";

// Only the permission answer is stubbed. The sibling suite stands PermissionButton
// in for a stub to keep its cases about row layout, which is exactly where a
// refusal that no longer refuses can hide, so this suite wires the real button,
// the real Button styling and the real tooltip together and clicks the result.
vi.mock("@/lib/auth/auth.query");

describe("TableRowActions with the real PermissionButton", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(useHasPermissions).mockReturnValue({
      data: false,
    } as unknown as ReturnType<typeof useHasPermissions>);
  });

  it("neither navigates nor runs the handler for a refused link action", () => {
    // An action carrying href, permissions and onClick at once: the href would
    // navigate past the refusal on its own, and the handler would run past it
    // if the caller's onClick reached the rendered button.
    const onClick = vi.fn();
    const actions: TableRowAction[] = [
      {
        icon: <span>icon</span>,
        label: "Edit",
        href: "/agents/abc",
        permissions: { agent: ["update"] },
        onClick,
      },
    ];

    render(
      <TooltipProvider>
        <TableRowActions actions={actions} itemName="My Agent" />
      </TooltipProvider>,
    );

    const button = screen.getByRole("button", { name: "Edit My Agent" });
    fireEvent.click(button);

    expect(onClick).not.toHaveBeenCalled();
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
    expect(button).not.toHaveAttribute("href");
    expect(button).toHaveAttribute("aria-disabled", "true");
    expect(button).toHaveAccessibleDescription(
      "Available to roles with the Agents (update) permission",
    );
  });
});
