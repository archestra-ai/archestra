import type { Permissions } from "@archestra/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { authClient } from "@/lib/clients/auth/auth-client";
import { resolveSettingsSection, useSettingsTabs } from "./settings-tabs";

vi.mock("@/lib/clients/auth/auth-client");

let mockPermissions: Permissions = {};

vi.mock("@archestra/shared", async () => {
  const actual = await vi.importActual("@archestra/shared");
  return {
    ...actual,
    archestraApiSdk: {
      getUserPermissions: vi.fn(() =>
        Promise.resolve({ data: mockPermissions }),
      ),
      getSecretsType: vi.fn(() => Promise.resolve({ data: { type: "DB" } })),
    },
  };
});

let mockSecretsType = "DB";

vi.mock("@/lib/secrets.query", () => ({
  useSecretsType: vi.fn(() => ({
    data: { type: mockSecretsType },
  })),
}));

const createWrapper = () => {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
};

beforeEach(() => {
  vi.clearAllMocks();
  mockPermissions = {};
  mockSecretsType = "DB";

  vi.mocked(authClient.getSession).mockResolvedValue({
    data: {
      user: { id: "test-user", email: "test@example.com" },
      session: { id: "test-session" },
    },
  } as Awaited<ReturnType<typeof authClient.getSession>>);
});

function getTabLabels(tabs: Array<{ label: string }>) {
  return tabs.map((t) => t.label);
}

