import { renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useAppearanceSettings } from "@/lib/organization.query";

const { mockUseTheme } = vi.hoisted(() => ({
  mockUseTheme: vi.fn(),
}));

vi.mock("@/lib/organization.query");

vi.mock("next-themes", () => ({
  useTheme: () => mockUseTheme(),
}));

function mockAppearance(data: unknown) {
  vi.mocked(useAppearanceSettings).mockReturnValue({
    data,
  } as unknown as ReturnType<typeof useAppearanceSettings>);
}

import { useAppIconLogo, useAppName } from "./use-app-name";

describe("useAppName", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAppearance(null);
  });

  it("uses the public appearance app name when available", () => {
    mockAppearance({ appName: "Sparky" });

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
    mockAppearance(null);
    mockUseTheme.mockReturnValue({ resolvedTheme: "light" });
  });

  it("uses the public appearance icon logo when available", () => {
    mockAppearance({ iconLogo: "data:image/png;base64,appearance" });

    const { result } = renderHook(() => useAppIconLogo());

    expect(result.current).toBe("data:image/png;base64,appearance");
  });

  it("falls back to the default app logo when no branding is available", () => {
    const { result } = renderHook(() => useAppIconLogo());

    expect(result.current).toBe("/logo-icon.svg");
  });

  it("uses the dark icon logo in dark mode when available", () => {
    mockUseTheme.mockReturnValue({ resolvedTheme: "dark" });
    mockAppearance({
      iconLogo: "data:image/png;base64,light",
      iconLogoDark: "data:image/svg+xml;base64,dark",
    });

    const { result } = renderHook(() => useAppIconLogo());

    expect(result.current).toBe("data:image/svg+xml;base64,dark");
  });

  it("falls back to the light icon logo in dark mode when no dark variant is set", () => {
    mockUseTheme.mockReturnValue({ resolvedTheme: "dark" });
    mockAppearance({
      iconLogo: "data:image/png;base64,light",
      iconLogoDark: null,
    });

    const { result } = renderHook(() => useAppIconLogo());

    expect(result.current).toBe("data:image/png;base64,light");
  });
});
