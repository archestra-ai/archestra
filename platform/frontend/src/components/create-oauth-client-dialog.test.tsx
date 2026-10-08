import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useHasPermissions, useSession } from "@/lib/auth/auth.query";
import { useModelsWithApiKeys } from "@/lib/llm-models.query";
import {
  useAppearanceSettings,
  useOrganization,
} from "@/lib/organization.query";
import { useMyTeams, useTeams } from "@/lib/teams/team.query";
import { CreateOAuthClientDialog } from "./create-oauth-client-dialog";

vi.mock("@/lib/auth/auth.query");
// The permissions section reads the organization policy over the network;
// what it submits is covered by the resource-permissions tests.
vi.mock("@/components/resource-access-section", () => ({
  ResourceAccessSection: () => null,
}));
vi.mock("sonner");
vi.mock("@/lib/organization.query");
vi.mock("@/lib/llm-models.query", () => ({
  useModelsWithApiKeys: vi.fn(),
}));
vi.mock("@/lib/teams/team.query", () => ({
  useTeams: vi.fn(),
  useMyTeams: vi.fn(),
}));

// Radix Popper / floating-ui needs ResizeObserver as a real constructor
global.ResizeObserver = class ResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
};
// Radix Select uses scrollIntoView and pointer capture
Element.prototype.scrollIntoView = vi.fn();
Element.prototype.hasPointerCapture = vi.fn().mockReturnValue(false);
Element.prototype.setPointerCapture = vi.fn();
Element.prototype.releasePointerCapture = vi.fn();

const GATEWAYS = [
  { id: "ag-1", name: "Marketing Agent", agentType: "agent" as const },
  { id: "gw-1", name: "Prod Gateway", agentType: "mcp_gateway" as const },
];

const PROVIDER_KEYS = [
  { id: "pk-1", name: "Main OpenAI", provider: "openai", scope: "org" },
] as never[];

function renderDialog(
  overrides: Partial<Parameters<typeof CreateOAuthClientDialog>[0]> = {},
) {
  const onSubmit = vi.fn().mockResolvedValue(undefined);
  render(
    <QueryClientProvider client={new QueryClient()}>
      <CreateOAuthClientDialog
        open
        onOpenChange={vi.fn()}
        gateways={GATEWAYS}
        providerApiKeys={PROVIDER_KEYS}
        onSubmit={onSubmit}
        isSubmitting={false}
        {...overrides}
      />
    </QueryClientProvider>,
  );
  return { onSubmit };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(useOrganization).mockReturnValue({
    data: undefined,
  } as unknown as ReturnType<typeof useOrganization>);
  vi.mocked(useAppearanceSettings).mockReturnValue({
    data: undefined,
  } as unknown as ReturnType<typeof useAppearanceSettings>);
  vi.mocked(useHasPermissions).mockReturnValue({
    data: false,
  } as ReturnType<typeof useHasPermissions>);
  vi.mocked(useSession).mockReturnValue({
    data: { user: { id: "u-self" } },
  } as unknown as ReturnType<typeof useSession>);
  vi.mocked(useModelsWithApiKeys).mockReturnValue({
    data: [],
  } as unknown as ReturnType<typeof useModelsWithApiKeys>);
  const team = {
    id: "team-platform",
    name: "Platform",
    members: [{ userId: "u-self", role: "admin" }],
  };
  vi.mocked(useMyTeams).mockReturnValue({
    data: [team],
  } as unknown as ReturnType<typeof useMyTeams>);
  vi.mocked(useTeams).mockReturnValue({
    data: [team],
  } as unknown as ReturnType<typeof useTeams>);
});

