import { renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockUseOrganization, mockUseAppearanceSettings } = vi.hoisted(() => ({
  mockUseOrganization: vi.fn(),
  mockUseAppearanceSettings: vi.fn(),
}));

vi.mock("@/lib/organization.query", () => ({
  useOrganization: () => mockUseOrganization(),
  useAppearanceSettings: () => mockUseAppearanceSettings(),
}));

import { useAppName } from "./use-app-name";

describe("useAppName", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUseOrganization.mockReturnValue({ data: null });
    mockUseAppearanceSettings.mockReturnValue({ data: null });
  });

  it("uses the organization app name when available", () => {
    mockUseOrganization.mockReturnValue({
      data: { appName: "Sparky" },
    });
    mockUseAppearanceSettings.mockReturnValue({
      data: { appName: "Other Name" },
    });

    const { result } = renderHook(() => useAppName());

    expect(result.current).toBe("Sparky");
  });

  it("falls back to public appearance settings on unauthenticated pages", () => {
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
