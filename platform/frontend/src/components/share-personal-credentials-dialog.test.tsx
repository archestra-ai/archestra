import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { SharePersonalCredentialsDialog } from "@/components/share-personal-credentials-dialog";

// Render the shell inline (no Radix portal) so the copy and footer are directly
// assertable.
vi.mock("@/components/standard-dialog", () => ({
  StandardDialog: ({
    open,
    title,
    children,
    footer,
  }: {
    open: boolean;
    title?: React.ReactNode;
    children?: React.ReactNode;
    footer?: React.ReactNode;
  }) =>
    open ? (
      <div>
        <div>{title}</div>
        <div>{children}</div>
        <div>{footer}</div>
      </div>
    ) : null,
}));

vi.mock("@/components/ui/button", () => ({
  Button: ({
    children,
    onClick,
  }: {
    children?: React.ReactNode;
    onClick?: (e: React.MouseEvent) => void;
  }) => (
    <button type="button" onClick={onClick}>
      {children}
    </button>
  ),
}));

const pins = [
  { mcpName: "GitHub", ownerEmail: "alice@example.com", isCurrentUser: false },
  { mcpName: "Jira", ownerEmail: "me@example.com", isCurrentUser: true },
];

describe("SharePersonalCredentialsDialog", () => {
  it("lists every affected server with its owner (and 'you' for the caller)", () => {
    const { container } = render(
      <SharePersonalCredentialsDialog
        open
        pins={pins}
        onResolveDynamic={vi.fn()}
        onShareAsIs={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    expect(container.textContent).toContain("GitHub");
    expect(container.textContent).toContain("as alice@example.com");
    expect(container.textContent).toContain("Jira");
    expect(container.textContent).toContain("as you");
    expect(container.textContent).toContain("no matter who is calling");
  });

  it("wires the resolve-at-call-time (safe) action", () => {
    const onResolveDynamic = vi.fn();
    const onShareAsIs = vi.fn();
    const onCancel = vi.fn();
    render(
      <SharePersonalCredentialsDialog
        open
        pins={pins}
        onResolveDynamic={onResolveDynamic}
        onShareAsIs={onShareAsIs}
        onCancel={onCancel}
      />,
    );
    fireEvent.click(screen.getByText("Resolve at call time"));
    expect(onResolveDynamic).toHaveBeenCalledTimes(1);
    expect(onShareAsIs).not.toHaveBeenCalled();
    expect(onCancel).not.toHaveBeenCalled();
  });

  it("wires the share-as-is and cancel actions", () => {
    const onResolveDynamic = vi.fn();
    const onShareAsIs = vi.fn();
    const onCancel = vi.fn();
    render(
      <SharePersonalCredentialsDialog
        open
        pins={pins}
        onResolveDynamic={onResolveDynamic}
        onShareAsIs={onShareAsIs}
        onCancel={onCancel}
      />,
    );
    fireEvent.click(screen.getByText("Share as-is"));
    expect(onShareAsIs).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByText("Cancel"));
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onResolveDynamic).not.toHaveBeenCalled();
  });
});
