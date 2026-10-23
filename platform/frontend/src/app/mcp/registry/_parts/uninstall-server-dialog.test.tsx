import { archestraApiClient } from "@archestra/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import { HttpResponse, http } from "msw";
import { setupServer } from "msw/node";
import type { ReactElement } from "react";
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
import { UninstallServerDialog } from "./uninstall-server-dialog";

vi.mock("@/lib/auth/auth.query");
const { deleteState } = vi.hoisted(() => ({
  deleteState: { isPending: false },
}));
vi.mock("@/lib/mcp/mcp-server.query", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/mcp/mcp-server.query")>()),
  useDeleteMcpServer: () => ({
    mutateAsync: vi.fn(),
    isPending: deleteState.isPending,
  }),
}));

const API_ORIGIN = "http://localhost:9000";
const server = setupServer();
beforeAll(() => {
  archestraApiClient.setConfig({ baseUrl: API_ORIGIN });
  server.listen({ onUnhandledRequest: "error" });
});
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

/** An admin sees shared installations and everyone's agents; a member neither. */
function viewAs(role: "admin" | "member") {
  vi.mocked(useHasPermissions).mockReturnValue({
    data: role === "admin",
  } as ReturnType<typeof useHasPermissions>);
}

function agent(
  id: string,
  name: string,
  options: { pinned: boolean; ownerEmail?: string },
) {
  return {
    id,
    name,
    agentType: "agent",
    scope: "personal",
    ownerId: null,
    ownerEmail: options.ownerEmail ?? null,
    pinned: options.pinned,
  };
}

/** GET /api/mcp_server/:id answers with each install's assigned agents. */
function serveAgents(
  agentsByServerId: Record<string, ReturnType<typeof agent>[]>,
) {
  server.use(
    http.get(`${API_ORIGIN}/api/mcp_server/:id`, ({ params }) => {
      const agents = agentsByServerId[params.id as string];
      return agents
        ? HttpResponse.json({ id: params.id, assignedAgents: agents })
        : HttpResponse.json(
            { error: { message: "Not found", type: "api_not_found_error" } },
            { status: 404 },
          );
    }),
  );
}

function renderDialog(ui: ReactElement) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const view = render(ui, {
    wrapper: ({ children }) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    ),
  });
  return { ...view, queryClient };
}

const personalInstall = {
  server: { id: "srv-1", name: "Notes", scope: "personal" as const },
};

