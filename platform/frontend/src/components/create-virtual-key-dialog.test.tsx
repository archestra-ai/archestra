import { archestraApiClient } from "@archestra/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
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
import {
  useHasPermissions,
  useScopedCapabilities,
  useSession,
} from "@/lib/auth/auth.query";
import { useFeature } from "@/lib/config/config.query";
import { useAppName } from "@/lib/hooks/use-app-name";
import { useLlmModels, useModelsWithApiKeys } from "@/lib/llm-models.query";
import { useLlmProviderApiKeys } from "@/lib/llm-provider-api-keys.query";
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
  // The key pickers' per-key model counts.
  useLlmModelIdsByKey: () => ({ data: [], isPending: false }),
}));
vi.mock("@/lib/llm-provider-api-keys.query", async (importOriginal) => ({
  ...(await importOriginal()),
  useLlmProviderApiKeys: vi.fn(() => ({ data: [] })),
}));
vi.mock("@/lib/organization.query");
vi.mock("@/lib/auth/auth.query");
vi.mock("@/lib/config/config.query");
vi.mock("@/lib/teams/team.query", () => ({
  useTeams: vi.fn(),
  useMyTeams: vi.fn(),
}));
vi.mock("@/lib/hooks/use-app-name");
const mutateAsync = vi.fn();
const server = setupServer();
beforeAll(() => {
  server.listen({ onUnhandledRequest: "bypass" });
  archestraApiClient.setConfig({ baseUrl: "http://localhost:9000" });
});
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(useFeature).mockReturnValue(undefined);
  vi.mocked(useScopedCapabilities).mockReturnValue({
    data: [],
  } as unknown as ReturnType<typeof useScopedCapabilities>);
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
    memberCount: 1,
    myRole: "admin",
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
  it("creates with only a model pool, blocks empty access, and shows its connection guide", async () => {
    const user = userEvent.setup();
    vi.mocked(useHasPermissions).mockReturnValue({
      data: true,
    } as unknown as ReturnType<typeof useHasPermissions>);
    server.use(
      http.get("http://localhost:9000/api/model-pools", () =>
        HttpResponse.json([
          {
            id: "pool-1",
            name: "subscription-pool",
            virtualApiKeyIds: [],
            members: [
              {
                id: "member-1",
                provider: "github-copilot",
                modelId: "gpt-4.1",
                priority: 1,
                enabled: true,
              },
            ],
          },
        ]),
      ),
    );
    renderDialog("standard", {
      parentableKeys: [],
      initialProviderApiKeys: [],
    });
    const create = screen.getByRole("button", { name: "Create key" });
    expect(create).toBeDisabled();
    await user.click(
      screen.getByRole("combobox", {
        name: "Add a provider, model pool or auto router",
      }),
    );
    await user.click(
      await screen.findByRole("option", { name: /subscription-pool/ }),
    );
    // Picking only adds, so an added pool leaves the picker.
    await user.click(
      screen.getByRole("combobox", {
        name: "Add a provider, model pool or auto router",
      }),
    );
    expect(
      screen.queryByRole("option", { name: /subscription-pool/ }),
    ).not.toBeInTheDocument();
    await user.keyboard("{Escape}");
    expect(create).toBeEnabled();
    expect(
      screen.queryByText("Add a provider key first."),
    ).not.toBeInTheDocument();
    await user.click(
      screen.getByRole("button", { name: "Change model pools" }),
    );
    await user.click(
      screen.getByRole("button", { name: "Remove subscription-pool" }),
    );
    expect(create).toBeDisabled();
    await user.click(
      screen.getByRole("combobox", {
        name: "Add a provider, model pool or auto router",
      }),
    );
    await user.click(
      await screen.findByRole("option", { name: /subscription-pool/ }),
    );
    mutateAsync.mockResolvedValueOnce({
      ...createdKey("standard", []),
      id: "vk-pool-only",
    });
    await user.click(create);
    expect(mutateAsync).toHaveBeenCalledWith({
      data: expect.objectContaining({
        keyType: "standard",
        providerApiKeys: [],
        modelPoolIds: ["pool-1"],
      }),
    });
    expect(screen.getByRole("button", { name: "Copy key" })).toBeVisible();
    expect(
      screen.getByRole("radio", { name: /Unified Model API/ }),
    ).toBeChecked();
    const native = screen.getByRole("radio", { name: /Native provider API/ });
    expect(native).toBeDisabled();
    await user.click(native);
    expect(
      screen.getByText("https://proxy.example.com/unified-model"),
    ).toBeVisible();
    expect(screen.getByRole("link", { name: "Model pools" })).toHaveAttribute(
      "href",
      "/llm/model-pools",
    );
    expect(
      screen.getByText(
        /assigned pool's exact name as the model. Do not add a provider prefix/,
      ),
    ).toBeVisible();
    expect(screen.getByText(/open its Connect section/)).toBeVisible();
    expect(screen.queryByText(/\/undefined/)).not.toBeInTheDocument();
    expect(
      screen.queryByText(/No runnable model example/),
    ).not.toBeInTheDocument();
  });

  it("finishes management-only creation without displaying a member's bearer value", async () => {
    const user = userEvent.setup();
    const onOpenChange = vi.fn();
    mutateAsync.mockResolvedValueOnce({
      id: "member-key",
      name: "Member key",
      keyType: "passthrough",
    });
    renderDialog("passthrough", { onOpenChange });
    await user.type(screen.getByLabelText("Name"), "Member key");
    await user.click(screen.getByRole("button", { name: "Create key" }));
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(
      screen.queryByRole("button", { name: "Copy key" }),
    ).not.toBeInTheDocument();
  });
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
    // Every value starts at a sensible default, so Create is enough.
    expect(screen.getByLabelText("Name")).toHaveValue(
      "Self Admin's virtual key (2)",
    );
    await user.click(screen.getByRole("button", { name: "Change providers" }));
    await user.click(
      screen.getByRole("button", { name: "Show OpenAI details" }),
    );
    expect(screen.getByRole("region", { name: "Access" })).toHaveTextContent(
      "Main OpenAI",
    );
    expect(screen.queryByText("Key type")).not.toBeInTheDocument();
    expect(screen.getByLabelText("Expires")).toHaveTextContent("Never");
    expect(screen.getByLabelText("Who pays for this key?")).not.toBeVisible();
    expect(screen.getByLabelText("Label key")).not.toBeVisible();
    expect(
      screen.queryByRole("button", { name: "Continue" }),
    ).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Create key" }));

    expect(mutateAsync).toHaveBeenCalledWith({
      data: {
        name: "Self Admin's virtual key (2)",
        keyType: "standard",
        includeFutureProviders: false,
        expiresAt: undefined,
        providerApiKeys: [
          { provider: "openai", providerApiKeyId: "provider-key-1" },
        ],
        labels: [],
        billingTeamId: undefined,
        spendCap: undefined,
        initialGrants: [],
      },
    });
  });

  it("bills a team the caller administers and caps the key", async () => {
    const user = userEvent.setup();
    renderDialog("standard");

    expect(screen.getByRole("button", { name: "Advanced" })).toHaveAttribute(
      "aria-expanded",
      "false",
    );
    expect(screen.getByLabelText("Spend cap in dollars")).not.toBeVisible();
    expect(
      screen.getByRole("heading", { name: "Who can use it", hidden: true }),
    ).not.toBeVisible();
    await user.click(screen.getByRole("button", { name: "Advanced" }));
    expect(
      screen.getByRole("heading", { name: "Who can use it" }),
    ).toBeVisible();
    await user.click(screen.getByLabelText("Who pays for this key?"));
    await user.click(await screen.findByRole("option", { name: /^Platform/ }));
    expect(
      screen.getByText(/The owner's personal limit does not apply/),
    ).toBeVisible();
    await user.type(screen.getByLabelText("Spend cap in dollars"), "500");
    await user.click(screen.getByRole("button", { name: "Create key" }));

    expect(mutateAsync).toHaveBeenCalledWith({
      data: expect.objectContaining({
        billingTeamId: "team-platform",
        spendCap: { limitValue: 500, cleanupInterval: "calendar_month" },
      }),
    });
  });

  it("keeps a cap period picked before the amount", async () => {
    const user = userEvent.setup();
    renderDialog("standard");

    expect(screen.getByRole("button", { name: "Advanced" })).toHaveAttribute(
      "aria-expanded",
      "false",
    );
    expect(screen.getByLabelText("Spend cap in dollars")).not.toBeVisible();
    await user.click(screen.getByRole("button", { name: "Advanced" }));
    await user.click(screen.getByLabelText("Cap resets"));
    await user.click(await screen.findByRole("option", { name: "Every week" }));
    await user.type(screen.getByLabelText("Spend cap in dollars"), "100");
    await user.click(screen.getByRole("button", { name: "Create key" }));

    expect(mutateAsync).toHaveBeenCalledWith({
      data: expect.objectContaining({
        spendCap: { limitValue: 100, cleanupInterval: "calendar_week_monday" },
      }),
    });
  });

  it("creates a passthrough key with its budget in one dialog", async () => {
    const user = userEvent.setup();
    renderDialog("passthrough");
    expect(
      screen.queryByRole("list", { name: "Steps" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Continue" }),
    ).not.toBeInTheDocument();
    await user.type(screen.getByLabelText("Name"), "Regional key");
    expect(screen.getByRole("button", { name: "Advanced" })).toHaveAttribute(
      "aria-expanded",
      "false",
    );
    expect(screen.getByLabelText("Spend cap in dollars")).not.toBeVisible();
    await user.click(screen.getByRole("button", { name: "Advanced" }));
    await user.type(screen.getByLabelText("Spend cap in dollars"), "250");
    await user.type(screen.getByLabelText("Label key"), "environment");
    await user.type(screen.getByLabelText("Label value"), "development");
    await user.click(screen.getByRole("button", { name: "Advanced" }));
    await user.click(screen.getByRole("button", { name: "Create key" }));
    expect(mutateAsync).toHaveBeenCalledWith({
      data: expect.objectContaining({
        name: "Regional key",
        keyType: "passthrough",
        labels: [{ key: "environment", value: "development" }],
        spendCap: { limitValue: 250, cleanupInterval: "calendar_month" },
      }),
    });
  });

  it("focuses the name when it opens", async () => {
    renderDialog("standard");

    await waitFor(() => expect(screen.getByLabelText("Name")).toHaveFocus());
  });

  it("creates automatic coverage without freezing the currently selected primary keys", async () => {
    vi.mocked(useScopedCapabilities).mockReturnValue({
      data: [{ resource: "llmProviderApiKey", action: "use", scope: "*" }],
    } as unknown as ReturnType<typeof useScopedCapabilities>);
    const user = userEvent.setup();
    renderDialog("standard");
    await user.click(
      screen.getByRole("radio", { name: /Current and future providers/ }),
    );
    await user.click(screen.getByRole("button", { name: "Create key" }));
    expect(mutateAsync).toHaveBeenCalledWith({
      data: expect.objectContaining({
        includeFutureProviders: true,
        providerApiKeys: [],
      }),
    });
  });

  it("starts with every provider's primary key", async () => {
    const user = userEvent.setup();
    renderDialog("standard", {
      parentableKeys: SEVERAL_KEYS,
      initialProviderApiKeys: null,
    });

    const section = screen.getByRole("region", { name: "Access" });
    // Folded, the providers line says how many and which keys they use.
    expect(section).toHaveTextContent("2 providers · each on its primary key");
    await user.click(screen.getByRole("button", { name: "Change providers" }));
    await user.click(
      screen.getByRole("button", { name: "Show OpenAI details" }),
    );
    expect(section).toHaveTextContent("Team key");
    await user.click(screen.getByRole("button", { name: "Done providers" }));
    expect(
      screen.queryByRole("button", { name: "Show OpenAI details" }),
    ).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Create key" }));

    expect(mutateAsync).toHaveBeenCalledWith({
      data: expect.objectContaining({
        providerApiKeys: [
          { provider: "openai", providerApiKeyId: "openai-team" },
          { provider: "zhipuai", providerApiKeyId: "zhipu-key" },
        ],
      }),
    });
  });

  it("stops using a provider and adds it back from the picker", async () => {
    const user = userEvent.setup();
    renderDialog("standard", {
      parentableKeys: SEVERAL_KEYS,
      initialProviderApiKeys: null,
    });

    await user.click(screen.getByRole("button", { name: "Change providers" }));
    await user.click(screen.getByRole("button", { name: "Stop using OpenAI" }));
    await user.click(screen.getByRole("button", { name: "Create key" }));
    expect(mutateAsync).toHaveBeenLastCalledWith({
      data: expect.objectContaining({
        providerApiKeys: [
          { provider: "zhipuai", providerApiKeyId: "zhipu-key" },
        ],
      }),
    });

    await user.click(
      screen.getByRole("combobox", {
        name: "Add a provider, model pool or auto router",
      }),
    );
    await user.click(await screen.findByRole("option", { name: /^Team key/ }));
    await user.click(
      screen.getByRole("button", { name: "Show OpenAI details" }),
    );
    expect(screen.getByRole("region", { name: "Access" })).toHaveTextContent(
      "Team key",
    );
  });

  it("offers a provider's keys only until one of them is in the list", async () => {
    const user = userEvent.setup();
    renderDialog("standard", {
      parentableKeys: SEVERAL_KEYS,
      initialProviderApiKeys: null,
    });
    const picker = screen.getByRole("combobox", {
      name: "Add a provider, model pool or auto router",
    });

    // OpenAI already has its Team key, so none of its keys are offered.
    await user.click(picker);
    expect(
      await screen.findByText("Everything is already added."),
    ).toBeVisible();
    expect(screen.queryByRole("option")).not.toBeInTheDocument();
    await user.keyboard("{Escape}");

    // Switching keys is remove, then add the other one.
    await user.click(screen.getByRole("button", { name: "Change providers" }));
    await user.click(screen.getByRole("button", { name: "Stop using OpenAI" }));
    await user.click(picker);
    await user.keyboard("openai");
    const openai = await screen.findByRole("group", { name: "OpenAI" });
    expect(
      within(openai).getByRole("option", { name: /^Team key/ }),
    ).toBeVisible();
    expect(
      screen.queryByRole("option", { name: /^Zhipu key/ }),
    ).not.toBeInTheDocument();
    await user.click(
      within(openai).getByRole("option", { name: /^Staging key/ }),
    );
    await user.click(screen.getByRole("button", { name: "Create key" }));
    expect(mutateAsync).toHaveBeenLastCalledWith({
      data: expect.objectContaining({
        providerApiKeys: [
          { provider: "zhipuai", providerApiKeyId: "zhipu-key" },
          { provider: "openai", providerApiKeyId: "openai-staging" },
        ],
      }),
    });
  });

  it("closes the picker after a pick and narrows it by kind", async () => {
    const user = userEvent.setup();
    vi.mocked(useHasPermissions).mockReturnValue({
      data: true,
    } as unknown as ReturnType<typeof useHasPermissions>);
    server.use(
      http.get("http://localhost:9000/api/model-pools", () =>
        HttpResponse.json([
          {
            id: "pool-1",
            name: "subscription-pool",
            virtualApiKeyIds: [],
            members: [
              {
                id: "member-1",
                provider: "github-copilot",
                modelId: "gpt-4.1",
                priority: 1,
                enabled: true,
              },
            ],
          },
        ]),
      ),
    );
    renderDialog("standard", {
      parentableKeys: SEVERAL_KEYS,
      initialProviderApiKeys: [],
    });

    const picker = screen.getByRole("combobox", {
      name: "Add a provider, model pool or auto router",
    });
    await user.click(picker);
    await screen.findByRole("option", { name: /subscription-pool/ });
    await user.click(screen.getByRole("button", { name: /^Model pools/ }));
    expect(
      screen.queryByRole("option", { name: /^Team key/ }),
    ).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /^Providers/ }));
    expect(
      screen.queryByRole("option", { name: /subscription-pool/ }),
    ).not.toBeInTheDocument();
    await user.click(screen.getByRole("option", { name: /^Team key/ }));
    expect(picker).toHaveAttribute("aria-expanded", "false");
    await user.click(screen.getByRole("button", { name: "Change providers" }));
    expect(
      screen.getByRole("button", { name: "Stop using OpenAI" }),
    ).toBeVisible();
  });

  it("shows a provider's several endpoint keys as one row", async () => {
    const user = userEvent.setup();
    renderDialog("standard", {
      parentableKeys: [
        { id: "ollama-a", name: "Laptop", provider: "ollama" },
        { id: "ollama-b", name: "GPU box", provider: "ollama" },
      ] as never[],
      initialProviderApiKeys: [
        { provider: "ollama", providerApiKeyId: "ollama-a" },
        { provider: "ollama", providerApiKeyId: "ollama-b" },
      ],
    });

    const access = screen.getByRole("region", { name: "Access" });
    expect(access).toHaveTextContent(/Ollama.* uses 2 keys/);
    await user.click(screen.getByRole("button", { name: "Change providers" }));
    await user.click(screen.getByRole("button", { name: /^Show .* details$/ }));
    await user.click(screen.getByRole("button", { name: "Remove Laptop" }));
    expect(access).not.toHaveTextContent("2 keys");
    await user.click(screen.getByRole("button", { name: "Create key" }));
    expect(mutateAsync).toHaveBeenLastCalledWith({
      data: expect.objectContaining({
        providerApiKeys: [{ provider: "ollama", providerApiKeyId: "ollama-b" }],
      }),
    });
  });

  it("blocks Create when no provider is used until one is picked", async () => {
    const user = userEvent.setup();
    renderDialog("standard", {
      parentableKeys: SEVERAL_KEYS,
      initialProviderApiKeys: [],
    });

    expect(screen.getByText("None yet — add one above")).toBeVisible();
    expect(screen.getByRole("button", { name: "Create key" })).toBeDisabled();
    await user.click(
      screen.getByRole("combobox", {
        name: "Add a provider, model pool or auto router",
      }),
    );
    await user.click(await screen.findByRole("option", { name: /^Zhipu key/ }));
    expect(screen.getByRole("button", { name: "Create key" })).toBeEnabled();
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
      "https://proxy.example.com/unified-model/responses",
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

  it("hands off a key on current and future providers with a request for its primary keys", async () => {
    const user = userEvent.setup();
    vi.mocked(useLlmProviderApiKeys).mockReturnValue({
      data: [
        { id: "openai-key", provider: "openai", isPrimary: true, userId: null },
      ],
    } as unknown as ReturnType<typeof useLlmProviderApiKeys>);
    mutateAsync.mockResolvedValue({
      ...createdKey("standard", []),
      includeFutureProviders: true,
    });
    renderDialog("standard");
    await createFromAnyStep(user);

    const dialog = await screen.findByTestId("virtual-key-create-dialog");
    expect(dialog).toHaveTextContent('"model": "openai:gpt-5.6-sol"');
  });

  it("offers image-only mapped Azure deployments with generation and multipart edit examples", async () => {
    const user = userEvent.setup();
    vi.mocked(useModelsWithApiKeys).mockReturnValue({
      isPending: false,
      data: [
        {
          modelId: "studio-images",
          provider: "azure",
          isBest: true,
          apiKeys: [{ id: "azure-key" }],
          ignored: false,
          embeddingDimensions: null,
          inputModalities: ["text", "image"],
          outputModalities: ["image"],
          supportedEndpoints: null,
        },
      ],
    } as unknown as ReturnType<typeof useModelsWithApiKeys>);
    mutateAsync.mockResolvedValue(
      createdKey("standard", [
        { provider: "azure", providerApiKeyId: "azure-key" },
      ]),
    );
    renderDialog("standard");
    await createFromAnyStep(user);
    const dialog = await screen.findByTestId("virtual-key-create-dialog");
    expect(dialog).not.toHaveTextContent("/unified-model/images");
    expect(dialog).toHaveTextContent(
      "Choose the native provider API for image generation examples.",
    );
    await user.click(within(dialog).getByText("Native provider API"));
    expect(dialog).toHaveTextContent(
      "https://proxy.example.com/azure/images/generations",
    );
    expect(dialog).toHaveTextContent('"model": "studio-images"');
    expect(dialog).not.toHaveTextContent('"messages"');
    await user.click(within(dialog).getByLabelText("Image operation"));
    await user.click(screen.getByRole("option", { name: "Edit an image" }));
    expect(dialog).toHaveTextContent(
      "https://proxy.example.com/azure/images/edits",
    );
    expect(dialog).toHaveTextContent("image[]=@edit.png");
    expect(dialog).toHaveTextContent("Authorization: Bearer arch_created");
    expect(dialog).toHaveTextContent("Save your input image as edit.png");
    expect(dialog).not.toHaveTextContent("Content-Type: application/json");
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
      within(dialog).getByRole("radio", { name: /Unified Model API/ }),
    ).toBeDisabled();
    expect(dialog).toHaveTextContent("Authorization: Bearer $OPENAI_API_KEY");
    expect(dialog).toHaveTextContent("X-Archestra-Virtual-Key: arch_created");
  });

  it("makes the creator the owner and hides the owner field from members", async () => {
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
    expect(screen.queryByLabelText("Owner")).not.toBeInTheDocument();
    await createFromAnyStep(user);

    expect(mutateAsync).toHaveBeenCalledWith({
      data: expect.not.objectContaining({ ownerId: expect.anything() }),
    });
  });

  it("creates keys for the current user without an owner selector", async () => {
    const user = userEvent.setup();
    renderDialog("standard");
    expect(screen.queryByLabelText("Owner")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Create key" }));
    expect(mutateAsync.mock.calls[0]?.[0].data).not.toHaveProperty("ownerId");
  });
});

