// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
import { archestraApiClient, type archestraApiTypes } from "@archestra/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render, screen, waitFor } from "@testing-library/react";
import { HttpResponse, http } from "msw";
import { setupServer } from "msw/node";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  expect,
  it,
  vi,
} from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";
import {
  useAllPermissions,
  useHasPermissions,
  useSession,
} from "@/lib/auth/auth.query";
import config from "@/lib/config/config";
import { makeConfig } from "@/mocks/data/config";
import { TeamManagementDialog } from "./team-management-dialog";

vi.mock("@/lib/auth/auth.query");

const origin = "http://localhost:9000";
const server = setupServer();
const team: archestraApiTypes.GetTeamResponses["200"] = {
  id: "team-a",
  name: "Team A",
  description: null,
  organizationId: "org-1",
  parentId: null,
  createdBy: "user-1",
  createdByServiceAccountId: null,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  roles: [],
  members: [],
};
let groupRequests = 0;

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
beforeEach(() => {
  vi.clearAllMocks();
  groupRequests = 0;
  vi.spyOn(config.enterpriseFeatures, "core", "get").mockReturnValue(false);
  archestraApiClient.setConfig({ baseUrl: origin });
  vi.mocked(useSession).mockReturnValue({
    data: { user: { id: "user-1" } },
  } as ReturnType<typeof useSession>);
  vi.mocked(useHasPermissions).mockReturnValue({ data: false } as ReturnType<
    typeof useHasPermissions
  >);
  vi.mocked(useAllPermissions).mockReturnValue({ data: {} } as ReturnType<
    typeof useAllPermissions
  >);
  server.use(
    http.get(`${origin}/api/roles`, () => HttpResponse.json({ data: [] })),
    http.get(`${origin}/api/identity-providers/team-sync-options`, () =>
      HttpResponse.json([]),
    ),
    http.get(`${origin}/api/teams/team-a/external-groups`, () => {
      groupRequests++;
      return HttpResponse.json([]);
    }),
  );
});
afterEach(() => {
  server.resetHandlers();
  vi.restoreAllMocks();
});
afterAll(() => {
  server.close();
  archestraApiClient.setConfig({ baseUrl: "" });
});

it("enables Team Sync when effective core arrives after mount despite a false static flag", async () => {
  let respond!: () => void;
  const pending = new Promise<void>((resolve) => {
    respond = resolve;
  });
  server.use(
    http.get(`${origin}/api/config`, async () => {
      await pending;
      return HttpResponse.json(
        makeConfig({ enterpriseFeatures: { core: true } }),
      );
    }),
  );
  renderDialog();
  expect(screen.getByRole("button", { name: "Team Sync" })).toBeDisabled();
  expect(groupRequests).toBe(0);
  await act(async () => {
    respond();
  });
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "Team Sync" })).toBeEnabled(),
  );
  expect(
    await screen.findByText(
      /Add people to Team A from their identity provider/,
    ),
  ).toBeInTheDocument();
  await waitFor(() => expect(groupRequests).toBe(1));
  expect(
    screen.queryByText("Enterprise license required"),
  ).not.toBeInTheDocument();
});

it("keeps Team Sync unavailable when the server denies core despite a true static flag", async () => {
  vi.spyOn(config.enterpriseFeatures, "core", "get").mockReturnValue(true);
  server.use(
    http.get(`${origin}/api/config`, () => HttpResponse.json(makeConfig())),
  );
  const client = renderDialog();
  await waitFor(() =>
    expect(client.getQueryState(["config"])?.status).toBe("success"),
  );
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "Team Sync" })).toBeDisabled(),
  );
  expect(
    screen.getByText("Activate an Enterprise license to use Team Sync."),
  ).toBeInTheDocument();
  expect(groupRequests).toBe(0);
});

it("removes an already loaded Team Sync section when effective entitlement is revoked", async () => {
  vi.spyOn(config.enterpriseFeatures, "core", "get").mockReturnValue(true);
  server.use(
    http.get(`${origin}/api/config`, () =>
      HttpResponse.json(makeConfig({ enterpriseFeatures: { core: true } })),
    ),
  );
  const client = renderDialog();
  await screen.findByText(/Add people to Team A from their identity provider/);
  server.use(
    http.get(`${origin}/api/config`, () => HttpResponse.json(makeConfig())),
  );
  await act(async () => {
    await client.invalidateQueries({ queryKey: ["config"] });
  });
  // The refetched config re-renders the dialog after the query settles.
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "Team Sync" })).toBeDisabled(),
  );
  expect(
    screen.queryByText(/Add people to Team A from their identity provider/),
  ).not.toBeInTheDocument();
  expect(
    screen.getByText("Activate an Enterprise license to use Team Sync."),
  ).toBeInTheDocument();
});

function renderDialog() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <TooltipProvider>
        <TeamManagementDialog
          open
          readOnly
          onOpenChange={vi.fn()}
          team={team}
        />
      </TooltipProvider>
    </QueryClientProvider>,
  );
  return client;
}
