import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useEnterpriseFeature, useFeature } from "@/lib/config/config.query";
import { McpCatalogForm } from "./mcp-catalog-form";

const { useIdentityProvidersMock } = vi.hoisted(() => ({
  useIdentityProvidersMock: vi.fn(() => ({ data: [] })),
}));

vi.mock("@/lib/config/config.query", () => ({
  useFeature: vi.fn((feature: string) => {
    if (feature === "mcpServerBaseImage") return "";
    if (feature === "orchestratorK8sRuntime") return true;
    if (feature === "byosEnabled") return false;
    return undefined;
  }),
  useEnterpriseFeature: vi.fn(() => false),
}));

vi.mock("@/lib/config/config", () => ({
  default: {
    enterpriseFeatures: {
      core: true,
    },
  },
}));

vi.mock("@/lib/auth/auth.query", () => ({
  useHasPermissions: vi.fn(() => ({ data: true })),
}));

vi.mock("@/lib/auth/identity-provider.query.ee", () => ({
  useIdentityProviders: useIdentityProvidersMock,
}));

vi.mock("@/lib/teams/team.query", () => ({
  useTeams: vi.fn(() => ({ data: [] })),
}));

vi.mock("@/lib/mcp/internal-mcp-catalog.query", () => ({
  useK8sImagePullSecrets: vi.fn(() => ({ data: [] })),
}));

vi.mock("@/lib/secrets.query", () => ({
  useGetSecret: vi.fn(() => ({ data: null })),
}));

vi.mock("@/lib/docs/docs", () => ({
  getVisibleDocsUrl: vi.fn(() => "https://docs.example.com"),
  getFrontendDocsUrl: vi.fn(() => "https://docs.example.com/mcp-auth"),
}));

vi.mock("@/lib/hooks/use-app-name", () => ({
  useAppName: vi.fn(() => "Archestra"),
}));

vi.mock("@/components/agent-icon-picker", () => ({
  AgentIconPicker: () => <div data-testid="agent-icon-picker" />,
}));

vi.mock("@/components/agent-labels", () => ({
  ProfileLabels: () => <div data-testid="profile-labels" />,
}));

vi.mock("@/components/environment-variables-form-field", () => ({
  EnvironmentVariablesFormField: () => (
    <div data-testid="environment-variables-form-field" />
  ),
}));

vi.mock("@/components/visibility-selector", () => ({
  VisibilitySelector: () => <div data-testid="visibility-selector" />,
}));

