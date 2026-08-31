import {
  type archestraApiTypes,
  DocsPage,
  getDocsUrl,
} from "@archestra/shared";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useHasPermissions } from "@/lib/auth/auth.query";
import { useOrganization } from "@/lib/organization.query";
import {
  useFetchTeamTokenValue,
  useTokens,
} from "@/lib/teams/team-token.query";
import { useFetchUserTokenValue, useUserToken } from "@/lib/user-token.query";
import { A2AConnectionInstructions } from "./a2a-connection-instructions";

vi.mock("@/lib/auth/auth.query");
vi.mock("@/lib/organization.query");
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

function renderChannels(overrides: Partial<Agent> = {}) {
  const { container } = render(
    <A2AConnectionInstructions
      agent={{ ...baseAgent, ...overrides }}
      layout="detail"
    />,
  );
  return container;
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
});

describe("A2AConnectionInstructions — detail layout", () => {
  it("gives each concern its own section, with the examples collapsed", async () => {
    const user = userEvent.setup();
    vi.mocked(useUserToken).mockReturnValue(
      stubQuery({ data: { tokenStart: "arch_bb566777c" } }),
    );
    renderChannels();

    // Four sections, in the order someone works through them. There is no
    // "Call via API" wrapper any more: the tab is already named A2A.
    expect(
      screen
        .getAllByRole("heading", { level: 3 })
        .map((heading) => heading.textContent),
    ).toEqual(["Endpoint", "Authentication", "OAuth clients", "Examples"]);
    expect(screen.queryByText("Call via API")).toBeNull();

    // The token is readable and copyable where authentication is explained,
    // rather than only inside an example.
    const authentication = screen
      .getByRole("heading", { name: "Authentication" })
      .closest("section") as HTMLElement;
    expect(within(authentication).getByText("arch_bb566777c***")).toBeVisible();
    expect(
      within(authentication).getByRole("button", {
        name: "Copy your platform token",
      }),
    ).toBeEnabled();
    expect(
      within(authentication).getByRole("link", { name: "Learn more" }),
    ).toHaveAttribute(
      "href",
      `${getDocsUrl(DocsPage.PlatformAgentTriggersWebhookA2a)}#authentication`,
    );

    // Reference material stays folded away, and the chat deep link is folded
    // with it rather than sitting in a section of its own.
    expect(screen.queryByText("Continue the conversation")).toBeNull();
    expect(screen.queryByLabelText("Token for examples")).toBeNull();
    expect(screen.queryByText("Chat Deep Link")).toBeNull();

    await user.click(screen.getByRole("button", { name: /Show examples/ }));
    expect(screen.getByLabelText("Token for examples")).toBeVisible();
    expect(screen.getByText("Continue the conversation")).toBeVisible();
    expect(screen.getByText("Chat Deep Link")).toBeVisible();
  });

  it("leaves the messaging channels to their own tab", () => {
    // Channels are a section of the record's page now, so the A2A tab neither
    // lists them nor singles Email out.
    const container = renderChannels({
      incomingEmailEnabled: true,
    } as Partial<Agent>);

    expect(within(container).queryByText("Email Invocation")).toBeNull();
    expect(within(container).queryByText("Messaging channels")).toBeNull();
  });
});
