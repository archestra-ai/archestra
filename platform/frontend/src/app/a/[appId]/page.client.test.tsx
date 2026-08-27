import { archestraApiClient, type archestraApiTypes } from "@archestra/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { HttpResponse, http } from "msw";
import { setupServer } from "msw/node";
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
import AppRunPage from "./page.client";

const API_ORIGIN = "http://localhost:9000";
const APP_ID = "app-1";
const APP_URL = `${API_ORIGIN}/api/apps/${APP_ID}`;
const app = {
  id: APP_ID,
  organizationId: "org-1",
  authorId: "user-1",
  name: "Test App",
  slug: "test-app",
  description: null,
  templateId: null,
  mcpServerId: "server-1",
  spec: null,
  icon: null,
  latestVersion: 1,
  enabled: true,
  locked: false,
  openInFullscreen: false,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  deletedAt: null,
  scope: "personal",
  environmentId: null,
  teams: [],
  users: [],
  labels: [],
  viewerRole: "owner",
  authorName: null,
} satisfies archestraApiTypes.GetAppResponses["200"];

const server = setupServer();

vi.mock("sonner");

vi.mock("@/components/mcp-app/mcp-app-view", () => ({
  // Surfaces the endpoint the runtime was actually mounted on, so a test can
  // assert the app id reaches it — never the URL segment.
  McpAppRuntime: ({ endpoint }: { endpoint: { appId?: string } }) => (
    <div data-testid="app-frame" data-endpoint-app-id={endpoint.appId} />
  ),
}));

vi.mock("@/components/mcp-app/use-app-runtime-controls", () => ({
  useAppRuntimeControls: () => ({
    displayMode: "inline",
    setDisplayMode: vi.fn(),
    reloadNonce: 0,
    resourceState: "ready",
    setResourceState: vi.fn(),
  }),
}));

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));

beforeEach(() => {
  vi.clearAllMocks();
  archestraApiClient.setConfig({ baseUrl: API_ORIGIN });
  server.use(http.get(APP_URL, () => HttpResponse.json(app)));
});

afterEach(() => server.resetHandlers());

afterAll(() => {
  server.close();
  archestraApiClient.setConfig({ baseUrl: "" });
});

describe("AppRunPage", () => {
  it("retries an initial query failure", async () => {
    let attempts = 0;
    server.use(
      http.get(APP_URL, () => {
        attempts += 1;
        return attempts === 1
          ? apiError("api_internal_server_error", 500)
          : HttpResponse.json(app);
      }),
    );

    renderPage();
    const retry = await screen.findByRole("button", { name: "Retry" });
    expect(toast.error).not.toHaveBeenCalled();
    fireEvent.click(retry);

    expect(await screen.findByTestId("app-frame")).toBeInTheDocument();
    expect(attempts).toBe(2);
    expect(toast.error).not.toHaveBeenCalled();
  });

  it("keeps a successful not-found response as unavailable", async () => {
    server.use(http.get(APP_URL, () => apiError("api_not_found_error", 404)));

    renderPage();

    expect(await screen.findByRole("status")).toBeInTheDocument();
    expect(screen.queryByTestId("app-frame")).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Retry" }),
    ).not.toBeInTheDocument();
    expect(toast.error).not.toHaveBeenCalled();
  });

  it("keeps cached app content mounted when a refetch fails", async () => {
    let requests = 0;
    server.use(
      http.get(APP_URL, () => {
        requests += 1;
        return apiError("api_internal_server_error", 500);
      }),
    );
    const queryClient = createQueryClient();
    queryClient.setQueryData(["apps", APP_ID], app);

    renderPage(queryClient);

    expect(await screen.findByTestId("app-frame")).toBeInTheDocument();
    await act(() =>
      queryClient.invalidateQueries({ queryKey: ["apps", APP_ID] }),
    );
    await waitFor(() =>
      expect(queryClient.getQueryState(["apps", APP_ID])).toMatchObject({
        status: "error",
        fetchStatus: "idle",
      }),
    );
    expect(requests).toBe(1);
    expect(screen.getByTestId("app-frame")).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Retry" }),
    ).not.toBeInTheDocument();
    expect(toast.error).not.toHaveBeenCalled();
  });

  it("mounts the runtime on the app id when the URL carried a slug", async () => {
    // The slug addresses the page; the runtime endpoint (/api/mcp/app/:appId)
    // is uuid-keyed and the id is the app's isolation key, so the resolved id —
    // not the URL segment — is what must reach it.
    // Only the slug URL resolves, so the page cannot pass by guessing the id.
    server.resetHandlers();
    server.use(
      http.get(`${API_ORIGIN}/api/apps/${app.slug}`, () =>
        HttpResponse.json(app),
      ),
    );

    renderPage(createQueryClient(), app.slug);

    expect(await screen.findByTestId("app-frame")).toHaveAttribute(
      "data-endpoint-app-id",
      APP_ID,
    );
  });

  it("looks the app up by whatever segment the URL carried", async () => {
    let slugRequests = 0;
    server.use(
      http.get(`${API_ORIGIN}/api/apps/${app.slug}`, () => {
        slugRequests += 1;
        return HttpResponse.json(app);
      }),
    );

    renderPage(createQueryClient(), app.slug);

    await screen.findByTestId("app-frame");
    expect(slugRequests).toBe(1);
  });
});

function renderPage(
  queryClient = createQueryClient(),
  idOrSlug: string = APP_ID,
): QueryClient {
  render(
    <QueryClientProvider client={queryClient}>
      <AppRunPage idOrSlug={idOrSlug} />
    </QueryClientProvider>,
  );
  return queryClient;
}

function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: 60_000 } },
  });
}

function apiError(type: string, status: number) {
  return HttpResponse.json(
    { error: { message: "Request failed", type } },
    { status },
  );
}
