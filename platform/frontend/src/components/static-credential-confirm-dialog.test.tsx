import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { StaticCredentialConfirmDialog } from "@/components/static-credential-confirm-dialog";

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

describe("StaticCredentialConfirmDialog", () => {
  it("agent context names another user's connection", () => {
    const { container } = render(
      <StaticCredentialConfirmDialog
        open
        pins={[
          {
            mcpName: "Everything",
            ownerEmail: "member@example.com",
            isCurrentUser: false,
          },
        ]}
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    expect(container.textContent).toContain("Every user of this agent");
    expect(container.textContent).toContain("connect to");
    expect(container.textContent).toContain("as member@example.com");
    expect(container.textContent).toContain("no matter who is calling");
    expect(container.textContent).toContain("member@example.com's access");
    expect(screen.getByText("Use this connection")).toBeInTheDocument();
  });

  it("agent context uses 'you' / 'your' wording for the caller's own connection", () => {
    const { container } = render(
      <StaticCredentialConfirmDialog
        open
        pins={[
          {
            mcpName: "Everything",
            ownerEmail: "me@example.com",
            isCurrentUser: true,
          },
        ]}
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    expect(container.textContent).toContain("Every user of this agent");
    expect(container.textContent).toContain("connect to");
    expect(container.textContent).toContain("as you");
    expect(container.textContent).toContain("your access");
    expect(screen.getByText("Use this connection")).toBeInTheDocument();
  });

  it("server context describes the default connection", () => {
    const { container } = render(
      <StaticCredentialConfirmDialog
        open
        context="server"
        pins={[
          {
            mcpName: "Everything",
            ownerEmail: "member@example.com",
            isCurrentUser: false,
          },
        ]}
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    expect(container.textContent).toContain("Every agent that resolves");
    expect(container.textContent).toContain("at call time will connect as");
    expect(container.textContent).toContain("member@example.com");
    expect(screen.getByText("Use this connection")).toBeInTheDocument();
  });

  it("server context uses 'you' for the caller's own connection", () => {
    const { container } = render(
      <StaticCredentialConfirmDialog
        open
        context="server"
        pins={[
          {
            mcpName: "Everything",
            ownerEmail: "me@example.com",
            isCurrentUser: true,
          },
        ]}
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    expect(container.textContent).toContain("will connect as you");
    expect(container.textContent).toContain("your access");
  });

  it("wires the confirm and cancel actions", () => {
    const onConfirm = vi.fn();
    const onCancel = vi.fn();
    render(
      <StaticCredentialConfirmDialog
        open
        pins={[{ mcpName: "X", ownerEmail: "e@x.com", isCurrentUser: false }]}
        onConfirm={onConfirm}
        onCancel={onCancel}
      />,
    );
    fireEvent.click(screen.getByText("Cancel"));
    expect(onCancel).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByText("Use this connection"));
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it("lists every pin when more than one is affected", () => {
    const { container } = render(
      <StaticCredentialConfirmDialog
        open
        pins={[
          { mcpName: "ServerA", ownerEmail: "a@x.com", isCurrentUser: false },
          { mcpName: "ServerB", ownerEmail: "b@x.com", isCurrentUser: true },
        ]}
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    expect(container.textContent).toContain("ServerA");
    expect(container.textContent).toContain("as a@x.com");
    expect(container.textContent).toContain("ServerB");
    expect(container.textContent).toContain("as you");
    expect(screen.getByText("Use these connections")).toBeInTheDocument();
  });
});
