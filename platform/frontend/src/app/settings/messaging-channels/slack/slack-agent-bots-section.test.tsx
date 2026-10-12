import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useSearchParams } from "next/navigation";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useInternalAgents } from "@/lib/agent.query";
import { useSession } from "@/lib/auth/auth.query";
import {
  useConvertSlackAppToAgentBot,
  useCreateSlackAgentBotApp,
  useDeleteSlackAgentBot,
  useMigrateSlackApps,
  useSaveSlackAppConfigToken,
  useSlackAgentBots,
  useUpdateSlackAgentBot,
} from "@/lib/chatops/chatops-config.query";
import { useAppName } from "@/lib/hooks/use-app-name";
import { SlackAgentBotsSection } from "./slack-agent-bots-section";

const router = vi.hoisted(() => ({ replace: vi.fn() }));
vi.mock("next/navigation", () => ({
  useRouter: () => router,
  useSearchParams: vi.fn(),
}));
vi.mock("@/lib/auth/auth.query");
vi.mock("@/lib/hooks/use-app-name");
vi.mock("@/lib/agent.query", () => ({ useInternalAgents: vi.fn() }));
vi.mock("@/lib/chatops/chatops-config.query", () => ({
  useConvertSlackAppToAgentBot: vi.fn(),
  useCreateSlackAgentBotApp: vi.fn(),
  useDeleteSlackAgentBot: vi.fn(),
  useMigrateSlackApps: vi.fn(),
  useSaveSlackAppConfigToken: vi.fn(),
  useSlackAgentBots: vi.fn(),
  useUpdateSlackAgentBot: vi.fn(),
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
      unassignedApp: null,
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
  );
}

const mutation = (mutateAsync = vi.fn()) => ({
  mutate: vi.fn(),
  mutateAsync,
  isPending: false,
});

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(useAppName).mockReturnValue("Archestra");
  vi.mocked(useSession).mockReturnValue({
    data: { user: { id: "me" } },
  } as unknown as ReturnType<typeof useSession>);
  vi.mocked(useInternalAgents).mockReturnValue({
    data: [
      { id: "a1", name: "Marketing" },
      { id: "a2", name: "Coding" },
      { id: "a3", name: "Sales" },
    ],
  } as unknown as ReturnType<typeof useInternalAgents>);
  saveToken.mockResolvedValue({ success: true, migrated: [] });
  vi.mocked(useSaveSlackAppConfigToken).mockReturnValue(
    mutation(saveToken) as unknown as ReturnType<
      typeof useSaveSlackAppConfigToken
    >,
  );
  for (const hook of [
    useConvertSlackAppToAgentBot,
    useCreateSlackAgentBotApp,
    useDeleteSlackAgentBot,
    useMigrateSlackApps,
    useUpdateSlackAgentBot,
  ]) {
    vi.mocked(hook).mockReturnValue(mutation() as never);
  }
});

describe("SlackAgentBotsSection", () => {
  it("says whose Slack app each bot is, so teammates know whom to ask", () => {
    setup({
      bots: [
        bot("a1", "Marketing", { createdBy: { id: "me", name: "Me" } }),
        bot("a2", "Coding", { createdBy: { id: "u2", name: "Dana" } }),
      ],
    });

    expect(screen.getByText("Your Slack app")).toBeVisible();
    expect(
      screen.getByText("Dana's Slack app — ask them to add you in Slack"),
    ).toBeVisible();
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
