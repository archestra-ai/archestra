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
import { useFeature } from "@/lib/config/config.query";
import { useLlmModels, useModelsWithApiKeys } from "@/lib/llm-models.query";
import { useUpdateVirtualApiKey } from "@/lib/virtual-api-keys.query";
import {
  type EditableVirtualKey,
  EditVirtualKeyDialog,
} from "./edit-virtual-key-dialog";

vi.mock("@/lib/virtual-api-keys.query", () => ({
  useUpdateVirtualApiKey: vi.fn(),
}));
vi.mock("@/lib/auth/auth.query");
vi.mock("@/lib/config/config.query");
vi.mock("@/lib/llm-models.query", () => ({
  useLlmModels: vi.fn(),
  useModelsWithApiKeys: vi.fn(),
  // The key pickers' per-key model counts.
  useLlmModelIdsByKey: () => ({ data: [], isPending: false }),
}));
vi.mock("@/components/virtual-key-connection-base-url", () => ({
  useConnectionBaseUrl: () => "https://proxy.example.com",
}));
vi.mock("@/lib/llm-provider-api-keys.query", () => ({
  useLlmProviderApiKeys: () => ({ data: [] }),
}));
vi.mock("@/components/resource-access-section", () => ({
  ResourceAccessSection: ({
    resource,
    id,
  }: {
    resource: string;
    id?: string;
  }) => (
    <div data-testid="resource-access" data-resource={resource} data-id={id} />
  ),
}));

const mutateAsync = vi.fn();
const server = setupServer();
beforeAll(() => {
  server.listen({ onUnhandledRequest: "bypass" });
  archestraApiClient.setConfig({ baseUrl: "http://localhost:9000" });
});
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

const virtualKey = {
  id: "vk-1",
  name: "Team key",
  keyType: "standard",
  scope: "team",
  teams: [{ id: "team-1", name: "Platform" }],
  providerApiKeys: [{ provider: "openai", providerApiKeyId: "pak-1" }],
  labels: [],
  expiresAt: null,
  billingTeamId: null,
  billingTeam: null,
  spendCap: null,
} as unknown as EditableVirtualKey;

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(useFeature).mockReturnValue(undefined);
  vi.mocked(useHasPermissions).mockReturnValue({
    data: false,
  } as unknown as ReturnType<typeof useHasPermissions>);
  vi.mocked(useSession).mockReturnValue({
    data: null,
  } as unknown as ReturnType<typeof useSession>);
  vi.mocked(useUpdateVirtualApiKey).mockReturnValue({
    isPending: false,
    mutateAsync,
  } as unknown as ReturnType<typeof useUpdateVirtualApiKey>);
  vi.mocked(useLlmModels).mockReturnValue({
    isPending: false,
    data: [],
  } as unknown as ReturnType<typeof useLlmModels>);
  vi.mocked(useModelsWithApiKeys).mockReturnValue({
    isPending: false,
    data: [
      {
        modelId: "gpt-5.6-sol",
        provider: "openai",
        isBest: true,
        apiKeys: [{ id: "pak-1" }],
        ignored: false,
        embeddingDimensions: null,
        inputModalities: null,
        outputModalities: null,
        supportedEndpoints: null,
      },
    ],
  } as unknown as ReturnType<typeof useModelsWithApiKeys>);
});

