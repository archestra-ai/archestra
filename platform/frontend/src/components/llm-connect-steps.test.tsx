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
import { EndpointCard } from "@/app/llm/proxy/_parts/endpoint-card";
import {
  useHasPermissions,
  useScopedCapabilities,
  useSession,
} from "@/lib/auth/auth.query";
import { useProviderBaseUrls } from "@/lib/config/config.query";
import {
  useAppearanceSettings,
  useOrganization,
} from "@/lib/organization.query";
import { LlmConnectSteps } from "./llm-connect-steps";

// Keep a missing MSW handler away from the developer's running backend.
const API_ORIGIN = "http://127.0.0.1:1";

// The credential picker is a Radix Select, which needs pointer capture and
// scrollIntoView that jsdom lacks.
Element.prototype.scrollIntoView = vi.fn();
Element.prototype.hasPointerCapture = vi.fn().mockReturnValue(false);
Element.prototype.setPointerCapture = vi.fn();
Element.prototype.releasePointerCapture = vi.fn();

vi.mock("@/lib/auth/auth.query");
vi.mock("@/lib/organization.query");
vi.mock("@/lib/config/config.query");

const server = setupServer(
  http.get(`${API_ORIGIN}/api/llm-proxy`, () =>
    HttpResponse.json({ id: "proxy-1", identityProviderId: null }),
  ),
);

beforeAll(() => {
  server.listen({ onUnhandledRequest: "bypass" });
  archestraApiClient.setConfig({ baseUrl: API_ORIGIN });
});
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

function renderSteps(
  selected: "jev" | "gemini",
  auth: "standard" | "passthrough" | "oauth" = "standard",
) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const targetLabel = selected === "jev" ? "Jev" : "Gemini";
  return render(
    <QueryClientProvider client={queryClient}>
      <ol>
        <LlmConnectSteps
          firstNumber={3}
          baseUrl="http://localhost:3000/v1"
          selected={selected}
          auth={auth}
          targetLabel={targetLabel}
          showKeyPools
          offerAutoModel
        />
      </ol>
    </QueryClientProvider>,
  );
}

