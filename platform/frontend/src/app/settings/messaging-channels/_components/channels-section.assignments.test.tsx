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
import { useSession } from "@/lib/auth/auth.query";
import { ChannelsSection } from "./channels-section";
import type { ProviderConfig } from "./types";

const API_ORIGIN = "http://localhost:9000";
const CURRENT_AGENT_ID = "11111111-1111-4111-8111-111111111111";
const TARGET_AGENT_ID = "22222222-2222-4222-8222-222222222222";
const PERSONAL_AGENT_ID = "33333333-3333-4333-8333-333333333333";
const BINDING_ID = "44444444-4444-4444-8444-444444444444";
const SECOND_BINDING_ID = "55555555-5555-4555-8555-555555555555";

vi.mock("next/navigation");
vi.mock("sonner");
vi.mock("@/lib/auth/auth.query");
vi.mock("@/lib/hooks/use-app-name");

const providerConfig: ProviderConfig = {
  provider: "slack",
  providerLabel: "Slack",
  providerIcon: "/icons/slack.png",
  supportsAnswerAll: true,
  docsUrl: null,
  slashCommand: "/select-agent",
  buildDeepLink: () => null,
};

const server = setupServer();
let bulkRequests: Array<Record<string, unknown>>;
let bindingRequestCount: number;

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
    configurable: true,
    value: vi.fn(),
  });
  vi.mocked(useRouter).mockReturnValue({
    push: vi.fn(),
  } as unknown as ReturnType<typeof useRouter>);
  vi.mocked(usePathname).mockReturnValue("/settings/messaging-channels/slack");
  vi.mocked(useSearchParams).mockReturnValue(
    new URLSearchParams() as unknown as ReturnType<typeof useSearchParams>,
  );
  vi.mocked(useSession).mockReturnValue({
    data: { user: { id: "user-1", email: "admin@example.com" } },
  } as unknown as ReturnType<typeof useSession>);
  bulkRequests = [];
  bindingRequestCount = 0;
  archestraApiClient.setConfig({ baseUrl: API_ORIGIN });

  server.use(
    http.get(`${API_ORIGIN}/api/chatops/bindings`, () => {
      bindingRequestCount += 1;
      return HttpResponse.json({
        data: [
          {
            id: BINDING_ID,
            organizationId: "org-1",
            provider: "slack",
            channelId: "C1",
            workspaceId: "W1",
            channelName: "general",
            workspaceName: "Workspace",
            isDm: false,
            answerAllMessages: false,
            channelInstructions: null,
            dmOwnerEmail: null,
            agentId: CURRENT_AGENT_ID,
            createdAt: "2026-01-01T00:00:00.000Z",
            updatedAt: "2026-01-01T00:00:00.000Z",
          },
          {
            id: SECOND_BINDING_ID,
            organizationId: "org-1",
            provider: "slack",
            channelId: "C2",
            workspaceId: "W1",
            channelName: "operations",
            workspaceName: "Workspace",
            isDm: false,
            answerAllMessages: false,
            channelInstructions: null,
            dmOwnerEmail: null,
            agentId: CURRENT_AGENT_ID,
            createdAt: "2026-01-01T00:00:00.000Z",
            updatedAt: "2026-01-01T00:00:00.000Z",
          },
        ],
        pagination: { total: 2, limit: 20, offset: 0 },
        counts: { configured: 2, unassigned: 0 },
        workspaces: [{ id: "W1", name: "Workspace" }],
        hasDmBinding: true,
        workspacesWithUnmentionedTraffic: [],
      });
    }),
    http.get(`${API_ORIGIN}/api/chatops/status`, () =>
      HttpResponse.json({
        providers: [{ id: "slack", displayName: "Slack", configured: true }],
      }),
    ),
    http.get(`${API_ORIGIN}/api/agents/all`, () =>
      HttpResponse.json([
        {
          id: CURRENT_AGENT_ID,
          name: "Current Agent",
          scope: "org",
          authorId: null,
        },
        {
          id: TARGET_AGENT_ID,
          name: "Target Agent",
          scope: "org",
          authorId: null,
        },
        {
          id: PERSONAL_AGENT_ID,
          name: "Personal Agent",
          scope: "personal",
          authorId: "user-1",
        },
      ]),
    ),
    http.patch(`${API_ORIGIN}/api/chatops/bindings`, async ({ request }) => {
      bulkRequests.push((await request.json()) as Record<string, unknown>);
      return HttpResponse.json([]);
    }),
  );
});

afterEach(() => server.resetHandlers());

afterAll(() => {
  server.close();
  archestraApiClient.setConfig({ baseUrl: "" });
});

function renderTable() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <ChannelsSection providerConfig={providerConfig} />
    </QueryClientProvider>,
  );
}

async function chooseTargetAgent(user: ReturnType<typeof userEvent.setup>) {
  const [agentButton] = await screen.findAllByRole("button", {
    name: /Current Agent/,
  });
  await user.click(agentButton);
  await user.click(screen.getByRole("option", { name: /Target Agent/ }));
}

