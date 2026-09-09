import { archestraApiClient, type archestraApiTypes } from "@archestra/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { HttpResponse, http } from "msw";
import { setupServer } from "msw/node";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
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
import { useAppName } from "@/lib/hooks/use-app-name";
import { useOrganizationMembers } from "@/lib/organization.query";
import { useTeams } from "@/lib/teams/team.query";
import OutboundA2aAgentsPage from "./page.client";

const API_ORIGIN = "http://localhost:9000";
const REGISTRY_URL = `${API_ORIGIN}/api/a2a/remote-agents`;

const remoteAgent = {
  id: "remote-agent-1",
  organizationId: "org-1",
  name: "Payments Agent",
  description: "Answers payment operations questions",
  discoveryMode: "well_known",
  discoveryUrl: "https://agent.example.com",
  agentCard: { name: "Fixture Agent" },
  cardHash: "card-hash",
  lastDiscoveredAt: "2026-09-08T12:00:00.000Z",
  createdAt: "2026-09-08T12:00:00.000Z",
  updatedAt: "2026-09-08T12:00:00.000Z",
  scope: "personal",
  authorId: "user-1",
  authorName: "Test User",
  teams: [],
  users: [],
  connection: {
    id: "connection-1",
    remoteAgentId: "remote-agent-1",
    selectedInterface: {
      url: "https://agent.example.com/a2a",
      protocolBinding: "JSONRPC",
      protocolVersion: "1.0",
    },
    securityRequirement: null,
    authType: "none",
    authConfig: {},
    enabled: true,
    lastVerifiedAt: "2026-09-08T12:00:00.000Z",
    createdAt: "2026-09-08T12:00:00.000Z",
    updatedAt: "2026-09-08T12:00:00.000Z",
    hasCredential: false,
  },
  toolId: "tool-1",
} satisfies archestraApiTypes.ListA2aRemoteAgentsResponses["200"][number] & {
  scope: "personal";
  authorId: string;
  authorName: string;
  teams: [];
  users: [];
};

const teamRemoteAgent = {
  ...remoteAgent,
  id: "remote-agent-2",
  name: "Reporting Agent",
  scope: "team",
  authorId: "user-2",
  authorName: "Other User",
  teams: [{ id: "team-1", name: "Finance" }],
  connection: {
    ...remoteAgent.connection,
    id: "connection-2",
    remoteAgentId: "remote-agent-2",
  },
} as const;

const otherPersonalRemoteAgent = {
  ...remoteAgent,
  id: "remote-agent-3",
  name: "Other Personal Agent",
  authorId: "user-2",
  authorName: "Other User",
  connection: {
    ...remoteAgent.connection,
    id: "connection-3",
    remoteAgentId: "remote-agent-3",
  },
} as const;

const server = setupServer();

vi.mock("next/navigation");
vi.mock("@/lib/auth/auth.query");
vi.mock("@/lib/hooks/use-app-name");
vi.mock("@/lib/organization.query");
vi.mock("@/lib/teams/team.query");
vi.mock("sonner");

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));

beforeEach(() => {
  vi.clearAllMocks();
  window.localStorage.clear();
  archestraApiClient.setConfig({ baseUrl: API_ORIGIN });
  vi.mocked(usePathname).mockReturnValue("/a2a/agents");
  vi.mocked(useRouter).mockReturnValue({
    push: vi.fn(),
    replace: vi.fn(),
  } as unknown as ReturnType<typeof useRouter>);
  vi.mocked(useSearchParams).mockReturnValue(
    new URLSearchParams() as ReturnType<typeof useSearchParams>,
  );
  vi.mocked(useAppName).mockReturnValue("Archestra");
  vi.mocked(useHasPermissions).mockReturnValue({
    data: true,
    isPending: false,
  } as ReturnType<typeof useHasPermissions>);
  vi.mocked(useSession).mockReturnValue({
    data: { user: { id: "user-1" } },
  } as ReturnType<typeof useSession>);
  vi.mocked(useTeams).mockReturnValue({ data: [] } as unknown as ReturnType<
    typeof useTeams
  >);
  vi.mocked(useOrganizationMembers).mockReturnValue({
    data: [],
  } as unknown as ReturnType<typeof useOrganizationMembers>);
  server.use(http.get(`${REGISTRY_URL}/:id/runs`, () => HttpResponse.json([])));
});

afterEach(() => server.resetHandlers());

afterAll(() => {
  server.close();
  archestraApiClient.setConfig({ baseUrl: "" });
});