describe("UninstallServerDialog", () => {
  beforeEach(() => {
    viewAs("admin");
    deleteState.isPending = false;
  });

  it("tells a member only what they can act on: no shared connections, no owners", async () => {
    viewAs("member");
    serveAgents({
      "srv-1": [
        agent("a1", "My Gateway", {
          pinned: true,
          ownerEmail: "member@example.com",
        }),
      ],
    });
    renderDialog(
      <UninstallServerDialog
        open
        onClose={vi.fn()}
        installs={[personalInstall]}
      />,
    );

    expect(
      screen.getByText('Are you sure you want to uninstall "Notes"?'),
    ).toBeInTheDocument();
    expect(screen.queryByText(/team and organization/)).toBeNull();
    expect(
      await screen.findByText(/^My Gateway has tools assigned/),
    ).toBeInTheDocument();
  });

  it("tells an admin which connections stay and whose agents are affected", async () => {
    serveAgents({
      "srv-1": [
        agent("a1", "My Gateway", {
          pinned: true,
          ownerEmail: "member@example.com",
        }),
      ],
    });
    renderDialog(
      <UninstallServerDialog
        open
        onClose={vi.fn()}
        installs={[personalInstall]}
      />,
    );

    expect(
      screen.getByText(/team and organization connections are not affected/),
    ).toBeInTheDocument();
    expect(
      await screen.findByText(/^My Gateway \(member@example\.com\) has tools/),
    ).toBeInTheDocument();
  });

  it("holds the uninstall until it knows which agents lose access", async () => {
    let release = () => {};
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    server.use(
      http.get(`${API_ORIGIN}/api/mcp_server/:id`, async () => {
        await released;
        return HttpResponse.json({
          id: "srv-1",
          assignedAgents: [agent("a1", "My Gateway", { pinned: true })],
        });
      }),
    );
    renderDialog(
      <UninstallServerDialog
        open
        onClose={vi.fn()}
        installs={[personalInstall]}
      />,
    );

    expect(
      await screen.findByText("Searching agents using this connection..."),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Uninstall" })).toBeDisabled();

    release();

    expect(await screen.findByText("Used by 1 agent")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Uninstall" })).toBeEnabled();
    expect(
      screen.queryByText("Searching agents using this connection..."),
    ).toBeNull();
  });

  it("still lets the user uninstall when the agents cannot be loaded", async () => {
    server.use(
      http.get(`${API_ORIGIN}/api/mcp_server/:id`, () =>
        HttpResponse.json(
          { error: { message: "Boom", type: "api_internal_server_error" } },
          { status: 500 },
        ),
      ),
    );
    renderDialog(
      <UninstallServerDialog
        open
        onClose={vi.fn()}
        installs={[personalInstall]}
      />,
    );

    expect(
      await screen.findByText("Agents could not be loaded"),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Uninstall" })).toBeEnabled();
  });

  it("names each affected agent once across the selected connections", async () => {
    serveAgents({
      // Nobody but its owner resolves to a personal connection, so only the
      // agents pinned to it lose access.
      "srv-1": [
        agent("a1", "Shared Helper", { pinned: true }),
        agent("a2", "Floating Agent", { pinned: false }),
      ],
      // Any caller may resolve to a team connection.
      "srv-2": [
        agent("a1", "Shared Helper", { pinned: false }),
        agent("a3", "Team Bot", { pinned: false }),
      ],
    });
    renderDialog(
      <UninstallServerDialog
        open
        onClose={vi.fn()}
        installs={[
          personalInstall,
          {
            server: {
              id: "srv-2",
              name: "Notes (team)",
              scope: "team",
              teamId: "team-1",
            },
          },
        ]}
      />,
    );

    expect(await screen.findByText("Used by 2 agents")).toBeInTheDocument();
    const names = screen.getByText(/have tools assigned/);
    expect(names).toHaveTextContent(/^Shared Helper, Team Bot have/);
    expect(names).not.toHaveTextContent("Floating Agent");
  });

  it("keeps the agents it showed when the connection is removed elsewhere", async () => {
    serveAgents({
      "srv-1": [agent("a1", "My Gateway", { pinned: true })],
    });
    const { queryClient } = renderDialog(
      <UninstallServerDialog
        open
        onClose={vi.fn()}
        installs={[personalInstall]}
      />,
    );
    expect(await screen.findByText("Used by 1 agent")).toBeInTheDocument();

    // A server-list refresh while the dialog is open rereads the install,
    // which someone else has removed by then.
    serveAgents({});
    await queryClient.refetchQueries({ queryKey: ["mcp-servers"] });

    await waitFor(() =>
      expect(
        queryClient.getQueryState(["mcp-servers", "srv-1", "detail"])?.status,
      ).toBe("error"),
    );
    expect(screen.getByText("Used by 1 agent")).toBeInTheDocument();
    expect(screen.queryByText("Agents could not be loaded")).toBeNull();
  });

  it("stops rereading the connection once the uninstall runs", async () => {
    let reads = 0;
    server.use(
      http.get(`${API_ORIGIN}/api/mcp_server/:id`, () => {
        reads++;
        return HttpResponse.json({
          id: "srv-1",
          assignedAgents: [agent("a1", "My Gateway", { pinned: true })],
        });
      }),
    );
    const { queryClient, rerender } = renderDialog(
      <UninstallServerDialog
        open
        onClose={vi.fn()}
        installs={[personalInstall]}
      />,
    );
    expect(await screen.findByText("Used by 1 agent")).toBeInTheDocument();
    expect(reads).toBe(1);

    // The delete refetches every server query; the install it removes would
    // only answer "not found".
    deleteState.isPending = true;
    rerender(
      <UninstallServerDialog
        open
        onClose={vi.fn()}
        installs={[personalInstall]}
      />,
    );
    await queryClient.refetchQueries({ queryKey: ["mcp-servers"] });

    expect(reads).toBe(1);
    expect(screen.getByText("Used by 1 agent")).toBeInTheDocument();
  });

  it("keeps the server name while the uninstall removes it from the list", () => {
    deleteState.isPending = true;
    serveAgents({ "srv-1": [] });
    const { rerender } = renderDialog(
      <UninstallServerDialog
        open
        onClose={vi.fn()}
        installs={[{ server: { id: "srv-1", name: "Slack" } }]}
      />,
    );

    rerender(<UninstallServerDialog open onClose={vi.fn()} installs={[]} />);

    expect(screen.getByText(/uninstall "Slack"\?/)).toBeInTheDocument();
  });
});
