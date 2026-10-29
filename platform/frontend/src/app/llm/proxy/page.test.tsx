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
import { useHasPermissions, useSession } from "@/lib/auth/auth.query";
import { useProviderBaseUrls } from "@/lib/config/config.query";
import {
  useAppearanceSettings,
  useOrganization,
} from "@/lib/organization.query";
import LlmProxyPage from "./page";

const API_ORIGIN = "http://localhost:9000";

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

function renderPage() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <LlmProxyPage />
    </QueryClientProvider>,
  );
}

describe("LlmProxyPage provider dropdown", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(useHasPermissions).mockReturnValue({
      data: false,
      isPending: false,
    } as unknown as ReturnType<typeof useHasPermissions>);
    vi.mocked(useOrganization).mockReturnValue({
      data: null,
    } as unknown as ReturnType<typeof useOrganization>);
    vi.mocked(useSession).mockReturnValue({
      data: { user: { id: "user-1" } },
    } as unknown as ReturnType<typeof useSession>);
  });

  it("defaults to the Model Router endpoint", async () => {
    renderPage();

    expect(
      await screen.findByText("http://localhost:3000/v1/model-router"),
    ).toBeInTheDocument();
  });

  it("searches the long-tail providers and switches the endpoint on selection", async () => {
    const user = userEvent.setup();
    renderPage();

    const moreTrigger = await screen.findByRole("combobox", {
      name: "More providers",
    });
    await user.click(moreTrigger);

    // Unfiltered, the long-tail list is reachable — the exact set the old
    // hand-rolled combobox listed behind the "…" tab.
    expect(await screen.findByText("Cohere")).toBeInTheDocument();
    expect(screen.getByText("Mistral AI")).toBeInTheDocument();

    // Each entry renders its provider logo, matching the canonical provider
    // dropdown used elsewhere (e.g. the Add API Key form) rather than a bare
    // text list. Radix portals the popover content onto document.body, so
    // search from there rather than the render container.
    expect(document.querySelector('img[src*="mistral"]')).toBeInTheDocument();
    expect(document.querySelector('img[src*="cohere"]')).toBeInTheDocument();

    await user.type(screen.getByPlaceholderText("Search providers..."), "mist");

    await waitFor(() => {
      expect(screen.queryByText("Cohere")).not.toBeInTheDocument();
    });
    const mistralOption = screen.getByText("Mistral AI");
    expect(mistralOption).toBeInTheDocument();

    await user.click(mistralOption);

    // Selecting from the search dropdown promotes the provider to its own
    // active tab and repoints the endpoint at it, same as the tab bar does
    // for the built-in primary providers.
    expect(
      await screen.findByText("http://localhost:3000/v1/mistral"),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Mistral AI" }),
    ).toBeInTheDocument();
  });
});

