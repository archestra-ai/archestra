import { archestraApiClient } from "@archestra/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  cleanup,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { HttpResponse, http } from "msw";
import { setupServer } from "msw/node";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { toast } from "sonner";
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
import { authClient } from "@/lib/clients/auth/auth-client";
import { makeSession } from "@/mocks/data/auth";
import { configSeed } from "@/mocks/data/config";
import { makeLlmProviderApiKey } from "@/mocks/data/llm-keys";
import {
  appearanceSettingsSeed,
  organizationSeed,
} from "@/mocks/data/organization";
import ApiKeysPage from "./page";

vi.mock("next/navigation");
vi.mock("sonner");
vi.mock("@/lib/clients/auth/auth-client");

const server = setupServer(
  // Exercise the individual reads, including per-test organization overrides.
  http.get("/api/bootstrap", () => HttpResponse.json(null, { status: 401 })),
  http.get("/api/resource-permissions", () => HttpResponse.json([])),
  http.get("/api/llm-provider-api-keys/labels/keys", () =>
    HttpResponse.json([]),
  ),
  http.get("/api/organization/appearance-settings", () =>
    HttpResponse.json(appearanceSettingsSeed),
  ),
  http.get("/api/config", () => HttpResponse.json(configSeed)),
  http.get("/api/organization", () => HttpResponse.json(organizationSeed)),
  http.get("/api/teams", () => HttpResponse.json([])),
);
const unhandledRequests: string[] = [];
server.events.on("request:unhandled", ({ request }) => {
  unhandledRequests.push(`${request.method} ${new URL(request.url).pathname}`);
});
const memberId = "test-member";
const permissions = {
  llmProviderApiKey: ["read"],
  llmVirtualKey: ["read"],
  oauthClient: ["read"],
};
let queryClient: QueryClient;

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
beforeEach(() => {
  unhandledRequests.length = 0;
  vi.clearAllMocks();
  archestraApiClient.setConfig({ baseUrl: window.location.origin });
  vi.mocked(usePathname).mockReturnValue("/llm/model-providers");
  vi.mocked(useSearchParams).mockReturnValue(
    new URLSearchParams() as ReturnType<typeof useSearchParams>,
  );
  vi.mocked(useRouter).mockReturnValue({
    push: vi.fn(),
    replace: vi.fn(),
  } as unknown as ReturnType<typeof useRouter>);
  vi.mocked(authClient.getSession).mockResolvedValue({
    data: makeSession({ user: { id: memberId, role: "member" } }),
    error: null,
  } as Awaited<ReturnType<typeof authClient.getSession>>);
  queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  server.use(
    http.get("/api/user/permissions", () => HttpResponse.json(permissions)),
    http.get("/api/llm-virtual-keys", () => HttpResponse.json(emptyPage)),
    http.get("/api/oauth-clients", () => HttpResponse.json(emptyPage)),
  );
});
afterEach(() => {
  cleanup();
  queryClient.clear();
  server.resetHandlers();
  expect(unhandledRequests).toEqual([]);
});
afterAll(() => {
  server.close();
  archestraApiClient.setConfig({ baseUrl: "" });
});