describe("LlmConnectSteps", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(useAppearanceSettings).mockReturnValue({
      data: undefined,
      isLoading: false,
    } as unknown as ReturnType<typeof useAppearanceSettings>);
    vi.mocked(useProviderBaseUrls).mockReturnValue({
      data: {},
    } as unknown as ReturnType<typeof useProviderBaseUrls>);
    vi.mocked(useHasPermissions).mockReturnValue({
      data: true,
      isPending: false,
    } as unknown as ReturnType<typeof useHasPermissions>);
    vi.mocked(useOrganization).mockReturnValue({
      data: null,
    } as unknown as ReturnType<typeof useOrganization>);
    vi.mocked(useSession).mockReturnValue({
      data: { user: { id: "user-1" } },
    } as unknown as ReturnType<typeof useSession>);
    server.use(
      http.get(`${API_ORIGIN}/api/llm-models`, () => HttpResponse.json([])),
      http.get(`${API_ORIGIN}/api/llm-models/key-model-ids`, () =>
        HttpResponse.json([]),
      ),
      http.get(`${API_ORIGIN}/api/llm-models/available`, () =>
        HttpResponse.json([]),
      ),
      http.get(`${API_ORIGIN}/api/llm-virtual-keys`, ({ request }) =>
        HttpResponse.json(
          page(
            new URL(request.url).searchParams.get("keyType") === "standard"
              ? [JUDGE_KEY]
              : [],
          ),
        ),
      ),
    );
  });

  it.each([
    "standard",
    "passthrough",
  ] as const)("selects image examples by capabilities for %s credentials and restores text requests", async (keyType) => {
    const mapping = {
      provider: "gemini",
      providerApiKeyId: "pk-gemini",
      providerApiKeyName: "Studio",
    };
    const models = [
      {
        modelId: "gemini-nano-banana-2.1",
        outputModalities: ["text", "image"],
        isBest: true,
      },
      { modelId: "gemini-2.5-flash-image", outputModalities: ["image"] },
      { modelId: "gemini-3-pro-image", outputModalities: ["text", "image"] },
      { modelId: "gemini-3.1-flash-image", outputModalities: ["image"] },
      { modelId: "gemini-3.8-flash", outputModalities: ["text"] },
      {
        modelId: "gemini-other-key",
        outputModalities: ["image"],
        unmapped: true,
      },
    ].map(({ unmapped, ...model }) => ({
      ...model,
      provider: "gemini",
      ignored: false,
      embeddingDimensions: null,
      inputModalities: ["text", "image"],
      apiKeys: [{ id: unmapped ? "other-key" : mapping.providerApiKeyId }],
    }));
    server.use(
      http.get(`${API_ORIGIN}/api/llm-provider-api-keys`, () =>
        HttpResponse.json([
          {
            ...JEV_PROVIDER_KEY,
            id: mapping.providerApiKeyId,
            name: "Studio",
            provider: "gemini",
          },
        ]),
      ),
      http.get(`${API_ORIGIN}/api/llm-virtual-keys`, ({ request }) =>
        HttpResponse.json(
          page(
            new URL(request.url).searchParams.get("keyType") === "passthrough"
              ? [PASSTHROUGH_KEY]
              : [{ ...JUDGE_KEY, providerApiKeys: [mapping] }],
          ),
        ),
      ),
      http.get(`${API_ORIGIN}/api/llm-models`, () => HttpResponse.json(models)),
      http.get(`${API_ORIGIN}/api/llm-models/available`, () =>
        HttpResponse.json(
          models
            .filter((model) => model.modelId !== "gemini-other-key")
            .map((model) => ({
              id: model.modelId,
              provider: model.provider,
              isBest: model.isBest,
              capabilities: { outputModalities: model.outputModalities },
            })),
        ),
      ),
    );
    const user = userEvent.setup();
    renderSteps("gemini", keyType);
    const requestBlock = (
      await screen.findByText(/gemini-nano-banana-2.1:generateContent/)
    ).closest("pre");
    expect(requestBlock).toHaveTextContent('"responseModalities": [');
    expect(requestBlock).toHaveTextContent('"IMAGE"');
    expect(requestBlock).not.toHaveTextContent("Hello!");
    if (keyType === "passthrough") {
      expect(requestBlock).toHaveTextContent("x-goog-api-key: $GEMINI_API_KEY");
      expect(requestBlock).toHaveTextContent("X-Archestra-Virtual-Key:");
    }
    expect(screen.getByText(/base64 image data/)).toBeVisible();
    expect(screen.queryByLabelText("Image operation")).not.toBeInTheDocument();

    await user.click(screen.getByRole("combobox", { name: "Model" }));
    expect(
      screen.getByRole("option", { name: "gemini-2.5-flash-image" }),
    ).toBeVisible();
    expect(
      screen.getByRole("option", { name: "gemini-3-pro-image" }),
    ).toBeVisible();
    expect(
      screen.getByRole("option", { name: "gemini-3.1-flash-image" }),
    ).toBeVisible();
    expect(
      screen.queryByRole("option", { name: "gemini-other-key" }),
    ).not.toBeInTheDocument();
    await user.click(screen.getByRole("option", { name: "gemini-3.8-flash" }));
    const textBlock = (
      await screen.findByText(/gemini-3.8-flash:generateContent/)
    ).closest("pre");
    expect(textBlock).toHaveTextContent("Hello!");
    expect(textBlock).not.toHaveTextContent("responseModalities");
    expect(screen.queryByText(/base64 image data/)).not.toBeInTheDocument();
  });

  it("connects to Jev with the existing virtual key that maps the Jev key", async () => {
    server.use(
      http.get(`${API_ORIGIN}/api/llm-provider-api-keys`, () =>
        HttpResponse.json([
          JEV_PROVIDER_KEY,
          { ...JEV_PROVIDER_KEY, id: "pk-jev-2", name: "Via OpenRouter" },
        ]),
      ),
    );
    renderSteps("jev");

    expect(
      await screen.findByRole("heading", { name: /Send a request/ }),
    ).toBeInTheDocument();
    // With a key in place there is no provider-key step; the virtual key
    // says which provider key its requests use.
    expect(await screen.findByText("Jev · TypeSafe")).toBeInTheDocument();
    // Someone else's key shows masked on its own line, with no way to reveal it.
    expect(screen.getByText("arch_ab••••••••••••")).toBeInTheDocument();
    expect(
      screen.getByText("Only its author can reveal this key."),
    ).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Show key" })).toBeNull();
    expect(screen.queryByText("Provider key")).not.toBeInTheDocument();

    // The request posts a decision with the saved key read from the env.
    const request = await findRequest();
    expect(request).toContain(
      "Authorization: Bearer $ARCHESTRA_LLM_VIRTUAL_KEY",
    );
    expect(request).toContain('"model": "jev-1.13.0"');
  });

  it("starts a new virtual key with one key per provider, as a key allows", async () => {
    server.use(
      http.get(`${API_ORIGIN}/api/llm-provider-api-keys`, () =>
        HttpResponse.json([
          JEV_PROVIDER_KEY,
          { ...JEV_PROVIDER_KEY, id: "pk-jev-2", name: "Via OpenRouter" },
        ]),
      ),
    );
    const user = userEvent.setup();
    renderSteps("jev");

    await chooseCreateVirtualKey(user);
    const dialog = await screen.findByRole("dialog", {
      name: "New virtual key for Jev",
    });
    const providers = within(dialog).getByRole("region", { name: "Providers" });
    expect(providers).toHaveTextContent("TypeSafe");
    expect(providers).not.toHaveTextContent("Via OpenRouter");
    await user.click(
      within(providers).getByRole("button", { name: "Stop using Jev" }),
    );
    await user.click(
      within(dialog).getByRole("combobox", {
        name: "Add a provider, model pool or auto router",
      }),
    );
    expect(
      await screen.findByRole("option", { name: /^Jev\s*TypeSafe/ }),
    ).toBeVisible();
    await user.click(
      screen.getByRole("option", { name: /^Jev\s*Via OpenRouter/ }),
    );
    expect(providers).toHaveTextContent("Via OpenRouter");
    expect(providers).not.toHaveTextContent("TypeSafe");
  });

  it("fills a key created here into the request", async () => {
    const created = {
      ...JUDGE_KEY,
      id: "vk-new",
      name: "Fresh key",
      value: "arch_fresh_secret_value",
    };
    let keys = [JUDGE_KEY];
    server.use(
      http.get(`${API_ORIGIN}/api/llm-provider-api-keys`, () =>
        HttpResponse.json([JEV_PROVIDER_KEY]),
      ),
      http.get(`${API_ORIGIN}/api/llm-virtual-keys`, () =>
        HttpResponse.json(page(keys)),
      ),
      http.post(`${API_ORIGIN}/api/llm-virtual-keys`, () => {
        keys = [JUDGE_KEY, created];
        return HttpResponse.json(created);
      }),
    );
    const user = userEvent.setup();
    renderSteps("jev");

    await chooseCreateVirtualKey(user);
    const dialog = await screen.findByRole("dialog", {
      name: "New virtual key for Jev",
    });
    // Defaults are enough: walk Key and Budget, then create from Review.
    await user.click(
      within(dialog).getByRole("button", { name: "Create key" }),
    );

    // No separate reveal dialog: the new key is selected and sits in the
    // request masked until the reader asks to see it.
    expect(
      await screen.findByRole("combobox", { name: "Virtual key" }),
    ).toHaveTextContent("Fresh key");
    expect(await screen.findByText("Jev · TypeSafe")).toBeInTheDocument();
    expect(await findRequest()).not.toContain("arch_fresh_secret_value");
    // The key's own field; revealing it reveals the request too.
    await user.click(screen.getAllByRole("button", { name: "Show key" })[0]);
    await waitFor(async () => {
      expect(await findRequest()).toContain(
        "Authorization: Bearer arch_fresh_secret_value",
      );
    });
  });

  it.each([
    true,
    false,
  ])("shows the outcome of creating an automatic key from Endpoint (shared primary: %s)", async (hasSharedPrimary) => {
    vi.mocked(useScopedCapabilities).mockReturnValue({
      data: [{ resource: "llmProviderApiKey", action: "use", scope: "*" }],
    } as unknown as ReturnType<typeof useScopedCapabilities>);
    const created = {
      ...JUDGE_KEY,
      id: "vk-new",
      name: "Fresh key",
      authorId: "user-1",
      includeFutureProviders: true,
      providerApiKeys: [],
    };
    const existing = {
      ...JUDGE_KEY,
      name: "Existing personal mapping",
      providerApiKeys: [
        {
          provider: "openai",
          providerApiKeyId: "pk-openai",
          providerApiKeyName: "Personal OpenAI",
        },
      ],
    };
    server.use(
      http.get(`${API_ORIGIN}/api/llm-provider-api-keys`, () =>
        HttpResponse.json([
          {
            ...JEV_PROVIDER_KEY,
            id: "pk-openai",
            name: hasSharedPrimary ? "Shared OpenAI" : "Personal OpenAI",
            provider: "openai",
            isPrimary: true,
            scope: hasSharedPrimary ? "org" : "personal",
            userId: hasSharedPrimary ? null : "user-1",
          },
        ]),
      ),
      http.get(`${API_ORIGIN}/api/llm-virtual-keys`, () =>
        // The freshly created key need not be on the first page.
        HttpResponse.json(page(hasSharedPrimary ? [] : [existing])),
      ),
      http.post(`${API_ORIGIN}/api/llm-virtual-keys`, async ({ request }) => {
        expect(await request.json()).toMatchObject({
          includeFutureProviders: true,
          providerApiKeys: [],
        });
        return HttpResponse.json({
          ...created,
          value: "arch_fresh_secret_value",
        });
      }),
      http.get(`${API_ORIGIN}/api/model-pools`, () => HttpResponse.json([])),
      http.get(`${API_ORIGIN}/api/auto-routers`, () => HttpResponse.json([])),
    );
    const user = userEvent.setup();
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    render(
      <QueryClientProvider client={queryClient}>
        <EndpointCard baseUrl="http://localhost:3000/v1" />
      </QueryClientProvider>,
    );
    if (!hasSharedPrimary) {
      await waitFor(() =>
        expect(
          screen.getByRole("combobox", { name: "Virtual key" }),
        ).toHaveTextContent(existing.name),
      );
    }
    await user.click(screen.getByRole("combobox", { name: "Virtual key" }));
    await user.click(
      await screen.findByRole("option", { name: "Create new virtual key" }),
    );
    const dialog = await screen.findByRole("dialog", {
      name: "New virtual key for Unified Model API",
    });
    await user.click(
      within(dialog).getByRole("radio", {
        name: /Current and future providers/,
      }),
    );
    await user.click(
      within(dialog).getByRole("button", { name: "Create key" }),
    );
    await waitFor(() => expect(dialog).not.toBeInTheDocument());

    if (hasSharedPrimary) {
      await waitFor(() =>
        expect(
          screen.getByRole("combobox", { name: "Virtual key" }),
        ).toHaveTextContent("Fresh key"),
      );
      expect(
        screen.queryByText("Pick a credential first"),
      ).not.toBeInTheDocument();
    } else {
      expect(await screen.findByText(/was created, but/)).toHaveTextContent(
        "Fresh key was created, but it has no access to this endpoint.",
      );
      expect(screen.getByRole("combobox", { name: "Model" })).toBeDisabled();
      expect(
        screen.getByRole("combobox", { name: "Virtual key" }),
      ).toHaveTextContent(/Fresh key\s*No access yet/);
      expect(
        screen.getByRole("link", { name: "Edit key to add access" }),
      ).toHaveAttribute(
        "href",
        "/llm/proxy/virtual-keys?keyType=standard&search=Fresh+key&edit=vk-new",
      );
    }
  });

  it("lists and picks the reader's own keys before anyone else's", async () => {
    server.use(
      http.get(`${API_ORIGIN}/api/llm-provider-api-keys`, () =>
        HttpResponse.json([JEV_PROVIDER_KEY]),
      ),
      http.get(`${API_ORIGIN}/api/llm-virtual-keys`, () =>
        HttpResponse.json(
          page([
            JUDGE_KEY,
            {
              ...JUDGE_KEY,
              id: "vk-mine",
              name: "My key",
              tokenStart: "arch_me",
              authorId: "user-1",
            },
          ]),
        ),
      ),
    );
    const user = userEvent.setup();
    renderSteps("jev");

    // Picked by default, so it can be revealed.
    expect(await screen.findByText("arch_me••••••••••••")).toBeInTheDocument();
    await user.click(screen.getByRole("combobox", { name: "Virtual key" }));
    const options = screen.getAllByRole("option").map((o) => o.textContent);
    expect(options).toEqual(["My key", "Judge pipeline"]);
    expect(screen.getByText("Your keys")).toBeInTheDocument();
    expect(screen.getByText("Other keys")).toBeInTheDocument();
  });

  it("reveals the reader's own key in the request on demand", async () => {
    server.use(
      http.get(`${API_ORIGIN}/api/llm-provider-api-keys`, () =>
        HttpResponse.json([JEV_PROVIDER_KEY]),
      ),
      http.get(`${API_ORIGIN}/api/llm-virtual-keys`, () =>
        HttpResponse.json(page([{ ...JUDGE_KEY, authorId: "user-1" }])),
      ),
      http.get(`${API_ORIGIN}/api/llm-virtual-keys/vk-judge/value`, () =>
        HttpResponse.json({ value: "arch_judge_secret" }),
      ),
    );
    const user = userEvent.setup();
    renderSteps("jev");

    // Masked until asked, as on the MCP gateway's examples.
    expect(await findRequest()).toContain("arch_••••");
    expect(screen.getByText("arch_ab••••••••••••")).toBeInTheDocument();
    // The key's own field; revealing it reveals the request too.
    await user.click(screen.getAllByRole("button", { name: "Show key" })[0]);
    await waitFor(async () => {
      expect(await findRequest()).toContain(
        "Authorization: Bearer arch_judge_secret",
      );
    });
    expect(screen.getByText("arch_judge_secret")).toBeInTheDocument();
  });

  it("sends the caller's own key plus the passthrough key in its header", async () => {
    server.use(
      http.get(`${API_ORIGIN}/api/llm-provider-api-keys`, () =>
        HttpResponse.json([JEV_PROVIDER_KEY]),
      ),
      http.get(`${API_ORIGIN}/api/llm-virtual-keys`, () =>
        HttpResponse.json(page([PASSTHROUGH_KEY])),
      ),
    );
    renderSteps("jev", "passthrough");

    expect(await screen.findByText("Passthrough key")).toBeInTheDocument();
    expect(
      screen.getByText(/Send your own Jev key, and this passthrough key/),
    ).toHaveTextContent("X-Archestra-Virtual-Key header");
    // The first passthrough key is taken, like a standard key, and shows as the
    // key card instead of an env var to set.
    expect(await screen.findByText("Laptop")).toBeInTheDocument();
    expect(screen.getByText("arch_pt••••••••••••")).toBeInTheDocument();
    expect(
      screen.queryByText(/Set ARCHESTRA_LLM_VIRTUAL_KEY/),
    ).not.toBeInTheDocument();
    const request = await findRequest();
    expect(request).toContain("Authorization: Bearer $JEV_API_KEY");
    expect(request).toContain("X-Archestra-Virtual-Key:");
  });

  it("does not offer 'No passthrough key' when the organization requires one", async () => {
    server.use(
      http.get(`${API_ORIGIN}/api/llm-provider-api-keys`, () =>
        HttpResponse.json([JEV_PROVIDER_KEY]),
      ),
      http.get(`${API_ORIGIN}/api/llm-virtual-keys`, () =>
        HttpResponse.json(page([PASSTHROUGH_KEY])),
      ),
    );
    const user = userEvent.setup();
    renderSteps("jev", "passthrough");
    await user.click(await screen.findByRole("button", { name: "Change" }));

    expect(
      await screen.findByText("Choose a passthrough key"),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Laptop/ })).toBeInTheDocument();
    expect(screen.queryByText("No passthrough key")).not.toBeInTheDocument();
  });

  it("sends only the caller's own key when the org allows requests without a passthrough key", async () => {
    vi.mocked(useOrganization).mockReturnValue({
      data: { allowUnauthenticatedLlmProxyRequests: true },
    } as unknown as ReturnType<typeof useOrganization>);
    server.use(
      http.get(`${API_ORIGIN}/api/llm-provider-api-keys`, () =>
        HttpResponse.json([JEV_PROVIDER_KEY]),
      ),
    );
    renderSteps("jev", "passthrough");

    expect(
      await screen.findByText(/requests aren't linked to a user/),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/Requests without a passthrough key are accepted/),
    ).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "LLM settings" })).toHaveAttribute(
      "href",
      "/settings/llm",
    );
    const request = await findRequest();
    expect(request).toContain("Authorization: Bearer $JEV_API_KEY");
    expect(request).not.toContain("X-Archestra-Virtual-Key");
  });

  it("does not offer a request without a passthrough key when the header is required", async () => {
    server.use(
      http.get(`${API_ORIGIN}/api/llm-provider-api-keys`, () =>
        HttpResponse.json([JEV_PROVIDER_KEY]),
      ),
    );
    renderSteps("jev", "passthrough");

    expect(
      await screen.findByText("No passthrough key yet"),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/Requests without a passthrough key are rejected/),
    ).toBeInTheDocument();
  });

  it("shows how an OAuth client gets the token the request sends", async () => {
    server.use(
      http.get(`${API_ORIGIN}/api/llm-provider-api-keys`, () =>
        HttpResponse.json([JEV_PROVIDER_KEY]),
      ),
      http.get(`${API_ORIGIN}/api/oauth-clients`, ({ request }) => {
        expect(new URL(request.url).searchParams.get("capability")).toBe(
          "llm:proxy",
        );
        return HttpResponse.json(
          page([
            {
              id: "oc-batch",
              clientId: "client-batch",
              name: "Batch jobs",
              grantType: "client_credentials",
              authorId: "someone-else",
              providerApiKeys: JUDGE_KEY.providerApiKeys,
              includeFutureProviders: false,
              scopes: ["llm:proxy"],
              modelPoolIds: [],
            },
          ]),
        );
      }),
    );
    renderSteps("jev", "oauth");

    const tokenRequest = await screen.findByText(
      /grant_type=client_credentials/,
    );
    expect(tokenRequest).toHaveTextContent("client_id=client-batch");
    // The note waits for the request, which waits for the models.
    expect(
      await screen.findByText(/from the token request above/),
    ).toBeInTheDocument();
    expect(
      screen.queryByText(/your token before running/),
    ).not.toBeInTheDocument();
    expect(await findRequest()).toContain(
      "Authorization: Bearer $ARCHESTRA_LLM_ACCESS_TOKEN",
    );
  });

  it("asks for the provider key first and holds the request back without one", async () => {
    server.use(
      http.get(`${API_ORIGIN}/api/llm-provider-api-keys`, () =>
        HttpResponse.json([]),
      ),
    );
    const user = userEvent.setup();
    renderSteps("jev");

    // Adding the key happens here, in a dialog, rather than on another page.
    await user.click(
      await screen.findByRole("button", { name: "Add Jev key" }),
    );
    expect(
      await screen.findByRole("dialog", { name: "Add Jev key" }),
    ).toBeInTheDocument();
    await user.keyboard("{Escape}");
    expect(
      screen.getByText(
        "The request appears here once the steps above are done.",
      ),
    ).toBeInTheDocument();
    expect(screen.queryByText(/curl "/)).not.toBeInTheDocument();
  });
});