describe("CreateOAuthClientDialog", () => {
  it("carries a deep-linked agent through to the submitted client", async () => {
    const user = userEvent.setup();
    const { onSubmit } = renderDialog({
      defaultClientType: "mcp",
      defaultAllowedGatewayIds: ["ag-1"],
    });

    expect(
      screen.getByRole("radio", { name: /Agents & MCP gateways/ }),
    ).toBeChecked();
    await user.type(screen.getByLabelText("Name"), "marketing-bot");
    await continueStep(user);

    expect(screen.getByRole("combobox")).toHaveTextContent("Marketing Agent");
    expect(screen.getByText("1 of 2 selected")).toBeVisible();
    await continueStep(user);
    expect(screen.queryByLabelText("Label key")).not.toBeInTheDocument();
    expect(screen.queryByText("Permissions")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Create client" }));

    await waitFor(() =>
      expect(onSubmit).toHaveBeenCalledWith({
        kind: "mcp",
        body: {
          name: "marketing-bot",
          grantType: "client_credentials",
          allowedGatewayIds: ["ag-1"],
          initialGrants: [],
          labels: [],
        },
      }),
    );
  });

  it("needs a gateway before an MCP client acting as itself can continue", async () => {
    const user = userEvent.setup();
    renderDialog();

    await user.type(screen.getByLabelText("Name"), "bot");
    await continueStep(user);

    expect(screen.getByRole("button", { name: "Continue" })).toBeDisabled();
    await user.click(screen.getByRole("combobox"));
    await user.click(screen.getByRole("option", { name: /Prod Gateway/ }));
    expect(screen.getByRole("button", { name: "Continue" })).toBeEnabled();
  });

  it("locks a resource-scoped dialog to its own client kind", () => {
    renderDialog({ fixedClientType: "mcp", defaultClientType: "llm" });

    expect(
      screen.queryByRole("radiogroup", { name: "What will it reach?" }),
    ).not.toBeInTheDocument();
  });

  it("bills an LLM client to a team and caps it", async () => {
    const user = userEvent.setup();
    const { onSubmit } = renderDialog({ fixedClientType: "llm" });

    await user.type(screen.getByLabelText("Name"), "ci-runner");
    await continueStep(user);
    await user.click(screen.getByRole("radio", { name: "Main OpenAI" }));
    await continueStep(user);
    await user.click(screen.getByLabelText("Who pays for this client?"));
    await user.click(await screen.findByRole("option", { name: /^Platform/ }));
    await user.type(screen.getByLabelText("Spend cap in dollars"), "200");
    await continueStep(user);
    expect(screen.queryByLabelText("Label key")).not.toBeInTheDocument();
    expect(screen.queryByText("Permissions")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Create client" }));

    await waitFor(() =>
      expect(onSubmit).toHaveBeenCalledWith({
        kind: "llm",
        body: expect.objectContaining({
          grantType: "client_credentials",
          providerApiKeys: [{ provider: "openai", providerApiKeyId: "pk-1" }],
          billingTeamId: "team-platform",
          spendCap: { limitValue: 200, cleanupInterval: "calendar_month" },
        }),
      }),
    );
  });

  it("lets each signed-in user pay for an LLM client that acts for users", async () => {
    const user = userEvent.setup();
    const { onSubmit } = renderDialog({ fixedClientType: "llm" });

    await user.type(screen.getByLabelText("Name"), "chat-app");
    await user.click(screen.getByRole("radio", { name: /For its users/ }));
    await continueStep(user);
    await user.type(
      screen.getByLabelText("Redirect URIs"),
      "https://app.example.com/cb",
    );
    await continueStep(user);

    expect(screen.getByText("Each signed-in user pays")).toBeVisible();
    expect(
      screen.queryByLabelText("Who pays for this client?"),
    ).not.toBeInTheDocument();
    await continueStep(user);
    expect(screen.queryByLabelText("Label key")).not.toBeInTheDocument();
    expect(screen.queryByText("Permissions")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Create client" }));

    await waitFor(() =>
      expect(onSubmit).toHaveBeenCalledWith({
        kind: "llm",
        body: expect.not.objectContaining({ billingTeamId: expect.anything() }),
      }),
    );
  });
});

async function continueStep(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole("button", { name: "Continue" }));
}
