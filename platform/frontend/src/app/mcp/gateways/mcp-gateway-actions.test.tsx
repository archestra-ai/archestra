import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
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
    scope: "personal",
    deletedAt: null,
    ...overrides,
  } as GatewayProp;
}

function renderActions(agent: GatewayProp, canModify = true) {
  const onPermanentlyDelete = vi.fn();
  render(
    <McpGatewayActions
      agent={agent}
      canModify={canModify}
      onConnect={vi.fn()}
      onEdit={vi.fn()}
      onDelete={vi.fn()}
      onRestore={vi.fn()}
      onPermanentlyDelete={onPermanentlyDelete}
      onClone={vi.fn()}
      onHistory={vi.fn()}
    />,
  );
  return { onPermanentlyDelete };
}

const openRowMenu = () =>
  userEvent.click(
    screen.getByRole("button", { name: "More actions billing-gateway" }),
  );

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

  it("offers permanent delete on a gateway already in the trash", async () => {
    // Gateways are agent rows with their own trash view, and the permanent
    // delete route accepts every agent type — this is where an admin reaches it.
    renderActions(gateway({ deletedAt: "2026-01-02T00:00:00.000Z" }));

    expect(
      screen.getByLabelText("Restore billing-gateway"),
    ).toBeInTheDocument();
    await openRowMenu();
    // Named after the row: a trash list is a column of these buttons, and the
    // accessible name is the only thing telling them apart.
    expect(
      screen.getByRole("menuitem", { name: /Delete permanently/ }),
    ).toBeInTheDocument();
  });

  it("keeps permanent delete out of the active list", async () => {
    // It is a trash action, never a shortcut past soft-delete: the route 404s
    // on a live row, so offering it here would only ever fail.
    renderActions(gateway());

    await openRowMenu();
    expect(
      screen.getByRole("menuitem", { name: "Delete" }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("menuitem", { name: /Delete permanently/ }),
    ).not.toBeInTheDocument();
  });

  /**
   * The row used to be five bare icon buttons in a `ButtonGroup` with no
   * `tooltip` passed to any of them, so hovering Delete told a permitted user
   * nothing. The shared dialect is two labelled icon buttons plus the menu.
   */
  it("labels the visible row buttons and folds the rest into the row menu", async () => {
    renderActions(gateway());

    expect(
      screen.getByLabelText("Connect billing-gateway"),
    ).toBeInTheDocument();
    expect(screen.getByLabelText("Edit billing-gateway")).toBeInTheDocument();
    // Clone, Version history and Delete are not competing for the row's width.
    expect(screen.queryByLabelText("Clone billing-gateway")).toBeNull();

    await openRowMenu();

    expect(screen.getByRole("menuitem", { name: "Clone" })).toBeInTheDocument();
    expect(
      screen.getByRole("menuitem", { name: "Version history" }),
    ).toBeInTheDocument();
  });

  it("keeps a row the user cannot modify visible, disabled, with the reason", async () => {
    // Removing the control would leave no way to learn the record simply is
    // not this user's to change.
    renderActions(gateway(), false);

    const edit = screen.getByLabelText("Edit billing-gateway");
    expect(edit).toHaveAttribute("aria-disabled", "true");

    await openRowMenu();
    expect(screen.getByRole("menuitem", { name: /Delete/ })).toHaveAttribute(
      "aria-disabled",
      "true",
    );
    // Once per refused control: the row's Edit and the menu's Delete each carry
    // their own description, so focusing either one states the reason.
    expect(screen.getAllByText(/Only this MCP gateway's author/)).toHaveLength(
      2,
    );
  });
});