describe("member subscription disconnect", () => {
  it.each([
    ["chatgpt", "openai"],
    ["github-copilot", "github-copilot"],
    ["microsoft-365-copilot", "microsoft-365-copilot"],
    ["x-premium", "xai"],
  ] as const)("disconnects %s and refreshes the card to Connect", async (subscriptionKind, provider) => {
    const user = userEvent.setup();
    const key = makeLlmProviderApiKey({
      id: "own-key",
      provider,
      subscriptionKind,
      userId: memberId,
      requiresReauthentication: true,
    });
    let connected = true;
    const deletes: string[] = [];
    server.use(
      http.get("/api/llm-provider-api-keys", () =>
        HttpResponse.json(connected ? [key] : []),
      ),
      http.delete("/api/llm-provider-api-keys/:id", ({ params }) => {
        deletes.push(String(params.id));
        connected = false;
        return HttpResponse.json({ success: true });
      }),
    );
    renderPage();
    const card = within(
      await screen.findByTestId(
        `subscription-provider-card-${subscriptionKind}`,
      ),
    );
    await user.click(
      await card.findByRole(
        "button",
        { name: "Disconnect" },
        { timeout: 5000 },
      ),
    );
    const dialog = within(
      screen.getByRole("dialog", { name: "Disconnect subscription" }),
    );
    await user.click(dialog.getByRole("button", { name: "Cancel" }));
    expect(deletes).toEqual([]);
    await user.click(card.getByRole("button", { name: "Disconnect" }));
    const confirm = within(screen.getByRole("dialog")).getByRole("button", {
      name: "Disconnect",
    });
    await waitFor(() => expect(confirm).toBeEnabled(), { timeout: 5000 });
    await user.click(confirm);
    expect(await card.findByRole("button", { name: "Connect" })).toBeEnabled();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(deletes).toEqual([key.id]);
  });

  it("disconnects after confirming the consequence for virtual keys that use it", async () => {
    const user = userEvent.setup();
    const key = makeLlmProviderApiKey({
      name: "Copilot subscription",
      provider: "github-copilot",
      userId: memberId,
    });
    let connected = true;
    const deletes: string[] = [];
    server.use(
      http.get("/api/llm-provider-api-keys", () =>
        HttpResponse.json(connected ? [key] : []),
      ),
      http.get("/api/llm-virtual-keys", () =>
        HttpResponse.json({
          ...emptyPage,
          data: [
            {
              id: "dependent-virtual-key",
              name: "Team proxy key",
              tokenStart: "arch_abc",
              includeFutureProviders: false,
              providerApiKeys: [
                {
                  provider: "github-copilot",
                  providerApiKeyId: key.id,
                  providerApiKeyName: key.name,
                },
              ],
            },
          ],
          pagination: { ...emptyPage.pagination, total: 1 },
        }),
      ),
      http.delete("/api/llm-provider-api-keys/:id", ({ params }) => {
        deletes.push(String(params.id));
        connected = false;
        return HttpResponse.json({ success: true });
      }),
    );
    renderPage();
    const card = within(
      await screen.findByTestId("subscription-provider-card-github-copilot"),
    );
    await user.click(
      await card.findByRole(
        "button",
        { name: "Disconnect" },
        { timeout: 5000 },
      ),
    );
    const dialogElement = screen.getByRole("dialog");
    const dialog = within(dialogElement);
    expect(await dialog.findByText("Team proxy key")).toBeVisible();
    expect(dialogElement).toHaveTextContent(
      "The virtual key below will be deleted too.",
    );
    const confirm = dialog.getByRole("button", { name: "Disconnect" });
    await waitFor(() => expect(confirm).toBeEnabled(), { timeout: 5000 });
    await user.click(confirm);
    await waitFor(() =>
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
    );
    expect(deletes).toEqual([key.id]);
    expect(toast.success).toHaveBeenCalledWith("Subscription disconnected");
  });

  it("disconnects and deletes an OAuth client that uses only the credential", async () => {
    const user = userEvent.setup();
    const key = makeLlmProviderApiKey({
      name: "Copilot subscription",
      provider: "github-copilot",
      userId: memberId,
    });
    let connected = true;
    const deletes: string[] = [];
    server.use(
      http.get("/api/llm-provider-api-keys", () =>
        HttpResponse.json(connected ? [key] : []),
      ),
      http.get("/api/oauth-clients", () =>
        HttpResponse.json({
          ...emptyPage,
          data: [
            {
              id: "dependent-credential",
              name: "Subscription client",
              clientId: "llm_oauth_sub",
              includeFutureProviders: false,
              providerApiKeys: [
                {
                  provider: "github-copilot",
                  providerApiKeyId: key.id,
                  providerApiKeyName: key.name,
                },
              ],
            },
          ],
          pagination: { ...emptyPage.pagination, total: 1 },
        }),
      ),
      http.delete("/api/llm-provider-api-keys/:id", ({ params }) => {
        deletes.push(String(params.id));
        connected = false;
        return HttpResponse.json({ success: true });
      }),
    );
    renderPage();
    const card = within(
      await screen.findByTestId("subscription-provider-card-github-copilot"),
    );
    await user.click(
      await card.findByRole(
        "button",
        { name: "Disconnect" },
        { timeout: 5000 },
      ),
    );
    const dialogElement = screen.getByRole("dialog");
    const dialog = within(dialogElement);
    expect(await dialog.findByText("Subscription client")).toBeVisible();
    expect(dialogElement).toHaveTextContent(
      "The OAuth client below will be deleted too.",
    );
    const confirm = dialog.getByRole("button", { name: "Disconnect" });
    await waitFor(() => expect(confirm).toBeEnabled(), { timeout: 5000 });
    await user.click(confirm);
    await waitFor(() =>
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
    );
    expect(deletes).toEqual([key.id]);
  });

  it("disconnects an owned subscription for a hidden provider without granting shared-key deletion", async () => {
    const user = userEvent.setup();
    const subscription = makeLlmProviderApiKey({
      id: "hidden-subscription",
      name: "Hidden subscription",
      provider: "github-copilot",
      userId: memberId,
    });
    const shared = makeLlmProviderApiKey({
      id: "shared-key",
      name: "Shared API key",
      scope: "org",
      userId: null,
    });
    let connected = true;
    const deletes: string[] = [];
    server.use(
      http.get("/api/organization", () =>
        HttpResponse.json({
          ...organizationSeed,
          modelProviderOverrides: { "github-copilot": { hidden: true } },
        }),
      ),
      http.get("/api/llm-provider-api-keys", () =>
        HttpResponse.json(connected ? [subscription, shared] : [shared]),
      ),
      http.delete("/api/llm-provider-api-keys/:id", ({ params }) => {
        deletes.push(String(params.id));
        connected = false;
        return HttpResponse.json({ success: true });
      }),
    );
    renderPage();
    const disconnect = await screen.findByRole(
      "button",
      { name: "Delete Hidden subscription" },
      { timeout: 5000 },
    );
    expect(
      screen.queryByTestId("subscription-provider-card-github-copilot"),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Delete Shared API key" }),
    ).toHaveAttribute("aria-disabled", "true");
    await user.click(disconnect);
    const confirm = within(
      screen.getByRole("dialog", { name: "Disconnect subscription" }),
    ).getByRole("button", { name: "Disconnect" });
    await waitFor(() => expect(confirm).toBeEnabled(), { timeout: 5000 });
    await user.click(confirm);
    await waitFor(() =>
      expect(
        screen.queryByRole("button", { name: "Delete Hidden subscription" }),
      ).not.toBeInTheDocument(),
    );
    expect(deletes).toEqual([subscription.id]);
    expect(
      screen.getByRole("button", { name: "Delete Shared API key" }),
    ).toHaveAttribute("aria-disabled", "true");
  });

  it("keeps a failed disconnect open and allows retry", async () => {
    const user = userEvent.setup();
    const key = makeLlmProviderApiKey({
      provider: "github-copilot",
      userId: memberId,
    });
    let connected = true;
    let attempts = 0;
    server.use(
      http.get("/api/llm-provider-api-keys", () =>
        HttpResponse.json(connected ? [key] : []),
      ),
      http.delete("/api/llm-provider-api-keys/:id", () => {
        attempts++;
        if (attempts === 1)
          return HttpResponse.json(
            {
              error: {
                message: "Disconnect failed",
                type: "api_internal_server_error",
              },
            },
            { status: 500 },
          );
        connected = false;
        return HttpResponse.json({ success: true });
      }),
    );
    renderPage();
    const card = within(
      await screen.findByTestId("subscription-provider-card-github-copilot"),
    );
    await user.click(
      await card.findByRole(
        "button",
        { name: "Disconnect" },
        { timeout: 5000 },
      ),
    );
    const confirm = within(screen.getByRole("dialog")).getByRole("button", {
      name: "Disconnect",
    });
    await waitFor(() => expect(confirm).toBeEnabled(), { timeout: 5000 });
    await user.click(confirm);
    await waitFor(() => expect(toast.error).toHaveBeenCalled());
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    await user.click(confirm);
    expect(await card.findByRole("button", { name: "Connect" })).toBeEnabled();
    expect(attempts).toBe(2);
  });

  it("says a subscription removed elsewhere was already disconnected", async () => {
    const user = userEvent.setup();
    const key = makeLlmProviderApiKey({
      provider: "github-copilot",
      subscriptionKind: "github-copilot",
      userId: memberId,
    });
    let connected = true;
    server.use(
      http.get("/api/llm-provider-api-keys", () =>
        HttpResponse.json(connected ? [key] : []),
      ),
      http.delete("/api/llm-provider-api-keys/:id", () => {
        connected = false;
        return notFound();
      }),
    );
    renderPage();
    const card = within(
      await screen.findByTestId("subscription-provider-card-github-copilot"),
    );
    await user.click(await card.findByRole("button", { name: "Disconnect" }));
    await confirmDisconnect(user);
    expect(await card.findByRole("button", { name: "Connect" })).toBeEnabled();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(toast.info).toHaveBeenCalledWith(
      "This subscription was already disconnected",
    );
    expect(toast.error).not.toHaveBeenCalled();
  });
});

