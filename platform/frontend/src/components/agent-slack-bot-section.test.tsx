import { archestraApiClient } from "@archestra/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render as renderUI, screen, within } from "@testing-library/react";
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
import { useHasPermissions } from "@/lib/auth/auth.query";
import {
  useAllChatOpsBindings,
  useUpdateChatOpsBinding,
} from "@/lib/chatops/chatops.query";
import {
  useJoinSlackAgentBotChannel,
  useJoinSlackRouterBotChannel,
  useSlackAgentBotChannels,
  useSlackAgentBots,
  useSlackRouterBotChannels,
} from "@/lib/chatops/chatops-config.query";
import { useAppName } from "@/lib/hooks/use-app-name";
import { AgentSlackBotSection } from "./agent-slack-bot-section";
import { SlackBotEditDialog } from "./slack-bot-edit-dialog";

vi.mock("@/lib/auth/auth.query");
vi.mock("@/lib/hooks/use-app-name");
vi.mock("@/lib/chatops/chatops.query", () => ({
  useAllChatOpsBindings: vi.fn(),
  useUpdateChatOpsBinding: vi.fn(),
}));
vi.mock("@/lib/chatops/chatops-config.query", () => ({
  useJoinSlackAgentBotChannel: vi.fn(),
  useJoinSlackRouterBotChannel: vi.fn(),
  useSlackAgentBotChannels: vi.fn(),
  useSlackAgentBots: vi.fn(),
  useSlackRouterBotChannels: vi.fn(),
}));

const agentServer = setupServer(
  http.get("http://localhost:9000/api/agents/options", ({ request }) => {
    const query = new URL(request.url).searchParams;
    const ids = [...query.getAll("ids"), ...query.getAll("ids[]")].flatMap(
      (value) => value.split(","),
    );
    return HttpResponse.json(
      [
        { id: "a1", name: "Marketing" },
        { id: "a2", name: "Coding" },
      ].filter((agent) => ids.includes(agent.id)),
    );
  }),
  http.get("http://localhost:9000/api/agents/options/page", () =>
    HttpResponse.json({
      data: [
        { id: "a1", name: "Marketing" },
        { id: "a2", name: "Coding" },
      ],
      pagination: { hasNext: false, nextCursor: null },
    }),
  ),
);
beforeAll(() => agentServer.listen({ onUnhandledRequest: "error" }));
afterEach(() => agentServer.resetHandlers());
afterAll(() => {
  agentServer.close();
  archestraApiClient.setConfig({ baseUrl: "" });
});
function render(children: React.ReactNode) {
  return renderUI(
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      {children}
    </QueryClientProvider>,
  );
}

const join = vi.fn();
const update = vi.fn();

function binding(
  channelId: string,
  agentId: string | null,
  extra: Record<string, unknown> = {},
) {
  return {
    id: `b-${channelId}`,
    provider: "slack",
    channelId,
    channelName: `name-${channelId}`,
    workspaceId: "T1",
    isDm: false,
    agentId,
    answerAllMessages: false,
    channelInstructions: null,
    ...extra,
  };
}

function setup(params: {
  hasBot?: boolean;
  bindings?: ReturnType<typeof binding>[];
  channels?: Array<{
    channelId: string;
    channelName: string;
    description?: string | null;
    isPrivate: boolean;
    isMember: boolean;
  }>;
}) {
  vi.mocked(useSlackAgentBots).mockReturnValue({
    data: {
      bots:
        params.hasBot === false
          ? []
          : [
              {
                agentId: "a1",
                agentName: "Marketing",
                handle: "archestra_marketing",
                installed: true,
                connected: true,
                needsAppLevelToken: false,
                reinstallUrl: null,
              },
            ],
    },
    isError: false,
    isLoading: false,
  } as unknown as ReturnType<typeof useSlackAgentBots>);
  vi.mocked(useAllChatOpsBindings).mockReturnValue({
    data: { bindings: params.bindings ?? [] },
  } as unknown as ReturnType<typeof useAllChatOpsBindings>);
  const channels = {
    data: {
      workspaceId: "T1",
      canJoin: true,
      channels: params.channels ?? [],
    },
    isLoading: false,
    isError: false,
  };
  vi.mocked(useSlackAgentBotChannels).mockReturnValue(
    channels as unknown as ReturnType<typeof useSlackAgentBotChannels>,
  );
  vi.mocked(useSlackRouterBotChannels).mockReturnValue(
    channels as unknown as ReturnType<typeof useSlackRouterBotChannels>,
  );
}