describe("EditVirtualKeyDialog", () => {
  it("retains pool-only access on rename and blocks removing its last pool", async () => {
    const user = userEvent.setup();
    vi.mocked(useFeature).mockImplementation(
      (feature) => feature === "llmModelPoolsEnabled",
    );
    vi.mocked(useHasPermissions).mockReturnValue({
      data: true,
    } as unknown as ReturnType<typeof useHasPermissions>);
    server.use(
      http.get("http://localhost:9000/api/model-pools", () =>
        HttpResponse.json([
          {
            id: "pool-1",
            name: "subscription-pool",
            virtualApiKeyIds: [virtualKey.id],
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
    renderDialog({
      ...virtualKey,
      includeFutureProviders: false,
      providerApiKeys: [],
    });
    const save = screen.getByRole("button", { name: "Save Changes" });
    await waitFor(() => expect(save).toBeEnabled());
    await user.clear(screen.getByLabelText("Name"));
    await user.type(screen.getByLabelText("Name"), "Pool key renamed");
    await user.click(save);
    expect(mutateAsync).toHaveBeenCalledWith({
      id: virtualKey.id,
      data: expect.objectContaining({
        name: "Pool key renamed",
        providerApiKeys: [],
      }),
    });
    expect(mutateAsync.mock.calls[0]?.[0].data).not.toHaveProperty(
      "modelPoolIds",
    );
    await user.click(screen.getByRole("button", { name: "Provider keys" }));
    await user.click(
      screen.getByRole("button", { name: "Remove subscription-pool" }),
    );
    expect(save).toBeDisabled();
    await user.click(save);
    expect(mutateAsync).toHaveBeenCalledTimes(1);
  });

  it("lets a non-manager rename a pool-only key without rewriting its grants", async () => {
    const user = userEvent.setup();
    vi.mocked(useFeature).mockImplementation(
      (feature) => feature === "llmModelPoolsEnabled",
    );
    renderDialog({
      ...virtualKey,
      includeFutureProviders: false,
      providerApiKeys: [],
    });
    await user.type(screen.getByLabelText("Name"), " renamed");
    await user.click(screen.getByRole("button", { name: "Save Changes" }));
    expect(mutateAsync).toHaveBeenCalledOnce();
    expect(mutateAsync.mock.calls[0]?.[0].data).not.toHaveProperty(
      "modelPoolIds",
    );
  });

  it("shows reusable connection instructions without revealing the saved key", async () => {
    const user = userEvent.setup();
    renderDialog();

    await user.click(screen.getByRole("button", { name: "Connect" }));

    expect(screen.getByText("Use your saved key")).toBeVisible();
    expect(
      screen.getByText(/full key was shown only when it was created/),
    ).toBeVisible();
    expect(
      screen.queryByRole("button", { name: "Copy key" }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByText(/Authorization: Bearer \$ARCHESTRA_LLM_VIRTUAL_KEY/),
    ).toBeVisible();
    expect(
      screen.getByText("https://proxy.example.com/unified-model"),
    ).toBeVisible();
    expect(
      screen.queryByRole("button", { name: "Save Changes" }),
    ).not.toBeInTheDocument();
  });

  it("keeps personal passthrough keys to General and Connect", async () => {
    const user = userEvent.setup();
    renderDialog({
      ...virtualKey,
      keyType: "passthrough",
      providerApiKeys: [],
    });

    expect(
      screen.queryByRole("button", { name: "Permissions" }),
    ).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Connect" }));
    expect(screen.getByText("Use your saved key")).toBeVisible();
    // Named in the explanation, and sent in the example request too: before
    // any model syncs, the request falls back to the provider's default model.
    for (const header of screen.getAllByText(/X-Archestra-Virtual-Key/)) {
      expect(header).toBeVisible();
    }
  });

  it("edits access on General through the key's own permission policy", () => {
    renderDialog();

    // Access sits with the key's other settings, not behind a tab of its own.
    expect(
      screen.queryByRole("button", { name: "Permissions" }),
    ).not.toBeInTheDocument();
    const section = screen.getByTestId("resource-access");
    expect(section).toBeVisible();
    expect(section).toHaveAttribute("data-resource", "llmVirtualKey");
    expect(section).toHaveAttribute("data-id", "vk-1");
  });

  it("saves without rewriting the retired scope and team fields", async () => {
    // A converted key answers every access question from its grants. Sending
    // a scope here would write columns no read path consults, and would tell
    // the person their change took effect when it did not.
    const user = userEvent.setup();
    renderDialog();

    await user.clear(screen.getByLabelText("Name"));
    await user.type(screen.getByLabelText("Name"), "Renamed key");
    await user.click(screen.getByRole("button", { name: "Save Changes" }));

    expect(mutateAsync).toHaveBeenCalledTimes(1);
    const payload = mutateAsync.mock.calls[0]?.[0] as {
      id: string;
      data: Record<string, unknown>;
    };
    expect(payload.id).toBe("vk-1");
    expect(payload.data.name).toBe("Renamed key");
    expect(payload.data).not.toHaveProperty("scope");
    expect(payload.data).not.toHaveProperty("teams");
    // Unchanged billing stays out, so renaming never needs limit permissions.
    expect(payload.data).not.toHaveProperty("billingTeamId");
    expect(payload.data).not.toHaveProperty("spendCap");
  });

  it("preserves label drafts when Advanced is collapsed before saving", async () => {
    const user = userEvent.setup();
    renderDialog();
    expect(screen.getByLabelText("Label key")).not.toBeVisible();
    await user.click(screen.getByRole("button", { name: "Advanced" }));
    await user.type(screen.getByLabelText("Label key"), "environment");
    await user.type(screen.getByLabelText("Label value"), "development");
    await user.click(screen.getByRole("button", { name: "Advanced" }));
    await user.click(screen.getByRole("button", { name: "Save Changes" }));
    expect(mutateAsync).toHaveBeenCalledWith({
      id: "vk-1",
      data: expect.objectContaining({
        labels: [{ key: "environment", value: "development" }],
      }),
    });
  });

  it("shows a saved cap read-only to someone who cannot manage limits", async () => {
    const user = userEvent.setup();
    renderDialog({
      ...virtualKey,
      spendCap: {
        limitId: "limit-1",
        limitValue: 500,
        cleanupInterval: "calendar_month",
        currentUsage: 212,
      },
    } as EditableVirtualKey);

    expect(screen.getByRole("button", { name: "Advanced" })).toHaveAttribute(
      "aria-expanded",
      "false",
    );
    expect(screen.getByLabelText("Spend cap in dollars")).not.toBeVisible();
    await user.click(screen.getByRole("button", { name: "Advanced" }));

    expect(screen.getByLabelText("Spend cap in dollars")).toHaveValue("500");
    expect(screen.getByLabelText("Spend cap in dollars")).toBeDisabled();
    expect(screen.getByText("$212 spent this month.")).toBeVisible();
    expect(screen.getByText(/Ask someone who manages limits/)).toBeVisible();
  });
});

function renderDialog(key: EditableVirtualKey = virtualKey) {
  return render(
    <QueryClientProvider client={new QueryClient()}>
      <EditVirtualKeyDialog virtualKey={key} onOpenChange={vi.fn()} />
    </QueryClientProvider>,
  );
}
