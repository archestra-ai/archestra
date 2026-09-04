import { renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { useSettingsTabs } from "@/app/settings/settings-tabs";
import {
  getSettingsNavigationUrl,
  SETTINGS_TAB_HREFS,
} from "./settings-navigation";

const allPermitted = Object.fromEntries(
  SETTINGS_TAB_HREFS.map((href) => [href, true]),
);

vi.mock("@/lib/auth/auth.query", () => ({
  usePermissionMap: () =>
    Object.fromEntries(
      [
        "/settings/appearance",
        "/settings/auth",
        "/settings/service-accounts",
        "/settings/oauth-clients",
        "/settings/agents",
        "/settings/messaging-channels",
        "/settings/llm",
        "/settings/mcp",
        "/settings/connection",
        "/settings/apps",
        "/settings/skills",
        "/settings/security",
        "/settings/knowledge",
        "/settings/environments",
        "/settings/users",
        "/settings/teams",
        "/settings/roles",
        "/settings/github",
        "/settings/identity-providers",
        "/settings/secrets",
      ].map((href) => [href, true]),
    ),
}));

vi.mock("@/lib/secrets.query", () => ({
  useSecretsType: () => ({ data: { type: "Vault" } }),
}));

describe("settings navigation", () => {
  it("lists the same tabs, in the same order, as the settings page renders", () => {
    const { result } = renderHook(() => useSettingsTabs());

    // The sidebar picks the first entry of this list; if a tab is added to the
    // rendered tabs but not here, the sidebar would skip past it and open a
    // page further down than the one the user actually lands on via /settings.
    expect(result.current.map((tab) => tab.href)).toEqual([
      ...SETTINGS_TAB_HREFS,
    ]);
  });

  it("sends the sidebar to the first tab the reader may open", () => {
    expect(getSettingsNavigationUrl(allPermitted)).toBe("/settings/appearance");

    expect(
      getSettingsNavigationUrl({
        "/settings/appearance": false,
        "/settings/auth": false,
        "/settings/llm": true,
      }),
    ).toBe("/settings/llm");
  });

  it("falls back to the stub when it cannot decide", () => {
    // Nothing readable yet: permissions are still loading.
    expect(getSettingsNavigationUrl(undefined)).toBe("/settings");

    // Secrets is the one tab that needs more than the permission map, so a
    // reader with only that one goes through the stub, which resolves it.
    expect(getSettingsNavigationUrl({ "/settings/secrets": true })).toBe(
      "/settings",
    );
  });
});
