import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useInternalAgents } from "@/lib/agent.query";
import { useHasPermissions } from "@/lib/auth/auth.query";
import {
  useAllChatOpsBindings,
  useUpdateChatOpsBinding,
} from "@/lib/chatops/chatops.query";
import {
  useJoinSlackAgentBotChannel,
  useSlackAgentBotChannels,
  useSlackAgentBots,
} from "@/lib/chatops/chatops-config.query";
import { useAppName } from "@/lib/hooks/use-app-name";
import { AgentSlackBotSection } from "./agent-slack-bot-section";

vi.mock("@/lib/auth/auth.query");
vi.mock("@/lib/hooks/use-app-name");
vi.mock("@/lib/agent.query", () => ({ useInternalAgents: vi.fn() }));
vi.mock("@/lib/chatops/chatops.query", () => ({
  useAllChatOpsBindings: vi.fn(),
  useUpdateChatOpsBinding: vi.fn(),
}));
vi.mock("@/lib/chatops/chatops-config.query", () => ({
  useJoinSlackAgentBotChannel: vi.fn(),
  useSlackAgentBotChannels: vi.fn(),
  useSlackAgentBots: vi.fn(),
}));

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
  vi.mocked(useSlackAgentBotChannels).mockReturnValue({
    data: {
      workspaceId: "T1",
      canJoin: true,
      channels: params.channels ?? [],
    },
    isLoading: false,
    isError: false,
  } as unknown as ReturnType<typeof useSlackAgentBotChannels>);
}

beforeEach(() => {
  join.mockReset();
  update.mockReset();
  vi.mocked(useAppName).mockReturnValue("Archestra");
  vi.mocked(useHasPermissions).mockReturnValue({
    data: true,
    isPending: false,
  } as ReturnType<typeof useHasPermissions>);
  vi.mocked(useInternalAgents).mockReturnValue({
    data: [
      { id: "a1", name: "Marketing" },
      { id: "a2", name: "Coding" },
    ],
  } as unknown as ReturnType<typeof useInternalAgents>);
  vi.mocked(useJoinSlackAgentBotChannel).mockReturnValue({
    mutate: join,
    isPending: false,
  } as unknown as ReturnType<typeof useJoinSlackAgentBotChannel>);
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
  it("lists the bot's channels and who answers every message in them", async () => {
    setup({
      bindings: [
        binding("C1", "a1", { answerAllMessages: true }),
        binding("C2", "a2"),
      ],
      channels: [
        {
          channelId: "C1",
          channelName: "alerts",
          isPrivate: false,
          isMember: true,
        },
        {
          channelId: "C2",
          channelName: "eng",
          isPrivate: false,
          isMember: true,
        },
      ],
    });

    await openEditDialog();

    const alerts = screen.getByRole("listitem", { name: "alerts" });
    expect(within(alerts).getByText("Answers every message")).toBeVisible();
    expect(
      within(alerts).getByRole("button", { name: "Settings" }),
    ).toBeVisible();

    const eng = screen.getByRole("listitem", { name: "eng" });
    expect(within(eng).getByText(/belongs to Coding/)).toBeVisible();
  });

  it("hands a channel another agent owns over to this agent", async () => {
    setup({
      bindings: [binding("C2", "a2")],
      channels: [
        {
          channelId: "C2",
          channelName: "eng",
          isPrivate: false,
          isMember: true,
        },
      ],
    });

    await openEditDialog();
    await userEvent.click(
      screen.getByRole("button", { name: "Make it this agent's" }),
    );

    expect(update).toHaveBeenCalledWith({
      id: "b-C2",
      body: { agentId: "a1" },
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
