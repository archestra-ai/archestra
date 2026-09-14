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
const memberId = "test-member";
const permissions = {
  llmProviderApiKey: ["read"],
  llmVirtualKey: ["read"],
  llmOauthClient: ["read"],
};
let queryClient: QueryClient;

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
beforeEach(() => {
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
    http.get("/api/llm-oauth-clients", () => HttpResponse.json(emptyPage)),
  );
});
afterEach(() => {
  cleanup();
  queryClient.clear();
  server.resetHandlers();
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
    await user.click(await card.findByRole("button", { name: "Disconnect" }));
    const dialog = within(
      screen.getByRole("dialog", { name: "Disconnect subscription" }),
    );
    await user.click(dialog.getByRole("button", { name: "Cancel" }));
    expect(deletes).toEqual([]);
    await user.click(card.getByRole("button", { name: "Disconnect" }));
    const confirm = within(screen.getByRole("dialog")).getByRole("button", {
      name: "Disconnect",
    });
    await waitFor(() => expect(confirm).toBeEnabled());
    await user.click(confirm);
    expect(await card.findByRole("button", { name: "Connect" })).toBeEnabled();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(deletes).toEqual([key.id]);
  });

  it.each([
    "llm-virtual-keys",
    "llm-oauth-clients",
  ])("refuses disconnect when %s still uses the credential", async (resource) => {
    const user = userEvent.setup();
    const key = makeLlmProviderApiKey({
      provider: "github-copilot",
      userId: memberId,
    });
    const onDelete = vi.fn();
    server.use(
      http.get("/api/llm-provider-api-keys", () => HttpResponse.json([key])),
      http.get(`/api/${resource}`, () =>
        HttpResponse.json({
          ...emptyPage,
          data: [{ id: "dependent-credential", name: "Subscription client" }],
          pagination: { ...emptyPage.pagination, total: 1 },
        }),
      ),
      http.delete("/api/llm-provider-api-keys/:id", () => {
        onDelete();
        return HttpResponse.json({ success: true });
      }),
    );
    renderPage();
    const card = within(
      await screen.findByTestId("subscription-provider-card-github-copilot"),
    );
    await user.click(await card.findByRole("button", { name: "Disconnect" }));
    const dialog = within(screen.getByRole("dialog"));
    expect(await dialog.findByText("Subscription client")).toBeVisible();
    expect(dialog.getByRole("button", { name: "Disconnect" })).toBeDisabled();
    await user.keyboard("{Enter}");
    expect(onDelete).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog")).toBeInTheDocument();
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
    const disconnect = await screen.findByRole("button", {
      name: "Delete Hidden subscription",
    });
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
    await waitFor(() => expect(confirm).toBeEnabled());
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
    await user.click(await card.findByRole("button", { name: "Disconnect" }));
    const confirm = within(screen.getByRole("dialog")).getByRole("button", {
      name: "Disconnect",
    });
    await waitFor(() => expect(confirm).toBeEnabled());
    await user.click(confirm);
    await waitFor(() => expect(toast.error).toHaveBeenCalled());
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    await user.click(confirm);
    expect(await card.findByRole("button", { name: "Connect" })).toBeEnabled();
    expect(attempts).toBe(2);
  });
});

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
