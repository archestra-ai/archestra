import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useProfiles } from "@/lib/agent.query";
import { useHasPermissions } from "@/lib/auth/auth.query";
import {
  useCreateMcpOauthClient,
  useDeleteMcpOauthClient,
  useMcpOauthClients,
  useRotateMcpOauthClientSecret,
  useUpdateMcpOauthClient,
} from "@/lib/mcp-oauth-clients.query";
import { McpOauthManagement } from "./mcp-oauth-management";

vi.mock("@/lib/auth/auth.query");
vi.mock("@/lib/agent.query", () => ({ useProfiles: vi.fn() }));
vi.mock("@/lib/mcp-oauth-clients.query", () => ({
  useCreateMcpOauthClient: vi.fn(),
  useDeleteMcpOauthClient: vi.fn(),
  useMcpOauthClients: vi.fn(),
  useRotateMcpOauthClientSecret: vi.fn(),
  useUpdateMcpOauthClient: vi.fn(),
}));
vi.mock("@/components/create-oauth-client-dialog", () => ({
  CreateOAuthClientDialog: (props: {
    open: boolean;
    fixedClientType?: string;
    defaultAllowedGatewayIds?: string[];
  }) =>
    props.open ? (
      <div>
        create:{props.fixedClientType}:
        {props.defaultAllowedGatewayIds?.join(",")}
      </div>
    ) : null,
}));
vi.mock("@/components/mcp-oauth-client-dialogs", () => ({
  EditOAuthClientDialog: (props: { oauthClient: { name: string } | null }) =>
    props.oauthClient ? <div>editing:{props.oauthClient.name}</div> : null,
}));
vi.mock("@/components/delete-confirm-dialog", () => ({
  DeleteConfirmDialog: (props: { open: boolean; title: string }) =>
    props.open ? <div>{props.title}</div> : null,
}));
vi.mock("@/components/oauth-client-created-dialog", () => ({
  OAuthClientCreatedDialog: () => null,
}));

const assignedClient = {
  id: "client-1",
  name: "Assigned client",
  clientId: "mcp_client_1",
  grantType: "client_credentials",
  allowedGatewayIds: ["resource-1"],
  redirectUris: [],
  disabled: false,
  scope: "personal",
  teams: [],
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(useHasPermissions).mockReturnValue({ data: true } as ReturnType<
    typeof useHasPermissions
  >);
  vi.mocked(useProfiles).mockReturnValue({ data: [] } as ReturnType<
    typeof useProfiles
  >);
  vi.mocked(useMcpOauthClients).mockReturnValue({
    data: [
      assignedClient,
      { ...assignedClient, id: "other", name: "Other", allowedGatewayIds: [] },
    ],
    isPending: false,
    isLoadingError: false,
  } as unknown as ReturnType<typeof useMcpOauthClients>);
  for (const hook of [
    useCreateMcpOauthClient,
    useUpdateMcpOauthClient,
    useRotateMcpOauthClientSecret,
    useDeleteMcpOauthClient,
  ]) {
    vi.mocked(hook).mockReturnValue({
      isPending: false,
      mutate: vi.fn(),
      mutateAsync: vi.fn(),
    } as never);
  }
});

describe("McpOauthManagement", () => {
  it("filters clients and independently exposes permitted operations", () => {
    vi.mocked(useHasPermissions).mockImplementation(
      (permission) =>
        ({
          data:
            "mcpOauthClient" in permission &&
            (permission.mcpOauthClient.includes("read") ||
              permission.mcpOauthClient.includes("update")),
        }) as ReturnType<typeof useHasPermissions>,
    );

    render(<McpOauthManagement resourceId="resource-1" resourceKind="agent" />);

    expect(screen.getByText("Assigned client")).toBeInTheDocument();
    expect(screen.queryByText("Other")).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Edit Assigned client" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Rotate secret for Assigned client" }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Delete Assigned client" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /Create OAuth client/ }),
    ).not.toBeInTheDocument();
  });

  it("opens fixed MCP create, edit, rotate, and delete dialogs", async () => {
    const user = userEvent.setup();
    render(<McpOauthManagement resourceId="resource-1" resourceKind="agent" />);

    await user.click(
      screen.getByRole("button", { name: /Create OAuth client/ }),
    );
    expect(screen.getByText("create:mcp:resource-1")).toBeInTheDocument();
    await user.click(
      screen.getByRole("button", { name: "Edit Assigned client" }),
    );
    expect(screen.getByText("editing:Assigned client")).toBeInTheDocument();
    await user.click(
      screen.getByRole("button", { name: "Rotate secret for Assigned client" }),
    );
    expect(screen.getByText("Rotate Client Secret")).toBeInTheDocument();
    await user.click(
      screen.getByRole("button", { name: "Delete Assigned client" }),
    );
    expect(screen.getByText("Delete OAuth Client")).toBeInTheDocument();
  });
});
