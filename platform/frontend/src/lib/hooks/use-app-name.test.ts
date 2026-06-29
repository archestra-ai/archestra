import { renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockUseAppearanceSettings, mockUseTheme } = vi.hoisted(() => ({
  mockUseAppearanceSettings: vi.fn(),
  mockUseTheme: vi.fn(),
}));

vi.mock("@/lib/organization.query", () => ({
  useAppearanceSettings: () => mockUseAppearanceSettings(),
}));

vi.mock("next-themes", () => ({
  useTheme: () => mockUseTheme(),
}));

import { useAppIconLogo, useAppName } from "./use-app-name";

describe("useAppName", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUseAppearanceSettings.mockReturnValue({ data: null });
  });

  it("uses the public appearance app name when available", () => {
    mockUseAppearanceSettings.mockReturnValue({
      data: { appName: "Sparky" },
    });

    const { result } = renderHook(() => useAppName());

    expect(result.current).toBe("Sparky");
  });

  it("falls back to the default app name when no branding is available", () => {
    const { result } = renderHook(() => useAppName());

    expect(result.current).toBe("Archestra");
  });
});

describe("useAppIconLogo", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUseAppearanceSettings.mockReturnValue({ data: null });
    mockUseTheme.mockReturnValue({ resolvedTheme: "light" });
  });

  it("uses the public appearance icon logo when available", () => {
    mockUseAppearanceSettings.mockReturnValue({
      data: { iconLogo: "data:image/png;base64,appearance" },
    });

    const { result } = renderHook(() => useAppIconLogo());

    expect(result.current).toBe("data:image/png;base64,appearance");
  });

  it("falls back to the default app logo when no branding is available", () => {
    const { result } = renderHook(() => useAppIconLogo());

    expect(result.current).toBe("/logo-icon.svg");
  });

  it("uses the dark icon logo in dark mode when available", () => {
    mockUseTheme.mockReturnValue({ resolvedTheme: "dark" });
    mockUseAppearanceSettings.mockReturnValue({
      data: {
        iconLogo: "data:image/png;base64,light",
        iconLogoDark: "data:image/svg+xml;base64,dark",
      },
    });

    const { result } = renderHook(() => useAppIconLogo());

    expect(result.current).toBe("data:image/svg+xml;base64,dark");
  });

  it("falls back to the light icon logo in dark mode when no dark variant is set", () => {
    mockUseTheme.mockReturnValue({ resolvedTheme: "dark" });
    mockUseAppearanceSettings.mockReturnValue({
      data: { iconLogo: "data:image/png;base64,light", iconLogoDark: null },
    });

    const { result } = renderHook(() => useAppIconLogo());

    expect(result.current).toBe("data:image/png;base64,light");
  });
});
