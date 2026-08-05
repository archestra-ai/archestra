import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useIsGlobalAdmin } from "@/lib/organization.query";
import {
  PermanentDeleteButton,
  permanentDeleteRowAction,
} from "./permanent-delete";
import { TableRowActions } from "./table-row-actions";

vi.mock("@/lib/organization.query");
vi.mock("@/lib/auth/auth.query");

function setGlobalAdmin(isGlobalAdmin: boolean) {
  vi.mocked(useIsGlobalAdmin).mockReturnValue({
    isGlobalAdmin,
    isPending: false,
  });
}

describe("PermanentDeleteButton", () => {
  beforeEach(() => vi.clearAllMocks());

  it("runs the delete for a member holding a built-in admin role", () => {
    setGlobalAdmin(true);
    const onClick = vi.fn();

    render(<PermanentDeleteButton onClick={onClick} itemName="billing-gw" />);

    const button = screen.getByLabelText("Delete permanently billing-gw");
    expect(button).toBeEnabled();
    fireEvent.click(button);
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it("disables the button for everyone else", () => {
    // The route answers 404 to a non-admin whatever permissions they hold, so
    // an enabled button here would only ever produce a confusing "not found".
    setGlobalAdmin(false);
    const onClick = vi.fn();

    render(<PermanentDeleteButton onClick={onClick} itemName="billing-gw" />);

    const button = screen.getByLabelText("Delete permanently billing-gw");
    expect(button).toBeDisabled();
    fireEvent.click(button);
    expect(onClick).not.toHaveBeenCalled();
  });
});

describe("permanentDeleteRowAction", () => {
  beforeEach(() => vi.clearAllMocks());

  it("runs the delete for a member holding a built-in admin role", () => {
    const onClick = vi.fn();

    render(
      <TableRowActions
        itemName="my-skill"
        actions={[permanentDeleteRowAction({ isGlobalAdmin: true, onClick })]}
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
        actions={[permanentDeleteRowAction({ isGlobalAdmin: false, onClick })]}
      />,
    );

    fireEvent.click(screen.getByLabelText("Delete permanently my-skill"));
    expect(onClick).not.toHaveBeenCalled();
  });

  it("lets an entity-specific refusal replace the role reason", () => {
    // Telling an admin to go find an admin is useless when the API would
    // refuse them too — the concrete reason wins.
    const action = permanentDeleteRowAction({
      isGlobalAdmin: true,
      onClick: vi.fn(),
      disabledReason: "Built-in skills cannot be permanently deleted",
    });

    expect(action.disabled).toBe(true);
    expect(action.disabledTooltip).toBe(
      "Built-in skills cannot be permanently deleted",
    );
  });
});
