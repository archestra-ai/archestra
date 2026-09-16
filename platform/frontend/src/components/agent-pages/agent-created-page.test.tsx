import { archestraApiClient, type archestraApiTypes } from "@archestra/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { HttpResponse, http } from "msw";
import { setupServer } from "msw/node";
import { usePathname, useSearchParams } from "next/navigation";
import { toast } from "sonner";
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
import { useAppName } from "@/lib/hooks/use-app-name";
import { useOrganization } from "@/lib/organization.query";
import { AgentCreatedPage } from "./agent-created-page";

vi.mock("next/navigation");
vi.mock("sonner");
vi.mock("@/lib/clients/auth/auth-client");
vi.mock("@/lib/hooks/use-app-name");
vi.mock("@/lib/organization.query");

const API_ORIGIN = "http://localhost:9000";
const AGENT_ID = "new-agent";
const EMAIL_URL = `${API_ORIGIN}/api/agents/${AGENT_ID}/email-address`;
const BINDINGS_URL = `${API_ORIGIN}/api/chatops/bindings`;
const CONFIG_URL = `${API_ORIGIN}/api/config`;
const PERMISSIONS_URL = `${API_ORIGIN}/api/user/permissions`;
const agent = {
  id: AGENT_ID,
  name: "Release Assistant",
  agentType: "agent",
  incomingEmailEnabled: true,
  teams: [],
  scope: "personal",
  authorId: "user-1",
} satisfies Pick<
  archestraApiTypes.GetAgentResponses["200"],
  | "id"
  | "name"
  | "agentType"
  | "incomingEmailEnabled"
  | "teams"
  | "scope"
  | "authorId"
>;
const email = {
  providerEnabled: true,
  agentIncomingEmailEnabled: true,
  emailAddress: "agents+release@example.com",
  agentSecurityMode: "private",
  agentAllowedDomain: null,
} satisfies archestraApiTypes.GetAgentEmailAddressResponses["200"];
type Binding =
  archestraApiTypes.ListChatOpsBindingsResponses["200"]["data"][number];

const server = setupServer();

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
beforeEach(() => {
  vi.clearAllMocks();
  archestraApiClient.setConfig({ baseUrl: API_ORIGIN });
  vi.mocked(usePathname).mockReturnValue(`/agents/${AGENT_ID}/created`);
  vi.mocked(useSearchParams).mockReturnValue(
    new URLSearchParams() as ReturnType<typeof useSearchParams>,
  );
  vi.mocked(useAppName).mockReturnValue("Example AI");
  vi.mocked(authClient.getSession).mockResolvedValue({
    data: { user: { id: "user-1" } },
    error: null,
  } as Awaited<ReturnType<typeof authClient.getSession>>);
  vi.mocked(useOrganization).mockReturnValue({
    data: { messagingChannelOverrides: null },
  } as unknown as ReturnType<typeof useOrganization>);
  server.use(
    http.get(CONFIG_URL, () =>
      HttpResponse.json({ features: { chatopsTelegramEnabled: false } }),
    ),
    http.get(PERMISSIONS_URL, () =>
      HttpResponse.json({
        chat: ["read", "create"],
        agentTrigger: ["read"],
        llmProviderApiKey: ["read"],
      }),
    ),
    http.get(`${API_ORIGIN}/api/agents/${AGENT_ID}`, () =>
      HttpResponse.json(agent),
    ),
    http.get(`${API_ORIGIN}/api/agents/${AGENT_ID}/runtime/preflight`, () =>
      HttpResponse.json({
        ready: true,
        configured: [],
        missing: [],
        misconfigured: [],
        incompatible: null,
      }),
    ),
    http.get(EMAIL_URL, () => HttpResponse.json(email)),
    http.get(BINDINGS_URL, () => HttpResponse.json(bindingPage([]))),
  );
});
afterEach(() => server.resetHandlers());
afterAll(() => {
  server.close();
  archestraApiClient.setConfig({ baseUrl: "" });
});

