import { renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { useCredentialsPageHref } from "@/components/settings-link";
import { useCredentialsPage } from "./use-credentials-page";
import { useNavPermissionMap } from "./use-settings-area-access";

vi.mock("./use-settings-area-access", () => ({
  useNavPermissionMap: vi.fn(),
  useSettingsAreaAccess: vi.fn(),
}));

function withMap(map: Record<string, boolean> | null) {
  vi.mocked(useNavPermissionMap).mockReturnValue(map);
  return {
    page: renderHook(() => useCredentialsPage()).result.current,
    href: renderHook(() => useCredentialsPageHref()).result.current,
  };
}

describe("useCredentialsPage", () => {
  it("is Settings → Credentials for a reader who can open it", () => {
    expect(
      withMap({ "/settings": true, "/settings/credentials": true }),
    ).toEqual({
      page: { href: "/settings/credentials" },
      href: "/settings/credentials",
    });
  });

  it("is Personal Settings when Settings is hidden, even with the page permission", () => {
    // The member baseline: credential:read, but nothing to manage.
    expect(
      withMap({ "/settings": false, "/settings/credentials": true }),
    ).toEqual({
      page: { href: "/account/credentials" },
      href: "/account/credentials",
    });
  });

  it("is Personal Settings when Settings is visible but its Credentials page is not", () => {
    expect(
      withMap({ "/settings": true, "/settings/credentials": false }).href,
    ).toBe("/account/credentials");
  });

  it("is unknown until permissions load; links fall back to Personal Settings, which forwards", () => {
    expect(withMap(null)).toEqual({
      page: null,
      href: "/account/credentials",
    });
  });
});
