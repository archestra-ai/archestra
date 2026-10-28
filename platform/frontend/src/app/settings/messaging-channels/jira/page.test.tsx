import { archestraApiClient, type archestraApiTypes } from "@archestra/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
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
import { useHasPermissions } from "@/lib/auth/auth.query";
import { useAppName } from "@/lib/hooks/use-app-name";
import JiraPage from "./page";

vi.mock("@/lib/auth/auth.query");
vi.mock("@/lib/hooks/use-app-name");
vi.mock("sonner");

const ORIGIN = "http://localhost:9000";
const CONFIG_URL = `${ORIGIN}/api/chatops/jira/config`;
const config = {
  id: "00000000-0000-4000-8000-000000000001",
  enabled: true,
  siteUrl: "https://example.atlassian.net",
  ingressMode: "hmac",
  hasWebhookSecret: true,
  webhookUrl: "https://example.test/api/webhooks/chatops/jira/integration-id",
  bots: [],
  pollingSupported: true,
} satisfies archestraApiTypes.GetJiraChatOpsConfigResponses["200"];
const server = setupServer();

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
beforeEach(() => {
  vi.clearAllMocks();
  Element.prototype.scrollIntoView = vi.fn();
  Element.prototype.hasPointerCapture = vi.fn(() => false);
  Element.prototype.setPointerCapture = vi.fn();
  Element.prototype.releasePointerCapture = vi.fn();
  archestraApiClient.setConfig({ baseUrl: ORIGIN });
  vi.mocked(useAppName).mockReturnValue("Example Platform");
  vi.mocked(useHasPermissions).mockReturnValue({
    data: true,
    isLoading: false,
  } as ReturnType<typeof useHasPermissions>);
  server.use(
    http.get(CONFIG_URL, () => HttpResponse.json(config)),
    http.get(`${ORIGIN}/api/chatops/bindings`, () =>
      HttpResponse.json({
        data: [],
        pagination: {
          currentPage: 1,
          hasNext: false,
          hasPrev: false,
          limit: 20,
          total: 0,
          totalPages: 0,
        },
      }),
    ),
  );
});
afterEach(() => server.resetHandlers());
afterAll(() => {
  server.close();
  archestraApiClient.setConfig({ baseUrl: "" });
});

