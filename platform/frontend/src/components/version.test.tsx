import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  mockUseHealth,
  mockUseConfig,
  mockUseSession,
  mockUseLatestGitHubRelease,
  mockUseOrganization,
  mockUseAppearanceSettings,
} = vi.hoisted(() => ({
  mockUseHealth: vi.fn(),
  mockUseConfig: vi.fn(),
  mockUseSession: vi.fn(),
  mockUseLatestGitHubRelease: vi.fn(),
  mockUseOrganization: vi.fn(),
  mockUseAppearanceSettings: vi.fn(),
}));

const mockConfig = {
  enterpriseFeatures: {
    fullWhiteLabeling: false,
  },
};

vi.mock("next/link", () => ({
  default: ({
    children,
    href,
  }: {
    children: React.ReactNode;
    href: string;
  }) => <a href={href}>{children}</a>,
}));

vi.mock("@/lib/config/config", () => ({
  default: new Proxy(
    {},
    {
      get: (_target, prop) =>
        prop in mockConfig
          ? mockConfig[prop as keyof typeof mockConfig]
          : undefined,
    },
  ),
}));

vi.mock("@/lib/config/health.query", () => ({
  useHealth: (params?: { enabled?: boolean }) => mockUseHealth(params),
}));

vi.mock("@/lib/config/config.query", () => ({
  useConfig: () => mockUseConfig(),
}));

vi.mock("@/lib/auth/auth.query", () => ({
  useSession: () => mockUseSession(),
}));

vi.mock("@/lib/github/github-release.query", () => ({
  useLatestGitHubRelease: (params?: { enabled?: boolean }) =>
    mockUseLatestGitHubRelease(params),
}));

vi.mock("@/lib/organization.query", () => ({
  useOrganization: () => mockUseOrganization(),
  useAppearanceSettings: () => mockUseAppearanceSettings(),
}));

import { Version } from "./version";

describe("Version", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockConfig.enterpriseFeatures.fullWhiteLabeling = false;

    // Signed out by default: the version comes from /health.
    mockUseSession.mockReturnValue({ data: null, isPending: false });
    mockUseConfig.mockReturnValue({ data: undefined });
    mockUseHealth.mockReturnValue({
      data: { version: "1.1.32" },
    });
    mockUseLatestGitHubRelease.mockReturnValue({
      data: {
        tag_name: "platform-v1.1.33",
        html_url:
          "https://github.com/archestra-ai/archestra/releases/tag/platform-v1.1.33",
      },
    });
    mockUseOrganization.mockReturnValue({ data: null });
    mockUseAppearanceSettings.mockReturnValue({ data: null });
  });

  it("signed in, reads the version from the loaded config instead of asking /health", () => {
    mockUseSession.mockReturnValue({
      data: { user: { id: "user-1" } },
      isPending: false,
    });
    mockUseConfig.mockReturnValue({ data: { version: "1.1.32" } });
    mockUseHealth.mockReturnValue({ data: undefined });

    render(<Version inline />);

    expect(screen.getByText(/Version: 1\.1\.32/)).toBeInTheDocument();
    expect(mockUseHealth).toHaveBeenCalledWith({ enabled: false });
  });

  // A signed-in page load renders the footer before its session check
  // answers; asking /health then is a request nobody reads.
  it("asks /health nothing until the session check says signed out", () => {
    mockUseSession.mockReturnValue({ data: undefined, isPending: true });
    mockUseHealth.mockReturnValue({ data: undefined });

    render(<Version inline />);

    expect(mockUseHealth).toHaveBeenCalledWith({ enabled: false });
    expect(mockUseHealth).not.toHaveBeenCalledWith({ enabled: true });
  });

  it("shows the latest release link by default", async () => {
    const { container } = render(<Version inline />);

    expect(container.firstChild).toHaveTextContent("Version: 1.1.32");
    // The version comparison loads its semver dependency on demand.
    expect(
      await screen.findByRole("link", {
        name: "v1.1.33",
      }),
    ).toHaveAttribute(
      "href",
      "https://github.com/archestra-ai/archestra/releases/tag/platform-v1.1.33",
    );
  });

  it("hides the latest release link under full white-labeling", () => {
    mockConfig.enterpriseFeatures.fullWhiteLabeling = true;

    const { container } = render(<Version inline />);

    expect(container.firstChild).toHaveTextContent("Version: 1.1.32");
    expect(screen.queryByText(/new:/i)).not.toBeInTheDocument();
    expect(
      screen.queryByRole("link", {
        name: "v1.1.33",
      }),
    ).not.toBeInTheDocument();
    expect(mockUseLatestGitHubRelease).toHaveBeenCalledWith({
      enabled: false,
      deferMs: 5000,
    });
  });

  it("skips latest release lookup when custom footer text is configured", () => {
    mockUseOrganization.mockReturnValue({
      data: { footerText: "Custom footer" },
    });

    const { container } = render(<Version inline />);

    expect(container.firstChild).toHaveTextContent("Custom footer (v1.1.32)");
    expect(mockUseLatestGitHubRelease).toHaveBeenCalledWith({
      enabled: false,
      deferMs: 5000,
    });
  });

  it("shortens a full commit SHA and keeps the full value in the title", () => {
    const sha = "f12beffe7b60b380558b47c052fa7a00533cd312";
    mockUseHealth.mockReturnValue({ data: { version: sha } });
    mockUseOrganization.mockReturnValue({
      data: { footerText: "Custom footer" },
    });

    const { container } = render(<Version inline />);

    expect(container.firstChild).toHaveTextContent("Custom footer (vf12beff)");
    expect(container.firstChild).not.toHaveTextContent(sha);
    expect(container.firstChild).toHaveAttribute("title", sha);
  });
});
