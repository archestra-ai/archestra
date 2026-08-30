import type { archestraApiTypes } from "@archestra/shared";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useHasPermissions } from "@/lib/auth/auth.query";
import { useAgentEmailAddress } from "@/lib/chatops/incoming-email.query";
import { useFeature } from "@/lib/config/config.query";
import { useOrganization } from "@/lib/organization.query";
import {
  useFetchTeamTokenValue,
  useTokens,
} from "@/lib/teams/team-token.query";
import { useFetchUserTokenValue, useUserToken } from "@/lib/user-token.query";
import { A2AConnectionInstructions } from "./a2a-connection-instructions";

vi.mock("@/lib/auth/auth.query");
vi.mock("@/lib/organization.query");
vi.mock("@/lib/config/config.query", () => ({ useFeature: vi.fn() }));
vi.mock("@/lib/chatops/incoming-email.query", () => ({
  useAgentEmailAddress: vi.fn(),
}));
vi.mock("@/lib/teams/team-token.query", () => ({
  useTokens: vi.fn(),
  useFetchTeamTokenValue: vi.fn(),
}));
vi.mock("@/lib/user-token.query", () => ({
  useUserToken: vi.fn(),
  useFetchUserTokenValue: vi.fn(),
}));
// Registers its own queries and is not part of what these tests assert.
vi.mock("@/components/mcp-oauth-management", () => ({
  McpOauthManagement: ({ heading }: { heading?: { title: string } }) => (
    <div>{heading?.title}</div>
  ),
}));
vi.mock("@/components/agent-chat-apps", () => ({
  AgentChatApps: () => (
    <div className="space-y-2">
      <h4>Chat Apps</h4>
      <p className="text-xs text-muted-foreground">Assigned chat channels</p>
    </div>
  ),
}));
vi.mock(
  "@/app/settings/messaging-channels/email/agent-email-settings-dialog",
  () => ({
    AgentEmailSettingsDialog: () => null,
  }),
);

type Agent = archestraApiTypes.GetAllAgentsResponses["200"][number];

/** These tests read rendered markup, not query state, so a stub is enough. */
const stubQuery = <T,>(value: T) => value as never;

const baseAgent = {
  id: "agent-1",
  name: "Support",
  scope: "personal",
  incomingEmailEnabled: false,
  incomingEmailSecurityMode: "private",
  incomingEmailAllowedDomain: null,
  identityProviderId: null,
} as unknown as Agent;

function renderChannels(
  overrides: Partial<Agent> = {},
  { globalEmail = true }: { globalEmail?: boolean } = {},
) {
  vi.mocked(useFeature).mockReturnValue(stubQuery({ enabled: globalEmail }));
  render(
    <A2AConnectionInstructions
      agent={{ ...baseAgent, ...overrides }}
      layout="detail"
    />,
  );
  return screen
    .getByRole("heading", { name: "Other ways to reach this agent" })
    .closest("section") as HTMLElement;
}

/** The prose line a channel shows between its label and its copyable value. */
function proseFor(section: HTMLElement, label: string) {
  const heading = within(section).getByText(label);
  const channel = heading.closest(".space-y-2") as HTMLElement;
  return channel.querySelector("p") as HTMLElement;
}

beforeEach(() => {
  vi.mocked(useHasPermissions).mockReturnValue(stubQuery({ data: true }));
  vi.mocked(useOrganization).mockReturnValue(
    stubQuery({ data: { connectionBaseUrls: null } }),
  );
  vi.mocked(useTokens).mockReturnValue(stubQuery({ data: { tokens: [] } }));
  vi.mocked(useUserToken).mockReturnValue(stubQuery({ data: null }));
  vi.mocked(useFetchUserTokenValue).mockReturnValue(stubQuery({}));
  vi.mocked(useFetchTeamTokenValue).mockReturnValue(stubQuery({}));
  vi.mocked(useAgentEmailAddress).mockReturnValue(
    stubQuery({ data: { emailAddress: "support@agents.example.test" } }),
  );
});

describe("A2AConnectionInstructions — detail layout", () => {
  it("groups A2A setup before secondary channels and keeps request examples collapsed", async () => {
    const user = userEvent.setup();
    renderChannels();

    const apiHeading = screen.getByRole("heading", { name: "Call via API" });
    const apiSection = apiHeading.closest("section") as HTMLElement;
    expect(
      within(apiSection).getByRole("heading", { name: "Agent Endpoint" }),
    ).toBeVisible();
    expect(
      within(apiSection).getByRole("heading", { name: "Authentication" }),
    ).toBeVisible();
    const authenticationSection = within(apiSection)
      .getByRole("heading", { name: "Authentication" })
      .closest("section") as HTMLElement;
    expect(
      within(authenticationSection).getByText("OAuth clients"),
    ).toBeVisible();

    const channelsHeading = screen.getByRole("heading", {
      name: "Other ways to reach this agent",
    });
    expect(
      apiHeading.compareDocumentPosition(channelsHeading) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();

    const examplesTrigger = screen.getByRole("button", {
      name: /Request examples/,
    });
    expect(screen.queryByText("Continue the conversation")).toBeNull();
    expect(screen.queryByLabelText("Token for examples")).toBeNull();

    await user.click(examplesTrigger);
    expect(screen.getByLabelText("Token for examples")).toBeVisible();
    expect(screen.getByText("Continue the conversation")).toBeVisible();
  });

  // Email invocation used to render its guidance inside a bg-muted/50 panel at
  // text-sm, so the channel that most often has nothing to copy shouted over
  // the two above it. Every channel now gets the same one line of prose.
  it.each([
    ["off for the agent", { incomingEmailEnabled: false }, {}],
    [
      "off for the organization",
      { incomingEmailEnabled: false },
      { globalEmail: false },
    ],
    [
      "on",
      {
        incomingEmailEnabled: true,
        incomingEmailSecurityMode: "internal",
        incomingEmailAllowedDomain: "example.test",
      },
      {},
    ],
  ])("styles Email Invocation like the channels above it when email is %s", (_case, agentOverrides, options) => {
    const section = renderChannels(agentOverrides as Partial<Agent>, options);

    const deepLinkProse = proseFor(section, "Chat Deep Link");
    const chatAppsProse = proseFor(section, "Chat Apps");
    const emailProse = proseFor(section, "Email Invocation");

    expect(emailProse.className).toBe(deepLinkProse.className);
    expect(emailProse.className).toBe(chatAppsProse.className);
  });

  it("keeps the email address copyable when email invocation is on", () => {
    const section = renderChannels({
      incomingEmailEnabled: true,
    } as Partial<Agent>);

    expect(
      within(section).getByText("support@agents.example.test"),
    ).toBeInTheDocument();
  });

  it.each([
    [false, "Enable email"],
    [true, "Edit settings"],
  ])("offers agent-level email settings when invocation enabled is %s", (incomingEmailEnabled, buttonLabel) => {
    const section = renderChannels({ incomingEmailEnabled } as Partial<Agent>);

    expect(
      within(section).getByRole("button", { name: buttonLabel }),
    ).toBeInTheDocument();
  });

  it("does not offer agent-level email settings until the provider is configured", () => {
    const section = renderChannels({}, { globalEmail: false });

    expect(
      within(section).queryByRole("button", { name: "Enable email" }),
    ).not.toBeInTheDocument();
  });
});
