/**
 * The Inspector calls the upstream signed with the selected connection's own
 * credential, so it must not offer a colleague's connection — the registry
 * deliberately lists those to an installation admin for management.
 */
import { archestraApiClient } from "@archestra/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { HttpResponse, http } from "msw";
import { setupServer } from "msw/node";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { McpLogsContent, type McpLogsTab } from "./mcp-logs-dialog";

vi.mock("@/lib/websocket/websocket", () => ({
  default: {
    connect: vi.fn(),
    isConnected: () => false,
    send: vi.fn(),
    subscribe: vi.fn(() => () => {}),
  },
}));

const API_ORIGIN = "http://localhost:9000";

const server = setupServer(
  http.post(`${API_ORIGIN}/api/mcp_server/:id/inspect`, () =>
    HttpResponse.json({ tools: [] }),
  ),
);

beforeAll(() => {
  server.listen({ onUnhandledRequest: "bypass" });
  archestraApiClient.setConfig({ baseUrl: API_ORIGIN });
});
afterEach(() => server.resetHandlers());
afterAll(() => {
  server.close();
  archestraApiClient.setConfig({ baseUrl: "" });
});

const MINE = {
  id: "install-mine",
  name: "Orbit Tracker",
  ownerEmail: "me@example.com",
  teamDetails: null,
  scope: "personal" as const,
  canUseCredential: true,
};
const THEIRS = {
  id: "install-theirs",
  name: "Orbit Tracker",
  ownerEmail: "colleague@example.com",
  teamDetails: null,
  scope: "personal" as const,
  canUseCredential: false,
};
// Owned by the colleague but shared through a team the viewer belongs to —
// "or those shared with you" has to survive the filter.
const SHARED = {
  id: "install-shared",
  name: "Orbit Tracker",
  ownerEmail: "colleague@example.com",
  teamDetails: { teamId: "team-1", name: "Engineering Team" },
  scope: "team" as const,
  canUseCredential: true,
};

type Install = Parameters<typeof McpLogsContent>[0]["installs"][number];

function renderPanel(
  tab: McpLogsTab,
  installs: Install[] = [MINE, THEIRS, SHARED],
) {
  return render(
    <QueryClientProvider client={new QueryClient()}>
      <McpLogsContent
        isActive
        serverName="Orbit Tracker"
        installs={installs}
        deploymentStatuses={{}}
        controlledTab={tab}
        hideTabBar
        hideHeader
      />
    </QueryClientProvider>,
  );
}

describe("diagnostics instance selector", () => {
  it("offers the viewer's own and shared connections but not a colleague's", async () => {
    renderPanel("inspector");

    await userEvent.click(
      await screen.findByRole("button", { name: "Switch instance" }),
    );

    expect(await screen.findByText("Instances")).toBeInTheDocument();
    expect(screen.getAllByText("me@example.com").length).toBeGreaterThan(0);
    expect(screen.getByText("Engineering Team")).toBeInTheDocument();
    expect(screen.queryByText("colleague@example.com")).toBeNull();
  });

  it("keeps every connection selectable for pod logs", async () => {
    // Pod diagnostics read the deployment rather than authenticate as it, so
    // an installation admin must not lose sight of a colleague's pod.
    renderPanel("logs");

    await userEvent.click(
      await screen.findByRole("button", { name: "Switch instance" }),
    );

    expect(
      await screen.findByText("colleague@example.com"),
    ).toBeInTheDocument();
  });

  it("explains itself instead of inspecting when no connection is the viewer's", async () => {
    const inspect = vi.fn(() => HttpResponse.json({ tools: [] }));
    server.use(http.post(`${API_ORIGIN}/api/mcp_server/:id/inspect`, inspect));

    renderPanel("inspector", [THEIRS]);

    expect(
      await screen.findByText("No connection of yours to inspect"),
    ).toBeInTheDocument();
    await waitFor(() => expect(inspect).not.toHaveBeenCalled());
  });
});
