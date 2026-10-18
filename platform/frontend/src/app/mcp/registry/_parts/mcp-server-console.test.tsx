import {
  archestraApiClient,
  type McpDeploymentStatusEntry,
} from "@archestra/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render, screen, waitFor, within } from "@testing-library/react";
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
import type { McpLogsInstall } from "./mcp-logs-dialog";
import {
  McpServerConsole,
  type McpServerConsoleTab,
} from "./mcp-server-console";

vi.mock("@/lib/auth/auth.query");

// The websocket is the process boundary for logs and the shell: record each
// subscription so a test can push server messages through it.
const wsHandlers = vi.hoisted(
  () => new Map<string, Set<(message: unknown) => void>>(),
);
vi.mock("@/lib/websocket/websocket", () => ({
  default: {
    connect: vi.fn(),
    isConnected: () => true,
    send: vi.fn(),
    onConnectionChange: vi.fn(() => () => {}),
    subscribe: vi.fn((type: string, handler: (message: unknown) => void) => {
      const handlers = wsHandlers.get(type) ?? new Set();
      handlers.add(handler);
      wsHandlers.set(type, handlers);
      return () => handlers.delete(handler);
    }),
  },
}));

const API_ORIGIN = "http://localhost:9000";
const inspect = vi.fn(() => HttpResponse.json({ tools: [] }));
const server = setupServer(
  http.post(`${API_ORIGIN}/api/mcp_server/:id/inspect`, inspect),
);

const originalScrollIntoView = Element.prototype.scrollIntoView;

beforeAll(() => {
  // jsdom doesn't implement scrollIntoView, which the switcher's list calls.
  Element.prototype.scrollIntoView = vi.fn();
  server.listen({ onUnhandledRequest: "bypass" });
  archestraApiClient.setConfig({ baseUrl: API_ORIGIN });
});
beforeEach(() => {
  wsHandlers.clear();
  inspect.mockClear();
  vi.mocked(useSession).mockReturnValue({
    data: { user: { email: "me@example.com" } },
  } as ReturnType<typeof useSession>);
  vi.mocked(useHasPermissions).mockReturnValue({
    data: true,
  } as ReturnType<typeof useHasPermissions>);
});
afterEach(() => server.resetHandlers());
afterAll(() => {
  Element.prototype.scrollIntoView = originalScrollIntoView;
  server.close();
  archestraApiClient.setConfig({ baseUrl: "" });
});

const MINE: McpLogsInstall = {
  id: "install-mine",
  name: "orbit-mine",
  ownerEmail: "me@example.com",
  teamDetails: null,
  scope: "personal",
  canUseCredential: true,
};
// Owned by a colleague but shared through a team the viewer belongs to —
// "or those shared with you" has to survive the Inspector's filter.
const SHARED: McpLogsInstall = {
  id: "install-shared",
  name: "orbit-shared",
  ownerEmail: "colleague@example.com",
  teamDetails: { teamId: "team-1", name: "Engineering" },
  scope: "team",
  canUseCredential: true,
};
const THEIRS: McpLogsInstall = {
  id: "install-theirs",
  name: "orbit-theirs",
  ownerEmail: "colleague@example.com",
  teamDetails: null,
  scope: "personal",
  canUseCredential: false,
};

const RUNNING: Record<string, McpDeploymentStatusEntry> = Object.fromEntries(
  [MINE, SHARED, THEIRS].map((i) => [
    i.id,
    { state: "running", message: "", error: null, podName: `${i.name}-0` },
  ]),
);

function renderConsole(
  tab: McpServerConsoleTab,
  installs: McpLogsInstall[] = [MINE, SHARED, THEIRS],
) {
  return render(
    <QueryClientProvider client={new QueryClient()}>
      <McpServerConsole
        tab={tab}
        serverName="Orbit Tracker"
        installs={installs}
        deploymentStatuses={RUNNING}
        initialServerId={null}
      />
    </QueryClientProvider>,
  );
}

async function openSwitcher() {
  await userEvent.click(
    await screen.findByRole("button", { name: /Switch connection/ }),
  );
  return screen.findByRole("listbox");
}

describe("McpServerConsole", () => {
  it("groups every connection by whose it is for pod logs", async () => {
    // Pod diagnostics read the deployment rather than authenticate as it, so
    // an installation admin must not lose sight of a colleague's pod.
    renderConsole("logs");
    const list = await openSwitcher();

    const group = (name: RegExp) => within(list).getByRole("group", { name });
    expect(group(/^Yours/)).toHaveTextContent("orbit-mine");
    expect(group(/^Teams & organization/)).toHaveTextContent("orbit-shared");
    expect(group(/^Other people's/)).toHaveTextContent("orbit-theirs");
  });

  it("offers the Inspector only connections the viewer may use", async () => {
    renderConsole("inspector");
    const list = await openSwitcher();

    expect(screen.getByText(/usable as you/).parentElement).toHaveTextContent(
      "2 of 3 usable as you",
    );
    expect(list).toHaveTextContent("orbit-mine");
    expect(list).toHaveTextContent("orbit-shared");
    expect(list).not.toHaveTextContent("orbit-theirs");
  });

  it("explains itself instead of inspecting when no connection is the viewer's", async () => {
    renderConsole("inspector", [THEIRS]);

    expect(
      await screen.findByText("No connection of yours to inspect"),
    ).toBeInTheDocument();
    await waitFor(() => expect(inspect).not.toHaveBeenCalled());
  });

  it("keeps the shell to people who manage installations", async () => {
    vi.mocked(useHasPermissions).mockReturnValue({
      data: false,
    } as ReturnType<typeof useHasPermissions>);
    renderConsole("debug", [MINE]);

    expect(
      await screen.findByText("Shell access is limited to installation admins"),
    ).toBeInTheDocument();
  });

  it("shows streamed log lines and counts them in the status bar", async () => {
    renderConsole("logs", [MINE]);

    await waitFor(() => expect(wsHandlers.get("mcp_logs")?.size).toBe(1));
    act(() => {
      for (const handler of wsHandlers.get("mcp_logs") ?? []) {
        handler({
          type: "mcp_logs",
          payload: {
            serverId: MINE.id,
            logs: "booting\nlistening on :8080\nready\n",
            command: "kubectl logs -f orbit-mine",
          },
        });
      }
    });

    expect(await screen.findByText("listening on :8080")).toBeInTheDocument();
    const status = screen.getByText("lines").closest("footer");
    expect(status).toHaveTextContent(/3\s*lines/);
    expect(status).toHaveTextContent("kubectl logs -f orbit-mine");
  });
});
