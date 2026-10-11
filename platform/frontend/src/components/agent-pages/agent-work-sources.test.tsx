import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useAgentRuntimePreflight } from "@/lib/agent-runtime.query";
import { useHasPermissions } from "@/lib/auth/auth.query";
import { useAllChatOpsBindings } from "@/lib/chatops/chatops.query";
import {
  useSlackAgentBotChannels,
  useSlackAgentBots,
} from "@/lib/chatops/chatops-config.query";
import { useAppName } from "@/lib/hooks/use-app-name";
import { AgentWorkSources } from "./agent-work-sources";

vi.mock("@/lib/auth/auth.query");
vi.mock("@/lib/hooks/use-app-name");
vi.mock("@/lib/chatops/chatops.query", () => ({
  useAllChatOpsBindings: vi.fn(),
}));
vi.mock("@/lib/chatops/chatops-config.query", () => ({
  useSlackAgentBots: vi.fn(),
  useSlackAgentBotChannels: vi.fn(),
}));
vi.mock("@/lib/integration-overrides", () => ({
  useMessagingChannelCatalog: () => ({ isHidden: () => false }),
}));
vi.mock("@/components/slack-bot-edit-dialog", () => ({
  SlackBotEditDialog: () => null,
}));
vi.mock("@/lib/agent-runtime.query", () => ({
  useAgentRuntimePreflight: vi.fn(),
}));

function mockBindings(
  bindings: Array<{
    id: string;
    agentId: string | null;
    provider: "slack" | "ms-teams" | "telegram";
    channelId: string;
    channelName: string | null;
  }>,
) {
  vi.mocked(useAllChatOpsBindings).mockReturnValue({
    data: { bindings },
    isPending: false,
  } as unknown as ReturnType<typeof useAllChatOpsBindings>);
}

function mockSlackBots(
  bots: Array<{ agentId: string; agentName: string; handle: string | null }>,
  options: { perAgent?: boolean } = {},
) {
  vi.mocked(useSlackAgentBots).mockReturnValue({
    data: {
      bots: bots.map((bot) => ({ ...bot, installed: true, appId: "A1" })),
      // A Slack app still routed by channel (not converted) keeps the old card.
      unassignedApp: options.perAgent ? null : { appId: "A_OLD" },
    },
  } as unknown as ReturnType<typeof useSlackAgentBots>);
}

function mockBotChannels(memberCount: number) {
  vi.mocked(useSlackAgentBotChannels).mockReturnValue({
    data: {
      channels: Array.from({ length: memberCount }, (_, index) => ({
        channelId: `C${index}`,
        isMember: true,
      })),
    },
  } as unknown as ReturnType<typeof useSlackAgentBotChannels>);
}

function mockSetupReady(ready: boolean) {
  vi.mocked(useAgentRuntimePreflight).mockReturnValue({
    data: { ready },
  } as unknown as ReturnType<typeof useAgentRuntimePreflight>);
}

beforeEach(() => {
  mockSetupReady(true);
  vi.mocked(useAppName).mockReturnValue("Archestra");
  vi.mocked(useHasPermissions).mockReturnValue({
    data: true,
    isPending: false,
  } as ReturnType<typeof useHasPermissions>);
  mockBindings([]);
  mockSlackBots([]);
  mockBotChannels(0);
});

