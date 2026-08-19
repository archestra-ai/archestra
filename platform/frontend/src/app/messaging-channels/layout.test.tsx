import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useHasPermissions } from "@/lib/auth/auth.query";
import { useAppearanceSettings } from "@/lib/organization.query";
import { useMyResourceAccess } from "@/lib/role-resource-access.query";
import AgentTriggersLayout from "./layout";

vi.mock("next/navigation");
vi.mock("@/lib/auth/auth.query");
vi.mock("@/lib/organization.query");
vi.mock("@/lib/role-resource-access.query");
vi.mock("./_components/use-trigger-statuses", () => ({
  useTriggerStatuses: () => ({
    msTeams: false,
    slack: false,
    telegram: false,
    telegramAvailable: false,
    email: false,
    a2a: true,
    firstActiveHref: null,
    isLoading: false,
  }),
}));

import { usePathname, useSearchParams } from "next/navigation";

/** `null` = the role is unrestricted; a list = exactly those channels. */
function renderLayout(messagingChannels: string[] | null) {
  vi.mocked(useMyResourceAccess).mockReturnValue({
    modelProviders: null,
    knowledgeConnectors: null,
    messagingChannels,
    connectClients: null,
  });
  return render(
    <AgentTriggersLayout>
      <div>channel configuration</div>
    </AgentTriggersLayout>,
  );
}

const NOTHING_ALLOWED: string[] = [];

describe("messaging channels layout", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(useHasPermissions).mockReturnValue({
      data: true,
    } as unknown as ReturnType<typeof useHasPermissions>);
    vi.mocked(usePathname).mockReturnValue("/messaging-channels");
    vi.mocked(useSearchParams).mockReturnValue(
      new URLSearchParams() as unknown as ReturnType<typeof useSearchParams>,
    );
    vi.mocked(useAppearanceSettings).mockReturnValue({
      data: undefined,
    } as unknown as ReturnType<typeof useAppearanceSettings>);
  });

  it("lists the channels still available in its description", () => {
    renderLayout(["slack", "telegram", "email", "a2a"]);

    expect(screen.getByText(/Manage how agents are invoked/)).toHaveTextContent(
      "Slack, Email and A2A",
    );
    expect(screen.getByText("channel configuration")).toBeInTheDocument();
  });

  // A role with no channels used to leave a page describing an empty list,
  // with the index route redirecting onto a channel that then said it was off.
  it("collapses to a single explanation when the role has no channels", () => {
    renderLayout(NOTHING_ALLOWED);

    expect(
      screen.getByText("Your role has no messaging channels."),
    ).toBeInTheDocument();
    expect(
      screen.getByText("No messaging channels are available"),
    ).toBeInTheDocument();
    expect(screen.queryByText("channel configuration")).not.toBeInTheDocument();
    expect(screen.queryByRole("tab")).not.toBeInTheDocument();
  });

  it("explains a channel the role lacks when reached by its own URL", () => {
    vi.mocked(usePathname).mockReturnValue("/messaging-channels/slack");
    renderLayout(["ms-teams", "telegram", "email", "a2a"]);

    expect(
      screen.getByText("Slack is not available to your role"),
    ).toBeInTheDocument();
    expect(screen.queryByText("channel configuration")).not.toBeInTheDocument();
  });

  it("shows every channel when the role is unrestricted", () => {
    renderLayout(null);

    expect(screen.getByText(/Manage how agents are invoked/)).toHaveTextContent(
      "Slack, MS Teams, Email and A2A",
    );
  });
});