describe("useSettingsTabs", () => {
  it("shows no tabs without permissions", async () => {
    const { result } = renderHook(() => useSettingsTabs(), {
      wrapper: createWrapper(),
    });

    await waitFor(() => {
      expect(getTabLabels(result.current)).toEqual([]);
    });
  });

  it("shows admin tabs when user has all permissions", async () => {
    mockPermissions = {
      member: ["read"],
      team: ["read"],
      ac: ["read"],
      organizationSettings: ["read"],
      serviceAccount: ["read"],
      llmSettings: ["read"],
      agentSettings: ["read"],
    };

    const { result } = renderHook(() => useSettingsTabs(), {
      wrapper: createWrapper(),
    });

    await waitFor(() => {
      const labels = getTabLabels(result.current);
      expect(labels).toContain("Service Accounts");
      expect(labels).toContain("Agents");
      expect(labels).toContain("Security");
      expect(labels).toContain("LLM");
      expect(labels).toContain("Users");
      expect(labels).toContain("Teams");
      expect(labels).toContain("Roles");
      expect(labels).toContain("Appearance");
      expect(labels).toContain("Auth");
    });
  });

  it("shows LLM tab when user has llmSettings:read permission", async () => {
    mockPermissions = {
      llmSettings: ["read"],
    };

    const { result } = renderHook(() => useSettingsTabs(), {
      wrapper: createWrapper(),
    });

    await waitFor(() => {
      const labels = getTabLabels(result.current);
      expect(labels).toContain("LLM");
    });
  });

  it("shows Messaging Channels when the user can read agent triggers", async () => {
    mockPermissions = {
      agentTrigger: ["read"],
    };

    const { result } = renderHook(() => useSettingsTabs(), {
      wrapper: createWrapper(),
    });

    await waitFor(() => {
      expect(getTabLabels(result.current)).toEqual(["Messaging Channels"]);
    });
  });

  it("shows Service Accounts tab when user has serviceAccount:read permission", async () => {
    mockPermissions = {
      serviceAccount: ["read"],
    };

    const { result } = renderHook(() => useSettingsTabs(), {
      wrapper: createWrapper(),
    });

    await waitFor(() => {
      const labels = getTabLabels(result.current);
      expect(labels).toContain("Service Accounts");
    });
  });

  it("hides LLM tab when user lacks llmSettings:read permission", async () => {
    mockPermissions = {};

    const { result } = renderHook(() => useSettingsTabs(), {
      wrapper: createWrapper(),
    });

    await waitFor(() => {
      const labels = getTabLabels(result.current);
      expect(labels).not.toContain("LLM");
    });
  });

  it("hides Users tab when user lacks member:read permission", async () => {
    mockPermissions = {
      team: ["read"],
      ac: ["read"],
    };

    const { result } = renderHook(() => useSettingsTabs(), {
      wrapper: createWrapper(),
    });

    await waitFor(() => {
      const labels = getTabLabels(result.current);
      expect(labels).not.toContain("Users");
      expect(labels).toContain("Teams");
      expect(labels).toContain("Roles");
    });
  });

  it("hides Roles tab when user lacks ac:read permission", async () => {
    mockPermissions = {
      member: ["read"],
      team: ["read"],
    };

    const { result } = renderHook(() => useSettingsTabs(), {
      wrapper: createWrapper(),
    });

    await waitFor(() => {
      const labels = getTabLabels(result.current);
      expect(labels).toContain("Users");
      expect(labels).toContain("Teams");
      expect(labels).not.toContain("Roles");
    });
  });

  it("shows Secrets tab only when using Vault storage and user has permission", async () => {
    mockSecretsType = "Vault";
    mockPermissions = {
      secret: ["read"],
    };

    const { result } = renderHook(() => useSettingsTabs(), {
      wrapper: createWrapper(),
    });

    await waitFor(() => {
      const labels = getTabLabels(result.current);
      expect(labels).toContain("Secrets");
    });
  });

  it("hides Secrets tab when using DB storage", async () => {
    mockSecretsType = "DB";
    mockPermissions = {
      secret: ["read"],
    };

    const { result } = renderHook(() => useSettingsTabs(), {
      wrapper: createWrapper(),
    });

    await waitFor(() => {
      const labels = getTabLabels(result.current);
      expect(labels).not.toContain("Secrets");
    });
  });

  it("shows Identity Providers tab when user has identityProvider:read permission", async () => {
    mockPermissions = {
      identityProvider: ["read"],
    };

    const { result } = renderHook(() => useSettingsTabs(), {
      wrapper: createWrapper(),
    });

    await waitFor(() => {
      const labels = getTabLabels(result.current);
      expect(labels).toContain("Identity Providers");
    });
  });

  it("hides Identity Providers tab when user lacks identityProvider:read permission", async () => {
    mockPermissions = {};

    const { result } = renderHook(() => useSettingsTabs(), {
      wrapper: createWrapper(),
    });

    await waitFor(() => {
      const labels = getTabLabels(result.current);
      expect(labels).not.toContain("Identity Providers");
    });
  });

  it("shows GitHub tab when user has githubAppConfig:read permission", async () => {
    mockPermissions = { githubAppConfig: ["read"] };

    const { result } = renderHook(() => useSettingsTabs(), {
      wrapper: createWrapper(),
    });

    await waitFor(() => {
      const labels = getTabLabels(result.current);
      expect(labels).toContain("GitHub");
    });
  });

  it("hides GitHub tab when user lacks githubAppConfig:read permission", async () => {
    mockPermissions = {};

    const { result } = renderHook(() => useSettingsTabs(), {
      wrapper: createWrapper(),
    });

    await waitFor(() => {
      const labels = getTabLabels(result.current);
      expect(labels).not.toContain("GitHub");
    });
  });

  it("maintains correct tab order", async () => {
    mockSecretsType = "Vault";
    mockPermissions = {
      member: ["read"],
      team: ["read"],
      ac: ["read"],
      githubAppConfig: ["read"],
      identityProvider: ["read"],
      secret: ["read"],
      organizationSettings: ["read"],
      serviceAccount: ["read"],
      llmSettings: ["read"],
      agentSettings: ["read"],
    };

    const { result } = renderHook(() => useSettingsTabs(), {
      wrapper: createWrapper(),
    });

    await waitFor(() => {
      const labels = getTabLabels(result.current);
      expect(labels).toEqual([
        "Appearance",
        "Auth",
        "Service Accounts",
        "Agents",
        "LLM",
        "Connection",
        "Apps",
        "Security",
        "Users",
        "Teams",
        "Roles",
        "GitHub",
        "Identity Providers",
        "Secrets",
      ]);
    });
  });
});

describe("resolveSettingsSection", () => {
  const tabs = [
    { href: "/settings/users" },
    { href: "/settings/service-accounts" },
    { href: "/settings/teams" },
  ];

  it("matches the section itself", () => {
    expect(resolveSettingsSection("/settings/users", tabs)).toBe(
      "/settings/users",
    );
  });

  it("keeps a detail route on its parent section", () => {
    expect(
      resolveSettingsSection("/settings/service-accounts/abc-123", tabs),
    ).toBe("/settings/service-accounts");
  });

  it("does not match a section that is only a name prefix", () => {
    // "/settings/team" must not light up "/settings/teams".
    expect(resolveSettingsSection("/settings/team", tabs)).toBe("");
  });

  it("returns nothing for a path outside the section list", () => {
    expect(resolveSettingsSection("/account", tabs)).toBe("");
  });
});