describe("LlmProxyPage connect steps", () => {
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
    renderPage();
    await user.click(await screen.findByRole("button", { name: "Gemini" }));
    if (keyType === "passthrough") {
      await user.click(screen.getByRole("radio", { name: /Passthrough/ }));
    }
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
    const user = userEvent.setup();
    renderPage();
    await selectJev(user);

    // Jev has one endpoint, so the tab shows the full decisions URL rather
    // than a base URL a client appends `/chat/completions` to.
    expect(
      await screen.findByText("http://localhost:3000/v1/jev/decisions"),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { name: /Send a request/ }),
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

  it("puts providers that have a key first in the tab row", async () => {
    server.use(
      http.get(`${API_ORIGIN}/api/llm-provider-api-keys`, () =>
        HttpResponse.json([JEV_PROVIDER_KEY]),
      ),
    );
    renderPage();

    const jevTab = await screen.findByRole("button", { name: "Jev" });
    const openAiTab = screen.getByRole("button", { name: "OpenAI" });
    expect(
      jevTab.compareDocumentPosition(openAiTab) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
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
    renderPage();
    await selectJev(user);

    await chooseCreateVirtualKey(user);
    const dialog = await screen.findByRole("dialog", {
      name: "New virtual key for Jev",
    });
    // The provider picker is already expanded; both keys are offered, but a
    // virtual key maps only one per provider.
    await user.click(
      await within(dialog).findByRole("combobox", { name: "Jev key" }),
    );
    expect(
      await screen.findByRole("option", { name: /^TypeSafe/ }),
    ).toHaveAttribute("aria-selected", "true");
    expect(
      screen.getByRole("option", { name: /^Via OpenRouter/ }),
    ).toHaveAttribute("aria-selected", "false");
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
    renderPage();
    await selectJev(user);

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
    renderPage();
    await selectJev(user);

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
    renderPage();
    await selectJev(user);

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
    const user = userEvent.setup();
    renderPage();
    await selectJev(user);
    await user.click(screen.getByRole("radio", { name: /Passthrough/ }));

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
    renderPage();
    await selectJev(user);
    await user.click(screen.getByRole("radio", { name: /Passthrough/ }));
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
    const user = userEvent.setup();
    renderPage();
    await selectJev(user);
    await user.click(screen.getByRole("radio", { name: /Passthrough/ }));

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
    const user = userEvent.setup();
    renderPage();
    await selectJev(user);
    await user.click(screen.getByRole("radio", { name: /Passthrough/ }));

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
      http.get(`${API_ORIGIN}/api/llm-oauth-clients`, () =>
        HttpResponse.json(
          page([
            {
              id: "oc-batch",
              clientId: "client-batch",
              name: "Batch jobs",
              grantType: "client_credentials",
              authorId: "someone-else",
              providerApiKeys: JUDGE_KEY.providerApiKeys,
            },
          ]),
        ),
      ),
    );
    const user = userEvent.setup();
    renderPage();
    await selectJev(user);
    await user.click(screen.getByRole("radio", { name: /OAuth client/ }));

    const tokenRequest = await screen.findByText(
      /grant_type=client_credentials/,
    );
    expect(tokenRequest).toHaveTextContent("client_id=client-batch");
    expect(
      screen.getByText(/from the token request above/),
    ).toBeInTheDocument();
    expect(
      screen.queryByText(/your token before running/),
    ).not.toBeInTheDocument();
    expect(await findRequest()).toContain(
      "Authorization: Bearer $ARCHESTRA_LLM_ACCESS_TOKEN",
    );
  });

  it("keeps passthrough off the Model Router, which has no route for it", async () => {
    server.use(
      http.get(`${API_ORIGIN}/api/llm-provider-api-keys`, () =>
        HttpResponse.json([JEV_PROVIDER_KEY]),
      ),
    );
    const user = userEvent.setup();
    renderPage();

    expect(
      await screen.findByRole("radio", { name: /Passthrough/ }),
    ).toBeDisabled();

    // Chosen on a provider, it gives way to a standard key on the router
    // and comes back with the provider.
    await selectJev(user);
    await user.click(screen.getByRole("radio", { name: /Passthrough/ }));
    await user.click(screen.getByRole("button", { name: "Model Router" }));
    expect(screen.getByRole("radio", { name: /Standard/ })).toBeChecked();
    expect(screen.getByRole("radio", { name: /Passthrough/ })).toBeDisabled();

    await selectJev(user);
    expect(screen.getByRole("radio", { name: /Passthrough/ })).toBeChecked();
  });

  it("asks for the provider key first and holds the request back without one", async () => {
    server.use(
      http.get(`${API_ORIGIN}/api/llm-provider-api-keys`, () =>
        HttpResponse.json([]),
      ),
    );
    const user = userEvent.setup();
    renderPage();
    await selectJev(user);

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

async function selectJev(user: ReturnType<typeof userEvent.setup>) {
  // With a Jev key, Jev leads the tabs; without one it is under "More".
  await screen.findByRole("combobox", { name: "More providers" });
  const tab = screen.queryByRole("button", { name: "Jev" });
  if (tab) {
    await user.click(tab);
    return;
  }
  await user.click(
    await screen.findByRole("combobox", { name: "More providers" }),
  );
  await user.type(screen.getByPlaceholderText("Search providers..."), "jev");
  await user.click(await screen.findByText("Jev"));
}
