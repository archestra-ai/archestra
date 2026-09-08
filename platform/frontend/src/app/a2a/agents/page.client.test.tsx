import { archestraApiClient, type archestraApiTypes } from "@archestra/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { HttpResponse, http } from "msw";
import { setupServer } from "msw/node";
import { usePathname, useSearchParams } from "next/navigation";
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
import OutboundA2aAgentsPage from "./page.client";

const API_ORIGIN = "http://localhost:9000";
const REGISTRY_URL = `${API_ORIGIN}/api/a2a/remote-agents`;
const INSPECT_URL = `${REGISTRY_URL}/inspect`;

const remoteAgent = {
  id: "remote-agent-1",
  organizationId: "org-1",
  name: "Payments Agent",
  description: "Answers payment operations questions",
  discoveryMode: "well_known",
  discoveryUrl: "https://agent.example.com",
  agentCard: { name: "Fixture Agent" },
  cardHash: "card-hash",
  etag: null,
  lastModified: null,
  lastDiscoveredAt: "2026-09-08T12:00:00.000Z",
  discoveryError: null,
  createdAt: "2026-09-08T12:00:00.000Z",
  updatedAt: "2026-09-08T12:00:00.000Z",
  connection: {
    id: "connection-1",
    remoteAgentId: "remote-agent-1",
    name: "Default",
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
    lastVerificationError: null,
    createdAt: "2026-09-08T12:00:00.000Z",
    updatedAt: "2026-09-08T12:00:00.000Z",
    hasCredential: false,
  },
  toolId: "tool-1",
} satisfies archestraApiTypes.ListA2aRemoteAgentsResponses["200"][number];

const inspection = {
  name: "Fixture Agent",
  description: "A deterministic external agent",
  agentCard: remoteAgent.agentCard,
  cardHash: remoteAgent.cardHash,
  selectedInterface: remoteAgent.connection.selectedInterface,
  supportedAuthTypes: ["none"],
  selectedSecurityRequirement: null,
} satisfies archestraApiTypes.InspectA2aRemoteAgentResponses["200"];

const server = setupServer();

vi.mock("next/navigation");
vi.mock("@/lib/auth/auth.query");
vi.mock("@/lib/hooks/use-app-name");
vi.mock("sonner");

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));

beforeEach(() => {
  vi.clearAllMocks();
  archestraApiClient.setConfig({ baseUrl: API_ORIGIN });
  vi.mocked(usePathname).mockReturnValue("/a2a/agents");
  vi.mocked(useSearchParams).mockReturnValue(
    new URLSearchParams() as ReturnType<typeof useSearchParams>,
  );
  vi.mocked(useAppName).mockReturnValue("Archestra");
  vi.mocked(useHasPermissions).mockReturnValue({
    data: true,
  } as ReturnType<typeof useHasPermissions>);
  server.use(http.get(`${REGISTRY_URL}/:id/runs`, () => HttpResponse.json([])));
});

afterEach(() => server.resetHandlers());

afterAll(() => {
  server.close();
  archestraApiClient.setConfig({ baseUrl: "" });
});

