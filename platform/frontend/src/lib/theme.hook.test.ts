import { renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAppearanceSettings } from "./organization.query";
import { useOrgTheme } from "./theme.hook";

vi.mock("next/navigation", () => ({ usePathname: () => "/chat" }));
vi.mock("./organization.query", () => ({
  useAppearanceSettings: vi.fn(),
  useUpdateAppearanceSettings: () => ({ mutateAsync: vi.fn() }),
}));

describe("useOrgTheme", () => {
  afterEach(() => {
    document.documentElement.className = "";
    localStorage.clear();
  });

  it("keeps the server-rendered theme while the appearance settings load", () => {
    // The server painted the organization's theme; this browser has no
    // remembered choice yet.
    document.documentElement.className = "theme-cosmic-night";
    vi.mocked(useAppearanceSettings).mockReturnValue({
      data: undefined,
      isLoading: true,
    } as unknown as ReturnType<typeof useAppearanceSettings>);

    renderHook(() => useOrgTheme());

    expect(document.documentElement.classList).toContain("theme-cosmic-night");
    expect(document.documentElement.classList).not.toContain("theme-caffeine");
  });

  it("follows a later change from the backend", () => {
    document.documentElement.className = "theme-cosmic-night";
    vi.mocked(useAppearanceSettings).mockReturnValue({
      data: { theme: "caffeine" },
      isLoading: false,
    } as unknown as ReturnType<typeof useAppearanceSettings>);

    renderHook(() => useOrgTheme());

    expect(document.documentElement.classList).toContain("theme-caffeine");
    expect(document.documentElement.classList).not.toContain(
      "theme-cosmic-night",
    );
  });
});
