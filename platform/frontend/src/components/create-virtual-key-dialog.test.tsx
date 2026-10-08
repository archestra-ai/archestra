import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useHasPermissions, useSession } from "@/lib/auth/auth.query";
import { useAppName } from "@/lib/hooks/use-app-name";
import { useLlmModels, useModelsWithApiKeys } from "@/lib/llm-models.query";
import { useOrganization } from "@/lib/organization.query";
import { useMyTeams, useTeams } from "@/lib/teams/team.query";
import { useCreateVirtualApiKey } from "@/lib/virtual-api-keys.query";
import { CreateVirtualKeyDialog } from "./create-virtual-key-dialog";

// Radix Select uses scrollIntoView and pointer capture
Element.prototype.scrollIntoView = vi.fn();
Element.prototype.hasPointerCapture = vi.fn().mockReturnValue(false);
Element.prototype.setPointerCapture = vi.fn();
Element.prototype.releasePointerCapture = vi.fn();

vi.mock("@/lib/virtual-api-keys.query", () => ({
  useCreateVirtualApiKey: vi.fn(),
}));
vi.mock("@/lib/llm-models.query", () => ({
  useLlmModels: vi.fn(),
  useModelsWithApiKeys: vi.fn(),
}));
vi.mock("@/lib/organization.query");
vi.mock("@/lib/auth/auth.query");
vi.mock("@/lib/teams/team.query", () => ({
  useTeams: vi.fn(),
  useMyTeams: vi.fn(),
}));
vi.mock("@/lib/hooks/use-app-name");
const mutateAsync = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(useAppName).mockReturnValue("Archestra");
  vi.mocked(useSession).mockReturnValue({
    data: { user: { id: "u-self" } },
  } as unknown as ReturnType<typeof useSession>);
  // A plain member: may bill only teams they administer, cannot read limits.
  vi.mocked(useHasPermissions).mockReturnValue({
    data: false,
  } as unknown as ReturnType<typeof useHasPermissions>);
  const platformTeam = {
    id: "team-platform",
    name: "Platform",
    members: [{ userId: "u-self", role: "admin" }],
  };
  vi.mocked(useMyTeams).mockReturnValue({
    data: [platformTeam],
  } as unknown as ReturnType<typeof useMyTeams>);
  vi.mocked(useTeams).mockReturnValue({
    data: [platformTeam],
  } as unknown as ReturnType<typeof useTeams>);
  vi.mocked(useOrganization).mockReturnValue({
    data: undefined,
  } as unknown as ReturnType<typeof useOrganization>);
  vi.mocked(useLlmModels).mockReturnValue({
    isPending: false,
    data: [
      { id: "gpt-5.4-mini", provider: "openai", isBest: false },
      { id: "gpt-5.6-sol", provider: "openai", isBest: true },
      { id: "glm-5.1", provider: "zhipuai", isBest: true },
    ],
  } as unknown as ReturnType<typeof useLlmModels>);
  vi.mocked(useModelsWithApiKeys).mockReturnValue({
    isPending: false,
    data: [
      {
        modelId: "gpt-5.4-unmapped",
        provider: "openai",
        isBest: true,
        apiKeys: [{ id: "different-openai-key" }],
      },
      {
        modelId: "gpt-5.6-sol",
        provider: "openai",
        isBest: true,
        apiKeys: [{ id: "openai-key" }],
      },
      {
        modelId: "glm-5.1",
        provider: "zhipuai",
        isBest: true,
        apiKeys: [{ id: "zhipu-key" }],
      },
    ].map((model) => ({
      ...model,
      ignored: false,
      embeddingDimensions: null,
      inputModalities: null,
      outputModalities: null,
      supportedEndpoints: null,
    })),
  } as unknown as ReturnType<typeof useModelsWithApiKeys>);
  vi.mocked(useCreateVirtualApiKey).mockReturnValue({
    isPending: false,
    mutateAsync,
  } as unknown as ReturnType<typeof useCreateVirtualApiKey>);
});

