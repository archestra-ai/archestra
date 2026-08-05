import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useHasPermissions } from "@/lib/auth/auth.query";
import { useIsGlobalAdmin } from "@/lib/organization.query";
import { McpGatewayActions } from "./mcp-gateway-actions";

vi.mock("@/lib/organization.query");
vi.mock("@/lib/auth/auth.query");

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

function renderActions(agent: GatewayProp) {
  const onPermanentlyDelete = vi.fn();
  render(
    <McpGatewayActions
      agent={agent}
      canModify
      onConnect={vi.fn()}
      onEdit={vi.fn()}
      onDelete={vi.fn()}
      onRestore={vi.fn()}
      onPermanentlyDelete={onPermanentlyDelete}
      onClone={vi.fn()}
    />,
  );
  return { onPermanentlyDelete };
}

describe("McpGatewayActions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(useIsGlobalAdmin).mockReturnValue({
      isGlobalAdmin: true,
      isLoading: false,
    });
    vi.mocked(useHasPermissions).mockReturnValue({
      data: true,
    } as ReturnType<typeof useHasPermissions>);
  });

  it("offers permanent delete on a gateway already in the trash", () => {
    // Gateways are agent rows with their own trash view, and the permanent
    // delete route accepts every agent type — this is where an admin reaches it.
    renderActions(gateway({ deletedAt: "2026-01-02T00:00:00.000Z" }));

    expect(screen.getByLabelText("Restore")).toBeInTheDocument();
    // Named after the row: a trash list is a column of these buttons, and the
    // accessible name is the only thing telling them apart.
    expect(
      screen.getByLabelText("Delete permanently billing-gateway"),
    ).toBeInTheDocument();
  });

  it("keeps permanent delete out of the active list", () => {
    // It is a trash action, never a shortcut past soft-delete: the route 404s
    // on a live row, so offering it here would only ever fail.
    renderActions(gateway());

    expect(screen.getByLabelText("Delete")).toBeInTheDocument();
    // The row's own label, not the bare one — an exact-match query for
    // "Delete permanently" would pass even if the button did render.
    expect(
      screen.queryByLabelText("Delete permanently billing-gateway"),
    ).not.toBeInTheDocument();
  });
});