const JEV_PROVIDER_KEY = {
  id: "pk-jev",
  name: "TypeSafe",
  provider: "jev",
  scope: "org",
};

const JUDGE_KEY = {
  id: "vk-judge",
  name: "Judge pipeline",
  keyType: "standard",
  tokenStart: "arch_ab",
  authorId: "someone-else",
  providerApiKeys: [
    {
      provider: "jev",
      providerApiKeyId: "pk-jev",
      providerApiKeyName: "TypeSafe",
    },
  ],
};

const PASSTHROUGH_KEY = {
  id: "vk-laptop",
  name: "Laptop",
  keyType: "passthrough",
  tokenStart: "arch_pt",
  authorId: "someone-else",
  providerApiKeys: [],
};

function page<T>(data: T[]) {
  return {
    data,
    pagination: {
      currentPage: 1,
      limit: 100,
      total: data.length,
      totalPages: 1,
      hasNext: false,
      hasPrev: false,
    },
  };
}

/** The whole highlighted curl block, whose tokens render as separate spans. */
async function findRequest() {
  const url = await screen.findByText(/\/v1\/jev\/decisions"/);
  return url.closest("pre")?.textContent ?? "";
}

async function chooseCreateVirtualKey(
  user: ReturnType<typeof userEvent.setup>,
) {
  // With existing keys, "+ Create new" sits on the step's title line and
  // opens the create dialog.
  await screen.findByRole("combobox", { name: "Virtual key" });
  await user.click(
    screen.getByRole("button", { name: "Create new virtual key" }),
  );
}