describe("Jira setup", () => {
  it.each([
    "scoped",
    "classic",
  ] as const)("sends the selected %s token type when verifying a Jira bot", async (tokenType) => {
    const agentId = "00000000-0000-4000-8000-000000000002";
    const agent = {
      id: agentId,
      name: "Jira Responder",
      agentType: "agent",
      scope: "org",
      icon: null,
      runtime: null,
    };
    let body: unknown;
    server.use(
      http.get(`${ORIGIN}/api/agents/options/page`, () =>
        HttpResponse.json({
          data: [agent],
          pagination: { hasNext: false, nextCursor: null },
        }),
      ),
      http.get(`${ORIGIN}/api/agents/options`, () =>
        HttpResponse.json({
          data: [agent],
          pagination: { hasNext: false, nextCursor: null },
        }),
      ),
      http.post(`${ORIGIN}/api/chatops/jira/bots`, async ({ request }) => {
        body = await request.json();
        return HttpResponse.json({
          id: "00000000-0000-4000-8000-000000000003",
          agentId,
          accountId: "verified-jira-account",
          displayName: "Jira Bot",
          email: "bot@example.test",
          enabled: true,
          hasApiToken: true,
          fallbackServiceAccountId: null,
          fallbackReviewerUserId: null,
        });
      }),
    );
    const user = userEvent.setup();
    renderPage();
    await user.click(
      await screen.findByRole("button", { name: "Connect Jira bot" }),
    );
    expect(
      screen.getByRole("combobox", { name: "Token type" }),
    ).toHaveTextContent("Service account / scoped API token");
    await user.click(screen.getByRole("combobox", { name: "" }));
    await user.click(
      await screen.findByRole("option", { name: /Jira Responder/ }),
    );
    await user.type(
      screen.getByLabelText("Jira account email"),
      "bot@example.test",
    );
    await user.type(
      screen.getByLabelText("Jira API token"),
      "example-api-token",
    );
    if (tokenType === "classic") {
      await user.click(screen.getByRole("combobox", { name: "Token type" }));
      await user.click(
        screen.getByRole("option", { name: "Classic API token" }),
      );
    }
    await user.click(
      screen.getByRole("button", { name: "Verify and connect" }),
    );
    await waitFor(() =>
      expect(body).toEqual({
        agentId,
        email: "bot@example.test",
        apiToken: "example-api-token",
        tokenType,
      }),
    );
  });

  it("preserves an existing secret when saving the redacted configuration", async () => {
    let body: unknown;
    server.use(
      http.put(CONFIG_URL, async ({ request }) => {
        body = await request.json();
        return HttpResponse.json(config);
      }),
    );
    renderPage();
    expect(await screen.findByLabelText("Jira site URL")).toHaveValue(
      config.siteUrl,
    );
    expect(screen.getByLabelText("Webhook signing secret")).toHaveValue("");
    fireEvent.click(screen.getByRole("button", { name: "Save Jira site" }));
    await waitFor(() =>
      expect(body).toEqual({
        enabled: true,
        siteUrl: config.siteUrl,
        ingressMode: "hmac",
      }),
    );
    expect(screen.getByLabelText("Webhook signing secret")).toHaveValue("");
  });

  it("requires a valid new secret and clears it after a successful save", async () => {
    server.use(
      http.get(CONFIG_URL, () =>
        HttpResponse.json({ ...config, hasWebhookSecret: false }),
      ),
    );
    let body: unknown;
    server.use(
      http.put(CONFIG_URL, async ({ request }) => {
        body = await request.json();
        return HttpResponse.json(config);
      }),
    );
    renderPage();
    const secret = await screen.findByLabelText("Webhook signing secret");
    fireEvent.change(secret, { target: { value: "short" } });
    fireEvent.click(screen.getByRole("button", { name: "Save Jira site" }));
    expect(
      await screen.findByText("Use a secret with at least 16 characters"),
    ).toBeInTheDocument();
    expect(body).toBeUndefined();
    fireEvent.change(secret, { target: { value: "example-shared-secret" } });
    fireEvent.click(screen.getByRole("button", { name: "Save Jira site" }));
    await waitFor(() =>
      expect(body).toMatchObject({ webhookSecret: "example-shared-secret" }),
    );
    await waitFor(() => expect(secret).toHaveValue(""));
  });

  it("saves private-install polling without requesting a webhook secret", async () => {
    let body: unknown;
    server.use(
      http.get(CONFIG_URL, () =>
        HttpResponse.json({
          ...config,
          ingressMode: "hmac",
          hasWebhookSecret: false,
        }),
      ),
      http.put(CONFIG_URL, async ({ request }) => {
        body = await request.json();
        return HttpResponse.json({
          ...config,
          ingressMode: "poll",
          hasWebhookSecret: false,
        });
      }),
    );
    renderPage();
    fireEvent.change(await screen.findByLabelText("Webhook signing secret"), {
      target: { value: "short" },
    });
    const user = userEvent.setup();
    await user.click(screen.getByLabelText("Event delivery"));
    await user.click(
      screen.getByRole("option", { name: "Poll Jira every minute" }),
    );
    expect(
      await screen.findByText(/No public callback or webhook secret is needed/),
    ).toBeInTheDocument();
    expect(
      screen.queryByLabelText("Webhook signing secret"),
    ).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Save Jira site" }));
    await waitFor(() =>
      expect(body).toEqual({
        enabled: true,
        siteUrl: config.siteUrl,
        ingressMode: "poll",
      }),
    );
  });

  it("shows an initial configuration failure instead of an empty setup", async () => {
    server.use(
      http.get(CONFIG_URL, () =>
        HttpResponse.json(
          {
            error: {
              message: "Unavailable",
              type: "api_internal_server_error",
            },
          },
          { status: 503 },
        ),
      ),
    );
    renderPage();
    expect(
      await screen.findByText("Could not load Jira configuration"),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Connect Jira bot" }),
    ).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Retry" })).toBeInTheDocument();
  });
});

function renderPage() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <JiraPage />
    </QueryClientProvider>,
  );
}