describe("channels table - assignments", () => {
  it("names both agents and does not mutate when a reassignment is cancelled", async () => {
    const user = userEvent.setup();
    renderTable();

    await chooseTargetAgent(user);

    const dialog = await screen.findByRole("dialog", {
      name: "Move channel to Target Agent?",
    });
    expect(dialog).toHaveTextContent(
      "Each messaging channel can be assigned to only one agent at a time. New messages will go to Target Agent. Current Agent will stop receiving messages from this channel.",
    );
    expect(bulkRequests).toEqual([]);

    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(bulkRequests).toEqual([]);
  });

  it("uses the guarded bulk request after reassignment is confirmed", async () => {
    const user = userEvent.setup();
    renderTable();

    await chooseTargetAgent(user);
    await user.click(
      await screen.findByRole("button", { name: "Move channel" }),
    );

    await waitFor(() => {
      expect(bulkRequests).toEqual([
        {
          ids: [BINDING_ID],
          agentId: TARGET_AGENT_ID,
          expectedAgentAssignments: [
            { id: BINDING_ID, agentId: CURRENT_AGENT_ID },
          ],
        },
      ]);
    });
  });

  it("requires confirmation before a bulk reassignment", async () => {
    const user = userEvent.setup();
    renderTable();

    await user.click(
      await screen.findByRole("checkbox", { name: "Select all" }),
    );
    await user.click(screen.getByRole("button", { name: "Bulk Assign" }));
    await user.click(screen.getByRole("option", { name: /Target Agent/ }));

    expect(
      await screen.findByRole("dialog", {
        name: "Move 2 channels to Target Agent?",
      }),
    ).toHaveTextContent(
      "Each messaging channel can be assigned to only one agent at a time. New messages will go to Target Agent. Current Agent will stop receiving messages from these channels.",
    );
    expect(bulkRequests).toEqual([]);
  });

  it("shows personal agents as disabled options for channels", async () => {
    const user = userEvent.setup();
    renderTable();

    const [agentButton] = await screen.findAllByRole("button", {
      name: /Current Agent/,
    });
    await user.click(agentButton);

    const personalOption = screen.getByRole("option", {
      name: /Personal Agent/,
    });
    expect(personalOption).toHaveAttribute("data-disabled", "true");
    expect(personalOption).toHaveTextContent(
      "Personal agents can only receive direct messages.",
    );
  });

  it("refreshes stale assignments after a guarded move fails", async () => {
    server.use(
      http.patch(`${API_ORIGIN}/api/chatops/bindings`, () =>
        HttpResponse.json(
          { error: { message: "Channel assignments changed." } },
          { status: 409 },
        ),
      ),
    );
    const user = userEvent.setup();
    renderTable();

    await chooseTargetAgent(user);
    await user.click(
      await screen.findByRole("button", { name: "Move channel" }),
    );

    await waitFor(() => expect(bindingRequestCount).toBeGreaterThan(1));
    expect(
      screen.queryByRole("dialog", {
        name: "Move channel to Personal Agent?",
      }),
    ).not.toBeInTheDocument();
  });

  it("allows a personal agent when only a direct message is selected", async () => {
    server.use(
      http.get(`${API_ORIGIN}/api/chatops/bindings`, () =>
        HttpResponse.json({
          data: [],
          pagination: { total: 0, limit: 20, offset: 0 },
          counts: { configured: 0, unassigned: 0 },
          workspaces: [],
          hasDmBinding: false,
          workspacesWithUnmentionedTraffic: [],
        }),
      ),
    );
    const user = userEvent.setup();
    renderTable();

    await user.click(
      await screen.findByRole("checkbox", { name: "Select Direct Message" }),
    );
    await user.click(screen.getByRole("button", { name: "Bulk Assign" }));

    expect(
      screen.getByRole("option", { name: /Personal Agent/ }),
    ).not.toHaveAttribute("data-disabled", "true");
  });

  it("labels another user's DM accurately and disables personal agents", async () => {
    server.use(
      http.get(`${API_ORIGIN}/api/chatops/bindings`, () =>
        HttpResponse.json({
          data: [
            {
              id: BINDING_ID,
              organizationId: "org-1",
              provider: "slack",
              channelId: "D-other",
              workspaceId: "T1",
              channelName: "Direct message",
              workspaceName: "Workspace",
              isDm: true,
              answerAllMessages: false,
              channelInstructions: null,
              dmOwnerEmail: "another-user@example.com",
              agentId: CURRENT_AGENT_ID,
              createdAt: "2026-01-01T00:00:00.000Z",
              updatedAt: "2026-01-01T00:00:00.000Z",
            },
          ],
          pagination: { total: 1, limit: 20, offset: 0 },
          counts: { configured: 1, unassigned: 0 },
          workspaces: [{ id: "T1", name: "Workspace" }],
          hasDmBinding: true,
          workspacesWithUnmentionedTraffic: [],
        }),
      ),
    );
    const user = userEvent.setup();
    renderTable();

    expect(
      await screen.findByText("Direct Message (another-user@example.com)"),
    ).toBeVisible();
    await user.click(screen.getByRole("button", { name: /Current Agent/ }));

    const personalOption = screen.getByRole("option", {
      name: /Personal Agent/,
    });
    expect(personalOption).toHaveAttribute("data-disabled", "true");
    expect(personalOption).toHaveTextContent(
      "Personal agents can only be assigned to your own direct messages.",
    );
  });
});