describe("CreateVirtualKeyDialog", () => {
  it("creates the passthrough type supplied by its resource tab without a type selector", async () => {
    const user = userEvent.setup();
    renderDialog("passthrough");

    expect(
      screen.getByRole("heading", { name: "New passthrough key" }),
    ).toBeInTheDocument();
    expect(
      screen.getByPlaceholderText("My passthrough key"),
    ).toBeInTheDocument();
    expect(screen.getByLabelText("Name")).toHaveValue("");
    expect(screen.queryByText("Key type")).not.toBeInTheDocument();
    expect(screen.queryByText("Standard")).not.toBeInTheDocument();
    expect(screen.queryByText("Passthrough")).not.toBeInTheDocument();

    await user.type(screen.getByLabelText("Name"), "My passthrough key");
    await createFromAnyStep(user);

    expect(mutateAsync).toHaveBeenCalledWith({
      data: {
        name: "My passthrough key",
        keyType: "passthrough",
        expiresAt: undefined,
        labels: [],
        billingTeamId: undefined,
        spendCap: undefined,
      },
    });
  });

  it("creates the standard type supplied by its resource tab without a type selector", async () => {
    const user = userEvent.setup();
    renderDialog("standard");

    expect(
      screen.getByRole("heading", { name: "New virtual key" }),
    ).toBeInTheDocument();
    // Every value starts at a sensible default, so Continue is enough.
    expect(screen.getByLabelText("Name")).toHaveValue(
      "Self Admin's virtual key (2)",
    );
    expect(screen.getByLabelText("Selected provider keys")).toHaveTextContent(
      "OpenAI · Main OpenAI",
    );
    // Sharing is set from the saved key's Permissions tab, not on create.
    expect(
      screen.queryByRole("button", { name: "Permissions" }),
    ).not.toBeInTheDocument();
    expect(screen.queryByText("Key type")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Continue" }));
    await user.click(screen.getByRole("button", { name: "Continue" }));
    expect(screen.getByText("Never")).toBeVisible();
    expect(screen.getByText("No team")).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Create key" }));

    expect(mutateAsync).toHaveBeenCalledWith({
      data: {
        name: "Self Admin's virtual key (2)",
        keyType: "standard",
        expiresAt: undefined,
        providerApiKeys: [
          { provider: "openai", providerApiKeyId: "provider-key-1" },
        ],
        labels: [],
        billingTeamId: undefined,
        spendCap: undefined,
      },
    });
  });

  it("bills a team the caller administers and caps the key", async () => {
    const user = userEvent.setup();
    renderDialog("standard");

    await user.click(screen.getByRole("button", { name: "Continue" }));
    await user.click(screen.getByLabelText("Who pays for this key?"));
    await user.click(await screen.findByRole("option", { name: /^Platform/ }));
    expect(
      screen.getByText(/The owner's personal limit does not apply/),
    ).toBeVisible();
    await user.type(screen.getByLabelText("Spend cap in dollars"), "500");
    await user.click(screen.getByRole("button", { name: "Continue" }));

    expect(screen.getByText("Platform")).toBeVisible();
    expect(screen.getByText("$500 this month")).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Create key" }));

    expect(mutateAsync).toHaveBeenCalledWith({
      data: expect.objectContaining({
        billingTeamId: "team-platform",
        spendCap: { limitValue: 500, cleanupInterval: "calendar_month" },
      }),
    });
  });

  it("adds labels from their own row and saves the in-progress label", async () => {
    const user = userEvent.setup();
    renderDialog("passthrough");

    expect(screen.queryByLabelText("Label key")).not.toBeInTheDocument();

    await user.type(screen.getByLabelText("Name"), "Regional key");
    await user.click(screen.getByRole("button", { name: "Continue" }));
    await user.click(screen.getByRole("button", { name: "Continue" }));
    await user.type(screen.getByLabelText("Label key"), "region");
    await user.type(screen.getByLabelText("Label value"), "eu");
    await user.click(screen.getByRole("button", { name: "Create key" }));

    expect(mutateAsync).toHaveBeenCalledWith({
      data: {
        name: "Regional key",
        keyType: "passthrough",
        expiresAt: undefined,
        labels: [{ key: "region", value: "eu" }],
        billingTeamId: undefined,
        spendCap: undefined,
      },
    });
  });

  it("hands off a standard key with a runnable request for the endpoint picked", async () => {
    const user = userEvent.setup();
    mutateAsync.mockResolvedValue(
      createdKey("standard", [
        { provider: "openai", providerApiKeyId: "openai-key" },
        { provider: "zhipuai", providerApiKeyId: "zhipu-key" },
      ]),
    );
    renderDialog("standard");
    await createFromAnyStep(user);

    const dialog = await screen.findByTestId("virtual-key-create-dialog");
    expect(within(dialog).getByText("Copy your key")).toBeVisible();
    expect(
      screen.queryByRole("button", { name: "Connect" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "General" }),
    ).not.toBeInTheDocument();
    // The default model is linked to this key and gets a Responses example.
    expect(dialog).toHaveTextContent(
      "https://proxy.example.com/model-router/responses",
    );
    expect(dialog).toHaveTextContent('"model": "openai:gpt-5.6-sol"');
    expect(dialog).not.toHaveTextContent("gpt-5.4-unmapped");

    await user.click(within(dialog).getByText("Native provider API"));
    expect(dialog).toHaveTextContent(
      "https://proxy.example.com/openai/responses",
    );
    expect(dialog).toHaveTextContent('"model": "gpt-5.6-sol"');
    expect(dialog).toHaveTextContent('"input": "Hello!"');
    expect(dialog).toHaveTextContent("Authorization: Bearer arch_created");
    expect(dialog).toHaveTextContent("NameLaptop");
    expect(dialog).toHaveTextContent("Visible toOnly you");
  });

  it("uses a Copilot model's published Responses endpoint in the native example", async () => {
    const user = userEvent.setup();
    vi.mocked(useModelsWithApiKeys).mockReturnValue({
      isPending: false,
      data: [
        {
          modelId: "gpt-5.4-codex",
          provider: "github-copilot",
          isBest: true,
          apiKeys: [{ id: "copilot-key" }],
          ignored: false,
          embeddingDimensions: null,
          inputModalities: null,
          outputModalities: null,
          supportedEndpoints: ["/responses"],
        },
      ],
    } as unknown as ReturnType<typeof useModelsWithApiKeys>);
    mutateAsync.mockResolvedValue(
      createdKey("standard", [
        { provider: "github-copilot", providerApiKeyId: "copilot-key" },
      ]),
    );
    renderDialog("standard");
    await createFromAnyStep(user);

    const dialog = await screen.findByTestId("virtual-key-create-dialog");
    await user.click(within(dialog).getByText("Native provider API"));
    expect(dialog).toHaveTextContent(
      "https://proxy.example.com/github-copilot/responses",
    );
    expect(dialog).toHaveTextContent('"model": "gpt-5.4-codex"');
  });

  it("offers only native routes to a passthrough key and keeps the caller's provider key", async () => {
    const user = userEvent.setup();
    mutateAsync.mockResolvedValue(createdKey("passthrough", []));
    renderDialog("passthrough");
    await user.type(screen.getByLabelText("Name"), "Laptop");
    await createFromAnyStep(user);

    const dialog = await screen.findByTestId("virtual-key-create-dialog");
    expect(
      within(dialog).getByRole("radio", { name: /Model Router/ }),
    ).toBeDisabled();
    expect(dialog).toHaveTextContent("Authorization: Bearer $OPENAI_API_KEY");
    expect(dialog).toHaveTextContent("X-Archestra-Virtual-Key: arch_created");
  });

  it("makes the creator the owner, even for an admin", async () => {
    const user = userEvent.setup();
    renderDialog("standard", {
      existingKeys: [
        { authorId: "u-self", keyType: "standard" },
        { authorId: "u-bob", keyType: "standard" },
      ],
    });

    // Only the creator's own keys count toward the generated name.
    expect(screen.getByLabelText("Name")).toHaveValue(
      "Self Admin's virtual key (2)",
    );
    await user.click(screen.getByRole("button", { name: "Continue" }));
    expect(screen.queryByText("Key owner")).not.toBeInTheDocument();
    await createFromAnyStep(user);

    expect(mutateAsync).toHaveBeenCalledWith({
      data: expect.not.objectContaining({ ownerId: expect.anything() }),
    });
  });
});

/** Walk the remaining wizard steps with their defaults and create. */
async function createFromAnyStep(user: ReturnType<typeof userEvent.setup>) {
  for (;;) {
    const create = screen.queryByRole("button", { name: "Create key" });
    if (create) {
      await user.click(create);
      return;
    }
    await user.click(screen.getByRole("button", { name: "Continue" }));
  }
}

function createdKey(
  keyType: "standard" | "passthrough",
  providerApiKeys: Array<{ provider: string; providerApiKeyId: string }>,
) {
  return {
    value: "arch_created",
    name: "Laptop",
    keyType,
    scope: "personal",
    authorId: "u-self",
    authorName: "Self Admin",
    teams: [],
    expiresAt: null,
    providerApiKeys: providerApiKeys.map((mapping) => ({
      ...mapping,
      providerApiKeyName: mapping.provider,
    })),
  };
}

function renderDialog(
  keyType: "standard" | "passthrough",
  options: {
    existingKeys?: Array<{
      authorId: string;
      keyType: "standard" | "passthrough";
    }>;
  } = {},
) {
  // The permissions section reads the role and team catalog through queries.
  return render(
    <QueryClientProvider client={new QueryClient()}>
      <CreateVirtualKeyDialog
        open
        onOpenChange={vi.fn()}
        keyType={keyType}
        parentableKeys={[
          {
            id: "provider-key-1",
            name: "Main OpenAI",
            provider: "openai",
          } as never,
        ]}
        initialProviderApiKeys={
          keyType === "standard"
            ? [{ provider: "openai", providerApiKeyId: "provider-key-1" }]
            : undefined
        }
        connectionBaseUrl="https://proxy.example.com"
        defaultExpirationSeconds={null}
        currentUser={{ id: "u-self", name: "Self Admin" }}
        existingKeys={
          (options.existingKeys ?? [
            {
              authorId: "u-self",
              keyType,
            },
          ]) as never[]
        }
      />
    </QueryClientProvider>,
  );
}
