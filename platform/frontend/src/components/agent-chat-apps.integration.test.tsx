import { archestraApiClient } from "@archestra/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, within } from "@testing-library/react";
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
import { authClient } from "@/lib/clients/auth/auth-client";
import { AgentChatAppsEditor } from "./agent-chat-apps";

vi.mock("@/lib/clients/auth/auth-client");

const API_ORIGIN = "http://localhost:9000";
const server = setupServer();

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
beforeEach(() => {
  archestraApiClient.setConfig({ baseUrl: API_ORIGIN });
  vi.mocked(authClient.getSession).mockResolvedValue({
    data: { user: { id: "user-1" } },
    error: null,
  } as Awaited<ReturnType<typeof authClient.getSession>>);
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  server.use(
    http.get(`${API_ORIGIN}/api/user/permissions`, () =>
      HttpResponse.json({
        agent: ["read", "update"],
        agentTrigger: ["read", "create", "update"],
      }),
    ),
    http.get(`${API_ORIGIN}/api/config`, () =>
      HttpResponse.json({
        features: {
          chatopsTelegramEnabled: false,
          incomingEmail: { enabled: false },
        },
      }),
    ),
    http.get(`${API_ORIGIN}/api/config/public`, () => HttpResponse.json({})),
    http.get(`${API_ORIGIN}/api/organization`, () => HttpResponse.json({})),
    http.get(`${API_ORIGIN}/api/organization/appearance-settings`, () =>
      HttpResponse.json({}),
    ),
    http.get(`${API_ORIGIN}/api/chatops/status`, () =>
      HttpResponse.json({
        providers: [{ id: "slack", configured: true }],
      }),
    ),
    http.get(`${API_ORIGIN}/api/chatops/bindings`, () =>
      HttpResponse.json({
        data: [
          {
            id: "binding-1",
            provider: "slack",
            channelId: "channel-1",
            channelName: "support",
            workspaceName: "Example workspace",
            agentId: "source-agent",
            isDm: false,
          },
        ],
        pagination: { hasNext: false },
      }),
    ),
  );
});
afterEach(() => server.resetHandlers());
afterAll(() => {
  server.close();
  archestraApiClient.setConfig({ baseUrl: "" });
});

describe("Channel takeover agent names", () => {
  it.each([
    { name: "Help Desk", builtIn: true },
    { name: "Escalation Coordinator", builtIn: false },
  ])("resolves $name in the staged row and confirmation", async (source) => {
    server.use(
      http.get(`${API_ORIGIN}/api/agents/all`, ({ request }) => {
        const excludesBuiltIn =
          new URL(request.url).searchParams.get("excludeBuiltIn") === "true";
        return HttpResponse.json(
          source.builtIn && excludesBuiltIn
            ? []
            : [{ id: "source-agent", ...source, icon: "🔎" }],
        );
      }),
    );
    const user = userEvent.setup();
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    render(
      <QueryClientProvider client={queryClient}>
        <AgentChatAppsEditor
          subject={{ id: "target-agent", name: "New Responder", scope: "org" }}
          emailAgent={null}
        />
      </QueryClientProvider>,
    );

    await user.click(
      await screen.findByRole("button", { name: "Add channel" }),
    );
    await user.click(
      await screen.findByRole("button", {
        name: `supportAnswered by ${source.name}`,
      }),
    );
    expect(
      screen.getByRole("listitem", { name: /support$/ }),
    ).toHaveTextContent(`Takes over from ${source.name} agent`);
    await user.click(
      screen.getByRole("button", { name: "Save channel changes" }),
    );
    const dialog = await screen.findByRole("dialog", {
      name: "Change the agent for this channel?",
    });
    const changes = within(dialog).getByText("Answers now").parentElement;
    expect(changes).toHaveTextContent(
      new RegExp(
        `Answers now.*Answers after saving.*${source.name}.*New Responder`,
      ),
    );
    expect(within(dialog).queryByText("another agent")).not.toBeInTheDocument();
    await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
    queryClient.clear();
  });
});
