import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { McpGatewayActions } from "./mcp-gateway-actions";

// Render the permission gate as data instead of behaviour: which permission
// guards the permanent delete is the point of these cases.
vi.mock("@/components/ui/permission-button", () => ({
  PermissionButton: ({
    children,
    permissions,
    onClick,
    disabled,
    ...props
  }: {
    children: React.ReactNode;
    permissions: Record<string, string[]>;
    onClick?: React.MouseEventHandler;
    disabled?: boolean;
    [key: string]: unknown;
  }) => (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      data-permissions={JSON.stringify(permissions)}
      {...props}
    >
      {children}
    </button>
  ),
}));

vi.mock("@/components/ui/button-group", () => ({
  ButtonGroup: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
}));

type GatewayProp = Parameters<typeof McpGatewayActions>[0]["agent"];

function gateway(overrides: Partial<GatewayProp> = {}): GatewayProp {
  return {
    id: "gw-1",
    name: "billing-gateway",
    agentType: "mcp_gateway",
    slug: "billing-gateway",
    deletedAt: null,
    ...overrides,
  } as GatewayProp;
}

function renderActions(
  agent: GatewayProp,
  handlers: Partial<Parameters<typeof McpGatewayActions>[0]> = {},
) {
  const onPurge = vi.fn();
  render(
    <McpGatewayActions
      agent={agent}
      canModify
      onConnect={vi.fn()}
      onEdit={vi.fn()}
      onDelete={vi.fn()}
      onRestore={vi.fn()}
      onPurge={onPurge}
      onClone={vi.fn()}
      {...handlers}
    />,
  );
  return { onPurge };
}

describe("McpGatewayActions", () => {
  it("offers permanent delete on a gateway already in the trash", () => {
    // The retention sweep purges gateways like any other agent row, so the
    // trash view is where an admin needs the manual path to the same thing.
    const { onPurge } = renderActions(
      gateway({ deletedAt: new Date().toISOString() }),
    );

    const purge = screen.getByLabelText("Delete permanently");
    fireEvent.click(purge);

    expect(onPurge).toHaveBeenCalledWith(
      expect.objectContaining({ id: "gw-1" }),
    );
  });

  it("gates permanent delete on gateway admin, not plain delete", () => {
    renderActions(gateway({ deletedAt: new Date().toISOString() }));

    expect(
      screen.getByLabelText("Delete permanently").dataset.permissions,
    ).toBe(JSON.stringify({ mcpGateway: ["admin"] }));
    // Restore stays at the lower bar it has always had.
    expect(screen.getByLabelText("Restore").dataset.permissions).toBe(
      JSON.stringify({ mcpGateway: ["delete"] }),
    );
  });

  it("keeps permanent delete out of the active list", () => {
    // Permanent delete is a trash action, never a shortcut past soft-delete.
    renderActions(gateway());

    expect(
      screen.queryByLabelText("Delete permanently"),
    ).not.toBeInTheDocument();
    expect(screen.getByLabelText("Delete")).toBeInTheDocument();
  });
});
