import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useHasPermissions } from "@/lib/auth/auth.query";
import { useAssignableTeams } from "@/lib/teams/team.query";
import { CreateOAuthClientDialog } from "./create-oauth-client-dialog";

vi.mock("@/lib/auth/auth.query");
vi.mock("@/lib/teams/team.query");
vi.mock("sonner");

// Radix Popper / floating-ui needs ResizeObserver as a real constructor
global.ResizeObserver = class ResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
};

const GATEWAYS = [
  { id: "ag-1", name: "Marketing Agent", agentType: "agent" as const },
  { id: "gw-1", name: "Prod Gateway", agentType: "mcp_gateway" as const },
];

function renderDialog(
  overrides: Partial<Parameters<typeof CreateOAuthClientDialog>[0]> = {},
) {
  const onSubmit = vi.fn().mockResolvedValue(undefined);
  render(
    <CreateOAuthClientDialog
      open
      onOpenChange={vi.fn()}
      gateways={GATEWAYS}
      llmProxies={[]}
      providerApiKeys={[]}
      onSubmit={onSubmit}
      isSubmitting={false}
      {...overrides}
    />,
  );
  return { onSubmit };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(useHasPermissions).mockReturnValue({
    data: false,
  } as ReturnType<typeof useHasPermissions>);
  vi.mocked(useAssignableTeams).mockReturnValue({
    data: [],
  } as unknown as ReturnType<typeof useAssignableTeams>);
});

describe("deep-link defaults", () => {
  it("pre-selects the client type and the allowed agent", () => {
    renderDialog({
      defaultClientType: "mcp",
      defaultAllowedGatewayIds: ["ag-1"],
    });

    expect(
      screen.getByRole("radio", { name: /Agents & MCP gateways/ }),
    ).toBeChecked();
    // The pre-selected agent shows as a chip in the allowed-resources field.
    expect(screen.getByText("Marketing Agent")).toBeInTheDocument();
  });

  it("submits the pre-selected agent without touching the selector", async () => {
    const user = userEvent.setup();
    const { onSubmit } = renderDialog({
      defaultClientType: "mcp",
      defaultAllowedGatewayIds: ["ag-1"],
    });

    await user.type(
      screen.getByRole("textbox", { name: "Name" }),
      "marketing-bot",
    );
    await user.click(
      screen.getByRole("button", { name: "Create OAuth Client" }),
    );

    await waitFor(() =>
      expect(onSubmit).toHaveBeenCalledWith({
        kind: "mcp",
        body: {
          name: "marketing-bot",
          grantType: "client_credentials",
          allowedGatewayIds: ["ag-1"],
          scope: "personal",
          teams: [],
        },
      }),
    );
  });

  it("starts empty without deep-link defaults", () => {
    renderDialog();

    expect(
      screen.getByRole("radio", { name: /Agents & MCP gateways/ }),
    ).toBeChecked();
    expect(screen.queryByText("Marketing Agent")).not.toBeInTheDocument();
    // No allowed resource selected → submit stays disabled even with a name.
    expect(
      screen.getByRole("button", { name: "Create OAuth Client" }),
    ).toBeDisabled();
  });
});
