import { renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockUseAppearanceSettings } = vi.hoisted(() => ({
  mockUseAppearanceSettings: vi.fn(),
}));

vi.mock("@/lib/organization.query", () => ({
  useAppearanceSettings: () => mockUseAppearanceSettings(),
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
});
