import { archestraApiClient } from "@archestra/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { HttpResponse, http } from "msw";
import { setupServer } from "msw/node";
import { useSearchParams } from "next/navigation";
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
import { useAllChatOpsBindings } from "@/lib/chatops/chatops.query";
import {
  useConvertSlackAppToAgentBot,
  useCreateSlackAgentBotApp,
  useCreateSlackRouterBotApp,
  useDeleteSlackAgentBot,
  useMigrateSlackApps,
  useSaveSlackAppConfigToken,
  useSlackAgentBotChannels,
  useSlackAgentBots,
  useUpdateSlackAgentBot,
  useUpdateSlackChatOpsConfig,
} from "@/lib/chatops/chatops-config.query";
import { useAppName } from "@/lib/hooks/use-app-name";
import { SlackAgentBotsSection } from "./slack-agent-bots-section";

const optionRequests: string[] = [];
const optionAgents = [
  { id: "a1", name: "Marketing" },
  { id: "a2", name: "Coding" },
  { id: "a3", name: "Sales" },
];
const optionServer = setupServer(
  http.get("http://localhost:9000/api/agents/options", ({ request }) => {
    const url = new URL(request.url);
    optionRequests.push(url.pathname + url.search);
    const ids = [
      ...url.searchParams.getAll("ids"),
      ...url.searchParams.getAll("ids[]"),
    ].flatMap((value) => value.split(","));
    return HttpResponse.json(
      optionAgents.filter((agent) => ids.includes(agent.id)),
    );
  }),
  http.get("http://localhost:9000/api/agents/options/page", ({ request }) => {
    const url = new URL(request.url);
    optionRequests.push(url.pathname + url.search);
    const excluded = [
      ...url.searchParams.getAll("excludeIds"),
      ...url.searchParams.getAll("excludeIds[]"),
    ].flatMap((value) => value.split(","));
    const search = url.searchParams.get("search")?.toLowerCase() ?? "";
    return HttpResponse.json({
      data: optionAgents.filter(
        (agent) =>
          !excluded.includes(agent.id) &&
          agent.name.toLowerCase().includes(search),
      ),
      pagination: { hasNext: false, nextCursor: null },
    });
  }),
);
beforeAll(() => optionServer.listen({ onUnhandledRequest: "error" }));
afterEach(() => {
  optionServer.resetHandlers();
  optionRequests.length = 0;
});
afterAll(() => {
  optionServer.close();
  archestraApiClient.setConfig({ baseUrl: "" });
});
function QueryBoundary({ children }: { children: React.ReactNode }) {
  return (
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      {children}
    </QueryClientProvider>
  );
}

const router = vi.hoisted(() => ({ replace: vi.fn() }));
vi.mock("next/navigation", () => ({
  useRouter: () => router,
  useSearchParams: vi.fn(),
}));
vi.mock("@/lib/auth/auth.query");
vi.mock("@/lib/hooks/use-app-name");
vi.mock("@/lib/chatops/chatops-config.query", () => ({
  useConvertSlackAppToAgentBot: vi.fn(),
  useCreateSlackAgentBotApp: vi.fn(),
  useCreateSlackRouterBotApp: vi.fn(),
  useDeleteSlackAgentBot: vi.fn(),
  useMigrateSlackApps: vi.fn(),
  useSaveSlackAppConfigToken: vi.fn(),
  useSlackAgentBotChannels: vi.fn(),
  useSlackAgentBots: vi.fn(),
  useUpdateSlackAgentBot: vi.fn(),
  useUpdateSlackChatOpsConfig: vi.fn(),
}));
vi.mock("@/lib/chatops/chatops.query", () => ({
  useAllChatOpsBindings: vi.fn(),
}));
vi.mock("@/components/slack-bot-edit-dialog", () => ({
  SlackBotEditDialog: () => null,
}));
vi.mock("@/components/slack-setup-dialog", () => ({
  SlackSetupDialog: () => null,
}));

const saveToken = vi.fn();

function bot(
  agentId: string,
  agentName: string,
  extra: Record<string, unknown> = {},
) {
  return {
    agentId,
    agentName,
    appId: `A_${agentId}`,
    handle: `archestra_${agentName.toLowerCase()}`,
    enabled: true,
    connectionMode: "socket",
    connected: true,
    botUserId: "U1",
    teamId: "T1",
    installed: true,
    needsAppLevelToken: false,
    missingScopes: [],
    reinstallUrl: null,
    identitySyncError: null,
    createdByArchestra: true,
    createdBy: null,
    ...extra,
  };
}

