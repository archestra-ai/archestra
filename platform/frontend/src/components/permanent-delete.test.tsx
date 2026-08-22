import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { permanentDeleteRowAction } from "./permanent-delete";
import { TableRowActions } from "./table-row-actions";

vi.mock("@/lib/auth/auth.query");

describe("permanentDeleteRowAction", () => {
  beforeEach(() => vi.clearAllMocks());

  it("runs the delete for a member holding a built-in admin role", () => {
    const onClick = vi.fn();

    render(
      <TableRowActions
        itemName="my-skill"
        actions={[
          permanentDeleteRowAction({
            admin: { isGlobalAdmin: true, isLoading: false },
            onClick,
          }),
        ]}
      />,
    );

    fireEvent.click(screen.getByLabelText("Delete permanently my-skill"));
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it("disables the action for everyone else", () => {
    const onClick = vi.fn();

    render(
      <TableRowActions
        itemName="my-skill"
        actions={[
          permanentDeleteRowAction({
            admin: { isGlobalAdmin: false, isLoading: false },
            onClick,
          }),
        ]}
      />,
    );

    fireEvent.click(screen.getByLabelText("Delete permanently my-skill"));
    expect(onClick).not.toHaveBeenCalled();
  });

  it("lets an entity-specific refusal replace the role reason", () => {
    // Telling an admin to go find an admin is useless when the API would
    // refuse them too — the concrete reason wins.
    const action = permanentDeleteRowAction({
      admin: { isGlobalAdmin: true, isLoading: false },
      onClick: vi.fn(),
      disabledReason: "Built-in skills cannot be permanently deleted",
    });

    expect(action.disabled).toBe(true);
    expect(action.disabledTooltip).toBe(
      "Built-in skills cannot be permanently deleted",
    );
  });

  it("does not blame the role while the role is still unknown", () => {
    // The gate reads "not an admin" until the query settles, so an admin
    // opening the trash would otherwise be told they lack the role.
    const action = permanentDeleteRowAction({
      admin: { isGlobalAdmin: false, isLoading: true },
      onClick: vi.fn(),
    });

    expect(action.disabled).toBe(true);
    expect(action.disabledTooltip).toBe("Checking your role…");
  });
});