describe("AgentCreatedPage", () => {
  it("connects Claude from the saved page and resolves setup live", async () => {
    const user = userEvent.setup();
    let connected = false;
    const accountUrl = `${API_ORIGIN}/api/agents/${AGENT_ID}/runtime/claude-code/account`;
    server.use(
      http.get(`${API_ORIGIN}/api/agents/${AGENT_ID}`, () =>
        HttpResponse.json({
          ...agent,
          runtime: {
            command: ["archestra-claude-code"],
            claudeCode: { authentication: "subscription" },
          },
        }),
      ),
      http.get(`${API_ORIGIN}/api/agents/${AGENT_ID}/runtime/preflight`, () =>
        HttpResponse.json({
          ready: connected,
          configured: [],
          missing: connected
            ? []
            : [{ key: "CLAUDE_CODE_ACCOUNT", label: "Claude account" }],
          misconfigured: [],
          incompatible: null,
        }),
      ),
      http.get(accountUrl, () =>
        HttpResponse.json({ state: connected ? "connected" : "disconnected" }),
      ),
      http.post(accountUrl, () => {
        connected = true;
        return HttpResponse.json({ state: "connected" });
      }),
    );
    renderPage();
    expect(await screen.findByText("Before this agent can run")).toBeVisible();
    expect(screen.queryByText("Ready to run.")).toBeNull();
    await user.click(await screen.findByRole("button", { name: "Sign in" }));
    await user.click(
      screen.getByRole("button", { name: "Sign in with Claude" }),
    );
    expect(await screen.findByText("Ready to run.")).toBeVisible();
    expect(screen.getByText("Connect your Claude account")).toBeVisible();
    expect(screen.getByText("Done")).toBeVisible();
  });

  it("waits for preflight and exposes missing, misconfigured, and incompatible setup together", async () => {
    let finishCheck = () => {};
    const pendingCheck = new Promise<void>((resolve) => {
      finishCheck = resolve;
    });
    server.use(
      http.get(`${API_ORIGIN}/api/agents/${AGENT_ID}`, () =>
        HttpResponse.json({ ...agent, runtime: { command: ["custom-agent"] } }),
      ),
      http.get(
        `${API_ORIGIN}/api/agents/${AGENT_ID}/runtime/preflight`,
        async () => {
          await pendingCheck;
          return HttpResponse.json({
            ready: false,
            configured: [],
            missing: [{ key: "TOKEN", label: "Service token" }],
            misconfigured: [{ key: "SECRET", label: "Shared connection" }],
            incompatible:
              "The selected model does not support this inference API.",
          });
        },
      ),
    );
    renderPage();
    expect(await screen.findByText("Checking agent setup…")).toBeVisible();
    expect(screen.queryByText("Ready to run.")).toBeNull();
    finishCheck();
    expect(
      await screen.findByText(
        "Provide a value for Service token, or connect Service token",
      ),
    ).toBeVisible();
    expect(
      screen.getByText(
        "Provide a value for Shared connection, or connect Shared connection",
      ),
    ).toBeVisible();
    expect(
      screen.getByText(
        "The selected model does not support this inference API.",
      ),
    ).toBeVisible();
    expect(screen.getByRole("link", { name: "Review model" })).toHaveAttribute(
      "href",
      `/agents/${AGENT_ID}?section=general`,
    );
    expect(screen.queryByText("Ready to run.")).toBeNull();
  });

  it("does not claim readiness when preflight fails and recovers on retry", async () => {
    let failed = true;
    server.use(
      http.get(`${API_ORIGIN}/api/agents/${AGENT_ID}`, () =>
        HttpResponse.json({ ...agent, runtime: { command: ["custom-agent"] } }),
      ),
      http.get(`${API_ORIGIN}/api/agents/${AGENT_ID}/runtime/preflight`, () =>
        failed
          ? apiError()
          : HttpResponse.json({
              ready: true,
              configured: [],
              missing: [],
              misconfigured: [],
              incompatible: null,
            }),
      ),
    );
    renderPage();
    expect(await screen.findByText("Cannot check agent setup")).toBeVisible();
    expect(screen.queryByText("Ready to run.")).toBeNull();
    failed = false;
    await userEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByText("Ready to run.")).toBeVisible();
  });

  it("requires the selected Codex key to be a ChatGPT subscription even when preflight is ready", async () => {
    server.use(
      http.get(`${API_ORIGIN}/api/agents/${AGENT_ID}`, () =>
        HttpResponse.json({
          ...agent,
          llmApiKeyId: "api-key",
          runtime: { command: ["archestra-codex"] },
        }),
      ),
      http.get(`${API_ORIGIN}/api/llm-provider-api-keys/available`, () =>
        HttpResponse.json([
          { id: "api-key", subscriptionKind: null },
          {
            id: "subscription",
            subscriptionKind: "chatgpt",
            scope: "personal",
          },
        ]),
      ),
    );
    renderPage();
    expect(
      await screen.findByText("Select a ChatGPT subscription for this agent"),
    ).toBeVisible();
    expect(screen.queryByText("Ready to run.")).toBeNull();
  });

  it("requires the caller's own subscription when an agent pins someone else's ChatGPT key", async () => {
    server.use(
      http.get(`${API_ORIGIN}/api/agents/${AGENT_ID}`, () =>
        HttpResponse.json({
          ...agent,
          llmApiKeyId: "pinned-key",
          runtime: { command: ["archestra-codex"] },
        }),
      ),
      http.get(`${API_ORIGIN}/api/llm-provider-api-keys/available`, () =>
        HttpResponse.json([
          {
            id: "pinned-key",
            subscriptionKind: "chatgpt",
            scope: "personal",
            isAgentKey: true,
          },
        ]),
      ),
    );
    renderPage();
    expect(
      await screen.findByText("Connect your own ChatGPT subscription"),
    ).toBeVisible();
    expect(screen.getByRole("link", { name: "Sign in" })).toHaveAttribute(
      "href",
      "/llm/model-providers?connect=chatgpt",
    );
    expect(screen.getByRole("link", { name: "Sign in" })).toHaveAttribute(
      "target",
      "_blank",
    );
    expect(screen.queryByText("Ready to run.")).toBeNull();
  });

  it("accepts a pinned subscription when the caller also has their own personal subscription", async () => {
    server.use(
      http.get(`${API_ORIGIN}/api/agents/${AGENT_ID}`, () =>
        HttpResponse.json({
          ...agent,
          llmApiKeyId: "pinned-key",
          runtime: { command: ["archestra-codex"] },
        }),
      ),
      http.get(`${API_ORIGIN}/api/llm-provider-api-keys/available`, () =>
        HttpResponse.json([
          {
            id: "pinned-key",
            subscriptionKind: "chatgpt",
            scope: "personal",
            isAgentKey: true,
          },
          {
            id: "my-key",
            subscriptionKind: "chatgpt",
            scope: "personal",
            isAgentKey: false,
          },
        ]),
      ),
    );
    renderPage();
    expect(await screen.findByText("Ready to run.")).toBeVisible();
    expect(
      screen.queryByText("Connect your own ChatGPT subscription"),
    ).toBeNull();
  });

  it.each([
    "denied",
    "failed",
  ])("retains runtime setup when subscription verification is %s", async (failure) => {
    const readKeys = vi.fn();
    server.use(
      http.get(PERMISSIONS_URL, () =>
        HttpResponse.json({
          chat: ["read", "create"],
          agentTrigger: ["read"],
          llmProviderApiKey: failure === "denied" ? [] : ["read"],
        }),
      ),
      http.get(`${API_ORIGIN}/api/agents/${AGENT_ID}`, () =>
        HttpResponse.json({
          ...agent,
          llmApiKeyId: "pinned-key",
          runtime: { command: ["archestra-codex"] },
        }),
      ),
      http.get(`${API_ORIGIN}/api/agents/${AGENT_ID}/runtime/preflight`, () =>
        HttpResponse.json({
          ready: false,
          configured: [],
          missing: [{ key: "TOKEN", label: "Service token" }],
          misconfigured: [],
          incompatible: null,
        }),
      ),
      http.get(`${API_ORIGIN}/api/llm-provider-api-keys/available`, () => {
        readKeys();
        return apiError();
      }),
    );
    renderPage();
    expect(
      await screen.findByText(/Subscription verification is unavailable/),
    ).toBeVisible();
    expect(
      screen.getByText(
        "Provide a value for Service token, or connect Service token",
      ),
    ).toBeVisible();
    expect(screen.queryByText("Ready to run.")).toBeNull();
    if (failure === "denied") expect(readKeys).not.toHaveBeenCalled();
    else expect(readKeys).toHaveBeenCalledOnce();
  });

  it("summarizes the saved email and only channels assigned to this agent", async () => {
    server.use(
      http.get(BINDINGS_URL, () =>
        HttpResponse.json(
          bindingPage([
            binding({ id: "release", channelName: "Release planning" }),
            binding({
              id: "dm",
              provider: "ms-teams",
              isDm: true,
              dmOwnerEmail: "author@example.com",
            }),
            binding({
              id: "other",
              agentId: "other-agent",
              channelName: "Another agent's channel",
            }),
            binding({
              id: "unassigned",
              agentId: null,
              channelName: "Unassigned channel",
            }),
          ]),
        ),
      ),
    );

    renderPage();
    expect(
      await screen.findByRole("heading", { name: agent.name }),
    ).toBeVisible();
    expect(
      await screen.findByRole("link", { name: email.emailAddress }),
    ).toHaveAttribute("href", `mailto:${email.emailAddress}`);
    expect(await screen.findByText("Release planning")).toBeVisible();
    expect(
      screen.getByText("Direct message (author@example.com)"),
    ).toBeVisible();
    expect(screen.getByText("Slack")).toBeVisible();
    expect(screen.queryByText("Another agent's channel")).toBeNull();
    expect(screen.queryByText("Unassigned channel")).toBeNull();
    expect(screen.getByRole("link", { name: "Chat" })).toHaveAttribute(
      "href",
      `/chat?agentId=${AGENT_ID}`,
    );
    expect(screen.getByRole("link", { name: "View agent" })).toHaveAttribute(
      "href",
      `/agents/${AGENT_ID}`,
    );
  });

  it.each([
    { providerEnabled: false, agentIncomingEmailEnabled: true },
    { providerEnabled: true, agentIncomingEmailEnabled: false },
  ])("omits inactive email and explains an empty channel list (%j)", async (settings) => {
    server.use(
      http.get(EMAIL_URL, () => HttpResponse.json({ ...email, ...settings })),
    );
    renderPage();
    expect(
      await screen.findByText(
        "No messaging channels are configured for this agent.",
      ),
    ).toBeVisible();
    expect(screen.queryByRole("region", { name: "Email" })).toBeNull();
    expect(screen.getByRole("link", { name: "Chat" })).toBeVisible();
  });

  it("loads later pages before reporting that no channels are configured", async () => {
    const offsets: string[] = [];
    server.use(
      http.get(BINDINGS_URL, ({ request }) => {
        const offset = new URL(request.url).searchParams.get("offset") ?? "0";
        offsets.push(offset);
        return HttpResponse.json(
          offset === "0"
            ? bindingPage([binding({ agentId: "other-agent" })], true)
            : bindingPage([binding({ channelName: "Later-page channel" })]),
        );
      }),
    );
    renderPage();
    expect(await screen.findByText("Later-page channel")).toBeVisible();
    expect(offsets).toEqual(["0", "100"]);
    expect(
      screen.queryByText(
        "No messaging channels are configured for this agent.",
      ),
    ).toBeNull();
  });

  it("waits for saved assignments to replace the wizard's cached empty list", async () => {
    const queryClient = createQueryClient();
    queryClient.setQueryData(["chatops", "bindings", "all"], {
      pages: [bindingPage([])],
      pageParams: [0],
    });
    let finishRefresh = () => {};
    const refresh = new Promise<void>((resolve) => {
      finishRefresh = resolve;
    });
    server.use(
      http.get(BINDINGS_URL, async () => {
        await refresh;
        return HttpResponse.json(bindingPage([binding()]));
      }),
    );
    renderPage(queryClient);
    expect(
      await screen.findByRole("heading", { name: agent.name }),
    ).toBeVisible();
    expect(
      screen.queryByText(
        "No messaging channels are configured for this agent.",
      ),
    ).toBeNull();
    finishRefresh();
    expect(await screen.findByText("Release planning")).toBeVisible();
  });

  it("retries failed channel and email reads without presenting them as unconfigured", async () => {
    const user = userEvent.setup();
    let bindingsFail = true;
    let emailFails = true;
    server.use(
      http.get(BINDINGS_URL, () =>
        bindingsFail ? apiError() : HttpResponse.json(bindingPage([binding()])),
      ),
      http.get(EMAIL_URL, () =>
        emailFails ? apiError() : HttpResponse.json(email),
      ),
    );
    renderPage();
    expect(
      await screen.findByText("Cannot load messaging channels"),
    ).toBeVisible();
    expect(
      await screen.findByText("Cannot load the agent's email address"),
    ).toBeVisible();
    expect(
      screen.queryByText(
        "No messaging channels are configured for this agent.",
      ),
    ).toBeNull();
    expect(toast.error).not.toHaveBeenCalled();
    expect(screen.getByRole("link", { name: "Chat" })).toBeVisible();
    bindingsFail = false;
    emailFails = false;
    for (const button of screen.getAllByRole("button", { name: "Retry" })) {
      await user.click(button);
    }
    expect(await screen.findByText("Release planning")).toBeVisible();
    expect(
      await screen.findByRole("link", { name: email.emailAddress }),
    ).toBeVisible();
  });

  it("does not request channel assignments without read permission", async () => {
    const readBindings = vi.fn();
    server.use(
      http.get(PERMISSIONS_URL, () =>
        HttpResponse.json({ chat: ["read", "create"] }),
      ),
      http.get(BINDINGS_URL, () => {
        readBindings();
        return HttpResponse.json(bindingPage([]));
      }),
    );
    renderPage();
    expect(
      await screen.findByText(
        "You do not have permission to view messaging channels.",
      ),
    ).toBeVisible();
    expect(readBindings).not.toHaveBeenCalled();
    expect(screen.getByRole("link", { name: "Chat" })).toBeVisible();
  });

  it.each([
    { chat: [] },
    { chat: ["read"] },
    { chat: ["create"] },
  ])("keeps the summary accessible without offering Chat when chat permissions are %j", async ({
    chat,
  }) => {
    server.use(
      http.get(PERMISSIONS_URL, () =>
        HttpResponse.json({
          agent: ["create", "read"],
          chat,
          agentTrigger: ["read"],
        }),
      ),
    );
    renderPage();
    expect(
      await screen.findByText(
        "No messaging channels are configured for this agent.",
      ),
    ).toBeVisible();
    expect(screen.getByRole("link", { name: "View agent" })).toBeVisible();
    expect(screen.queryByRole("link", { name: "Chat" })).toBeNull();
    expect(screen.queryByText(/Open a chat to start/)).toBeNull();
  });

  it("retries a failed permission read instead of treating it as denied access", async () => {
    const user = userEvent.setup();
    let permissionsFail = true;
    server.use(
      http.get(PERMISSIONS_URL, () =>
        permissionsFail
          ? apiError()
          : HttpResponse.json({
              chat: ["read", "create"],
              agentTrigger: ["read"],
            }),
      ),
      http.get(BINDINGS_URL, () => HttpResponse.json(bindingPage([binding()]))),
    );
    renderPage();
    expect(
      await screen.findByText("Cannot load your permissions"),
    ).toBeVisible();
    expect(
      screen.queryByText(
        "You do not have permission to view messaging channels.",
      ),
    ).toBeNull();
    expect(screen.queryByRole("link", { name: "Chat" })).toBeNull();
    expect(screen.getByRole("link", { name: "View agent" })).toBeVisible();
    expect(toast.error).not.toHaveBeenCalled();
    permissionsFail = false;
    await user.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByText("Release planning")).toBeVisible();
    expect(screen.getByRole("link", { name: "Chat" })).toBeVisible();
  });

  it("stops at a failed later channel page and recovers on Retry", async () => {
    const user = userEvent.setup();
    let laterPageFails = true;
    const offsets: string[] = [];
    server.use(
      http.get(BINDINGS_URL, ({ request }) => {
        const offset = new URL(request.url).searchParams.get("offset") ?? "0";
        offsets.push(offset);
        if (offset === "0") {
          return HttpResponse.json(
            bindingPage([binding({ agentId: "other-agent" })], true),
          );
        }
        return laterPageFails
          ? apiError()
          : HttpResponse.json(
              bindingPage([binding({ channelName: "Recovered channel" })]),
            );
      }),
    );
    renderPage();
    expect(
      await screen.findByText("Cannot load messaging channels"),
    ).toBeVisible();
    expect(offsets).toEqual(["0", "100"]);
    expect(
      screen.queryByText(
        "No messaging channels are configured for this agent.",
      ),
    ).toBeNull();
    laterPageFails = false;
    await user.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByText("Recovered channel")).toBeVisible();
  });

  it("does not advertise an integration the organization turned off", async () => {
    vi.mocked(useOrganization).mockReturnValue({
      data: {
        messagingChannelOverrides: {
          slack: { hidden: true },
          email: { hidden: true },
        },
      },
    } as unknown as ReturnType<typeof useOrganization>);
    const readEmail = vi.fn();
    server.use(
      http.get(BINDINGS_URL, () => HttpResponse.json(bindingPage([binding()]))),
      http.get(EMAIL_URL, () => {
        readEmail();
        return HttpResponse.json(email);
      }),
    );
    renderPage();
    const region = await screen.findByRole("region", {
      name: "Messaging channels",
    });
    expect(
      await within(region).findByText(
        "No messaging channels are configured for this agent.",
      ),
    ).toBeVisible();
    expect(screen.queryByText("Release planning")).toBeNull();
    expect(screen.queryByRole("region", { name: "Email" })).toBeNull();
    expect(readEmail).not.toHaveBeenCalled();
  });

  it.each([
    "subscription",
    "provider",
  ])("keeps Claude account setup discoverable for subscription agents (%s)", async (authentication) => {
    server.use(
      http.get(`${API_ORIGIN}/api/agents/${AGENT_ID}`, () =>
        HttpResponse.json({
          ...agent,
          runtime: {
            command: ["archestra-claude-code"],
            claudeCode: { authentication },
          },
        }),
      ),
    );
    renderPage();
    expect(
      await screen.findByRole("link", {
        name: "View agent",
      }),
    ).toHaveAttribute("href", `/agents/${AGENT_ID}`);
    expect(await screen.findByRole("link", { name: "Chat" })).toHaveAttribute(
      "href",
      `/chat?agentId=${AGENT_ID}`,
    );
  });

  it.each([
    false,
    true,
  ])("advertises assigned Telegram channels only when enabled (%s)", async (enabled) => {
    server.use(
      http.get(CONFIG_URL, () =>
        HttpResponse.json({ features: { chatopsTelegramEnabled: enabled } }),
      ),
      http.get(BINDINGS_URL, () =>
        HttpResponse.json(
          bindingPage([
            binding(),
            binding({
              id: "telegram-binding",
              provider: "telegram",
              channelName: "Telegram release group",
            }),
          ]),
        ),
      ),
    );
    renderPage();
    expect(await screen.findByText("Release planning")).toBeVisible();
    if (enabled) {
      expect(screen.getByText("Telegram release group")).toBeVisible();
    } else {
      expect(screen.queryByText("Telegram release group")).toBeNull();
    }
  });

  it("retries unavailable channel configuration instead of hiding enabled channels", async () => {
    const user = userEvent.setup();
    let configFails = true;
    server.use(
      http.get(CONFIG_URL, () =>
        configFails
          ? apiError()
          : HttpResponse.json({ features: { chatopsTelegramEnabled: true } }),
      ),
      http.get(BINDINGS_URL, () =>
        HttpResponse.json(bindingPage([binding({ provider: "telegram" })])),
      ),
    );
    renderPage();
    expect(
      await screen.findByText("Cannot load messaging channel availability"),
    ).toBeVisible();
    expect(
      screen.queryByText(
        "No messaging channels are configured for this agent.",
      ),
    ).toBeNull();
    expect(toast.error).not.toHaveBeenCalled();
    configFails = false;
    await user.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByText("Release planning")).toBeVisible();
    expect(screen.getByText("Telegram")).toBeVisible();
  });

  it("does not show a creation success or Chat link for a missing agent", async () => {
    server.use(
      http.get(`${API_ORIGIN}/api/agents/${AGENT_ID}`, () =>
        HttpResponse.json(
          { error: { message: "Not found", type: "api_not_found_error" } },
          { status: 404 },
        ),
      ),
    );
    renderPage();
    expect(await screen.findByText("Agent not found.")).toBeVisible();
    expect(screen.queryByRole("link", { name: "Chat" })).toBeNull();
  });
});

