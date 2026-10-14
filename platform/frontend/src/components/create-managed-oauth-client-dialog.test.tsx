import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { memo } from "react";
import { useForm } from "react-hook-form";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useHasPermissions, useSession } from "@/lib/auth/auth.query";
import { useModelsWithApiKeys } from "@/lib/llm-models.query";
import {
  useAppearanceSettings,
  useOrganization,
} from "@/lib/organization.query";
import { useMyTeams, useTeams } from "@/lib/teams/team.query";
import { CreateManagedOAuthClientDialog } from "./create-managed-oauth-client-dialog";
import {
  OAuthClientAccessFields,
  type OAuthClientFormValues,
} from "./oauth-client/configuration-fields";
import { Button } from "./ui/button";

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
  overrides: Partial<Parameters<typeof CreateManagedOAuthClientDialog>[0]> = {},
) {
  const onSubmit = vi.fn().mockResolvedValue(undefined);
  render(
    <QueryClientProvider client={new QueryClient()}>
      <CreateManagedOAuthClientDialog
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

describe("CreateManagedOAuthClientDialog", () => {
  it("keeps multiple targets and provider-key edits reactive with stable form props", async () => {
    const user = userEvent.setup();
    const save = vi.fn();
    const StableAccessFields = memo(OAuthClientAccessFields);
    function StableForm() {
      const form = useForm<OAuthClientFormValues>({
        defaultValues: {
          name: "Combined application",
          grantType: "client_credentials",
          scopes: ["mcp", "a2a", "llm:proxy"],
          allowedGatewayIds: [],
          providerApiKeys: [],
          redirectUrisText: "",
        },
      });
      return (
        <form onSubmit={form.handleSubmit(save)}>
          <output>{form.watch("name")}</output>
          <StableAccessFields
            form={form}
            gateways={GATEWAYS}
            providerApiKeys={PROVIDER_KEYS}
          />
          <Button type="submit">Save test client</Button>
        </form>
      );
    }
    render(
      <QueryClientProvider client={new QueryClient()}>
        <StableForm />
      </QueryClientProvider>,
    );
    await user.click(screen.getByRole("combobox"));
    await user.click(screen.getByRole("option", { name: /Prod Gateway/ }));
    await user.click(screen.getByRole("option", { name: /Marketing Agent/ }));
    await user.keyboard("{Escape}");
    expect(screen.getByText("2 of 2 selected")).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Add OpenAI" }));
    expect(
      screen.getByRole("combobox", { name: "OpenAI key" }),
    ).toHaveTextContent("Main OpenAI");
    await user.click(screen.getByRole("button", { name: "Save test client" }));
    await waitFor(() =>
      expect(save).toHaveBeenCalledWith(
        expect.objectContaining({
          allowedGatewayIds: ["gw-1", "ag-1"],
          providerApiKeys: [{ provider: "openai", providerApiKeyId: "pk-1" }],
        }),
        expect.anything(),
      ),
    );
  });
  it("carries a deep-linked agent through to the submitted client", async () => {
    const user = userEvent.setup();
    const { onSubmit } = renderDialog({
      defaultClientType: "mcp",
      defaultAllowedGatewayIds: ["ag-1"],
    });

    expect(screen.getByRole("checkbox", { name: /MCP Gateway/ })).toBeChecked();
    expect(screen.getByRole("checkbox", { name: /A2A/ })).toBeChecked();
    await user.type(screen.getByLabelText("Name"), "marketing-bot");
    await continueStep(user);

    expect(screen.getByRole("combobox")).toHaveTextContent("Marketing Agent");
    expect(screen.getByText("1 of 2 selected")).toBeVisible();
    await continueStep(user);
    expect(screen.queryByLabelText("Label key")).not.toBeInTheDocument();
    expect(screen.queryByText("Permissions")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Create client" }));

    await waitFor(() =>
      expect(onSubmit).toHaveBeenCalledWith(
        expect.objectContaining({
          name: "marketing-bot",
          grantType: "client_credentials",
          allowedGatewayIds: ["ag-1"],
          initialGrants: [],
          labels: [],
          scopes: ["mcp", "a2a"],
        }),
      ),
    );
  });

  it("focuses the name rather than the step bars when it opens", async () => {
    renderDialog();

    await waitFor(() => expect(screen.getByLabelText("Name")).toHaveFocus());
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

  it("requires at least one capability", async () => {
    const user = userEvent.setup();
    renderDialog();
    await user.type(screen.getByLabelText("Name"), "bot");
    await user.click(screen.getByRole("checkbox", { name: /MCP Gateway/ }));
    await user.click(screen.getByRole("checkbox", { name: /A2A/ }));
    expect(screen.getByRole("button", { name: "Continue" })).toBeDisabled();
  });

  it("clears an incompatible gateway when MCP access is removed", async () => {
    const user = userEvent.setup();
    renderDialog({ defaultAllowedGatewayIds: ["gw-1"] });
    await user.type(screen.getByLabelText("Name"), "Agent only");
    await user.click(screen.getByRole("checkbox", { name: /MCP Gateway/ }));
    await continueStep(user);
    expect(screen.getByText("0 of 1 selected")).toBeVisible();
    expect(screen.getByRole("button", { name: "Continue" })).toBeDisabled();
  });

  it("bills an LLM client to a team and caps it", async () => {
    const user = userEvent.setup();
    const { onSubmit } = renderDialog({ defaultClientType: "llm" });

    await user.type(screen.getByLabelText("Name"), "ci-runner");
    await continueStep(user);
    await user.click(screen.getByRole("button", { name: "Add OpenAI" }));
    await user.click(screen.getByLabelText("Who pays for this client?"));
    await user.click(await screen.findByRole("option", { name: /^Platform/ }));
    await user.type(screen.getByLabelText("Spend cap in dollars"), "200");
    await continueStep(user);
    expect(screen.queryByLabelText("Label key")).not.toBeInTheDocument();
    expect(screen.queryByText("Permissions")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Create client" }));

    await waitFor(() =>
      expect(onSubmit).toHaveBeenCalledWith(
        expect.objectContaining({
          grantType: "client_credentials",
          providerApiKeys: [{ provider: "openai", providerApiKeyId: "pk-1" }],
          billingTeamId: "team-platform",
          spendCap: { limitValue: 200, cleanupInterval: "calendar_month" },
        }),
      ),
    );
  });

  it("lets each signed-in user pay for an LLM client that acts for users", async () => {
    const user = userEvent.setup();
    const { onSubmit } = renderDialog({ defaultClientType: "llm" });

    await user.type(screen.getByLabelText("Name"), "chat-app");
    await user.click(screen.getByRole("radio", { name: /For its users/ }));
    await continueStep(user);
    await user.type(
      screen.getByLabelText("Redirect URIs"),
      "https://app.example.com/cb",
    );

    expect(screen.getByText("Each signed-in user pays")).toBeVisible();
    expect(
      screen.queryByLabelText("Who pays for this client?"),
    ).not.toBeInTheDocument();
    await continueStep(user);
    expect(screen.queryByLabelText("Label key")).not.toBeInTheDocument();
    expect(screen.queryByText("Permissions")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Create client" }));

    await waitFor(() =>
      expect(onSubmit).toHaveBeenCalledWith(
        expect.not.objectContaining({ billingTeamId: expect.anything() }),
      ),
    );
  });
});

async function continueStep(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole("button", { name: "Continue" }));
}
