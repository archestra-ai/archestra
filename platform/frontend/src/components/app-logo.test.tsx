import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

const { mockUseOrgTheme, mockUseTheme } = vi.hoisted(() => ({
  mockUseOrgTheme: vi.fn(),
  mockUseTheme: vi.fn(),
}));

vi.mock("next/image", () => ({
  default: ({ alt, src }: { alt: string; src: string }) => (
    <img alt={alt} src={src} />
  ),
}));

vi.mock("next-themes", () => ({
  useTheme: () => mockUseTheme(),
}));

vi.mock("@/lib/theme.hook", () => ({
  useOrgTheme: () => mockUseOrgTheme(),
}));

import { AppLogo } from "./app-logo";

describe("AppLogo", () => {
  it("does not render fallback branding while appearance is still loading", () => {
    mockUseTheme.mockReturnValue({ resolvedTheme: "light" });
    mockUseOrgTheme.mockReturnValue({
      isLoadingAppearance: true,
      logo: null,
      logoDark: null,
    });

    render(<AppLogo />);

    expect(screen.queryByText("Archestra.AI")).not.toBeInTheDocument();
    expect(screen.queryByAltText("Organization logo")).not.toBeInTheDocument();
  });

  it("renders the organization logo after appearance loads", () => {
    mockUseTheme.mockReturnValue({ resolvedTheme: "light" });
    mockUseOrgTheme.mockReturnValue({
      isLoadingAppearance: false,
      logo: "data:image/png;base64,custom",
      logoDark: null,
    });

    render(<AppLogo />);

    expect(screen.getByAltText("Organization logo")).toHaveAttribute(
      "src",
      "data:image/png;base64,custom",
    );
    expect(screen.queryByText("Archestra.AI")).not.toBeInTheDocument();
  });
});