describe("McpCatalogForm enterprise gating", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(useFeature).mockImplementation((feature: string) => {
      if (feature === "mcpServerBaseImage") return "";
      if (feature === "orchestratorK8sRuntime") return true;
      if (feature === "byosEnabled") return false;
      return undefined;
    });
    useIdentityProvidersMock.mockReturnValue({ data: [] });
    global.ResizeObserver = class ResizeObserver {
      observe() {}
      unobserve() {}
      disconnect() {}
    };
  });

  it("renders enterprise auth options as disabled when the enterprise license is disabled", () => {
    render(<McpCatalogForm mode="create" onSubmit={vi.fn()} />);

    expect(
      screen.getByRole("radio", {
        name: "Identity Provider Token Exchange",
      }),
    ).toBeDisabled();
    expect(
      screen.getByRole("radio", {
        name: "Identity Provider JWT / JWKS",
      }),
    ).toBeDisabled();
  });

  it("shows enterprise-managed credentials when the enterprise license is enabled", async () => {
    vi.mocked(useEnterpriseFeature).mockReturnValue(true);
    useIdentityProvidersMock.mockReturnValue({
      data: [
        {
          id: "idp-1",
          providerId: "okta",
          issuer: "https://idp.example.com",
          oidcConfig: { clientId: "client-id" },
        },
      ] as never,
    });

    render(<McpCatalogForm mode="create" onSubmit={vi.fn()} />);

    expect(
      screen.getByText("Identity Provider Token Exchange"),
    ).toBeInTheDocument();
    expect(
      screen.getByText("Identity Provider JWT / JWKS"),
    ).toBeInTheDocument();
  });

  it("renders enterprise auth options as disabled when no OIDC identity providers are configured", () => {
    vi.mocked(useEnterpriseFeature).mockReturnValue(true);

    render(<McpCatalogForm mode="create" onSubmit={vi.fn()} />);

    expect(
      screen.getByRole("radio", {
        name: "Identity Provider Token Exchange",
      }),
    ).toBeDisabled();
    expect(
      screen.getByRole("radio", {
        name: "Identity Provider JWT / JWKS",
      }),
    ).toBeDisabled();
  });

  it("resets an existing enterprise auth selection to none when OIDC providers become unavailable", () => {
    vi.mocked(useEnterpriseFeature).mockReturnValue(true);
    useIdentityProvidersMock.mockReturnValue({
      data: [
        {
          id: "idp-1",
          providerId: "okta",
          issuer: "https://idp.example.com",
          oidcConfig: { clientId: "client-id" },
        },
      ] as never,
    });

    const initialValues = {
      id: "catalog-1",
      name: "Remote MCP",
      description: "",
      icon: null,
      serverType: "remote",
      serverUrl: "https://mcp.example.com",
      oauthConfig: null,
      userConfig: {},
      enterpriseManagedConfig: {
        identityProviderId: "idp-1",
        assertionMode: "exchange",
        requestedCredentialType: "bearer_token",
        tokenInjectionMode: "authorization_bearer",
      },
      localConfig: null,
      deploymentSpecYaml: null,
      scope: "personal",
      teams: [],
      labels: [],
    } as never;

    const { rerender } = render(
      <McpCatalogForm
        mode="edit"
        onSubmit={vi.fn()}
        initialValues={initialValues}
      />,
    );

    expect(
      screen.getByRole("radio", {
        name: "Identity Provider Token Exchange",
      }),
    ).toBeChecked();

    useIdentityProvidersMock.mockReturnValue({ data: [] });

    rerender(
      <McpCatalogForm
        mode="edit"
        onSubmit={vi.fn()}
        initialValues={initialValues}
      />,
    );

    expect(
      screen.getByRole("radio", {
        name: /None \(e\.g\. static API key via environment variables\)/,
      }),
    ).toBeChecked();
  });

  it("disables browser autofill for MCP config forms and secret fields", () => {
    const { container } = render(
      <McpCatalogForm
        mode="edit"
        onSubmit={vi.fn()}
        initialValues={
          {
            id: "catalog-1",
            name: "Remote MCP",
            description: "",
            icon: null,
            serverType: "remote",
            serverUrl: "https://mcp.example.com",
            oauthConfig: {
              name: "Remote MCP",
              server_url: "https://mcp.example.com",
              client_id: "client-id",
              client_secret: "client-secret",
              grant_type: "authorization_code",
              redirect_uris: ["https://app.example.com/oauth-callback"],
              scopes: ["read"],
              default_scopes: ["read"],
              supports_resource_metadata: true,
            },
            userConfig: {},
            enterpriseManagedConfig: null,
            localConfig: null,
            deploymentSpecYaml: null,
            scope: "personal",
            teams: [],
            labels: [],
          } as never
        }
      />,
    );

    expect(container.querySelector("form")).toHaveAttribute(
      "autocomplete",
      "off",
    );
    expect(screen.getByLabelText("Client Secret")).toHaveAttribute(
      "autocomplete",
      "new-password",
    );
  });

  it("hides automatic tool assignment label copy when advanced tool features are disabled", () => {
    render(<McpCatalogForm mode="create" onSubmit={vi.fn()} />);

    expect(
      screen.queryByText(
        "Organize servers and drive automatic tool assignment",
      ),
    ).not.toBeInTheDocument();
  });

  it("shows automatic tool assignment label copy when advanced tool features are enabled", () => {
    vi.mocked(useFeature).mockImplementation((feature: string) => {
      if (feature === "mcpServerBaseImage") return "";
      if (feature === "orchestratorK8sRuntime") return true;
      if (feature === "byosEnabled") return false;
      if (feature === "advancedToolFeaturesEnabled") return true;
      return undefined;
    });

    render(<McpCatalogForm mode="create" onSubmit={vi.fn()} />);

    expect(
      screen.getByText("Organize servers and drive automatic tool assignment"),
    ).toBeInTheDocument();
  });
});
