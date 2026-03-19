import type { Permissions } from "@shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { authClient } from "@/lib/clients/auth/auth-client";
import { useSettingsTabs } from "./settings-tabs";

vi.mock("@/lib/clients/auth/auth-client", () => ({
  authClient: {
    useSession: vi.fn(),
  },
}));

let mockPermissions: Permissions = {};

vi.mock("@shared", async () => {
  const actual = await vi.importActual("@shared");
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

vi.mock("@/lib/auth.utils", () => ({
  hasPermission: vi.fn(),
}));

let mockSecretsType = "DB";

vi.mock("@/lib/secrets.query", () => ({
  useSecretsType: vi.fn(() => ({
    data: { type: mockSecretsType },
  })),
}));

let mockEnterpriseFeatures = false;

vi.mock("@/lib/config", () => ({
  default: {
    get enterpriseFeatures() {
      return { core: mockEnterpriseFeatures };
    },
  },
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
  mockEnterpriseFeatures = false;

  vi.mocked(authClient.useSession).mockReturnValue({
    data: {
      user: { id: "test-user", email: "test@example.com" },
      session: { id: "test-session" },
    },
  } as ReturnType<typeof authClient.useSession>);
});

function getTabLabels(tabs: Array<{ label: string }>) {
  return tabs.map((t) => t.label);
}

describe("useSettingsTabs", () => {
  it("always shows Your Account tab", async () => {
    const { result } = renderHook(() => useSettingsTabs(), {
      wrapper: createWrapper(),
    });

    await waitFor(() => {
      const labels = getTabLabels(result.current);
      expect(labels).toContain("Your Account");
      expect(labels).not.toContain("API Keys");
    });
  });

  it("shows admin tabs when user has all permissions", async () => {
    mockPermissions = {
      member: ["read"],
      team: ["read"],
      ac: ["read"],
      organizationSettings: ["read"],
      apiKey: ["read"],
      llmSettings: ["read"],
      agentSettings: ["read"],
    };

    const { result } = renderHook(() => useSettingsTabs(), {
      wrapper: createWrapper(),
    });

    await waitFor(() => {
      const labels = getTabLabels(result.current);
      expect(labels).toContain("API Keys");
      expect(labels).toContain("Agents");
      expect(labels).toContain("LLM");
      expect(labels).toContain("Users");
      expect(labels).toContain("Teams");
      expect(labels).toContain("Roles");
      expect(labels).toContain("Organization");
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

  it("shows Identity Providers tab only when enterprise features enabled and user has permission", async () => {
    mockEnterpriseFeatures = true;
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

  it("hides Identity Providers tab when enterprise features disabled", async () => {
    mockEnterpriseFeatures = false;
    mockPermissions = {
      identityProvider: ["read"],
    };

    const { result } = renderHook(() => useSettingsTabs(), {
      wrapper: createWrapper(),
    });

    await waitFor(() => {
      const labels = getTabLabels(result.current);
      expect(labels).not.toContain("Identity Providers");
    });
  });

  it("maintains correct tab order", async () => {
    mockEnterpriseFeatures = true;
    mockSecretsType = "Vault";
    mockPermissions = {
      member: ["read"],
      team: ["read"],
      ac: ["read"],
      identityProvider: ["read"],
      secret: ["read"],
      organizationSettings: ["read"],
      apiKey: ["read"],
      llmSettings: ["read"],
      agentSettings: ["read"],
    };

    const { result } = renderHook(() => useSettingsTabs(), {
      wrapper: createWrapper(),
    });

    await waitFor(() => {
      const labels = getTabLabels(result.current);
      expect(labels).toEqual([
        "Your Account",
        "API Keys",
        "Agents",
        "LLM",
        "Users",
        "Teams",
        "Roles",
        "Identity Providers",
        "Secrets",
        "Organization",
      ]);
    });
  });
});
