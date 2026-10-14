import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useProfiles } from "@/lib/agent.query";
import {
  useHasPermissions,
  useScopedCapabilities,
  useSession,
} from "@/lib/auth/auth.query";
import {
  useAllOauthClients,
  useCreateOauthClient,
  useDeleteOauthClient,
  useRotateOauthClientSecret,
  useUpdateOauthClient,
} from "@/lib/oauth-clients.query";
import { McpOauthManagement } from "./mcp-oauth-management";

vi.mock("@/lib/auth/auth.query");
vi.mock("@/lib/llm-provider-api-keys.query", () => ({
  useLlmProviderApiKeys: () => ({ data: [] }),
}));
vi.mock("@/lib/agent.query", () => ({ useProfiles: vi.fn() }));
vi.mock("@/lib/oauth-clients.query", () => ({
  useCreateOauthClient: vi.fn(),
  useDeleteOauthClient: vi.fn(),
  useAllOauthClients: vi.fn(),
  useRotateOauthClientSecret: vi.fn(),
  useUpdateOauthClient: vi.fn(),
}));
vi.mock("@/components/create-managed-oauth-client-dialog", () => ({
  CreateManagedOAuthClientDialog: (props: {
    open: boolean;
    defaultClientType?: string;
    defaultAllowedGatewayIds?: string[];
  }) =>
    props.open ? (
      <div>
        create:{props.defaultClientType}:
        {props.defaultAllowedGatewayIds?.join(",")}
      </div>
    ) : null,
}));
vi.mock("@/components/edit-managed-oauth-client-dialog", () => ({
  EditManagedOAuthClientDialog: (props: {
    oauthClient: { name: string } | null;
  }) =>
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
  scopes: ["mcp", "a2a"],
  allowedGatewayIds: ["resource-1"],
  redirectUris: [],
  disabled: false,
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(useHasPermissions).mockReturnValue({ data: true } as ReturnType<
    typeof useHasPermissions
  >);
  mockClientGrants(["update", "delete"]);
  vi.mocked(useSession).mockReturnValue({
    data: { user: { id: "user-1" } },
  } as ReturnType<typeof useSession>);
  vi.mocked(useProfiles).mockReturnValue({ data: [] } as ReturnType<
    typeof useProfiles
  >);
  vi.mocked(useAllOauthClients).mockReturnValue({
    data: [
      assignedClient,
      { ...assignedClient, id: "other", name: "Other", allowedGatewayIds: [] },
    ],
    isPending: false,
    isLoadingError: false,
  } as unknown as ReturnType<typeof useAllOauthClients>);
  for (const hook of [
    useCreateOauthClient,
    useUpdateOauthClient,
    useRotateOauthClientSecret,
    useDeleteOauthClient,
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
            "oauthClient" in permission &&
            permission.oauthClient.includes("read"),
        }) as ReturnType<typeof useHasPermissions>,
    );
    mockClientGrants(["update"]);

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

  it("opens combined create, edit, rotate, and delete dialogs", async () => {
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

  it("hides edit and delete when grants cover a different client", () => {
    mockClientGrants(["update", "delete"], "other");

    render(<McpOauthManagement resourceId="resource-1" resourceKind="agent" />);

    expect(screen.getByText("Assigned client")).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Edit Assigned client" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Delete Assigned client" }),
    ).not.toBeInTheDocument();
  });
});

function mockClientGrants(actions: string[], scope = assignedClient.id) {
  vi.mocked(useScopedCapabilities).mockReturnValue({
    data: actions.map((action) => ({
      resource: "oauthClient",
      action,
      scope,
    })),
  } as unknown as ReturnType<typeof useScopedCapabilities>);
}
