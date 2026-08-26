import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/config/config.query");

import { useSmallTeamTier } from "@/lib/config/config.query";
import { SmallTeamTierBanner } from "./small-team-tier-banner";

function mockTier(
  overrides: Partial<{ userCount: number; smallTeam: boolean }>,
) {
  vi.mocked(useSmallTeamTier).mockReturnValue({
    communicate: true,
    envFlag: false,
    threshold: 30,
    userCount: 5,
    smallTeam: true,
    ...overrides,
  } as ReturnType<typeof useSmallTeamTier>);
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("SmallTeamTierBanner", () => {
  it("says nothing at all when the tier is not meant to be communicated", () => {
    vi.mocked(useSmallTeamTier).mockReturnValue({
      communicate: false,
      envFlag: true,
      threshold: 30,
      userCount: 400,
      smallTeam: false,
    } as ReturnType<typeof useSmallTeamTier>);

    const { container } = render(<SmallTeamTierBanner />);

    expect(container).toBeEmptyDOMElement();
  });

  describe("without a feature name", () => {
    /**
     * The generic copy names the capabilities a license unlocks rather than
     * declaring a whole product area dead, so it stays true on pages that
     * keep working above the threshold.
     */
    it("names the gated capabilities instead of claiming a feature is off", () => {
      mockTier({ userCount: 42, smallTeam: false });

      render(<SmallTeamTierBanner />);

      expect(
        screen.getByText(
          /Enterprise features \(RBAC, SSO, Knowledge Base with access control\) are disabled until a license is activated\./,
        ),
      ).toBeInTheDocument();
    });

    it("confirms the features are included while under the threshold", () => {
      mockTier({ userCount: 5, smallTeam: true });

      render(<SmallTeamTierBanner />);

      expect(
        screen.getByText(
          /within the free tier for teams under 30 users\. Enterprise features \(RBAC, SSO, Knowledge Base with access control\) are included\./,
        ),
      ).toBeInTheDocument();
    });
  });

  describe("with a feature name", () => {
    it("declares that whole feature disabled above the threshold", () => {
      mockTier({ userCount: 42, smallTeam: false });

      render(<SmallTeamTierBanner featureName="SSO" />);

      expect(
        screen.getByText(
          /^SSO is an enterprise feature\. Your instance has 42 users, which exceeds the free tier for teams under 30 users, so it is disabled until a license is activated\./,
        ),
      ).toBeInTheDocument();
    });
  });

  it("uses the singular when the instance has one user", () => {
    mockTier({ userCount: 1, smallTeam: true });

    render(<SmallTeamTierBanner />);

    expect(
      screen.getByText(/Your instance has 1 user — within/),
    ).toBeInTheDocument();
  });
});
