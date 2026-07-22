import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useAppName } from "@/lib/hooks/use-app-name";

const { mockUseOrgTheme, mockUseTheme } = vi.hoisted(() => ({
  mockUseOrgTheme: vi.fn(),
  mockUseTheme: vi.fn(),
}));

vi.mock("next/image", () => ({
  default: ({
    alt,
    src,
    className,
  }: {
    alt: string;
    src: string;
    className?: string;
  }) => <img alt={alt} src={src} className={className} />,
}));

vi.mock("next-themes", () => ({
  useTheme: () => mockUseTheme(),
}));

vi.mock("@/lib/theme.hook", () => ({
  useOrgTheme: () => mockUseOrgTheme(),
}));

vi.mock("@/lib/hooks/use-app-name");

import { AppLogo } from "./app-logo";

describe("AppLogo", () => {
  beforeEach(() => {
    vi.mocked(useAppName).mockReturnValue("Acme");
  });

  it("does not render fallback branding while appearance is still loading", () => {
    mockUseTheme.mockReturnValue({ resolvedTheme: "light" });
    mockUseOrgTheme.mockReturnValue({
      isLoadingAppearance: true,
      logo: null,
      logoDark: null,
    });

    render(<AppLogo />);

    expect(screen.queryByText("Archestra.AI")).not.toBeInTheDocument();
    expect(screen.queryByAltText("Acme logo")).not.toBeInTheDocument();
  });

  it("renders the organization logo with the app name as alt text", () => {
    mockUseTheme.mockReturnValue({ resolvedTheme: "light" });
    mockUseOrgTheme.mockReturnValue({
      isLoadingAppearance: false,
      logo: "data:image/png;base64,custom",
      logoDark: null,
    });

    render(<AppLogo />);

    expect(screen.getByAltText("Acme logo")).toHaveAttribute(
      "src",
      "data:image/png;base64,custom",
    );
    expect(screen.queryByText("Archestra.AI")).not.toBeInTheDocument();
  });

  it("uses stable dimensions for the default logo and marks it decorative", () => {
    mockUseTheme.mockReturnValue({ resolvedTheme: "light" });
    mockUseOrgTheme.mockReturnValue({
      isLoadingAppearance: false,
      logo: null,
      logoDark: null,
    });

    const { container } = render(<AppLogo />);

    // Decorative (alt="") because the app name is visible text beside it
    const img = container.querySelector("img");
    expect(img).toHaveAttribute("alt", "");
    expect(img).toHaveClass("size-7", "shrink-0");
    expect(screen.getByText("Archestra.AI")).toBeInTheDocument();
  });
});
