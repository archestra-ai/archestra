import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  mockUseHealth,
  mockUseLatestGitHubRelease,
  mockUseOrganization,
  mockUseAppearanceSettings,
} = vi.hoisted(() => ({
  mockUseHealth: vi.fn(),
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
  useHealth: () => mockUseHealth(),
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

  it("shows the latest release link by default", () => {
    const { container } = render(<Version inline />);

    expect(container.firstChild).toHaveTextContent("Version: 1.1.32");
    expect(
      screen.getByRole("link", {
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
