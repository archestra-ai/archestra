import { fireEvent, render, screen } from "@testing-library/react";
import Link from "next/link";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useHasPermissions } from "@/lib/auth/auth.query";
import { PermissionButton } from "./permission-button";

vi.mock("@/lib/auth/auth.query");

const CONSTRAINT = "Available to roles with the Skills (update) permission";

function setPermission(granted: boolean) {
  vi.mocked(useHasPermissions).mockReturnValue({
    data: granted,
  } as unknown as ReturnType<typeof useHasPermissions>);
}

describe("PermissionButton", () => {
  beforeEach(() => vi.clearAllMocks());

  it("runs the caller's onClick when the permission is held", () => {
    setPermission(true);
    const onClick = vi.fn();

    render(
      <PermissionButton permissions={{ skill: ["update"] }} onClick={onClick}>
        Edit
      </PermissionButton>,
    );

    fireEvent.click(screen.getByRole("button", { name: "Edit" }));

    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it("refuses the click when the permission is missing", () => {
    // The guard is registered after the caller's props precisely so a caller
    // that passes its own onClick cannot silently replace it.
    setPermission(false);
    const onClick = vi.fn();

    render(
      <PermissionButton permissions={{ skill: ["update"] }} onClick={onClick}>
        Edit
      </PermissionButton>,
    );

    const button = screen.getByRole("button", { name: "Edit" });
    fireEvent.click(button);

    expect(onClick).not.toHaveBeenCalled();
    expect(button).toHaveAttribute("aria-disabled", "true");
  });

  it("states the constraint as a description, not as part of the name", () => {
    // A tooltip alone never reaches a keyboard or screen reader user, so the
    // constraint is rendered as text; carrying it as the description rather
    // than the name keeps the control's own name intact and stops the refusal
    // being announced twice.
    setPermission(false);

    render(
      <PermissionButton permissions={{ skill: ["update"] }} aria-label="Edit">
        <span>icon</span>
      </PermissionButton>,
    );

    const button = screen.getByRole("button", { name: "Edit" });
    expect(button).toHaveAccessibleDescription(CONSTRAINT);
    expect(screen.getByText(CONSTRAINT)).toBeInTheDocument();
  });

  it("keeps the caller's own reason when it disabled the control itself", () => {
    // Granting the permission would not make this control usable, so the state
    // the caller is describing is the reason that still applies.
    setPermission(false);

    render(
      <PermissionButton
        permissions={{ skill: ["update"] }}
        aria-label="Edit"
        disabled
        tooltip="Archived skills cannot be edited"
      >
        <span>icon</span>
      </PermissionButton>,
    );

    const button = screen.getByRole("button", { name: "Edit" });
    expect(button).toHaveAccessibleDescription(
      "Archived skills cannot be edited",
    );
    expect(screen.queryByText(CONSTRAINT)).not.toBeInTheDocument();
  });

  it("renders a refused link action as a button with nothing to navigate to", () => {
    // `asChild` hands the button's styling to a next/link anchor. `disabled`
    // means nothing on an anchor, so the refused control must not be one.
    setPermission(false);
    const onClick = vi.fn();

    render(
      <PermissionButton
        permissions={{ skill: ["update"] }}
        aria-label="Edit My Skill"
        asChild
        onClick={onClick}
      >
        <Link href="/skills/abc">icon</Link>
      </PermissionButton>,
    );

    expect(screen.queryByRole("link")).not.toBeInTheDocument();
    const button = screen.getByRole("button", { name: "Edit My Skill" });
    fireEvent.click(button);

    expect(onClick).not.toHaveBeenCalled();
    expect(button).not.toHaveAttribute("href");
  });

  it("does not submit the form it sits in when refused", () => {
    // Button sets no default type, so a refused control inside a form would
    // otherwise submit it.
    setPermission(false);
    const onSubmit = vi.fn((e: React.FormEvent) => e.preventDefault());

    render(
      <form onSubmit={onSubmit}>
        <PermissionButton permissions={{ skill: ["update"] }} type="submit">
          Save
        </PermissionButton>
      </form>,
    );

    const button = screen.getByRole("button", { name: "Save" });
    expect(button).toHaveAttribute("type", "button");
    fireEvent.click(button);

    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("renders nothing when the caller asked for the action to be hidden", () => {
    setPermission(false);

    const { container } = render(
      <PermissionButton
        permissions={{ skill: ["update"] }}
        noPermissionHandle="hide"
      >
        Edit
      </PermissionButton>,
    );

    expect(container).toBeEmptyDOMElement();
  });
});
