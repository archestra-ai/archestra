import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useAppName } from "@/lib/hooks/use-app-name";
import { useLlmModels, useModelsWithApiKeys } from "@/lib/llm-models.query";
import { useOrganization } from "@/lib/organization.query";
import { useCreateVirtualApiKey } from "@/lib/virtual-api-keys.query";
import { CreateVirtualKeyDialog } from "./create-virtual-key-dialog";

vi.mock("@/lib/virtual-api-keys.query", () => ({
  useCreateVirtualApiKey: vi.fn(),
}));
vi.mock("@/lib/llm-models.query", () => ({
  useLlmModels: vi.fn(),
  useModelsWithApiKeys: vi.fn(),
}));
vi.mock("@/lib/organization.query");
vi.mock("@/lib/hooks/use-app-name");
vi.mock("@/components/owner-select-field", async () => {
  const actual = await vi.importActual<
    typeof import("@/components/owner-select-field")
  >("@/components/owner-select-field");
  return {
    ...actual,
    OwnerSelectField: ({
      onChange,
      onSelectedOwnerChange,
    }: {
      onChange: (userId: string) => void;
      onSelectedOwnerChange?: (owner: { userId: string; name: string }) => void;
    }) => (
      <button
        type="button"
        onClick={() => {
          onSelectedOwnerChange?.({ userId: "u-bob", name: "Bob Brown" });
          onChange("u-bob");
        }}
      >
        Choose Bob
      </button>
    ),
  };
});
vi.mock("@/components/proxy-auth-provider-key-fields", () => ({
  ProviderKeyAccessFields: ({
    onProviderApiKeyIdsChange,
  }: {
    onProviderApiKeyIdsChange: (value: Record<string, string>) => void;
  }) => (
    <section>
      <h3>Provider Keys</h3>
      <button
        type="button"
        onClick={() => onProviderApiKeyIdsChange({ openai: "provider-key-1" })}
      >
        Map provider key
      </button>
    </section>
  ),
}));

const mutateAsync = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(useAppName).mockReturnValue("Archestra");
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
      screen.getByRole("heading", { name: "Create Passthrough Virtual Key" }),
    ).toBeInTheDocument();
    expect(
      screen.getByPlaceholderText("My passthrough key"),
    ).toBeInTheDocument();
    expect(screen.getByLabelText("Name")).toHaveValue("");
    expect(screen.queryByText("Key type")).not.toBeInTheDocument();
    expect(screen.queryByText("Standard")).not.toBeInTheDocument();
    expect(screen.queryByText("Passthrough")).not.toBeInTheDocument();

    await user.type(screen.getByLabelText("Name"), "My passthrough key");
    await user.click(screen.getByRole("button", { name: "Create" }));

    expect(mutateAsync).toHaveBeenCalledWith({
      data: {
        name: "My passthrough key",
        keyType: "passthrough",
        expiresAt: undefined,
        ownerId: undefined,
        labels: [],
      },
    });
  });

  it("creates the standard type supplied by its resource tab without a type selector", async () => {
    const user = userEvent.setup();
    renderDialog("standard");

    expect(
      screen.getByRole("heading", { name: "Create Standard Virtual Key" }),
    ).toBeInTheDocument();
    expect(screen.getByPlaceholderText("My virtual key")).toBeInTheDocument();
    expect(screen.getByLabelText("Name")).toHaveValue(
      "Self Admin's virtual key (2)",
    );
    expect(
      screen
        .getByLabelText("Name")
        .compareDocumentPosition(screen.getByText("Provider Keys")) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Permissions" }));
    expect(screen.getByText("Permissions", { selector: "h3" })).toBeVisible();
    await user.click(screen.getByRole("button", { name: "General" }));
    expect(screen.queryByText("Key type")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Map provider key" }));
    await user.click(screen.getByRole("button", { name: "Create" }));

    expect(mutateAsync).toHaveBeenCalledWith({
      data: {
        name: "Self Admin's virtual key (2)",
        keyType: "standard",
        expiresAt: undefined,
        initialGrants: [],
        providerApiKeys: [
          { provider: "openai", providerApiKeyId: "provider-key-1" },
        ],
        ownerId: undefined,
        labels: [],
      },
    });
  });

  it("keeps labels under Advanced and saves the in-progress label", async () => {
    const user = userEvent.setup();
    renderDialog("passthrough");

    expect(screen.queryByLabelText("Label key")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Advanced" }));
    await user.type(screen.getByLabelText("Name"), "Regional key");
    await user.type(screen.getByLabelText("Label key"), "region");
    await user.type(screen.getByLabelText("Label value"), "eu");
    await user.click(screen.getByRole("button", { name: "Create" }));

    expect(mutateAsync).toHaveBeenCalledWith({
      data: {
        name: "Regional key",
        keyType: "passthrough",
        expiresAt: undefined,
        ownerId: undefined,
        labels: [{ key: "region", value: "eu" }],
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
    await user.click(screen.getByRole("button", { name: "Map provider key" }));
    await user.click(screen.getByRole("button", { name: "Create" }));

    const dialog = await screen.findByTestId("virtual-key-create-dialog");
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
    await user.click(screen.getByRole("button", { name: "Map provider key" }));
    await user.click(screen.getByRole("button", { name: "Create" }));

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
    await user.click(screen.getByRole("button", { name: "Create" }));

    const dialog = await screen.findByTestId("virtual-key-create-dialog");
    expect(
      within(dialog).getByRole("radio", { name: /Model Router/ }),
    ).toBeDisabled();
    expect(dialog).toHaveTextContent("Authorization: Bearer $OPENAI_API_KEY");
    expect(dialog).toHaveTextContent("X-Archestra-Virtual-Key: arch_created");
  });

  it("updates the generated name when the key owner changes", async () => {
    const user = userEvent.setup();
    renderDialog("standard", {
      isVirtualKeyAdmin: true,
      existingKeys: [
        { authorId: "u-self", keyType: "standard" },
        { authorId: "u-bob", keyType: "standard" },
      ],
    });

    expect(screen.getByLabelText("Name")).toHaveValue(
      "Self Admin's virtual key (2)",
    );

    await user.click(screen.getByRole("button", { name: "Advanced" }));
    await user.click(screen.getByRole("button", { name: "Choose Bob" }));

    expect(screen.getByLabelText("Name")).toHaveValue(
      "Bob Brown's virtual key (2)",
    );
  });
});

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
    isVirtualKeyAdmin?: boolean;
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
        parentableKeys={[]}
        connectionBaseUrl="https://proxy.example.com"
        defaultExpirationSeconds={null}
        isVirtualKeyAdmin={options.isVirtualKeyAdmin ?? false}
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
