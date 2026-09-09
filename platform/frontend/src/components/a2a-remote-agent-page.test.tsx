import { archestraApiClient } from "@archestra/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
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
import {
  A2aRemoteAgentDetailPage,
  CreateA2aRemoteAgentPage,
} from "./a2a-remote-agent-page";

global.ResizeObserver = class ResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
};

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
    authType: "bearer",
    authConfig: {},
    enabled: true,
    lastVerifiedAt: "2026-09-08T12:00:00.000Z",
    createdAt: "2026-09-08T12:00:00.000Z",
    updatedAt: "2026-09-08T12:00:00.000Z",
    hasCredential: true,
  },
  toolId: "tool-1",
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
  archestraApiClient.setConfig({ baseUrl: API_ORIGIN });
  vi.mocked(usePathname).mockReturnValue("/a2a/agents/new");
  vi.mocked(useSearchParams).mockReturnValue(
    new URLSearchParams() as ReturnType<typeof useSearchParams>,
  );
  vi.mocked(useRouter).mockReturnValue({
    push: vi.fn(),
    replace: vi.fn(),
  } as unknown as ReturnType<typeof useRouter>);
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
});

afterEach(() => server.resetHandlers());

afterAll(() => {
  server.close();
  archestraApiClient.setConfig({ baseUrl: "" });
});

