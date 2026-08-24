import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useHasPermissions } from "@/lib/auth/auth.query";
import {
  useAppearanceSettings,
  useOrganization,
} from "@/lib/organization.query";
import AgentTriggersLayout from "./layout";

vi.mock("next/navigation");
vi.mock("@/lib/auth/auth.query");
vi.mock("@/lib/organization.query");

/** Mutable so a test can say which channels are set up; reset in `beforeEach`. */
const triggerStatuses = {
  msTeams: false,
  slack: false,
  telegram: false,
  telegramAvailable: false,
  email: false,
  a2a: true,
  firstActiveHref: null,
  isLoading: false,
};

vi.mock("./_components/use-trigger-statuses", () => ({
  useTriggerStatuses: () => triggerStatuses,
}));

import { usePathname, useSearchParams } from "next/navigation";

function renderLayout(overrides: Record<string, { hidden?: boolean }> | null) {
  vi.mocked(useOrganization).mockReturnValue({
    data: { messagingChannelOverrides: overrides },
  } as unknown as ReturnType<typeof useOrganization>);
  return render(
    <AgentTriggersLayout>
      <div>channel configuration</div>
    </AgentTriggersLayout>,
  );
}

const ALL_OFF = {
  slack: { hidden: true },
  "ms-teams": { hidden: true },
  telegram: { hidden: true },
  email: { hidden: true },
  a2a: { hidden: true },
};

describe("messaging channels layout", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    Object.assign(triggerStatuses, {
      msTeams: false,
      slack: false,
      telegram: false,
      telegramAvailable: false,
      email: false,
      a2a: true,
    });
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
    renderLayout({ "ms-teams": { hidden: true } });

    expect(screen.getByText(/Manage how agents are invoked/)).toHaveTextContent(
      "Slack, Email and A2A",
    );
    expect(screen.getByText("channel configuration")).toBeInTheDocument();
  });

  // Every channel off used to leave a page describing an empty list, with the
  // index route redirecting onto a channel that then said it was turned off.
  it("collapses to a single explanation when every channel is off", () => {
    renderLayout(ALL_OFF);

    expect(
      screen.getByText(
        "Every messaging channel is turned off for this organization.",
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByText("No messaging channels are available"),
    ).toBeInTheDocument();
    expect(screen.queryByText("channel configuration")).not.toBeInTheDocument();
    expect(screen.queryByRole("tab")).not.toBeInTheDocument();
  });

  it("no longer offers a per-page settings dialog", () => {
    renderLayout(ALL_OFF);

    // Availability moved to Agent settings, so the page carries no admin
    // control of its own — only the explanation of why it is empty.
    expect(
      screen.queryByTestId("messaging-channel-page-settings"),
    ).not.toBeInTheDocument();
    expect(
      screen.getByText("No messaging channels are available"),
    ).toBeInTheDocument();
  });

  /**
   * The tab labels carry an "Active"/"Configure" status badge, and the setup
   * status used to be handed to `PageLayout` as its selection override too.
   * Every connected channel then rendered as the open page — underline,
   * foreground text and `aria-current="page"` — whichever one the reader was
   * actually on.
   */
  it("selects only the channel whose page is open, whatever the others' status", () => {
    vi.mocked(usePathname).mockReturnValue("/messaging-channels/slack");
    Object.assign(triggerStatuses, { msTeams: true, a2a: true, slack: false });

    renderLayout(null);

    const current = document.querySelectorAll('[aria-current="page"]');
    expect(current.length).toBeGreaterThan(0);
    for (const link of current) {
      expect(link).toHaveAttribute("href", "/messaging-channels/slack");
    }

    // The badges still report status, they just no longer select anything.
    expect(screen.getAllByText("Active").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Configure").length).toBeGreaterThan(0);
  });

  it("explains a single turned-off channel reached by its own URL", () => {
    vi.mocked(usePathname).mockReturnValue("/messaging-channels/slack");
    renderLayout({ slack: { hidden: true } });

    expect(screen.getByText("Slack is turned off")).toBeInTheDocument();
    expect(screen.queryByText("channel configuration")).not.toBeInTheDocument();
  });
});
