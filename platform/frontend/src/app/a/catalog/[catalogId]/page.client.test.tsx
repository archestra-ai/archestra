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
import { useRouter, useSearchParams } from "next/navigation";
import type { ReactNode } from "react";
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
import CatalogAppRunPage from "./page.client";

const API_ORIGIN = "http://localhost:9000";
const CATALOG_ID = "cat-1";
const APP_URL = `${API_ORIGIN}/api/apps/external/${CATALOG_ID}`;
const resolution = {
  catalogId: CATALOG_ID,
  name: "Archestra PM",
  description: null,
  resourceUri: "ui://pm/backlog.html",
  resources: [
    {
      resourceUri: "ui://pm/backlog.html",
      toolName: "show_backlog",
      name: "Archestra PM / show_backlog",
      requiresInput: false,
    },
    {
      resourceUri: "ui://pm/board.html",
      toolName: "show_board",
      name: "Archestra PM / show_board",
      requiresInput: false,
    },
    {
      resourceUri: "ui://pm/task.html",
      toolName: "show_task",
      name: "Archestra PM / show_task",
      requiresInput: true,
    },
  ],
  defaultMcpServerId: "srv-1",
  installs: [
    {
      mcpServerId: "srv-1",
      scope: "org",
      ownerId: null,
      teamId: null,
      name: "Org install",
      localInstallationStatus: null,
    },
  ],
} satisfies archestraApiTypes.GetExternalAppResponses["200"];

let searchString = "";
const server = setupServer();

vi.mock("next/link", () => ({
  default: ({ children, ...props }: { children: ReactNode }) => (
    <a {...props}>{children}</a>
  ),
}));

vi.mock("next/navigation");
vi.mock("sonner");

vi.mock("@/components/mcp-app/app-frame", () => ({
  AppFrame: ({ resourceUri }: { resourceUri: string }) => (
    <div data-testid="app-frame" data-resource={resourceUri} />
  ),
}));

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));

beforeEach(() => {
  vi.clearAllMocks();
  archestraApiClient.setConfig({ baseUrl: API_ORIGIN });
  server.use(http.get(APP_URL, () => HttpResponse.json(resolution)));
  vi.mocked(useRouter).mockReturnValue({
    replace: vi.fn(),
    push: vi.fn(),
  } as unknown as ReturnType<typeof useRouter>);
  vi.mocked(useSearchParams).mockImplementation(
    () =>
      new URLSearchParams(searchString) as unknown as ReturnType<
        typeof useSearchParams
      >,
  );
});

afterEach(() => {
  searchString = "";
  server.resetHandlers();
});

afterAll(() => {
  server.close();
  archestraApiClient.setConfig({ baseUrl: "" });
});

describe("CatalogAppRunPage", () => {
  it("renders the resource named by ?resource= and labels the header", async () => {
    searchString = "resource=ui://pm/board.html";
    renderPage();

    expect(await screen.findByTestId("app-frame")).toHaveAttribute(
      "data-resource",
      "ui://pm/board.html",
    );
    expect(screen.getByText("Archestra PM / show_board")).toBeInTheDocument();
  });

  it("falls back to the default resource when ?resource= is absent or unknown", async () => {
    searchString = "resource=ui://pm/does-not-exist.html";
    renderPage();

    expect(await screen.findByTestId("app-frame")).toHaveAttribute(
      "data-resource",
      "ui://pm/backlog.html",
    );
  });

  it("offers an open-in-chat handoff instead of a bare render when the tool needs inputs", async () => {
    searchString = "resource=ui://pm/task.html";
    renderPage();

    // A deep link to a prompt-mode app must not mount a broken app.
    expect(
      await screen.findByRole("button", { name: /open in chat/i }),
    ).toBeInTheDocument();
    expect(screen.queryByTestId("app-frame")).not.toBeInTheDocument();
    expect(
      screen.getByText(/needs a few inputs before it can render/i),
    ).toBeInTheDocument();
  });

  it("retries an initial query failure", async () => {
    let attempts = 0;
    server.use(
      http.get(APP_URL, () => {
        attempts += 1;
        return attempts === 1
          ? apiError("api_internal_server_error", 500)
          : HttpResponse.json(resolution);
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
    queryClient.setQueryData(["apps", "external", CATALOG_ID], resolution);

    renderPage(queryClient);

    expect(await screen.findByTestId("app-frame")).toBeInTheDocument();
    await act(() =>
      queryClient.invalidateQueries({
        queryKey: ["apps", "external", CATALOG_ID],
      }),
    );
    await waitFor(() =>
      expect(
        queryClient.getQueryState(["apps", "external", CATALOG_ID]),
      ).toMatchObject({ status: "error", fetchStatus: "idle" }),
    );
    expect(requests).toBe(1);
    expect(screen.getByTestId("app-frame")).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Retry" }),
    ).not.toBeInTheDocument();
    expect(toast.error).not.toHaveBeenCalled();
  });
});

function renderPage(queryClient = createQueryClient()): QueryClient {
  render(
    <QueryClientProvider client={queryClient}>
      <CatalogAppRunPage catalogId={CATALOG_ID} />
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