describe("OutboundA2aAgentsPage", () => {
  it("tests discovery and then connects the external agent with the same source", async () => {
    const user = userEvent.setup();
    let configuredAgents: (typeof remoteAgent)[] = [];
    let inspectedBody: unknown;
    let createdBody: unknown;

    server.use(
      http.get(REGISTRY_URL, () => HttpResponse.json(configuredAgents)),
      http.post(INSPECT_URL, async ({ request }) => {
        inspectedBody = await request.json();
        return HttpResponse.json(inspection);
      }),
      http.post(REGISTRY_URL, async ({ request }) => {
        createdBody = await request.json();
        configuredAgents = [remoteAgent];
        return HttpResponse.json(remoteAgent);
      }),
    );

    renderPage();

    expect(
      await screen.findByText("No external A2A agents connected"),
    ).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Connect agent" }));

    const dialog = screen.getByRole("dialog", {
      name: "Connect external A2A agent",
    });
    await user.type(
      within(dialog).getByLabelText("Agent base URL"),
      "https://agent.example.com",
    );
    await user.type(
      within(dialog).getByLabelText("Display name (optional)"),
      "Payments Agent",
    );
    await user.click(
      within(dialog).getByRole("button", { name: "Validate Agent Card" }),
    );

    expect(
      await within(dialog).findByText("Fixture Agent"),
    ).toBeInTheDocument();
    expect(inspectedBody).toEqual({
      source: { type: "well_known", url: "https://agent.example.com" },
      auth: { type: "none" },
    });

    await user.click(
      within(dialog).getByRole("button", { name: "Connect agent" }),
    );

    expect(await screen.findByText("Payments Agent")).toBeInTheDocument();
    expect(createdBody).toEqual({
      source: { type: "well_known", url: "https://agent.example.com" },
      auth: { type: "none" },
      name: "Payments Agent",
      connectionName: "Default",
    });
  });

  it("removes a configured external agent after confirmation", async () => {
    const user = userEvent.setup();
    let configuredAgents: (typeof remoteAgent)[] = [remoteAgent];
    let deletedId: string | undefined;

    server.use(
      http.get(REGISTRY_URL, () => HttpResponse.json(configuredAgents)),
      http.delete(`${REGISTRY_URL}/:id`, ({ params }) => {
        deletedId = String(params.id);
        configuredAgents = [];
        return HttpResponse.json({ success: true });
      }),
    );

    renderPage();

    expect(await screen.findByText("Payments Agent")).toBeInTheDocument();
    await user.click(
      screen.getByRole("button", { name: "Delete Payments Agent" }),
    );
    const dialog = screen.getByRole("dialog", {
      name: "Remove external A2A agent?",
    });
    expect(dialog).toHaveTextContent(
      "This removes Payments Agent and its stored connection credential.",
    );
    await user.click(within(dialog).getByRole("button", { name: "Delete" }));

    await waitFor(() => expect(deletedId).toBe(remoteAgent.id));
    expect(
      await screen.findByText("No external A2A agents connected"),
    ).toBeInTheDocument();
    expect(screen.queryByText("Payments Agent")).not.toBeInTheDocument();
  });

  it("clears a successful connection test when connection details change", async () => {
    const user = userEvent.setup();
    server.use(
      http.get(REGISTRY_URL, () => HttpResponse.json([])),
      http.post(INSPECT_URL, () => HttpResponse.json(inspection)),
    );
    renderPage();

    await user.click(
      await screen.findByRole("button", { name: "Connect agent" }),
    );
    const dialog = screen.getByRole("dialog", {
      name: "Connect external A2A agent",
    });
    const urlInput = within(dialog).getByLabelText("Agent base URL");
    await user.type(urlInput, "https://agent.example.com");
    await user.click(
      within(dialog).getByRole("button", { name: "Validate Agent Card" }),
    );
    expect(
      await within(dialog).findByText("Fixture Agent"),
    ).toBeInTheDocument();

    await user.type(urlInput, "/changed");
    expect(within(dialog).queryByText("Fixture Agent")).not.toBeInTheDocument();
  });

  it("announces a failed connection test", async () => {
    const user = userEvent.setup();
    server.use(
      http.get(REGISTRY_URL, () => HttpResponse.json([])),
      http.post(INSPECT_URL, () =>
        HttpResponse.json({ message: "invalid card" }, { status: 400 }),
      ),
    );
    renderPage();

    await user.click(
      await screen.findByRole("button", { name: "Connect agent" }),
    );
    const dialog = screen.getByRole("dialog", {
      name: "Connect external A2A agent",
    });
    await user.type(
      within(dialog).getByLabelText("Agent base URL"),
      "https://invalid.example.com",
    );
    await user.click(
      within(dialog).getByRole("button", { name: "Validate Agent Card" }),
    );

    expect(await within(dialog).findByRole("alert")).toHaveTextContent(
      "The Agent Card could not be reached or validated.",
    );
  });

  it("shows the latest monitored outbound run to administrators", async () => {
    server.use(
      http.get(REGISTRY_URL, () => HttpResponse.json([remoteAgent])),
      http.get(`${REGISTRY_URL}/:id/runs`, () =>
        HttpResponse.json([
          {
            id: "run-1",
            parentAgentId: "parent-1",
            connectionId: remoteAgent.connection.id,
            toolId: remoteAgent.toolId,
            userId: "user-1",
            conversationId: "conversation-1",
            toolCallId: "call-1",
            messageId: "message-1",
            remoteTaskId: "task-1",
            remoteContextId: "context-1",
            state: "completed",
            targetNameSnapshot: remoteAgent.name,
            interfaceSnapshot: remoteAgent.connection.selectedInterface,
            errorCode: null,
            statusReason: null,
            startedAt: "2026-09-08T12:00:00.000Z",
            completedAt: "2026-09-08T12:00:01.000Z",
          },
        ]),
      ),
    );

    renderPage();

    expect(await screen.findByText("Recent activity")).toBeInTheDocument();
    expect(await screen.findByText(/completed ·/)).toBeInTheDocument();
  });
});

function renderPage() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  render(
    <QueryClientProvider client={queryClient}>
      <OutboundA2aAgentsPage />
    </QueryClientProvider>,
  );
}