function renderPage(queryClient = createQueryClient()) {
  return render(
    <QueryClientProvider client={queryClient}>
      <AgentCreatedPage id={AGENT_ID} />
    </QueryClientProvider>,
  );
}

function createQueryClient() {
  return new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
}

function binding(overrides: Partial<Binding> = {}): Binding {
  return {
    id: "binding-1",
    organizationId: "organization-1",
    provider: "slack",
    channelId: "channel-1",
    channelName: "Release planning",
    workspaceId: "workspace-1",
    workspaceName: null,
    isDm: false,
    answerAllMessages: false,
    channelInstructions: null,
    dmOwnerEmail: null,
    agentId: AGENT_ID,
    createdAt: "2026-09-14T10:00:00Z",
    updatedAt: "2026-09-14T10:00:00Z",
    ...overrides,
  };
}

function bindingPage(
  data: Binding[],
  hasNext = false,
): archestraApiTypes.ListChatOpsBindingsResponses["200"] {
  return {
    data,
    pagination: {
      currentPage: 1,
      limit: 100,
      total: data.length,
      totalPages: hasNext ? 2 : 1,
      hasNext,
      hasPrev: false,
    },
    counts: { configured: data.length, unassigned: 0 },
    workspaces: [],
    hasDmBinding: false,
    workspacesWithUnmentionedTraffic: [],
  };
}

function apiError() {
  return HttpResponse.json(
    { error: { message: "Unavailable", type: "api_internal_server_error" } },
    { status: 500 },
  );
}
