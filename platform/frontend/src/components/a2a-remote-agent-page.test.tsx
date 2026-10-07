import { archestraApiClient } from "@archestra/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { HttpResponse, http } from "msw";
import { setupServer } from "msw/node";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { StrictMode } from "react";
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
import {
  useHasPermissions,
  useScopedCapabilities,
  useSession,
} from "@/lib/auth/auth.query";
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
  authorId: "user-1",
  authorName: "Test User",
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
  assignmentCount: 2,
  lastUsedAt: null,
} as const;

const server = setupServer(
  http.post(`${REGISTRY_URL}/inspect`, () =>
    HttpResponse.json({
      name: remoteAgent.name,
      description: remoteAgent.description,
      agentCard: remoteAgent.agentCard,
      cardHash: remoteAgent.cardHash,
      selectedInterface: remoteAgent.connection.selectedInterface,
      supportedAuthTypes: [remoteAgent.connection.authType],
      selectedSecurityRequirement: remoteAgent.connection.securityRequirement,
    }),
  ),
);

vi.mock("next/navigation");
vi.mock("@/lib/auth/auth.query");
vi.mock("@/lib/hooks/use-app-name");
vi.mock("@/lib/organization.query");
vi.mock("@/lib/teams/team.query");
vi.mock("sonner");
// The shared permission editors have their own tests. Here they only need to
// show up, and the create form's one to hand back a starting grant.
const savePermissions = vi.fn(async () => {});
vi.mock("@/components/resource-permissions", async () => {
  const { useEffect } = await import("react");
  return {
    ResourcePermissions: ({
      resource,
      onDirtyChange,
      registerSave,
    }: {
      resource: string;
      onDirtyChange?: (dirty: boolean) => void;
      registerSave?: (save: (() => Promise<void>) | null) => void;
    }) => {
      useEffect(() => {
        registerSave?.(savePermissions);
        return () => registerSave?.(null);
      }, [registerSave]);
      return (
        <section aria-label={`Permissions for ${resource}`}>
          <button type="button" onClick={() => onDirtyChange?.(true)}>
            Change a grant
          </button>
          {!registerSave && <button type="button">Save permissions</button>}
        </section>
      );
    },
  };
});
vi.mock("@/components/initial-resource-permissions", () => ({
  InitialResourcePermissions: ({
    resource,
    onChange,
  }: {
    resource: string;
    onChange: (grants: unknown[]) => void;
  }) => (
    <section aria-label={`Initial permissions for ${resource}`}>
      <button
        type="button"
        onClick={() =>
          onChange([
            {
              subject: { type: "team", id: "team-1" },
              actions: ["read", "use"],
              name: "Operations",
            },
          ])
        }
      >
        Share with Operations
      </button>
    </section>
  ),
}));

beforeAll(() => {
  Element.prototype.hasPointerCapture = vi.fn().mockReturnValue(false);
  Element.prototype.setPointerCapture = vi.fn();
  Element.prototype.releasePointerCapture = vi.fn();
  Element.prototype.scrollIntoView = vi.fn();
  server.listen({ onUnhandledRequest: "error" });
});

