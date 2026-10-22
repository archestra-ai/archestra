import { archestraApiClient } from "@archestra/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { HttpResponse, http } from "msw";
import { setupServer } from "msw/node";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { useHasPermissions, useSession } from "@/lib/auth/auth.query";
import { useModelsWithApiKeys } from "@/lib/llm-models.query";
import { useOrganization } from "@/lib/organization.query";
import { useMyTeams, useTeams } from "@/lib/teams/team.query";
import { EditManagedOAuthClientDialog } from "./edit-managed-oauth-client-dialog";

vi.mock("@/lib/auth/auth.query");
vi.mock("@/lib/organization.query");
vi.mock("sonner");
vi.mock("@/components/resource-access-section", () => ({
  ResourceAccessSection: () => null,
}));
vi.mock("@/lib/llm-models.query", () => ({
  useModelsWithApiKeys: vi.fn(),
  // The key pickers' per-key model counts.
  useLlmModelIdsByKey: () => ({ data: [], isPending: false }),
}));
vi.mock("@/lib/teams/team.query", () => ({
  useTeams: vi.fn(),
  useMyTeams: vi.fn(),
}));

Element.prototype.scrollIntoView = vi.fn();

const server = setupServer();
beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

const base = {
  id: "client-1",
  clientId: "oc_123",
  organizationId: "org-1",
  labels: [],
  scopes: ["llm:proxy"],
  allowedGatewayIds: [],
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
      <EditManagedOAuthClientDialog
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
        gateways={[]}
        providerApiKeys={[]}
        onSubmit={onSubmit}
        isSubmitting={false}
      />,
    );

    expect(screen.getByRole("button", { name: "Budget" })).toBeVisible();
    await user.clear(screen.getByLabelText("Name"));
    await user.type(screen.getByLabelText("Name"), "ci-runner-2");
    expect(
      screen.queryByRole("textbox", { name: "Label key" }),
    ).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Advanced" }));
    await user.type(screen.getByLabelText("Label key"), "env");
    await user.type(screen.getByLabelText("Label value"), "staging");
    await user.click(screen.getByRole("button", { name: "Advanced" }));
    await user.click(screen.getByRole("button", { name: "Save Changes" }));

    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    const body = onSubmit.mock.calls[0]?.[1];
    expect(body.name).toBe("ci-runner-2");
    expect(body.labels).toEqual([{ key: "env", value: "staging" }]);
    expect(body).not.toHaveProperty("billingTeamId");
    expect(body).not.toHaveProperty("spendCap");
  });

  it("offers only a whole-client cap when each signed-in user pays", async () => {
    const user = userEvent.setup();
    renderWithQuery(
      <EditManagedOAuthClientDialog
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
        gateways={[]}
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
  it("hides unavailable account selection without fetching accounts or clearing an existing binding", async () => {
    const user = userEvent.setup();
    const accountReads = vi.fn();
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    archestraApiClient.setConfig({ baseUrl: "http://localhost:9000" });
    vi.mocked(useHasPermissions).mockImplementation(
      (permissions) =>
        ({
          data: !("serviceAccount" in permissions),
        }) as ReturnType<typeof useHasPermissions>,
    );
    server.use(
      http.get("http://localhost:9000/api/service-accounts", () => {
        accountReads();
        return HttpResponse.json({ message: "Forbidden" }, { status: 403 });
      }),
    );
    renderWithQuery(
      <EditManagedOAuthClientDialog
        oauthClient={
          {
            ...base,
            name: "Worker",
            scopes: ["mcp", "a2a"],
            providerApiKeys: [],
            grantType: "client_credentials",
            allowedGatewayIds: ["gw-1"],
            serviceAccountId: "a1111111-1111-4111-8111-111111111111",
          } as never
        }
        onOpenChange={vi.fn()}
        gateways={[{ id: "gw-1", name: "Gateway", agentType: "mcp_gateway" }]}
        providerApiKeys={[]}
        onSubmit={onSubmit}
        isSubmitting={false}
      />,
    );
    await user.click(screen.getByRole("button", { name: "Access" }));
    expect(
      screen.queryByRole("combobox", { name: "Service account" }),
    ).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "General" }));
    await user.type(screen.getByRole("textbox", { name: "Name" }), " renamed");
    await user.click(screen.getByRole("button", { name: "Save Changes" }));
    await waitFor(() => expect(onSubmit).toHaveBeenCalled());
    expect(onSubmit.mock.calls[0][1]).not.toHaveProperty("serviceAccountId");
    expect(accountReads).not.toHaveBeenCalled();
  });

  it("saves a chosen service-account binding", async () => {
    const user = userEvent.setup();
    archestraApiClient.setConfig({ baseUrl: "http://localhost:9000" });
    vi.mocked(useHasPermissions).mockReturnValue({ data: true } as ReturnType<
      typeof useHasPermissions
    >);
    server.use(
      http.get("http://localhost:9000/api/service-accounts", () =>
        HttpResponse.json([
          {
            id: "a1111111-1111-4111-8111-111111111111",
            name: "Worker account",
            disabled: false,
          },
        ]),
      ),
    );
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    renderWithQuery(
      <EditManagedOAuthClientDialog
        oauthClient={
          {
            ...base,
            name: "Worker",
            scopes: ["mcp", "a2a"],
            providerApiKeys: [],
            grantType: "client_credentials",
            allowedGatewayIds: ["gw-1"],
            serviceAccountId: null,
          } as never
        }
        onOpenChange={vi.fn()}
        gateways={[{ id: "gw-1", name: "Gateway", agentType: "mcp_gateway" }]}
        providerApiKeys={[]}
        onSubmit={onSubmit}
        isSubmitting={false}
      />,
    );
    expect(
      screen.queryByRole("combobox", { name: "Service account" }),
    ).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Access" }));
    const picker = await screen.findByRole("combobox", {
      name: "Service account",
    });
    await waitFor(() => expect(picker).toBeEnabled());
    await user.click(picker);
    await user.click(
      await screen.findByRole("option", { name: /Worker account/ }),
    );
    await user.click(screen.getByRole("button", { name: "General" }));
    await user.click(screen.getByRole("button", { name: "Advanced" }));
    await user.type(
      screen.getByRole("textbox", { name: "Label key" }),
      "environment",
    );
    await user.type(
      screen.getByRole("textbox", { name: "Label value" }),
      "demo",
    );
    await user.click(screen.getByRole("button", { name: "Advanced" }));
    await user.click(screen.getByRole("button", { name: "General" }));
    expect(
      screen.queryByRole("combobox", { name: "Service account" }),
    ).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Save Changes" }));
    await waitFor(() =>
      expect(onSubmit).toHaveBeenCalledWith(
        "client-1",
        expect.objectContaining({
          serviceAccountId: "a1111111-1111-4111-8111-111111111111",
          labels: [
            expect.objectContaining({ key: "environment", value: "demo" }),
          ],
        }),
      ),
    );
  });
  it("grants gateways to signed-in users only when asked to", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    renderWithQuery(
      <EditManagedOAuthClientDialog
        oauthClient={
          {
            ...base,
            name: "portal",
            scopes: ["mcp", "a2a"],
            providerApiKeys: [],
            grantType: "authorization_code",
            redirectUris: ["https://portal.example.com/cb"],
            allowedGatewayIds: [],
          } as never
        }
        onOpenChange={vi.fn()}
        gateways={[
          { id: "gw-1", name: "Prod Gateway", agentType: "mcp_gateway" },
        ]}
        providerApiKeys={[]}
        onSubmit={onSubmit}
        isSubmitting={false}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Access" }));
    expect(screen.getByLabelText("Redirect URIs")).toBeVisible();
    expect(screen.getByRole("button", { name: "Save Changes" })).toBeEnabled();
    await user.click(screen.getByRole("combobox", { name: "" }));
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
