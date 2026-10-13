import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useHasPermissions, useSession } from "@/lib/auth/auth.query";
import { useModelsWithApiKeys } from "@/lib/llm-models.query";
import { useOrganization } from "@/lib/organization.query";
import { useMyTeams, useTeams } from "@/lib/teams/team.query";
import { EditOAuthClientDialog as EditLlmOAuthClientDialog } from "./llm-oauth-client-dialogs";
import {
  EditOAuthClientDialog as EditMcpOAuthClientDialog,
  type McpOauthClient,
} from "./mcp-oauth-client-dialogs";

vi.mock("@/lib/auth/auth.query");
vi.mock("@/lib/organization.query");
vi.mock("sonner");
vi.mock("@/components/resource-access-section", () => ({
  ResourceAccessSection: () => null,
}));
vi.mock("@/lib/llm-models.query", () => ({
  useModelsWithApiKeys: vi.fn(),
}));
vi.mock("@/lib/teams/team.query", () => ({
  useTeams: vi.fn(),
  useMyTeams: vi.fn(),
}));

Element.prototype.scrollIntoView = vi.fn();

const base = {
  id: "client-1",
  clientId: "oc_123",
  organizationId: "org-1",
  labels: [],
  redirectUris: [],
  createdBy: null,
  createdAt: "2026-10-01T00:00:00.000Z",
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(useOrganization).mockReturnValue({
    data: undefined,
  } as unknown as ReturnType<typeof useOrganization>);
  vi.mocked(useHasPermissions).mockReturnValue({
    data: false,
  } as ReturnType<typeof useHasPermissions>);
  vi.mocked(useSession).mockReturnValue({
    data: { user: { id: "u-self" } },
  } as unknown as ReturnType<typeof useSession>);
  vi.mocked(useModelsWithApiKeys).mockReturnValue({
    data: [],
  } as unknown as ReturnType<typeof useModelsWithApiKeys>);
  vi.mocked(useMyTeams).mockReturnValue({
    data: [],
  } as unknown as ReturnType<typeof useMyTeams>);
  vi.mocked(useTeams).mockReturnValue({
    data: [],
  } as unknown as ReturnType<typeof useTeams>);
});

describe("LLM OAuth client edit", () => {
  it("saves a rename without touching billing", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    renderWithQuery(
      <EditLlmOAuthClientDialog
        oauthClient={
          {
            ...base,
            name: "ci-runner",
            grantType: "client_credentials",
            providerApiKeys: [
              {
                provider: "openai",
                providerApiKeyId: "pk-1",
                providerApiKeyName: "Main OpenAI",
              },
            ],
            billingTeam: { id: "team-1", name: "Platform" },
            spendCap: {
              limitId: "limit-1",
              limitValue: 500,
              cleanupInterval: "calendar_month",
              currentUsage: 0,
            },
          } as never
        }
        onOpenChange={vi.fn()}
        providerApiKeys={[]}
        onSubmit={onSubmit}
        isSubmitting={false}
      />,
    );

    expect(screen.getByRole("button", { name: "Budget" })).toHaveAttribute(
      "aria-description",
      "Platform · $500/month",
    );
    await user.clear(screen.getByLabelText("Name"));
    await user.type(screen.getByLabelText("Name"), "ci-runner-2");
    await user.click(screen.getByRole("button", { name: "Save Changes" }));

    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    const body = onSubmit.mock.calls[0]?.[1];
    expect(body.name).toBe("ci-runner-2");
    expect(body).not.toHaveProperty("billingTeamId");
    expect(body).not.toHaveProperty("spendCap");
  });

  it("offers only a whole-client cap when each signed-in user pays", async () => {
    const user = userEvent.setup();
    renderWithQuery(
      <EditLlmOAuthClientDialog
        oauthClient={
          {
            ...base,
            name: "chat-app",
            grantType: "authorization_code",
            redirectUris: ["https://app.example.com/cb"],
            providerApiKeys: [],
            billingTeam: null,
            spendCap: null,
          } as never
        }
        onOpenChange={vi.fn()}
        providerApiKeys={[]}
        onSubmit={vi.fn()}
        isSubmitting={false}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Budget" }));

    expect(screen.getByText("Each signed-in user pays")).toBeVisible();
    expect(
      screen.queryByLabelText("Who pays for this client?"),
    ).not.toBeInTheDocument();
    expect(screen.getByLabelText("Spend cap in dollars")).toBeEnabled();
  });
});

describe("MCP OAuth client edit", () => {
  it("grants gateways to signed-in users only when asked to", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    renderWithQuery(
      <EditMcpOAuthClientDialog
        oauthClient={
          {
            ...base,
            name: "portal",
            grantType: "authorization_code",
            redirectUris: ["https://portal.example.com/cb"],
            allowedGatewayIds: [],
          } as unknown as McpOauthClient
        }
        onOpenChange={vi.fn()}
        gateways={[
          { id: "gw-1", name: "Prod Gateway", agentType: "mcp_gateway" },
        ]}
        onSubmit={onSubmit}
        isSubmitting={false}
      />,
    );

    expect(
      screen.queryByRole("button", { name: "Access" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Sign-in" }),
    ).not.toBeInTheDocument();
    expect(screen.getByLabelText("Redirect URIs")).toBeVisible();
    expect(
      screen.getByRole("radio", {
        name: /Only what each user can already reach/,
      }),
    ).toBeChecked();
    await user.click(
      screen.getByRole("radio", { name: /Also these gateways/ }),
    );
    expect(screen.getByRole("button", { name: "Save Changes" })).toBeDisabled();
    await user.click(screen.getByRole("combobox"));
    await user.click(screen.getByRole("option", { name: /Prod Gateway/ }));
    await user.click(screen.getByRole("button", { name: "Save Changes" }));

    await waitFor(() =>
      expect(onSubmit).toHaveBeenCalledWith(
        "client-1",
        expect.objectContaining({ allowedGatewayIds: ["gw-1"] }),
      ),
    );
  });
});

function renderWithQuery(ui: React.ReactElement) {
  return render(
    <QueryClientProvider client={new QueryClient()}>{ui}</QueryClientProvider>,
  );
}