beforeEach(() => {
  vi.clearAllMocks();
  archestraApiClient.setConfig({ baseUrl: API_ORIGIN });
  vi.mocked(usePathname).mockReturnValue("/agents/a2a/new");
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
  grantCapabilities(["update", "delete"]);
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
    const connectButton = screen.getByRole("button", {
      name: "Connect agent",
    });
    expect(connectButton).toBeEnabled();
    await user.click(connectButton);
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "An agent base URL is required.",
    );
    expect(inspectedBody).toBeUndefined();
    expect(createdBody).toBeUndefined();
    expect(connectButton).toBeEnabled();

    const baseUrlInput = screen.getByLabelText("Agent base URL");
    await user.click(baseUrlInput);
    await user.paste(remoteAgent.discoveryUrl);
    expect(
      screen.getByLabelText("Display name (optional)"),
    ).toBeInTheDocument();
    const nameInput = screen.getByLabelText("Display name (optional)");
    const descriptionInput = screen.getByLabelText("Description (optional)");
    await user.type(nameInput, remoteAgent.name);
    await user.type(descriptionInput, remoteAgent.description);
    await user.click(connectButton);

    await waitFor(() => {
      expect(inspectedBody).toEqual({
        source: { type: "well_known", url: remoteAgent.discoveryUrl },
        auth: { type: "none" },
      });
      expect(createdBody).toEqual({
        source: { type: "well_known", url: remoteAgent.discoveryUrl },
        auth: { type: "none" },
        name: remoteAgent.name,
        description: remoteAgent.description,
        initialGrants: [],
      });
    });
    expect(push).toHaveBeenCalledWith("/agents/a2a/remote-agent-1");
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
    await user.click(screen.getByRole("link", { name: "Add Agent" }));

    expect(
      screen.getByRole("heading", { name: "Discard unsaved changes?" }),
    ).toBeInTheDocument();
    expect(push).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Discard changes" }));
    expect(push).toHaveBeenCalledWith("/agents/new");
  });

  it.each([
    {
      method: "Bearer token",
      credential: "bearer-secret",
      expectedAuth: { type: "bearer", credential: "bearer-secret" },
    },
    {
      method: "API key header",
      credential: "api-key-secret",
      expectedAuth: {
        type: "api_key",
        headerName: "X-API-Key",
        credential: "api-key-secret",
      },
    },
  ])("connects after checking the Agent Card with $method authentication", async ({
    method,
    credential,
    expectedAuth,
  }) => {
    const user = userEvent.setup();
    let inspectedBody: unknown;
    let createdBody: unknown;
    server.use(
      http.post(`${REGISTRY_URL}/inspect`, async ({ request }) => {
        inspectedBody = await request.json();
        return HttpResponse.json({
          name: "Fixture Agent",
          description: null,
          agentCard: remoteAgent.agentCard,
          cardHash: remoteAgent.cardHash,
          selectedInterface: remoteAgent.connection.selectedInterface,
          supportedAuthTypes: [expectedAuth.type],
          selectedSecurityRequirement: { fixtureAuth: [] },
        });
      }),
      http.post(REGISTRY_URL, async ({ request }) => {
        createdBody = await request.json();
        return HttpResponse.json(remoteAgent);
      }),
    );

    renderPage(<CreateA2aRemoteAgentPage />);

    const connectionSection = screen
      .getByRole("heading", { name: "Connection" })
      .closest("section");
    expect(connectionSection).not.toBeNull();
    expect(connectionSection).toContainElement(
      screen.getByRole("radiogroup", { name: "Authentication" }),
    );
    expect(
      screen.queryByRole("heading", { name: "Authentication" }),
    ).toBeNull();

    await user.type(
      screen.getByLabelText("Agent base URL"),
      remoteAgent.discoveryUrl,
    );
    await user.click(screen.getByRole("radio", { name: method }));
    expect(
      screen.getByRole("button", { name: "Check Agent Card" }),
    ).toBeDisabled();

    await user.type(screen.getByLabelText("Credential"), credential);
    await user.click(screen.getByRole("button", { name: "Connect agent" }));

    await waitFor(() => {
      expect(inspectedBody).toEqual({
        source: { type: "well_known", url: remoteAgent.discoveryUrl },
        auth: expectedAuth,
      });
      expect(createdBody).toEqual({
        source: { type: "well_known", url: remoteAgent.discoveryUrl },
        auth: expectedAuth,
        name: "Fixture Agent",
        initialGrants: [],
      });
    });
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
    expect(inspectCalls).toBe(1);
    expect(inspectedBody).toEqual({
      source: {
        type: "well_known",
        url: `${remoteAgent.discoveryUrl}/apikey`,
      },
      auth: { type: "none" },
    });
  });

  it("previews the checked Agent Card and fills empty details from it", async () => {
    const user = userEvent.setup();
    let createdBody: unknown;
    server.use(
      http.post(`${REGISTRY_URL}/inspect`, () =>
        HttpResponse.json(
          inspectionFor({
            name: "Fixture Agent",
            description: "A deterministic external agent",
            agentCard: {
              name: "Fixture Agent",
              version: "2.1.0",
              provider: { organization: "Example Org", url: "https://x.test" },
              skills: [
                {
                  id: "refunds",
                  name: "Refunds",
                  description: "Issues refunds for orders",
                },
                { id: "invoices", name: "Invoices" },
              ],
            },
          }),
        ),
      ),
      http.post(REGISTRY_URL, async ({ request }) => {
        createdBody = await request.json();
        return HttpResponse.json(remoteAgent);
      }),
    );

    renderPage(<CreateA2aRemoteAgentPage />);
    await user.click(screen.getByLabelText("Agent base URL"));
    await user.paste(remoteAgent.discoveryUrl);
    await user.click(screen.getByRole("button", { name: "Check Agent Card" }));

    const preview = await screen.findByRole("status", {
      name: "Agent Card found",
    });
    expect(preview).toHaveTextContent(
      "by Example Org · v2.1.0 · A2A 1.0 over JSONRPC",
    );
    // The description is shown once, in the prefilled field below.
    expect(preview).not.toHaveTextContent("A deterministic external agent");
    const skills = within(preview).getByRole("list", {
      name: "What this agent can do",
    });
    expect(
      within(skills)
        .getAllByRole("listitem")
        .map((item) => item.textContent),
    ).toEqual(["RefundsIssues refunds for orders", "Invoices"]);
    expect(screen.getByLabelText("Display name (optional)")).toHaveValue(
      "Fixture Agent",
    );
    expect(screen.getByLabelText("Description (optional)")).toHaveValue(
      "A deterministic external agent",
    );

    await user.click(screen.getByRole("button", { name: "Connect agent" }));
    await waitFor(() =>
      expect(createdBody).toMatchObject({
        name: "Fixture Agent",
        description: "A deterministic external agent",
      }),
    );
  });

  it("leaves out Agent Card skills and versions that add no information", async () => {
    const user = userEvent.setup();
    server.use(
      http.post(`${REGISTRY_URL}/inspect`, () =>
        HttpResponse.json(
          inspectionFor({
            name: "QA Tools",
            description: "Runs QA checks",
            agentCard: {
              name: "QA Tools",
              version: "1791292336",
              skills: [
                { id: "qa", name: "qa tools", description: "Runs QA checks" },
                { id: "lint", name: "Lint", description: "Runs QA checks" },
              ],
            },
          }),
        ),
      ),
    );

    renderPage(<CreateA2aRemoteAgentPage />);
    await user.click(screen.getByLabelText("Agent base URL"));
    await user.paste(remoteAgent.discoveryUrl);
    await user.click(screen.getByRole("button", { name: "Check Agent Card" }));

    const preview = await screen.findByRole("status", {
      name: "Agent Card found",
    });
    expect(preview).not.toHaveTextContent("1791292336");
    expect(preview).not.toHaveTextContent("Runs QA checks");
    const skills = within(preview).getByRole("list", {
      name: "What this agent can do",
    });
    expect(
      within(skills)
        .getAllByRole("listitem")
        .map((item) => item.textContent),
    ).toEqual(["Lint"]);
  });

  it("refreshes Agent Card details on recheck without overwriting user edits", async () => {
    const user = userEvent.setup();
    const cards: Record<string, { name: string; description: string | null }> =
      {
        "https://first.example.com": {
          name: "First Agent",
          description: "First description",
        },
        "https://second.example.com": {
          name: "Second Agent",
          description: "Second description",
        },
        "https://third.example.com": {
          name: "Third Agent",
          description: null,
        },
      };
    server.use(
      http.post(`${REGISTRY_URL}/inspect`, async ({ request }) => {
        const body = (await request.json()) as { source: { url: string } };
        const card = cards[body.source.url];
        return HttpResponse.json(
          inspectionFor({ ...card, agentCard: { name: card.name } }),
        );
      }),
    );

    renderPage(<CreateA2aRemoteAgentPage />);
    const baseUrlInput = screen.getByLabelText("Agent base URL");
    const nameInput = screen.getByLabelText("Display name (optional)");
    const descriptionInput = screen.getByLabelText("Description (optional)");
    const checkCard = async (url: string, expectedName: string) => {
      await user.clear(baseUrlInput);
      await user.click(baseUrlInput);
      await user.paste(url);
      await user.click(
        screen.getByRole("button", { name: "Check Agent Card" }),
      );
      expect(
        await screen.findByRole("status", { name: "Agent Card found" }),
      ).toHaveTextContent(expectedName);
    };

    // A name typed before checking is never replaced.
    await user.type(nameInput, "My Agent");
    await checkCard("https://first.example.com", "First Agent");
    expect(nameInput).toHaveValue("My Agent");
    expect(descriptionInput).toHaveValue("First description");

    // An untouched pre-filled description follows the newly checked card.
    await checkCard("https://second.example.com", "Second Agent");
    expect(nameInput).toHaveValue("My Agent");
    expect(descriptionInput).toHaveValue("Second description");

    // Clearing the name lets the card fill it; an edited description stays.
    await user.clear(nameInput);
    await user.type(descriptionInput, " (edited)");
    await checkCard("https://third.example.com", "Third Agent");
    expect(nameInput).toHaveValue("Third Agent");
    expect(descriptionInput).toHaveValue("Second description (edited)");
  });

  it("sends the starting grants chosen on the create page", async () => {
    const user = userEvent.setup();
    let createdBody: unknown;
    server.use(
      http.post(REGISTRY_URL, async ({ request }) => {
        createdBody = await request.json();
        return HttpResponse.json(remoteAgent);
      }),
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
    await user.click(
      within(
        screen.getByRole("region", {
          name: "Initial permissions for externalAgent",
        }),
      ).getByRole("button", { name: "Share with Operations" }),
    );
    await user.click(screen.getByRole("button", { name: "Connect agent" }));

    await waitFor(() =>
      expect(createdBody).toMatchObject({
        initialGrants: [
          { subject: { type: "team", id: "team-1" }, actions: ["read", "use"] },
        ],
      }),
    );
  });

  it("commits permission edits with the page's one Save", async () => {
    const user = userEvent.setup();
    let updated = false;
    server.use(
      http.get(`${REGISTRY_URL}/:id`, () => HttpResponse.json(remoteAgent)),
      http.put(`${REGISTRY_URL}/:id`, () => {
        updated = true;
        return HttpResponse.json(remoteAgent);
      }),
    );

    renderPage(<A2aRemoteAgentDetailPage id={remoteAgent.id} />);
    const permissions = await screen.findByRole("region", {
      name: "Permissions for externalAgent",
    });
    expect(
      within(permissions).queryByRole("button", { name: "Save permissions" }),
    ).toBeNull();
    const save = screen.getByRole("button", { name: "Save changes" });
    expect(save).toBeDisabled();

    await user.click(
      within(permissions).getByRole("button", { name: "Change a grant" }),
    );
    await user.click(save);

    await waitFor(() => expect(savePermissions).toHaveBeenCalledTimes(1));
    expect(updated).toBe(false);
  });

  it("lets a reader without edit grants view the agent but not change it", async () => {
    grantCapabilities([]);
    server.use(
      http.get(`${REGISTRY_URL}/:id`, () => HttpResponse.json(remoteAgent)),
    );

    renderPage(<A2aRemoteAgentDetailPage id={remoteAgent.id} />);

    expect(
      await screen.findByText(/you do not have permission to change/i),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("region", { name: "Permissions for externalAgent" }),
    ).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /More actions/ })).toBeNull();
  });

  it("prefills edit and omits unchanged source and stored credential on a details-only update", async () => {
    const user = userEvent.setup();
    let updatedBody: unknown;
    server.use(
      http.get(`${REGISTRY_URL}/:id`, () => HttpResponse.json(remoteAgent)),
      http.put(`${REGISTRY_URL}/:id`, async ({ request }) => {
        updatedBody = await request.json();
        return HttpResponse.json({ ...remoteAgent, name: "Renamed Agent" });
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
    const nameInput = screen.getByLabelText("Display name (optional)");
    await user.clear(nameInput);
    await user.type(nameInput, "Renamed Agent");
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

    await waitFor(() => expect(updatedBody).toEqual({ name: "Renamed Agent" }));
  });

  it("rechecks the saved Agent Card when the edit page opens", async () => {
    let inspectedBody: unknown;
    server.use(
      http.get(`${REGISTRY_URL}/:id`, () => HttpResponse.json(remoteAgent)),
      http.post(`${REGISTRY_URL}/inspect`, async ({ request }) => {
        inspectedBody = await request.json();
        return HttpResponse.json({
          name: "Fresh Agent Card",
          description: remoteAgent.description,
          agentCard: remoteAgent.agentCard,
          cardHash: remoteAgent.cardHash,
          selectedInterface: remoteAgent.connection.selectedInterface,
          supportedAuthTypes: [remoteAgent.connection.authType],
          selectedSecurityRequirement:
            remoteAgent.connection.securityRequirement,
        });
      }),
    );

    renderPage(
      <StrictMode>
        <A2aRemoteAgentDetailPage id={remoteAgent.id} />
      </StrictMode>,
    );

    expect(
      await screen.findByRole("status", { name: "Connection compatible" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("status", { name: "Agent Card found" }),
    ).toHaveTextContent("Fresh Agent Card");
    expect(inspectedBody).toEqual({
      source: { type: "well_known", url: remoteAgent.discoveryUrl },
      auth: { type: remoteAgent.connection.authType },
      remoteAgentId: remoteAgent.id,
    });
  });

  it("shows a fresh unavailable status when the saved Agent Card cannot be reached", async () => {
    server.use(
      http.get(`${REGISTRY_URL}/:id`, () => HttpResponse.json(remoteAgent)),
      http.post(`${REGISTRY_URL}/inspect`, () =>
        HttpResponse.json(
          {
            error: {
              message: "Unable to resolve the A2A Agent Card: fetch failed",
            },
          },
          { status: 400 },
        ),
      ),
    );

    renderPage(<A2aRemoteAgentDetailPage id={remoteAgent.id} />);

    expect(
      await screen.findByRole("alert", { name: "Agent Card unavailable" }),
    ).toHaveTextContent("Unable to resolve the A2A Agent Card: fetch failed");
    expect(
      screen.queryByRole("status", { name: "Agent Card found" }),
    ).toBeNull();
    expect(
      screen.queryByRole("status", { name: "Connection compatible" }),
    ).toBeNull();
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
        return HttpResponse.json({ ...legacyAgent, name: "Renamed Agent" });
      }),
    );

    renderPage(<A2aRemoteAgentDetailPage id={remoteAgent.id} />);

    expect(await screen.findByLabelText("Agent base URL")).toHaveValue("");
    expect(
      screen.getByText(/uses a legacy Agent Card source/i),
    ).toBeInTheDocument();
    const nameInput = screen.getByLabelText("Display name (optional)");
    await user.clear(nameInput);
    await user.type(nameInput, "Renamed Agent");
    await user.click(screen.getByRole("button", { name: "Save changes" }));

    await waitFor(() => expect(updatedBody).toEqual({ name: "Renamed Agent" }));
  });

  it("requires a credential when checking an edited base URL", async () => {
    const user = userEvent.setup();
    const inspectedBodies: unknown[] = [];
    let updatedBody: unknown;
    server.use(
      http.get(`${REGISTRY_URL}/:id`, () => HttpResponse.json(remoteAgent)),
      http.post(`${REGISTRY_URL}/inspect`, async ({ request }) => {
        inspectedBodies.push(await request.json());
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

    await screen.findByRole("status", { name: "Connection compatible" });
    expect(inspectedBodies).toHaveLength(1);
    const baseUrlInput = await screen.findByLabelText("Agent base URL");
    await user.clear(baseUrlInput);
    await user.click(baseUrlInput);
    await user.paste(`${remoteAgent.discoveryUrl}/replacement`);
    expect(screen.getByLabelText("Credential")).toHaveValue("");
    expect(
      screen.getByRole("button", { name: "Check Agent Card" }),
    ).toBeDisabled();
    const saveButton = screen.getByRole("button", { name: "Save changes" });
    expect(saveButton).toBeEnabled();
    await user.click(saveButton);
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Enter a credential when changing authentication.",
    );
    expect(inspectedBodies).toHaveLength(1);
    expect(updatedBody).toBeUndefined();
    await user.type(
      screen.getByLabelText("Credential"),
      "replacement-bearer-token",
    );
    await user.click(saveButton);

    await waitFor(() => {
      expect(inspectedBodies).toContainEqual({
        source: {
          type: "well_known",
          url: `${remoteAgent.discoveryUrl}/replacement`,
        },
        auth: {
          type: "bearer",
          credential: "replacement-bearer-token",
        },
      });
      expect(updatedBody).toEqual({
        source: {
          type: "well_known",
          url: `${remoteAgent.discoveryUrl}/replacement`,
        },
        auth: {
          type: "bearer",
          credential: "replacement-bearer-token",
        },
      });
    });
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
    let createCalls = 0;
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
      http.post(REGISTRY_URL, () => {
        createCalls += 1;
        return HttpResponse.json(remoteAgent);
      }),
    );

    renderPage(<CreateA2aRemoteAgentPage />);
    await user.type(
      screen.getByLabelText("Agent base URL"),
      remoteAgent.discoveryUrl,
    );
    await user.click(screen.getByRole("button", { name: "Connect agent" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Agent Card must accept the text/plain input mode",
    );
    expect(createCalls).toBe(0);
    expect(screen.getByRole("button", { name: "Connect agent" })).toBeEnabled();
  });

  it("shows a read-only detail without exposing or replacing credentials", async () => {
    grantCapabilities([]);
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

  it("warns assigned agents before deletion from the detail page", async () => {
    const user = userEvent.setup();
    server.use(
      http.get(`${REGISTRY_URL}/:id`, () => HttpResponse.json(remoteAgent)),
    );

    renderPage(<A2aRemoteAgentDetailPage id={remoteAgent.id} />);
    await screen.findByLabelText("Agent base URL");
    await user.click(
      screen.getByRole("button", {
        name: `More actions ${remoteAgent.name}`,
      }),
    );
    await user.click(screen.getByRole("menuitem", { name: "Delete" }));

    const dialog = screen.getByRole("dialog", {
      name: "Remove external A2A agent?",
    });
    expect(dialog).toHaveTextContent(
      "currently assigned as a subagent to 2 agents",
    );
    expect(dialog).toHaveTextContent(
      "those agents will no longer be able to delegate to it",
    );
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

function inspectionFor(card: {
  name: string;
  description: string | null;
  agentCard: Record<string, unknown>;
}) {
  return {
    ...card,
    cardHash: remoteAgent.cardHash,
    selectedInterface: remoteAgent.connection.selectedInterface,
    supportedAuthTypes: ["none"],
    selectedSecurityRequirement: null,
  };
}

function renderPage(children: React.ReactNode) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  render(
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>,
  );
}

function grantCapabilities(actions: Array<"update" | "delete">) {
  vi.mocked(useScopedCapabilities).mockReturnValue({
    data: actions.map((action) => ({
      organizationId: "org-1",
      resource: "externalAgent",
      scope: remoteAgent.id,
      action,
    })),
    isPending: false,
  } as unknown as ReturnType<typeof useScopedCapabilities>);
}