describe("AgentWorkSources", () => {
  it("offers a coding agent chat, handoff from a laptop, and its channels", () => {
    mockBindings([
      {
        id: "b1",
        agentId: "a1",
        provider: "slack",
        channelId: "C1",
        channelName: "eng-platform",
      },
      {
        id: "b2",
        agentId: "someone-else",
        provider: "slack",
        channelId: "C2",
        channelName: "support",
      },
    ]);
    render(
      <AgentWorkSources
        agentId="a1"
        hasRuntime
        runtimeAvailable
        chatHref="/chat?agentId=a1"
        onShowA2a={vi.fn()}
      />,
    );

    expect(
      screen.getByRole("heading", { level: 2, name: "Give it work" }),
    ).toBeVisible();
    expect(screen.getByRole("link", { name: "Open in chat" })).toHaveAttribute(
      "href",
      "/chat?agentId=a1",
    );
    expect(
      screen.getByRole("link", { name: "Connect your local agent" }),
    ).toHaveAttribute("href", "/connection");
    // Only this agent's channels, not every channel in the workspace.
    const channels = screen
      .getByRole("heading", { level: 3, name: "In your channels" })
      .closest("div")?.parentElement as HTMLElement;
    expect(within(channels).getByText(/eng-platform/)).toBeVisible();
    expect(within(channels).queryByText(/support/)).toBeNull();
    expect(
      within(channels).getByRole("link", { name: "Manage channels" }),
    ).toHaveAttribute("href", "/agents/a1/edit?step=messaging");
    // A coding agent already has a runtime: nothing to offer there.
    expect(
      screen.queryByRole("link", { name: "Set up Agent Runtime" }),
    ).toBeNull();
  });

  it("offers an agent on the built-in harness A2A and a dedicated runtime", async () => {
    const showA2a = vi.fn();
    render(
      <AgentWorkSources
        agentId="a1"
        hasRuntime={false}
        runtimeAvailable
        chatHref="/chat?agentId=a1"
        onShowA2a={showA2a}
      />,
    );

    expect(
      screen.getByRole("heading", { level: 2, name: "Where people use it" }),
    ).toBeVisible();
    expect(
      screen.queryByRole("link", { name: "Connect your local agent" }),
    ).toBeNull();
    await userEvent.click(
      screen.getByRole("button", { name: "Show A2A details" }),
    );
    expect(showA2a).toHaveBeenCalledOnce();
    expect(screen.getByRole("link", { name: "Add a channel" })).toBeVisible();
    expect(
      screen.getByRole("link", { name: "Set up Agent Runtime" }),
    ).toHaveAttribute("href", "/agents/a1/edit");
  });

  it("says a coding agent's routes wait on its setup until the setup is done", () => {
    mockSetupReady(false);
    const { rerender } = render(
      <AgentWorkSources
        agentId="a1"
        hasRuntime
        runtimeAvailable
        chatHref="/chat?agentId=a1"
        onShowA2a={vi.fn()}
      />,
    );
    expect(
      screen.getByText("Available once setup above is done."),
    ).toBeVisible();

    mockSetupReady(true);
    rerender(
      <AgentWorkSources
        agentId="a1"
        hasRuntime
        runtimeAvailable
        chatHref="/chat?agentId=a1"
        onShowA2a={vi.fn()}
      />,
    );
    expect(
      screen.queryByText("Available once setup above is done."),
    ).toBeNull();
  });

  it("hides channels from a reader who cannot see them", () => {
    vi.mocked(useHasPermissions).mockReturnValue({
      data: false,
      isPending: false,
    } as ReturnType<typeof useHasPermissions>);
    render(
      <AgentWorkSources
        agentId="a1"
        hasRuntime
        runtimeAvailable={false}
        chatHref={null}
        onShowA2a={vi.fn()}
      />,
    );
    expect(
      screen.queryByRole("heading", { level: 3, name: "In your channels" }),
    ).toBeNull();
    expect(screen.queryByRole("link", { name: "Open in chat" })).toBeNull();
  });

  const renderBuiltIn = () =>
    render(
      <AgentWorkSources
        agentId="a1"
        hasRuntime={false}
        runtimeAvailable={false}
        chatHref={null}
      />,
    );

  it("shows the agent's Slack bot, the channels it is in, and how to reach it", () => {
    mockSlackBots(
      [{ agentId: "a1", agentName: "Potato", handle: "archestra_potato" }],
      { perAgent: true },
    );
    mockBotChannels(4);

    renderBuiltIn();

    const channels = screen
      .getByRole("heading", { level: 3, name: "In your channels" })
      .closest("div")?.parentElement as HTMLElement;
    expect(within(channels).getByText(/4 channels/)).toBeVisible();
    expect(within(channels).getAllByText("@archestra_potato")).toHaveLength(2);
    expect(
      within(channels).getByRole("button", { name: "Edit Slack bot" }),
    ).toBeVisible();
    expect(within(channels).queryByText(/Not reachable/)).toBeNull();
  });

  it("offers a Slack bot to an agent no chat app reaches yet", () => {
    mockSlackBots([], { perAgent: true });

    renderBuiltIn();

    expect(screen.getByText(/Give it a Slack bot/)).toBeVisible();
    expect(screen.getByRole("link", { name: "Add Slack bot" })).toHaveAttribute(
      "href",
      "/settings/messaging-channels/slack?addBot=a1",
    );
    expect(screen.queryByRole("link", { name: "Add a channel" })).toBeNull();
  });

  it("warns that Slack channels assigned to the agent have no bot to answer", () => {
    mockBindings([
      {
        id: "b1",
        agentId: "a1",
        provider: "slack",
        channelId: "C1",
        channelName: "alerting",
      },
    ]);
    mockSlackBots(
      [{ agentId: "other", agentName: "Other", handle: "archestra_other" }],
      { perAgent: true },
    );

    renderBuiltIn();

    expect(screen.getByText(/no bot answers as it there/)).toBeVisible();
    expect(
      screen.getByRole("link", { name: "Add its Slack bot" }),
    ).toHaveAttribute("href", "/settings/messaging-channels/slack?addBot=a1");
  });
});