beforeEach(() => {
  archestraApiClient.setConfig({ baseUrl: "http://localhost:9000" });
  join.mockReset();
  update.mockReset();
  vi.mocked(useAppName).mockReturnValue("Archestra");
  vi.mocked(useHasPermissions).mockReturnValue({
    data: true,
    isPending: false,
  } as ReturnType<typeof useHasPermissions>);

  vi.mocked(useJoinSlackAgentBotChannel).mockReturnValue({
    mutate: join,
    isPending: false,
  } as unknown as ReturnType<typeof useJoinSlackAgentBotChannel>);
  vi.mocked(useJoinSlackRouterBotChannel).mockReturnValue({
    mutate: join,
    isPending: false,
  } as unknown as ReturnType<typeof useJoinSlackRouterBotChannel>);
  vi.mocked(useUpdateChatOpsBinding).mockReturnValue({
    mutate: update,
    mutateAsync: update,
    isPending: false,
  } as unknown as ReturnType<typeof useUpdateChatOpsBinding>);
});

// The bot's channels are edited in its dialog, opened from the bot's row.
async function openEditDialog() {
  render(<AgentSlackBotSection agentId="a1" agentName="Marketing" />);
  await userEvent.click(screen.getByRole("button", { name: "Edit" }));
}

describe("AgentSlackBotSection", () => {
  it("lists the bot's channels, their Slack descriptions, and which bot replies to all", async () => {
    setup({
      bindings: [
        binding("C1", "a1", { answerAllMessages: true }),
        binding("C2", "a2"),
        binding("C3", "a2", { answerAllMessages: true }),
      ],
      channels: [
        {
          channelId: "C1",
          channelName: "alerts",
          description: "Production alerts",
          isPrivate: false,
          isMember: true,
        },
        {
          channelId: "C2",
          channelName: "eng",
          isPrivate: false,
          isMember: true,
        },
        {
          channelId: "C3",
          channelName: "dev",
          isPrivate: false,
          isMember: true,
        },
      ],
    });

    await openEditDialog();

    const alerts = screen.getByRole("listitem", { name: "alerts" });
    expect(within(alerts).getByText("Production alerts")).toBeVisible();
    expect(within(alerts).getByText("Replies to all messages")).toBeVisible();

    // Another agent owning the channel changes nothing this bot does, so it
    // is not shown; only another bot replying to all is.
    const eng = screen.getByRole("listitem", { name: "eng" });
    expect(within(eng).getByText("Replies when @mentioned")).toBeVisible();
    const dev = screen.getByRole("listitem", { name: "dev" });
    expect(
      within(dev).getByText("Replies when @mentioned · Coding replies to all"),
    ).toBeVisible();

    for (const row of [alerts, eng, dev]) {
      expect(
        within(row).getByRole("button", { name: "Settings" }),
      ).toBeVisible();
    }
  });

  it("searches a long channel list by name and description", async () => {
    const names = ["alerts", "eng", "dev", "ops", "sales", "support", "random"];
    setup({
      channels: names.map((name, index) => ({
        channelId: `C${index}`,
        channelName: name,
        description: name === "random" ? "Watercooler chat" : null,
        isPrivate: false,
        isMember: true,
      })),
    });

    await openEditDialog();
    const search = screen.getByRole("textbox", { name: "Search channels" });

    await userEvent.type(search, "sal");
    expect(screen.getByRole("listitem", { name: "sales" })).toBeVisible();
    expect(screen.queryByRole("listitem", { name: "eng" })).toBeNull();

    await userEvent.clear(search);
    await userEvent.type(search, "watercooler");
    expect(screen.getByRole("listitem", { name: "random" })).toBeVisible();

    await userEvent.clear(search);
    await userEvent.type(search, "nothing-like-this");
    expect(screen.getByText(/No channels match/)).toBeVisible();
  });

  it("moves replying to all to this bot from another agent's", async () => {
    setup({
      bindings: [binding("C3", "a2", { answerAllMessages: true })],
      channels: [
        {
          channelId: "C3",
          channelName: "dev",
          description: "Day-to-day engineering",
          isPrivate: false,
          isMember: true,
        },
      ],
    });

    await openEditDialog();
    await userEvent.click(screen.getByRole("button", { name: "Settings" }));

    expect(screen.getAllByText("Day-to-day engineering")).toHaveLength(2);
    await userEvent.click(
      screen.getByRole("switch", { name: "Reply to all messages" }),
    );
    expect(
      screen.getByText(/Coding does this now. Saving switches it to/),
    ).toBeVisible();
    await userEvent.click(
      screen.getByRole("button", { name: "Save channel details" }),
    );

    expect(update).toHaveBeenCalledWith({
      id: "b-C3",
      body: {
        channelInstructions: null,
        answerAllMessages: true,
        agentId: "a1",
      },
    });
  });

  it("offers to add the bot to an assigned channel it is not in", async () => {
    setup({
      bindings: [binding("C3", "a1")],
      channels: [
        {
          channelId: "C3",
          channelName: "sales",
          isPrivate: false,
          isMember: false,
        },
      ],
    });

    await openEditDialog();
    const row = screen.getByRole("listitem", { name: "name-C3" });
    expect(within(row).getByText(/nobody answers as this agent/)).toBeVisible();
    await userEvent.click(within(row).getByRole("button", { name: "Add bot" }));

    expect(join).toHaveBeenCalledWith("C3");
  });

  it("shows the router bot's channels with the agent that answers in each by default", async () => {
    setup({
      bindings: [binding("C1", "a2")],
      channels: [
        {
          channelId: "C1",
          channelName: "eng",
          isPrivate: false,
          isMember: true,
        },
        {
          channelId: "C2",
          channelName: "random",
          isPrivate: false,
          isMember: true,
        },
        {
          channelId: "C3",
          channelName: "sales",
          isPrivate: false,
          isMember: false,
        },
      ],
    });

    render(
      <SlackBotEditDialog
        open
        onOpenChange={() => {}}
        agentId={null}
        handle="archestra_all"
        appId="A_ROUTER"
        installed
        reinstallUrl={null}
      />,
    );

    expect(
      await within(screen.getByRole("listitem", { name: "eng" })).findByText(
        "Default agent: Coding",
      ),
    ).toBeVisible();
    expect(
      within(screen.getByRole("listitem", { name: "random" })).getByText(
        /No default agent yet/,
      ),
    ).toBeVisible();
    expect(screen.queryByRole("listitem", { name: "sales" })).toBeNull();
  });

  it("says assigned channels have no bot until the agent gets one", () => {
    setup({
      hasBot: false,
      bindings: [binding("C1", "a1"), binding("C2", "a1")],
    });

    render(<AgentSlackBotSection agentId="a1" agentName="Marketing" />);

    expect(
      screen.getByText(/2 Slack channels are assigned to this agent/),
    ).toBeVisible();
    expect(screen.getByRole("link", { name: "Add Slack bot" })).toHaveAttribute(
      "href",
      "/settings/messaging-channels/slack?addBot=a1",
    );
  });
});
