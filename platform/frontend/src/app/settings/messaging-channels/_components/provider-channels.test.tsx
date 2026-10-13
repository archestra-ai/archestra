import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useInternalAgents } from "@/lib/agent.query";
import { useHasPermissions } from "@/lib/auth/auth.query";
import {
  useAllChatOpsBindings,
  useUpdateChatOpsBinding,
} from "@/lib/chatops/chatops.query";
import { ProviderChannels } from "./provider-channels";

vi.mock("@/lib/auth/auth.query");
vi.mock("@/lib/agent.query", () => ({ useInternalAgents: vi.fn() }));
vi.mock("@/lib/chatops/chatops.query", () => ({
  useAllChatOpsBindings: vi.fn(),
  useUpdateChatOpsBinding: vi.fn(),
}));
vi.mock("./channel-details-dialog", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./channel-details-dialog")>()),
  ChannelDetailsDialog: ({ open }: { open: boolean }) =>
    open ? <div role="dialog" aria-label="Channel settings" /> : null,
}));

function binding(
  id: string,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id,
    provider: "ms-teams",
    channelId: `19:${id}`,
    channelName: id,
    workspaceId: "T1",
    workspaceName: "Engineering",
    isDm: false,
    answerAllMessages: false,
    channelInstructions: null,
    dmOwnerEmail: null,
    agentId: "a1",
    ...extra,
  };
}

function setup(
  bindings: Record<string, unknown>[],
  workspacesWithUnmentionedTraffic: string[] = [],
) {
  vi.mocked(useAllChatOpsBindings).mockReturnValue({
    data: {
      bindings,
      pages: [{ workspacesWithUnmentionedTraffic }],
    },
    isPending: false,
  } as unknown as ReturnType<typeof useAllChatOpsBindings>);
  render(<ProviderChannels provider="ms-teams" />);
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(useHasPermissions).mockReturnValue({
    data: true,
    isPending: false,
  } as ReturnType<typeof useHasPermissions>);
  vi.mocked(useInternalAgents).mockReturnValue({
    data: [
      { id: "a1", name: "Marketing", agentType: "agent" },
      { id: "a2", name: "Support", agentType: "agent" },
    ],
  } as unknown as ReturnType<typeof useInternalAgents>);
  vi.mocked(useUpdateChatOpsBinding).mockReturnValue({
    mutate: vi.fn(),
    mutateAsync: vi.fn(),
    isPending: false,
  } as unknown as ReturnType<typeof useUpdateChatOpsBinding>);
});

describe("ProviderChannels", () => {
  it("lists the provider's channels with how each one replies", () => {
    setup([
      binding("general", { answerAllMessages: true, channelInstructions: "x" }),
      binding("escalations"),
      binding("deals", { provider: "slack" }),
    ]);

    expect(screen.getByRole("cell", { name: /general/ })).toBeVisible();
    expect(screen.getByRole("cell", { name: /escalations/ })).toBeVisible();
    expect(screen.queryByRole("cell", { name: /deals/ })).toBeNull();
    expect(screen.getByRole("cell", { name: "All messages" })).toBeVisible();
    expect(screen.getByRole("cell", { name: "When @mentioned" })).toBeVisible();
  });

  it("keeps personal chats out until asked for", async () => {
    setup([
      binding("general"),
      binding("dm1", { isDm: true, dmOwnerEmail: "pat@example.com" }),
    ]);

    expect(screen.queryByText(/pat@example.com/)).toBeNull();
    await userEvent.click(
      screen.getByRole("button", { name: "Show 1 personal chat" }),
    );
    expect(screen.getByText(/pat@example.com/)).toBeVisible();
  });

  it("searches channels by name", async () => {
    setup([binding("general"), binding("escalations")]);

    await userEvent.type(
      screen.getByRole("textbox", { name: "Search channels" }),
      "escal",
    );

    expect(screen.getByRole("cell", { name: /escalations/ })).toBeVisible();
    expect(screen.queryByRole("cell", { name: /general/ })).toBeNull();
  });

  it("warns when replying to all may not work yet in a team", () => {
    setup(
      [
        binding("general", { answerAllMessages: true }),
        binding("support", { answerAllMessages: true, workspaceId: "T2" }),
      ],
      ["T2"],
    );

    expect(
      screen.getAllByText(/A team owner may need to allow the bot/),
    ).toHaveLength(1);
  });

  it("opens a channel's settings", async () => {
    setup([binding("general")]);

    await userEvent.click(
      screen.getByRole("button", { name: "Settings for general" }),
    );

    expect(
      screen.getByRole("dialog", { name: "Channel settings" }),
    ).toBeVisible();
  });

  it("says how to get a first channel", () => {
    setup([]);

    expect(screen.getByText(/No MS Teams channels yet/)).toBeVisible();
  });
});
