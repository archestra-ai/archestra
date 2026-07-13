import {
  archestraApiClient,
  type archestraApiTypes,
  type Permissions,
} from "@archestra/shared";
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
import { useState } from "react";
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
import { authQueryKeys } from "@/lib/auth/auth.query";
import { adminPermissionsSeed, sessionSeed } from "@/mocks/data/auth";
import { organizationSeed, teamsSeed } from "@/mocks/data/organization";
import { AppSettingsDialog } from "./app-settings-dialog";

const API_ORIGIN = "http://localhost:9000";
const APP_ID = "app-1";
const APP_URL = `${API_ORIGIN}/api/apps/${APP_ID}`;
const APP_TOOLS_URL = `${APP_URL}/tools`;
const app = {
  id: APP_ID,
  organizationId: "org-1",
  authorId: "user-1",
  name: "Test App",
  description: null,
  templateId: null,
  mcpServerId: "server-1",
  spec: null,
  latestVersion: 1,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  deletedAt: null,
  scope: "personal",
  environmentId: null,
  teams: [],
} satisfies archestraApiTypes.GetAppResponses["200"];
const userPermissions = {
  ...adminPermissionsSeed,
  app: ["read", "update", "admin", "team-admin"],
} satisfies Permissions;

const server = setupServer(
  http.get(`${API_ORIGIN}/api/teams`, () => HttpResponse.json(teamsSeed)),
  http.get(`${API_ORIGIN}/api/environments`, () =>
    HttpResponse.json({ environments: [], defaultAssignedCatalogCount: 0 }),
  ),
  http.get(`${API_ORIGIN}/api/organization`, () =>
    HttpResponse.json(organizationSeed),
  ),
  http.get(`${API_ORIGIN}/api/internal_mcp_catalog`, () =>
    HttpResponse.json([]),
  ),
);

vi.mock("sonner");

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));

beforeEach(() => {
  vi.clearAllMocks();
  archestraApiClient.setConfig({ baseUrl: API_ORIGIN });
  server.use(
    http.get(APP_URL, () => HttpResponse.json(app)),
    http.get(APP_TOOLS_URL, () => HttpResponse.json([])),
  );
});

afterEach(() => server.resetHandlers());

afterAll(() => {
  server.close();
  archestraApiClient.setConfig({ baseUrl: "" });
});

describe("AppSettingsDialog", () => {
  it("shows a pending state until the app resolves", async () => {
    let releaseRequest = () => {};
    const blocked = new Promise<void>((resolve) => {
      releaseRequest = resolve;
    });
    server.use(
      http.get(APP_URL, async () => {
        await blocked;
        return HttpResponse.json(app);
      }),
    );

    renderDialog();

    expect(
      await screen.findByRole("status", { name: "Loading app settings" }),
    ).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Save" })).toBeNull();

    await act(async () => releaseRequest());
    expect(
      await screen.findByRole("textbox", { name: "Name" }),
    ).toBeInTheDocument();
  });

  it("retries an initial query failure without showing Save", async () => {
    let attempts = 0;
    server.use(
      http.get(APP_URL, () => {
        attempts += 1;
        return attempts === 1
          ? apiError("api_internal_server_error", 500)
          : HttpResponse.json(app);
      }),
    );

    renderDialog();
    const retry = await screen.findByRole("button", { name: "Retry" });

    expect(screen.queryByRole("button", { name: "Save" })).toBeNull();
    expect(toast.error).not.toHaveBeenCalled();
    fireEvent.click(retry);

    expect(
      await screen.findByRole("textbox", { name: "Name" }),
    ).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Save" })).toBeEnabled(),
    );
    expect(attempts).toBe(2);
  });

  it("shows an unavailable terminal state without Save after not-found", async () => {
    server.use(http.get(APP_URL, () => apiError("api_not_found_error", 404)));

    renderDialog();

    expect(
      await screen.findByRole("status", { name: "App settings unavailable" }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("textbox", { name: "Name" }),
    ).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Save" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeEnabled();
  });

  it("keeps cached settings usable when a refetch fails", async () => {
    let requests = 0;
    server.use(
      http.get(APP_URL, () => {
        requests += 1;
        return apiError("api_internal_server_error", 500);
      }),
    );
    const queryClient = createQueryClient();
    queryClient.setQueryData(["apps", APP_ID], app);

    renderDialog(queryClient);
    expect(
      await screen.findByRole("textbox", { name: "Name" }),
    ).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Save" })).toBeEnabled(),
    );

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
    expect(screen.getByRole("textbox", { name: "Name" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save" })).toBeEnabled();
  });

  it("closes on Cancel and remounts a fresh form when reopened", async () => {
    renderControlledDialog();
    const nameInput = await screen.findByRole("textbox", { name: "Name" });
    fireEvent.change(nameInput, { target: { value: "Unsaved name" } });
    expect(nameInput).toHaveValue("Unsaved name");

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() =>
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
    );
    fireEvent.click(screen.getByRole("button", { name: "Open settings" }));

    expect(await screen.findByRole("textbox", { name: "Name" })).toHaveValue(
      app.name,
    );
  });
});

function renderDialog(queryClient = createQueryClient()): void {
  render(
    <QueryClientProvider client={queryClient}>
      <AppSettingsDialog appId={APP_ID} open onOpenChange={vi.fn()} />
    </QueryClientProvider>,
  );
}

function renderControlledDialog(): void {
  function Harness() {
    const [open, setOpen] = useState(true);
    return (
      <>
        {!open ? (
          <button type="button" onClick={() => setOpen(true)}>
            Open settings
          </button>
        ) : null}
        <AppSettingsDialog appId={APP_ID} open={open} onOpenChange={setOpen} />
      </>
    );
  }

  const queryClient = createQueryClient();
  render(
    <QueryClientProvider client={queryClient}>
      <Harness />
    </QueryClientProvider>,
  );
}

function createQueryClient(): QueryClient {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: 60_000 } },
  });
  queryClient.setQueryData(authQueryKeys.session(), sessionSeed);
  queryClient.setQueryData(authQueryKeys.userPermissions(), userPermissions);
  return queryClient;
}

function apiError(type: string, status: number) {
  return HttpResponse.json(
    { error: { message: "Request failed", type } },
    { status },
  );
}