async function createFromAnyStep(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole("button", { name: "Create key" }));
}

const SEVERAL_KEYS = [
  {
    id: "openai-staging",
    name: "Staging key",
    provider: "openai",
    isPrimary: false,
  },
  {
    id: "openai-team",
    name: "Team key",
    provider: "openai",
    isPrimary: true,
  },
  { id: "zhipu-key", name: "Zhipu key", provider: "zhipuai", isPrimary: true },
] as never[];

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
    onOpenChange?: (open: boolean) => void;
    existingKeys?: Array<{
      authorId: string;
      keyType: "standard" | "passthrough";
    }>;
    parentableKeys?: never[];
    /** null starts from every provider's primary key. */
    initialProviderApiKeys?: Array<{
      provider: "openai" | "zhipuai" | "ollama";
      providerApiKeyId: string;
    }> | null;
  } = {},
) {
  // The permissions section reads the role and team catalog through queries.
  return render(
    <QueryClientProvider client={new QueryClient()}>
      <CreateVirtualKeyDialog
        open
        onOpenChange={options.onOpenChange ?? vi.fn()}
        keyType={keyType}
        parentableKeys={
          options.parentableKeys ?? [
            {
              id: "provider-key-1",
              name: "Main OpenAI",
              provider: "openai",
            } as never,
          ]
        }
        initialProviderApiKeys={
          options.initialProviderApiKeys === null
            ? undefined
            : (options.initialProviderApiKeys ??
              (keyType === "standard"
                ? [{ provider: "openai", providerApiKeyId: "provider-key-1" }]
                : undefined))
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
