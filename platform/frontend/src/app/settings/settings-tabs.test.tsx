import type { Permissions } from "@archestra/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { authClient } from "@/lib/clients/auth/auth-client";
import {
  type SettingsNavGroup,
  useSettingsNavGroups,
  useSettingsReturnPath,
} from "./settings-tabs";

vi.mock("@/lib/clients/auth/auth-client", () => ({
  authClient: {
    getSession: vi.fn(),
  },
}));

let mockPathname = "/chat";

vi.mock("next/navigation", () => ({
  usePathname: () => mockPathname,
}));

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

let mockEnterpriseFeatures = false;

vi.mock("@/lib/config/config", () => ({
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
  mockPathname = "/chat";

  vi.mocked(authClient.getSession).mockResolvedValue({
    data: {
      user: { id: "test-user", email: "test@example.com" },
      session: { id: "test-session" },
    },
  } as Awaited<ReturnType<typeof authClient.getSession>>);
});

function groupNames(groups: SettingsNavGroup[]) {
  return groups.map((g) => g.label);
}

function allLabels(groups: SettingsNavGroup[]) {
  return groups.flatMap((g) => g.items.map((i) => i.label));
}

function itemsOf(groups: SettingsNavGroup[], group: string) {
  return (groups.find((g) => g.label === group)?.items ?? []).map(
    (i) => i.label,
  );
}

describe("useSettingsNavGroups", () => {
  it("always shows Your Account in Personal and drops the empty Organization group", async () => {
    const { result } = renderHook(() => useSettingsNavGroups(), {
      wrapper: createWrapper(),
    });

    await waitFor(() => {
      expect(groupNames(result.current)).toEqual(["Personal"]);
      expect(itemsOf(result.current, "Personal")).toContain("Your Account");
      expect(allLabels(result.current)).not.toContain("API Keys");
    });
  });

  it("shows API Keys under Personal when user has apiKey:read", async () => {
    mockPermissions = { apiKey: ["read"] };

    const { result } = renderHook(() => useSettingsNavGroups(), {
      wrapper: createWrapper(),
    });

    await waitFor(() => {
      expect(itemsOf(result.current, "Personal")).toEqual([
        "Your Account",
        "API Keys",
      ]);
    });
  });

  it("groups org-wide items under Organization when user has admin permissions", async () => {
    mockPermissions = {
      member: ["read"],
      team: ["read"],
      ac: ["read"],
      organizationSettings: ["read"],
      apiKey: ["read"],
      serviceAccount: ["read"],
      llmSettings: ["read"],
      agentSettings: ["read"],
    };

    const { result } = renderHook(() => useSettingsNavGroups(), {
      wrapper: createWrapper(),
    });

    await waitFor(() => {
      expect(groupNames(result.current)).toEqual(["Personal", "Organization"]);
      const org = itemsOf(result.current, "Organization");
      expect(org).toContain("Overview");
      expect(org).toContain("Users");
      expect(org).toContain("Teams");
      expect(org).toContain("Roles");
      expect(org).toContain("Service Accounts");
      expect(org).toContain("LLM");
      expect(org).toContain("Agents");
    });
  });

  it("shows LLM under Organization when user has llmSettings:read", async () => {
    mockPermissions = { llmSettings: ["read"] };

    const { result } = renderHook(() => useSettingsNavGroups(), {
      wrapper: createWrapper(),
    });

    await waitFor(() => {
      expect(itemsOf(result.current, "Organization")).toContain("LLM");
    });
  });

  it("hides LLM when user lacks llmSettings:read", async () => {
    mockPermissions = {};

    const { result } = renderHook(() => useSettingsNavGroups(), {
      wrapper: createWrapper(),
    });

    await waitFor(() => {
      expect(allLabels(result.current)).not.toContain("LLM");
    });
  });

  it("shows Service Accounts when user has serviceAccount:read", async () => {
    mockPermissions = { serviceAccount: ["read"] };

    const { result } = renderHook(() => useSettingsNavGroups(), {
      wrapper: createWrapper(),
    });

    await waitFor(() => {
      expect(itemsOf(result.current, "Organization")).toContain(
        "Service Accounts",
      );
    });
  });

  it("hides Users when user lacks member:read", async () => {
    mockPermissions = { team: ["read"], ac: ["read"] };

    const { result } = renderHook(() => useSettingsNavGroups(), {
      wrapper: createWrapper(),
    });

    await waitFor(() => {
      const labels = allLabels(result.current);
      expect(labels).not.toContain("Users");
      expect(labels).toContain("Teams");
      expect(labels).toContain("Roles");
    });
  });

  it("hides Roles when user lacks ac:read", async () => {
    mockPermissions = { member: ["read"], team: ["read"] };

    const { result } = renderHook(() => useSettingsNavGroups(), {
      wrapper: createWrapper(),
    });

    await waitFor(() => {
      const labels = allLabels(result.current);
      expect(labels).toContain("Users");
      expect(labels).toContain("Teams");
      expect(labels).not.toContain("Roles");
    });
  });

  it("shows Secrets only with Vault storage and secret:read", async () => {
    mockSecretsType = "Vault";
    mockPermissions = { secret: ["read"] };

    const { result } = renderHook(() => useSettingsNavGroups(), {
      wrapper: createWrapper(),
    });

    await waitFor(() => {
      expect(allLabels(result.current)).toContain("Secrets");
    });
  });

  it("hides Secrets with DB storage", async () => {
    mockSecretsType = "DB";
    mockPermissions = { secret: ["read"] };

    const { result } = renderHook(() => useSettingsNavGroups(), {
      wrapper: createWrapper(),
    });

    await waitFor(() => {
      expect(allLabels(result.current)).not.toContain("Secrets");
    });
  });

  it("shows Identity Providers only with enterprise features and permission", async () => {
    mockEnterpriseFeatures = true;
    mockPermissions = { identityProvider: ["read"] };

    const { result } = renderHook(() => useSettingsNavGroups(), {
      wrapper: createWrapper(),
    });

    await waitFor(() => {
      expect(allLabels(result.current)).toContain("Identity Providers");
    });
  });

  it("hides Identity Providers when enterprise features disabled", async () => {
    mockEnterpriseFeatures = false;
    mockPermissions = { identityProvider: ["read"] };

    const { result } = renderHook(() => useSettingsNavGroups(), {
      wrapper: createWrapper(),
    });

    await waitFor(() => {
      expect(allLabels(result.current)).not.toContain("Identity Providers");
    });
  });

  it("shows GitHub when user has githubAppConfig:read", async () => {
    mockPermissions = { githubAppConfig: ["read"] };

    const { result } = renderHook(() => useSettingsNavGroups(), {
      wrapper: createWrapper(),
    });

    await waitFor(() => {
      expect(allLabels(result.current)).toContain("GitHub");
    });
  });

  it("hides GitHub when user lacks githubAppConfig:read", async () => {
    mockPermissions = {};

    const { result } = renderHook(() => useSettingsNavGroups(), {
      wrapper: createWrapper(),
    });

    await waitFor(() => {
      expect(allLabels(result.current)).not.toContain("GitHub");
    });
  });

  it("maintains Personal-then-Organization grouping and intra-group order", async () => {
    mockEnterpriseFeatures = true;
    mockSecretsType = "Vault";
    mockPermissions = {
      member: ["read"],
      team: ["read"],
      ac: ["read"],
      githubAppConfig: ["read"],
      identityProvider: ["read"],
      secret: ["read"],
      organizationSettings: ["read"],
      apiKey: ["read"],
      serviceAccount: ["read"],
      environment: ["admin"],
      llmSettings: ["read"],
      agentSettings: ["read"],
      knowledgeSettings: ["read"],
    };

    const { result } = renderHook(() => useSettingsNavGroups(), {
      wrapper: createWrapper(),
    });

    await waitFor(() => {
      expect(groupNames(result.current)).toEqual(["Personal", "Organization"]);
      expect(itemsOf(result.current, "Personal")).toEqual([
        "Your Account",
        "API Keys",
      ]);
      expect(itemsOf(result.current, "Organization")).toEqual([
        "Overview",
        "Users",
        "Teams",
        "Roles",
        "Service Accounts",
        "Environments",
        "Secrets",
        "GitHub",
        "Identity Providers",
        "LLM",
        "Agents",
        "Knowledge",
      ]);
    });
  });
});

describe("useSettingsReturnPath", () => {
  it("returns the page visited before entering settings", () => {
    mockPathname = "/llm/logs";
    const { result, rerender } = renderHook(() => useSettingsReturnPath());

    mockPathname = "/settings/account";
    rerender();

    expect(result.current).toBe("/llm/logs");
  });

  it("falls back to New Chat when settings is the first route", () => {
    mockPathname = "/settings/account";
    const { result } = renderHook(() => useSettingsReturnPath());

    expect(result.current).toBe("/chat");
  });

  it("keeps the original entry page while navigating between settings sections", () => {
    mockPathname = "/llm/logs";
    const { result, rerender } = renderHook(() => useSettingsReturnPath());

    mockPathname = "/settings/account";
    rerender();
    mockPathname = "/settings/llm";
    rerender();

    expect(result.current).toBe("/llm/logs");
  });
});