describe("OutboundA2aAgentsPage", () => {
  it("routes connect, card, and table-row actions to full pages", async () => {
    const user = userEvent.setup();
    const push = vi.fn();
    vi.mocked(useRouter).mockReturnValue({
      push,
      replace: vi.fn(),
    } as unknown as ReturnType<typeof useRouter>);
    server.use(http.get(REGISTRY_URL, () => HttpResponse.json([remoteAgent])));

    renderPage();

    await user.click(
      await screen.findByRole("button", { name: "Connect agent" }),
    );
    expect(push).toHaveBeenCalledWith("/a2a/agents/new");

    const card = screen.getByTestId("a2a-remote-agent-card-remote-agent-1");
    fireEvent.click(card);
    expect(push).toHaveBeenCalledWith("/a2a/agents/remote-agent-1");

    await user.click(screen.getByRole("button", { name: "View as table" }));
    const row = screen.getByRole("row", { name: /Payments Agent/ });
    fireEvent.click(row);
    expect(push).toHaveBeenLastCalledWith("/a2a/agents/remote-agent-1");
  });

  it("shows visibility badges and applies URL-backed scope filtering", async () => {
    vi.mocked(useSearchParams).mockReturnValue(
      new URLSearchParams("scope=team") as ReturnType<typeof useSearchParams>,
    );
    vi.mocked(useTeams).mockReturnValue({
      data: [{ id: "team-1", name: "Finance" }],
    } as unknown as ReturnType<typeof useTeams>);
    server.use(
      http.get(REGISTRY_URL, () =>
        HttpResponse.json([remoteAgent, teamRemoteAgent]),
      ),
    );

    renderPage();

    expect(await screen.findByText("Reporting Agent")).toBeInTheDocument();
    expect(screen.queryByText("Payments Agent")).not.toBeInTheDocument();
    expect(screen.getByTitle("Finance")).toHaveTextContent("Team");
  });

  it("hides other users' personal agents by default and shows them with the Other users filter", async () => {
    server.use(
      http.get(REGISTRY_URL, () =>
        HttpResponse.json([
          remoteAgent,
          otherPersonalRemoteAgent,
          teamRemoteAgent,
        ]),
      ),
    );

    const defaultView = renderPage();

    expect(await screen.findByText("Payments Agent")).toBeInTheDocument();
    expect(screen.getByText("Reporting Agent")).toBeInTheDocument();
    expect(screen.queryByText("Other Personal Agent")).not.toBeInTheDocument();

    defaultView.unmount();
    vi.mocked(useSearchParams).mockReturnValue(
      new URLSearchParams(
        "scope=personal&excludeAuthorIds=user-1",
      ) as ReturnType<typeof useSearchParams>,
    );

    renderPage();

    expect(await screen.findByText("Other Personal Agent")).toBeInTheDocument();
    expect(screen.queryByText("Payments Agent")).not.toBeInTheDocument();
    expect(screen.queryByText("Reporting Agent")).not.toBeInTheDocument();
    expect(
      screen.getByRole("combobox", { name: "Filter by owner" }),
    ).toHaveTextContent("Other users");
  });

  it("keeps Delete inside the overflow menu and confirms before removing", async () => {
    const user = userEvent.setup();
    let deletedId: string | undefined;
    let configuredAgents = [remoteAgent];
    server.use(
      http.get(REGISTRY_URL, () => HttpResponse.json(configuredAgents)),
      http.delete(`${REGISTRY_URL}/:id`, ({ params }) => {
        deletedId = String(params.id);
        configuredAgents = [];
        return HttpResponse.json({ success: true });
      }),
    );

    renderPage();
    const card = await screen.findByTestId(
      "a2a-remote-agent-card-remote-agent-1",
    );
    expect(within(card).queryByRole("button", { name: /Delete/ })).toBeNull();
    await user.click(
      within(card).getByRole("button", { name: "More actions Payments Agent" }),
    );
    await user.click(screen.getByRole("menuitem", { name: "Delete" }));
    const dialog = screen.getByRole("dialog", {
      name: "Remove external A2A agent?",
    });
    await user.click(within(dialog).getByRole("button", { name: "Delete" }));

    await waitFor(() => expect(deletedId).toBe(remoteAgent.id));
  });

  it("renders accessible agents as read-only for users without management permission", async () => {
    const user = userEvent.setup();
    const push = vi.fn();
    vi.mocked(useRouter).mockReturnValue({
      push,
      replace: vi.fn(),
    } as unknown as ReturnType<typeof useRouter>);
    vi.mocked(useHasPermissions).mockImplementation((permissions) => {
      const agentSettings = permissions.agentSettings;
      return {
        data:
          !agentSettings ||
          (agentSettings.includes("read") && !agentSettings.includes("update")),
        isPending: false,
      } as ReturnType<typeof useHasPermissions>;
    });
    server.use(http.get(REGISTRY_URL, () => HttpResponse.json([remoteAgent])));

    renderPage();
    const card = await screen.findByTestId(
      "a2a-remote-agent-card-remote-agent-1",
    );
    expect(screen.queryByRole("button", { name: "Connect agent" })).toBeNull();
    expect(
      within(card).queryByRole("button", { name: /More actions/ }),
    ).toBeNull();
    expect(within(card).getByText("Recent activity")).toBeInTheDocument();
    await user.click(
      within(card).getByRole("button", { name: "View Payments Agent" }),
    );
    expect(push).toHaveBeenCalledWith("/a2a/agents/remote-agent-1");
  });
});

function renderPage() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <OutboundA2aAgentsPage />
    </QueryClientProvider>,
  );
}