describe("enterprise plan disconnect", () => {
  const plan = makeLlmProviderApiKey({
    id: "plan-key",
    name: "GitHub Copilot (acme)",
    provider: "github-copilot",
    scope: "org",
    userId: null,
    isGithubAppKey: true,
    githubOrganization: "acme",
  });

  beforeEach(() => {
    server.use(
      http.get("/api/user/permissions", () =>
        HttpResponse.json({
          ...permissions,
          llmProviderApiKey: ["read", "delete"],
        }),
      ),
      http.get("/api/resource-permissions", () =>
        HttpResponse.json([
          { resource: "llmProviderApiKey", action: "delete", scope: "*" },
        ]),
      ),
    );
  });

  it.each([
    [
      "disconnects the plan",
      () => HttpResponse.json({ success: true }),
      () =>
        expect(toast.success).toHaveBeenCalledWith(
          "Enterprise plan disconnected",
        ),
    ],
    [
      "says a plan removed elsewhere was already disconnected",
      notFound,
      () => {
        expect(toast.info).toHaveBeenCalledWith(
          "This enterprise plan was already disconnected",
        );
        expect(toast.error).not.toHaveBeenCalled();
      },
    ],
  ] as const)("%s and refreshes the card", async (_, respond, expectToast) => {
    const user = userEvent.setup();
    let connected = true;
    server.use(
      http.get("/api/llm-provider-api-keys", () =>
        HttpResponse.json(connected ? [plan] : []),
      ),
      http.delete("/api/llm-provider-api-keys/:id", () => {
        connected = false;
        return respond();
      }),
    );
    renderPage();
    const plans = within(
      await screen.findByRole("region", { name: "Enterprise plans" }),
    );
    await user.click(
      await plans.findByRole(
        "button",
        { name: "Disconnect" },
        { timeout: 5000 },
      ),
    );
    await confirmDisconnect(user);
    expect(await plans.findByRole("button", { name: "Connect" })).toBeVisible();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expectToast();
  });

  // The first request failed after it had already removed the plan, so the
  // retry finds nothing. The card must follow the server without a reload,
  // and the retry must not report a missing API key.
  it("follows a disconnect that failed after removing the plan", async () => {
    const user = userEvent.setup();
    let connected = true;
    server.use(
      http.get("/api/llm-provider-api-keys", () =>
        HttpResponse.json(connected ? [plan] : []),
      ),
      http.delete("/api/llm-provider-api-keys/:id", () => {
        if (!connected) return notFound();
        connected = false;
        return HttpResponse.json(
          {
            error: {
              message: "Database query timed out.",
              type: "api_service_unavailable_error",
            },
          },
          { status: 503 },
        );
      }),
    );
    renderPage();
    const plans = within(
      await screen.findByRole("region", { name: "Enterprise plans" }),
    );
    await user.click(
      await plans.findByRole(
        "button",
        { name: "Disconnect" },
        { timeout: 5000 },
      ),
    );
    await confirmDisconnect(user);
    await waitFor(() => expect(toast.error).toHaveBeenCalledTimes(1));
    // The open dialog hides the page from the accessibility tree.
    expect(
      await plans.findByRole("button", { name: "Connect", hidden: true }),
    ).toBeInTheDocument();

    await confirmDisconnect(user);
    await waitFor(() =>
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
    );
    expect(toast.info).toHaveBeenCalledWith(
      "This enterprise plan was already disconnected",
    );
    expect(toast.error).toHaveBeenCalledTimes(1);
    expect(plans.getByRole("button", { name: "Connect" })).toBeVisible();
  });
});