function setup(params: {
  bots: ReturnType<typeof bot>[];
  canCreateApps?: boolean;
  searchParams?: string;
  routerBot?: Record<string, unknown> | null;
}) {
  vi.mocked(useSearchParams).mockReturnValue(
    new URLSearchParams(params.searchParams ?? "") as unknown as ReturnType<
      typeof useSearchParams
    >,
  );
  vi.mocked(useSlackAgentBots).mockReturnValue({
    data: {
      bots: params.bots,
      canCreateApps: params.canCreateApps ?? true,
      oneClickInstall: false,
      unassignedApp: params.routerBot ?? null,
      workspaceName: "Acme",
    },
    isLoading: false,
    isFetching: false,
    refetch: vi.fn(),
  } as unknown as ReturnType<typeof useSlackAgentBots>);
  render(
    <SlackAgentBotsSection
      connectionMode="socket"
      connectionModeSettings={null}
    />,
    { wrapper: QueryBoundary },
  );
}

const mutation = (mutateAsync = vi.fn()) => ({
  mutate: vi.fn(),
  mutateAsync,
  isPending: false,
});

beforeEach(() => {
  archestraApiClient.setConfig({ baseUrl: "http://localhost:9000" });
  vi.clearAllMocks();
  vi.mocked(useAppName).mockReturnValue("Archestra");
  vi.mocked(useSession).mockReturnValue({
    data: { user: { id: "me" } },
  } as unknown as ReturnType<typeof useSession>);

  saveToken.mockResolvedValue({ success: true, migrated: [] });
  vi.mocked(useSlackAgentBotChannels).mockReturnValue({
    data: undefined,
  } as unknown as ReturnType<typeof useSlackAgentBotChannels>);
  vi.mocked(useAllChatOpsBindings).mockReturnValue({
    data: { bindings: [] },
  } as unknown as ReturnType<typeof useAllChatOpsBindings>);
  vi.mocked(useSaveSlackAppConfigToken).mockReturnValue(
    mutation(saveToken) as unknown as ReturnType<
      typeof useSaveSlackAppConfigToken
    >,
  );
  for (const hook of [
    useConvertSlackAppToAgentBot,
    useCreateSlackAgentBotApp,
    useCreateSlackRouterBotApp,
    useDeleteSlackAgentBot,
    useMigrateSlackApps,
    useUpdateSlackAgentBot,
    useUpdateSlackChatOpsConfig,
  ]) {
    vi.mocked(hook).mockReturnValue(mutation() as never);
  }
});

