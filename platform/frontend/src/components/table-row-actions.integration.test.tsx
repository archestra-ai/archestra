import { fireEvent, render, screen } from "@testing-library/react";
import { useRouter } from "next/navigation";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";
import { useHasPermissions } from "@/lib/auth/auth.query";
import { type TableRowAction, TableRowActions } from "./table-row-actions";

// Only the permission answer is stubbed. The sibling suite stands PermissionButton
// in for a stub to keep its cases about row layout, which is exactly where a
// refusal that no longer refuses can hide, so this suite wires the real button,
// the real Button styling and the real tooltip together and clicks the result.
vi.mock("@/lib/auth/auth.query");
vi.mock("next/navigation");

const prefetch = vi.fn();

describe("TableRowActions with the real PermissionButton", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(useHasPermissions).mockReturnValue({
      data: false,
    } as unknown as ReturnType<typeof useHasPermissions>);
    vi.mocked(useRouter).mockReturnValue({
      prefetch,
    } as unknown as ReturnType<typeof useRouter>);
  });

  it.each([
    { kind: "plain", permissions: undefined },
    { kind: "permitted", permissions: { agent: ["read"] } },
  ] as const)("prefetches a $kind link action only on intent, and keeps its click from the row", ({
    permissions,
  }) => {
    vi.mocked(useHasPermissions).mockReturnValue({
      data: true,
    } as unknown as ReturnType<typeof useHasPermissions>);
    const onRowClick = vi.fn();
    const actions: TableRowAction[] = [
      {
        icon: <span>icon</span>,
        label: "Chat",
        href: "/chat/new?agent_id=abc",
        permissions,
      },
    ];

    render(
      <TooltipProvider>
        {/* biome-ignore lint/a11y/noStaticElementInteractions: stands in for a clickable table row */}
        {/* biome-ignore lint/a11y/useKeyWithClickEvents: stands in for a clickable table row */}
        <div onClick={onRowClick}>
          <TableRowActions actions={actions} itemName="My Agent" />
        </div>
      </TooltipProvider>,
    );

    const link = screen.getByRole("link", { name: "Chat My Agent" });
    expect(prefetch).not.toHaveBeenCalled();

    fireEvent.mouseEnter(link);
    expect(prefetch).toHaveBeenCalledTimes(1);
    expect(prefetch).toHaveBeenLastCalledWith("/chat/new?agent_id=abc");

    fireEvent.focus(link);
    expect(prefetch).toHaveBeenCalledTimes(2);

    fireEvent.click(link);
    expect(onRowClick).not.toHaveBeenCalled();
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
      "Missing permissions: Agents (update)",
    );
  });
});