describe("API key delete", () => {
  it("says a key removed elsewhere was already deleted and drops its row", async () => {
    const user = userEvent.setup();
    const key = makeLlmProviderApiKey({
      id: "shared-key",
      name: "Shared API key",
      scope: "org",
      userId: null,
    });
    let present = true;
    server.use(
      http.get("/api/user/permissions", () =>
        HttpResponse.json({
          ...permissions,
          llmProviderApiKey: ["read", "delete"],
        }),
      ),
      http.get("/api/resource-permissions", () =>
        HttpResponse.json([
          { resource: "llmProviderApiKey", action: "delete", scope: "*" },
        ]),
      ),
      http.get("/api/llm-provider-api-keys", () =>
        HttpResponse.json(present ? [key] : []),
      ),
      http.delete("/api/llm-provider-api-keys/:id", () => {
        present = false;
        return notFound();
      }),
    );
    renderPage();
    await user.click(
      await screen.findByRole(
        "button",
        { name: "Delete Shared API key" },
        { timeout: 5000 },
      ),
    );
    const confirm = within(screen.getByRole("dialog")).getByRole("button", {
      name: "Delete API Key",
    });
    await waitFor(() => expect(confirm).toBeEnabled(), { timeout: 5000 });
    await user.click(confirm);
    await waitFor(() =>
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
    );
    expect(toast.info).toHaveBeenCalledWith("This API key was already deleted");
    expect(toast.error).not.toHaveBeenCalled();
    await waitFor(() =>
      expect(
        screen.queryByRole("button", { name: "Delete Shared API key" }),
      ).not.toBeInTheDocument(),
    );
  });
});

async function confirmDisconnect(user: ReturnType<typeof userEvent.setup>) {
  const confirm = within(screen.getByRole("dialog")).getByRole("button", {
    name: "Disconnect",
  });
  await waitFor(() => expect(confirm).toBeEnabled(), { timeout: 5000 });
  await user.click(confirm);
}

function notFound() {
  return HttpResponse.json(
    {
      error: {
        message: "LLM provider API key not found",
        type: "api_not_found_error",
      },
    },
    { status: 404 },
  );
}

function renderPage() {
  render(
    <QueryClientProvider client={queryClient}>
      <ApiKeysPage />
    </QueryClientProvider>,
  );
}
const emptyPage = {
  data: [],
  pagination: {
    currentPage: 1,
    limit: 100,
    total: 0,
    totalPages: 0,
    hasNext: false,
    hasPrev: false,
  },
};