describe("SlackAgentBotsSection", () => {
  it("says who manages each bot's app in Slack, so teammates know whom to ask", () => {
    setup({
      bots: [
        bot("a1", "Marketing", { createdBy: { id: "me", name: "Me" } }),
        bot("a2", "Coding", { createdBy: { id: "u2", name: "Dana" } }),
      ],
    });

    expect(
      screen.getByRole("columnheader", { name: "Managed in Slack by" }),
    ).toBeVisible();
    expect(screen.getByRole("cell", { name: "You" })).toBeVisible();
    expect(screen.getByRole("cell", { name: "Dana" })).toBeVisible();
  });

  it("shows how many channels a bot is in and where it replies to every message", () => {
    vi.mocked(useSlackAgentBotChannels).mockReturnValue({
      data: {
        channels: [
          { channelId: "C1", isMember: true },
          { channelId: "C2", isMember: true },
          { channelId: "C3", isMember: false },
        ],
      },
    } as unknown as ReturnType<typeof useSlackAgentBotChannels>);
    vi.mocked(useAllChatOpsBindings).mockReturnValue({
      data: {
        bindings: [
          {
            provider: "slack",
            isDm: false,
            answerAllMessages: true,
            agentId: "a1",
            channelName: "task-feed",
            channelId: "C1",
          },
        ],
      },
    } as unknown as ReturnType<typeof useAllChatOpsBindings>);

    setup({ bots: [bot("a1", "Marketing")] });

    expect(screen.getByText("2 channels")).toBeVisible();
    expect(screen.getByText("Replies to all in #task-feed")).toBeVisible();
  });

  it("says what is wrong with a bot only when something is", () => {
    setup({
      bots: [
        bot("a1", "Marketing"),
        bot("a2", "Coding", { needsAppLevelToken: true }),
      ],
    });

    expect(screen.getByText("Needs app-level token")).toBeVisible();
    expect(screen.getByRole("button", { name: "Finish setup" })).toBeVisible();
    // A working bot has no status words, only a dot readers get as text.
    expect(screen.getByText("Connected")).toHaveClass("sr-only");
  });

  it("asks for the person's own token before adding a bot, then goes on to add it", async () => {
    setup({ bots: [bot("a1", "Marketing")], canCreateApps: false });

    await userEvent.click(
      screen.getByRole("button", { name: "Add Slack bot" }),
    );
    expect(screen.getByRole("dialog", { name: "Connect Slack" })).toBeVisible();

    await userEvent.type(screen.getByLabelText("Access token"), "xoxe.xoxp-1");
    await userEvent.type(screen.getByLabelText("Refresh token"), "xoxe-1");
    await userEvent.click(screen.getByRole("button", { name: "Connect" }));

    expect(saveToken).toHaveBeenCalledWith({
      accessToken: "xoxe.xoxp-1",
      refreshToken: "xoxe-1",
    });
    expect(
      await screen.findByRole("dialog", { name: "Add Slack bot" }),
    ).toBeVisible();
  });

  it("finishing the setup of your own bot asks you to add your team in Slack", async () => {
    setup({
      bots: [
        bot("a1", "Marketing", {
          installed: false,
          createdBy: { id: "me", name: "Me" },
        }),
      ],
    });

    await userEvent.click(screen.getByRole("button", { name: "Finish setup" }));

    expect(
      screen.getByRole("link", { name: /Collaborators page/ }),
    ).toHaveAttribute("href", "https://api.slack.com/apps/A_a1/collaborators");
  });

  it("after a one-click install that still needs a token, finishes setup and adds the team in one dialog", () => {
    setup({
      bots: [
        bot("a1", "Marketing", {
          needsAppLevelToken: true,
          createdBy: { id: "me", name: "Me" },
        }),
      ],
      searchParams: "slackBotInstalled=a1",
    });

    expect(
      screen.getByRole("dialog", { name: "Finish Marketing's Slack bot" }),
    ).toBeVisible();
    expect(screen.getByLabelText("App-Level Token")).toBeVisible();
    expect(
      screen.getByRole("link", { name: /Collaborators page/ }),
    ).toHaveAttribute("href", "https://api.slack.com/apps/A_a1/collaborators");
  });

  it("keeps the router bot next to agent bots, and converting it is an opt-in that says what goes away", async () => {
    const convert = vi.fn().mockResolvedValue({ success: true });
    vi.mocked(useConvertSlackAppToAgentBot).mockReturnValue(
      mutation(convert) as never,
    );
    setup({
      bots: [bot("a1", "Marketing")],
      routerBot: {
        appId: "A_MAIN",
        handle: "archestra",
        connected: true,
        installed: true,
        needsAppLevelToken: false,
        createdBy: null,
        connectionMode: "socket",
        agentUsage: [{ agentId: "a3", agentName: "Sales", bindings: 4 }],
      },
    });

    expect(screen.getByText("@archestra")).toBeVisible();
    // Its commands are named after the app, as Slack shows them.
    expect(screen.getByText("/archestra-select-agent")).toBeVisible();
    expect(screen.getByText("@archestra Agent > message")).toBeVisible();
    expect(screen.getByText("@archestra list")).toBeVisible();
    expect(screen.getByText("@archestra_marketing")).toBeVisible();
    expect(convert).not.toHaveBeenCalled();

    await userEvent.click(
      screen.getByRole("button", { name: "More actions for @archestra" }),
    );
    await userEvent.click(
      screen.getByRole("menuitem", { name: "Convert to an agent's bot…" }),
    );
    const dialog = screen.getByRole("dialog", {
      name: "Convert to an agent's bot",
    });
    expect(dialog).toHaveTextContent(
      "People can no longer pick their own agent with /select-agent",
    );

    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Convert" })).toBeEnabled(),
    );
    await userEvent.click(screen.getByRole("button", { name: "Convert" }));
    expect(convert).toHaveBeenCalledWith("a3");
  });

  it("loads only bot references until the candidate picker opens, excluding agents that already have a bot", async () => {
    setup({ bots: [bot("a1", "Marketing")] });
    await waitFor(() =>
      expect(
        optionRequests.some(
          (path) =>
            decodeURIComponent(path).includes("ids[]=a1") ||
            path.includes("ids=a1"),
        ),
      ).toBe(true),
    );
    expect(optionRequests.some((path) => path.includes("/page"))).toBe(false);
    await userEvent.click(
      screen.getByRole("button", { name: "Add Slack bot" }),
    );
    await userEvent.click(screen.getByRole("combobox"));
    expect(await screen.findByRole("option", { name: "Sales" })).toBeVisible();
    expect(screen.queryByRole("option", { name: "Marketing" })).toBeNull();
    await userEvent.click(screen.getByRole("option", { name: "Sales" }));
    expect(await screen.findByLabelText("Slack name")).toHaveValue(
      "archestra_sales",
    );
    const page = optionRequests.find((path) => path.includes("/page"));
    expect(
      new URL(page ?? "", "http://localhost:9000").searchParams.get(
        "excludeIds",
      ),
    ).toBe("a1");
    expect(
      optionRequests
        .filter((path) => !path.includes("/page"))
        .every((path) =>
          new URL(path, "http://localhost:9000").searchParams
            .keys()
            .some((key) => key.startsWith("ids")),
        ),
    ).toBe(true);
  });

  it("creates the router bot from the person's token, then asks for the tokens Slack does not hand over", async () => {
    const create = vi.fn().mockResolvedValue({
      appId: "A_ROUTER",
      installUrl: "https://api.slack.com/apps/A_ROUTER/oauth",
      installMode: "manual",
    });
    vi.mocked(useCreateSlackRouterBotApp).mockReturnValue(
      mutation(create) as never,
    );
    const openSpy = vi.spyOn(window, "open").mockReturnValue(null);
    setup({ bots: [bot("a1", "Marketing")] });

    expect(screen.getByText("No router bot")).toBeVisible();
    await userEvent.click(
      screen.getByRole("button", { name: "Add router bot" }),
    );
    expect(screen.getByLabelText("Slack name")).toHaveValue("archestra_all");
    await userEvent.click(screen.getByRole("button", { name: "Create bot" }));

    expect(create).toHaveBeenCalledWith({
      appName: "archestra_all",
      connectionMode: "socket",
    });
    expect(openSpy).toHaveBeenCalledWith(
      "https://api.slack.com/apps/A_ROUTER/oauth",
      "_blank",
      "noopener,noreferrer",
    );
    expect(
      screen.getByRole("dialog", { name: "Finish the router bot" }),
    ).toBeVisible();
    expect(screen.getByLabelText("Bot User OAuth Token")).toBeVisible();
    expect(screen.getByLabelText("App-Level Token")).toBeVisible();
    openSpy.mockRestore();
  });

  it("finishing the router bot switches it on with its tokens", async () => {
    const save = vi.fn().mockResolvedValue({ success: true });
    vi.mocked(useUpdateSlackChatOpsConfig).mockReturnValue(
      mutation(save) as never,
    );
    setup({
      bots: [],
      routerBot: {
        appId: "A_ROUTER",
        handle: null,
        connected: false,
        installed: false,
        needsAppLevelToken: false,
        createdBy: null,
        connectionMode: "webhook",
        agentUsage: [],
      },
    });

    expect(screen.getByText(/Not installed/)).toBeVisible();
    await userEvent.click(screen.getByRole("button", { name: "Finish setup" }));
    await userEvent.type(
      screen.getByLabelText("Bot User OAuth Token"),
      "xoxb-1",
    );
    await userEvent.click(screen.getByRole("button", { name: "Connect" }));

    expect(save).toHaveBeenCalledWith({ botToken: "xoxb-1", enabled: true });
  });

  it("after a one-click install, asks the creator to give their team access", () => {
    setup({
      bots: [bot("a1", "Marketing", { createdBy: { id: "me", name: "Me" } })],
      searchParams: "slackBotInstalled=a1",
    });

    expect(
      screen.getByRole("dialog", {
        name: "Give your team access to @archestra_marketing",
      }),
    ).toBeVisible();
    expect(
      screen.getByRole("link", { name: /Collaborators page/ }),
    ).toHaveAttribute("href", "https://api.slack.com/apps/A_a1/collaborators");
  });
});