describe("external A2A agent routed pages", () => {
  it("connects from the routed create form with personal visibility", async () => {
    const user = userEvent.setup();
    const push = vi.fn();
    let createdBody: unknown;
    let inspectedBody: unknown;
    vi.mocked(useRouter).mockReturnValue({
      push,
      replace: vi.fn(),
    } as unknown as ReturnType<typeof useRouter>);
    server.use(
      http.post(`${REGISTRY_URL}/inspect`, async ({ request }) => {
        inspectedBody = await request.json();
        return HttpResponse.json({
          name: "Fixture Agent",
          description: "A deterministic external agent",
          agentCard: remoteAgent.agentCard,
          cardHash: remoteAgent.cardHash,
          selectedInterface: remoteAgent.connection.selectedInterface,
          supportedAuthTypes: ["none"],
          selectedSecurityRequirement: null,
        });
      }),
      http.post(REGISTRY_URL, async ({ request }) => {
        createdBody = await request.json();
        return HttpResponse.json(remoteAgent);
      }),
    );

    renderPage(<CreateA2aRemoteAgentPage />);
    expect(screen.queryByLabelText("Agent Card source")).toBeNull();
    expect(screen.queryByLabelText("Agent Card JSON")).toBeNull();
    expect(
      screen.queryByRole("button", { name: "Validate Agent Card" }),
    ).toBeNull();
    const baseUrlInput = screen.getByLabelText("Agent base URL");
    await user.click(baseUrlInput);
    await user.paste(remoteAgent.discoveryUrl);
    expect(
      screen.getByRole("button", { name: "Connect agent" }),
    ).toBeDisabled();
    expect(
      screen.getByLabelText("Display name (optional)"),
    ).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Check Agent Card" }));
    expect(
      await screen.findByRole("status", { name: "Connection compatible" }),
    ).toBeInTheDocument();
    const nameInput = screen.getByLabelText("Display name (optional)");
    const descriptionInput = screen.getByLabelText("Description (optional)");
    await user.type(nameInput, remoteAgent.name);
    await user.type(descriptionInput, remoteAgent.description);
    await user.clear(screen.getByLabelText("Agent base URL"));
    await user.type(
      screen.getByLabelText("Agent base URL"),
      "https://changed.example.com",
    );
    expect(
      screen.getByRole("button", { name: "Connect agent" }),
    ).toBeDisabled();
    await user.clear(screen.getByLabelText("Agent base URL"));
    await user.type(
      screen.getByLabelText("Agent base URL"),
      remoteAgent.discoveryUrl,
    );
    expect(
      screen.getByRole("button", { name: "Connect agent" }),
    ).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "Check Agent Card" }));
    await screen.findByRole("status", { name: "Connection compatible" });
    expect(screen.getByLabelText("Display name (optional)")).toHaveValue(
      remoteAgent.name,
    );
    expect(screen.getByLabelText("Description (optional)")).toHaveValue(
      remoteAgent.description,
    );
    expect(inspectedBody).toEqual({
      source: { type: "well_known", url: remoteAgent.discoveryUrl },
      auth: { type: "none" },
    });
    await user.click(screen.getByRole("button", { name: "Connect agent" }));

    await waitFor(() =>
      expect(createdBody).toEqual({
        source: { type: "well_known", url: remoteAgent.discoveryUrl },
        auth: { type: "none" },
        name: remoteAgent.name,
        description: remoteAgent.description,
        scope: "personal",
        teams: [],
        users: [],
      }),
    );
    expect(push).toHaveBeenCalledWith("/a2a/agents/remote-agent-1");
  });

  it("guards the create page from discarding an unsaved connection", async () => {
    const user = userEvent.setup();
    const push = vi.fn();
    vi.mocked(useRouter).mockReturnValue({
      push,
      replace: vi.fn(),
    } as unknown as ReturnType<typeof useRouter>);
    server.use(
      http.post(`${REGISTRY_URL}/inspect`, () =>
        HttpResponse.json({
          name: "Fixture Agent",
          description: "A deterministic external agent",
          agentCard: remoteAgent.agentCard,
          cardHash: remoteAgent.cardHash,
          selectedInterface: remoteAgent.connection.selectedInterface,
          supportedAuthTypes: ["none"],
          selectedSecurityRequirement: null,
        }),
      ),
    );

    renderPage(<CreateA2aRemoteAgentPage />);
    await user.type(
      screen.getByLabelText("Agent base URL"),
      remoteAgent.discoveryUrl,
    );
    await user.click(screen.getByRole("link", { name: "External Agents" }));

    expect(
      screen.getByRole("heading", { name: "Discard unsaved changes?" }),
    ).toBeInTheDocument();
    expect(push).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Discard changes" }));
    expect(push).toHaveBeenCalledWith("/a2a/agents");
  });

  it("rejects query parameters and discovers from a canonical path-prefixed base URL", async () => {
    const user = userEvent.setup();
    let inspectCalls = 0;
    let inspectedBody: unknown;
    server.use(
      http.post(`${REGISTRY_URL}/inspect`, async ({ request }) => {
        inspectCalls += 1;
        inspectedBody = await request.json();
        return HttpResponse.json({
          name: "Fixture Agent",
          description: "A deterministic external agent",
          agentCard: remoteAgent.agentCard,
          cardHash: remoteAgent.cardHash,
          selectedInterface: remoteAgent.connection.selectedInterface,
          supportedAuthTypes: ["none"],
          selectedSecurityRequirement: null,
        });
      }),
    );

    renderPage(<CreateA2aRemoteAgentPage />);
    const baseUrlInput = screen.getByLabelText("Agent base URL");
    await user.click(baseUrlInput);
    await user.paste("https://agent.example.com/apikey?tenant=one");
    await user.click(screen.getByRole("button", { name: "Check Agent Card" }));

    expect(
      await screen.findByRole("alert", {}, { timeout: 2_000 }),
    ).toHaveTextContent(
      "Enter an HTTP(S) base URL without credentials, a query, or a fragment.",
    );
    expect(inspectCalls).toBe(0);

    await user.clear(baseUrlInput);
    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
    await user.click(baseUrlInput);
    await user.paste(`${remoteAgent.discoveryUrl}/apikey/`);
    await user.click(screen.getByRole("button", { name: "Check Agent Card" }));
    expect(
      await screen.findByRole("status", { name: "Agent Card found" }),
    ).toHaveTextContent("Fixture Agent");
    expect(inspectCalls).toBe(2);
    expect(inspectedBody).toEqual({
      source: {
        type: "well_known",
        url: `${remoteAgent.discoveryUrl}/apikey`,
      },
      auth: { type: "none" },
    });
  });

  it("requires a selected user or team for explicit access choices", async () => {
    const user = userEvent.setup();
    vi.mocked(useOrganizationMembers).mockReturnValue({
      data: [
        { id: "user-1", name: "Test User", email: "owner@example.com" },
        { id: "user-2", name: "Morgan Lee", email: "morgan@example.com" },
      ],
    } as unknown as ReturnType<typeof useOrganizationMembers>);
    vi.mocked(useTeams).mockReturnValue({
      data: [{ id: "team-1", name: "Operations", parentId: null }],
    } as unknown as ReturnType<typeof useTeams>);
    server.use(
      http.post(`${REGISTRY_URL}/inspect`, () =>
        HttpResponse.json({
          name: "Fixture Agent",
          description: null,
          agentCard: remoteAgent.agentCard,
          cardHash: remoteAgent.cardHash,
          selectedInterface: remoteAgent.connection.selectedInterface,
          supportedAuthTypes: ["none"],
          selectedSecurityRequirement: null,
        }),
      ),
    );

    renderPage(<CreateA2aRemoteAgentPage />);
    await user.type(
      screen.getByLabelText("Agent base URL"),
      remoteAgent.discoveryUrl,
    );
    await user.click(screen.getByRole("button", { name: "Check Agent Card" }));
    await screen.findByRole("status", { name: "Connection compatible" });
    await user.click(screen.getByRole("button", { name: /Personal/ }));
    await user.click(screen.getByRole("button", { name: /Users/ }));
    expect(
      screen.getByRole("button", { name: "Connect agent" }),
    ).toBeDisabled();
    await user.click(screen.getByRole("button", { name: /Users/ }));
    await user.click(screen.getByRole("button", { name: /Teams/ }));
    expect(
      screen.getByRole("button", { name: "Connect agent" }),
    ).toBeDisabled();
  });

  it("prefills edit and omits unchanged source and stored credential on a visibility-only update", async () => {
    const user = userEvent.setup();
    let updatedBody: unknown;
    server.use(
      http.get(`${REGISTRY_URL}/:id`, () => HttpResponse.json(remoteAgent)),
      http.put(`${REGISTRY_URL}/:id`, async ({ request }) => {
        updatedBody = await request.json();
        return HttpResponse.json({ ...remoteAgent, scope: "org" });
      }),
    );

    renderPage(<A2aRemoteAgentDetailPage id={remoteAgent.id} />);

    expect(await screen.findByLabelText("Agent base URL")).toHaveValue(
      remoteAgent.discoveryUrl,
    );
    expect(screen.getByLabelText("Display name (optional)")).toHaveValue(
      remoteAgent.name,
    );
    expect(screen.getByLabelText("Replace credential (optional)")).toHaveValue(
      "",
    );
    expect(screen.getByRole("button", { name: "Save changes" })).toBeDisabled();
    await user.click(screen.getByRole("button", { name: /Personal/ }));
    await user.click(screen.getByRole("button", { name: /Organization/ }));
    await user.click(
      screen.getByRole("button", {
        name: `More actions ${remoteAgent.name}`,
      }),
    );
    expect(
      screen.getByRole("menuitem", { name: "Disable delegation" }),
    ).toHaveAttribute("aria-disabled", "true");
    await user.keyboard("{Escape}");
    await user.click(screen.getByRole("button", { name: "Save changes" }));

    await waitFor(() =>
      expect(updatedBody).toEqual({ scope: "org", teams: [], users: [] }),
    );
  });

  it.each([
    {
      discoveryMode: "card_url" as const,
      discoveryUrl: "https://agent.example.com/custom-card.json",
    },
    { discoveryMode: "inline_card" as const, discoveryUrl: null },
  ])("preserves a legacy $discoveryMode source during an unrelated edit", async ({
    discoveryMode,
    discoveryUrl,
  }) => {
    const user = userEvent.setup();
    let updatedBody: unknown;
    const legacyAgent = { ...remoteAgent, discoveryMode, discoveryUrl };
    server.use(
      http.get(`${REGISTRY_URL}/:id`, () => HttpResponse.json(legacyAgent)),
      http.put(`${REGISTRY_URL}/:id`, async ({ request }) => {
        updatedBody = await request.json();
        return HttpResponse.json({ ...legacyAgent, scope: "org" });
      }),
    );

    renderPage(<A2aRemoteAgentDetailPage id={remoteAgent.id} />);

    expect(await screen.findByLabelText("Agent base URL")).toHaveValue("");
    expect(
      screen.getByText(/uses a legacy Agent Card source/i),
    ).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /Personal/ }));
    await user.click(screen.getByRole("button", { name: /Organization/ }));
    await user.click(screen.getByRole("button", { name: "Save changes" }));

    await waitFor(() =>
      expect(updatedBody).toEqual({ scope: "org", teams: [], users: [] }),
    );
  });

  it("rechecks an edited base URL without resubmitting its stored credential", async () => {
    const user = userEvent.setup();
    let inspectedBody: unknown;
    let updatedBody: unknown;
    server.use(
      http.get(`${REGISTRY_URL}/:id`, () => HttpResponse.json(remoteAgent)),
      http.post(`${REGISTRY_URL}/inspect`, async ({ request }) => {
        inspectedBody = await request.json();
        return HttpResponse.json({
          name: remoteAgent.name,
          description: remoteAgent.description,
          agentCard: remoteAgent.agentCard,
          cardHash: "refreshed-card-hash",
          selectedInterface: remoteAgent.connection.selectedInterface,
          supportedAuthTypes: ["bearer"],
          selectedSecurityRequirement: null,
        });
      }),
      http.put(`${REGISTRY_URL}/:id`, async ({ request }) => {
        updatedBody = await request.json();
        return HttpResponse.json({
          ...remoteAgent,
          cardHash: "refreshed-card-hash",
        });
      }),
    );

    renderPage(<A2aRemoteAgentDetailPage id={remoteAgent.id} />);

    const baseUrlInput = await screen.findByLabelText("Agent base URL");
    await user.clear(baseUrlInput);
    await user.click(baseUrlInput);
    await user.paste(remoteAgent.discoveryUrl);
    await user.click(screen.getByRole("button", { name: "Check Agent Card" }));

    await waitFor(() =>
      expect(inspectedBody).toEqual({
        source: { type: "well_known", url: remoteAgent.discoveryUrl },
        auth: { type: "bearer" },
      }),
    );
    expect(
      await screen.findByRole("status", { name: "Agent Card found" }),
    ).toBeInTheDocument();
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Save changes" }),
      ).toBeEnabled(),
    );
    await user.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() =>
      expect(updatedBody).toEqual({
        source: { type: "well_known", url: remoteAgent.discoveryUrl },
      }),
    );
  });

  it("uses one submit action for edit and enables it when dirty", async () => {
    const user = userEvent.setup();
    server.use(
      http.get(`${REGISTRY_URL}/:id`, () => HttpResponse.json(remoteAgent)),
    );

    renderPage(<A2aRemoteAgentDetailPage id={remoteAgent.id} />);
    const nameInput = await screen.findByLabelText("Display name (optional)");
    await user.clear(nameInput);
    await user.type(nameInput, "Changed name");
    expect(
      screen.queryByRole("button", { name: "Discard changes" }),
    ).toBeNull();
    expect(
      screen.getAllByRole("button", { name: "Save changes" }),
    ).toHaveLength(1);
    expect(screen.getByRole("button", { name: "Save changes" })).toBeEnabled();
  });

  it("keeps unsupported authentication choices visible and disabled", async () => {
    const user = userEvent.setup();
    server.use(
      http.post(`${REGISTRY_URL}/inspect`, () =>
        HttpResponse.json({
          name: "Fixture Agent",
          description: null,
          agentCard: remoteAgent.agentCard,
          cardHash: remoteAgent.cardHash,
          selectedInterface: remoteAgent.connection.selectedInterface,
          supportedAuthTypes: ["none"],
          selectedSecurityRequirement: null,
        }),
      ),
    );

    renderPage(<CreateA2aRemoteAgentPage />);
    expect(screen.getByRole("radio", { name: "Bearer token" })).toBeEnabled();
    await user.type(
      screen.getByLabelText("Agent base URL"),
      remoteAgent.discoveryUrl,
    );
    await user.click(screen.getByRole("button", { name: "Check Agent Card" }));
    await screen.findByRole("status", { name: "Connection compatible" });

    expect(screen.getByRole("radio", { name: /Bearer token/ })).toBeDisabled();
    expect(
      screen.getByRole("radio", { name: /API key header/ }),
    ).toBeDisabled();
    expect(
      screen.getAllByText("Not supported by this Agent Card"),
    ).toHaveLength(2);
  });

  it("shows why automatic Agent Card validation failed", async () => {
    const user = userEvent.setup();
    server.use(
      http.post(`${REGISTRY_URL}/inspect`, () =>
        HttpResponse.json(
          {
            error: {
              message: "Agent Card must accept the text/plain input mode",
            },
          },
          { status: 400 },
        ),
      ),
    );

    renderPage(<CreateA2aRemoteAgentPage />);
    await user.type(
      screen.getByLabelText("Agent base URL"),
      remoteAgent.discoveryUrl,
    );
    await user.click(screen.getByRole("button", { name: "Check Agent Card" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Agent Card must accept the text/plain input mode",
    );
  });

  it("shows a read-only detail without exposing or replacing credentials", async () => {
    vi.mocked(useHasPermissions).mockReturnValue({
      data: false,
      isPending: false,
    } as ReturnType<typeof useHasPermissions>);
    server.use(
      http.get(`${REGISTRY_URL}/:id`, () => HttpResponse.json(remoteAgent)),
    );

    renderPage(<A2aRemoteAgentDetailPage id={remoteAgent.id} />);

    expect(
      await screen.findByText(/you do not have permission to change/i),
    ).toBeInTheDocument();
    expect(screen.queryByLabelText("Agent base URL")).toBeNull();
    expect(screen.getByText("Configured")).toBeInTheDocument();
    expect(screen.getByText(remoteAgent.discoveryUrl)).toBeInTheDocument();
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(screen.queryByLabelText("Replace credential (optional)")).toBeNull();
    expect(screen.queryByRole("button", { name: "Show value" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Save changes" })).toBeNull();
    expect(screen.queryByRole("button", { name: /More actions/ })).toBeNull();
  });

  it("lets external-agent managers choose organization visibility", async () => {
    const user = userEvent.setup();
    vi.mocked(useHasPermissions).mockImplementation(
      (permissions) =>
        ({
          data:
            !!permissions.agentSettings?.includes("update") ||
            !!permissions.team?.includes("read"),
          isPending: false,
        }) as ReturnType<typeof useHasPermissions>,
    );

    renderPage(<CreateA2aRemoteAgentPage />);

    await user.click(screen.getByRole("button", { name: /Personal/ }));
    expect(screen.getByRole("button", { name: /Organization/ })).toBeEnabled();
  });

  it("pauses delegation from the detail actions", async () => {
    const user = userEvent.setup();
    let updatedBody: unknown;
    server.use(
      http.get(`${REGISTRY_URL}/:id`, () => HttpResponse.json(remoteAgent)),
      http.put(`${REGISTRY_URL}/:id`, async ({ request }) => {
        updatedBody = await request.json();
        return HttpResponse.json({
          ...remoteAgent,
          connection: { ...remoteAgent.connection, enabled: false },
        });
      }),
    );

    renderPage(<A2aRemoteAgentDetailPage id={remoteAgent.id} />);

    await screen.findByLabelText("Agent base URL");
    expect(screen.queryByRole("heading", { name: "Availability" })).toBeNull();
    expect(screen.queryByLabelText("Enabled for delegation")).toBeNull();
    await user.click(
      screen.getByRole("button", {
        name: `More actions ${remoteAgent.name}`,
      }),
    );
    await user.click(
      screen.getByRole("menuitem", { name: "Disable delegation" }),
    );

    await waitFor(() => expect(updatedBody).toEqual({ enabled: false }));
  });

  it("explains the missing permission on the direct create route", () => {
    vi.mocked(useHasPermissions).mockReturnValue({
      data: false,
      isPending: false,
    } as ReturnType<typeof useHasPermissions>);

    renderPage(<CreateA2aRemoteAgentPage />);

    expect(
      screen.getByText(/Connecting external A2A agents requires/),
    ).toBeInTheDocument();
    expect(screen.queryByLabelText("Agent base URL")).toBeNull();
  });
});

function renderPage(children: React.ReactNode) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  render(
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>,
  );
}
