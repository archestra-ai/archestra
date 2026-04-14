import type { McpCatalogFormValues } from "./mcp-catalog-form.types";
import {
  transformCatalogItemToFormValues,
  transformExternalCatalogToFormValues,
  transformFormToApiData,
} from "./mcp-catalog-form.utils";

describe("transformFormToApiData", () => {
  it("includes OAuth discovery overrides in the API payload", () => {
    const values: McpCatalogFormValues = {
      name: "Direct OAuth MCP",
      description: "",
      icon: null,
      serverType: "local",
      serverUrl: "",
      authMethod: "oauth",
      oauthConfig: {
        client_id: "client-id",
        client_secret: "client-secret",
        redirect_uris: "https://app.example.com/oauth-callback",
        scopes: "read:jira-work",
        supports_resource_metadata: true,
        oauthServerUrl: "https://mcp.example.com",
        authServerUrl: "https://auth.example.com",
        authorizationEndpoint: "https://legacy-idp.example.com/oauth/authorize",
        wellKnownUrl:
          "https://auth.example.com/.well-known/openid-configuration",
        resourceMetadataUrl:
          "https://mcp.example.com/.well-known/oauth-protected-resource/mcp",
        tokenEndpoint: "https://legacy-idp.example.com/oauth/token",
      },
      enterpriseManagedConfig: null,
      localConfig: {
        command: "node",
        arguments: "server.js",
        environment: [],
        envFrom: [],
        dockerImage: "",
        transportType: "streamable-http",
        httpPort: "8080",
        httpPath: "/mcp",
        serviceAccount: "",
        imagePullSecrets: [],
      },
      deploymentSpecYaml: "",
      originalDeploymentSpecYaml: "",
      oauthClientSecretVaultPath: "",
      oauthClientSecretVaultKey: "",
      localConfigVaultPath: "",
      localConfigVaultKey: "",
      labels: [],
      scope: "personal",
      teams: [],
    };

    expect(transformFormToApiData(values).oauthConfig).toMatchObject({
      server_url: "https://mcp.example.com",
      auth_server_url: "https://auth.example.com",
      authorization_endpoint: "https://legacy-idp.example.com/oauth/authorize",
      well_known_url:
        "https://auth.example.com/.well-known/openid-configuration",
      resource_metadata_url:
        "https://mcp.example.com/.well-known/oauth-protected-resource/mcp",
      token_endpoint: "https://legacy-idp.example.com/oauth/token",
      scopes: ["read:jira-work"],
      default_scopes: ["read:jira-work"],
    });
  });

  it("uses the remote server URL as the OAuth server URL for remote servers", () => {
    const values: McpCatalogFormValues = {
      name: "Remote Direct OAuth MCP",
      description: "",
      icon: null,
      serverType: "remote",
      serverUrl: "https://mcp.example.com",
      authMethod: "oauth",
      oauthConfig: {
        client_id: "client-id",
        client_secret: "client-secret",
        redirect_uris: "https://app.example.com/oauth-callback",
        scopes: "read:jira-work",
        supports_resource_metadata: true,
        oauthServerUrl: "",
        authServerUrl: "https://auth.example.com",
        authorizationEndpoint: "https://legacy-idp.example.com/oauth/authorize",
        wellKnownUrl:
          "https://auth.example.com/.well-known/openid-configuration",
        resourceMetadataUrl:
          "https://mcp.example.com/.well-known/oauth-protected-resource/mcp",
        tokenEndpoint: "https://legacy-idp.example.com/oauth/token",
      },
      enterpriseManagedConfig: null,
      localConfig: undefined,
      deploymentSpecYaml: "",
      originalDeploymentSpecYaml: "",
      oauthClientSecretVaultPath: "",
      oauthClientSecretVaultKey: "",
      localConfigVaultPath: "",
      localConfigVaultKey: "",
      labels: [],
      scope: "personal",
      teams: [],
    };

    expect(transformFormToApiData(values).oauthConfig).toMatchObject({
      server_url: "https://mcp.example.com",
      auth_server_url: "https://auth.example.com",
      authorization_endpoint: "https://legacy-idp.example.com/oauth/authorize",
      well_known_url:
        "https://auth.example.com/.well-known/openid-configuration",
      resource_metadata_url:
        "https://mcp.example.com/.well-known/oauth-protected-resource/mcp",
      token_endpoint: "https://legacy-idp.example.com/oauth/token",
      scopes: ["read:jira-work"],
      default_scopes: ["read:jira-work"],
    });
  });

  it('uses ["read", "write"] as defaults only when the scopes field is blank', () => {
    const values: McpCatalogFormValues = {
      name: "Default Scope OAuth MCP",
      description: "",
      icon: null,
      serverType: "remote",
      serverUrl: "https://mcp.example.com",
      authMethod: "oauth",
      oauthConfig: {
        client_id: "client-id",
        client_secret: "client-secret",
        redirect_uris: "https://app.example.com/oauth-callback",
        scopes: "",
        supports_resource_metadata: false,
        oauthServerUrl: "",
        authServerUrl: "",
        authorizationEndpoint: "",
        wellKnownUrl: "",
        resourceMetadataUrl: "",
        tokenEndpoint: "",
      },
      enterpriseManagedConfig: null,
      localConfig: undefined,
      deploymentSpecYaml: "",
      originalDeploymentSpecYaml: "",
      oauthClientSecretVaultPath: "",
      oauthClientSecretVaultKey: "",
      localConfigVaultPath: "",
      localConfigVaultKey: "",
      labels: [],
      scope: "personal",
      teams: [],
    };

    expect(transformFormToApiData(values).oauthConfig).toMatchObject({
      scopes: ["read", "write"],
      default_scopes: ["read", "write"],
    });
  });

  it('treats comma-only scopes input as blank and falls back to ["read", "write"]', () => {
    const values: McpCatalogFormValues = {
      name: "Comma Scope OAuth MCP",
      description: "",
      icon: null,
      serverType: "remote",
      serverUrl: "https://mcp.example.com",
      authMethod: "oauth",
      oauthConfig: {
        client_id: "client-id",
        client_secret: "client-secret",
        redirect_uris: "https://app.example.com/oauth-callback",
        scopes: " , ",
        supports_resource_metadata: false,
        oauthServerUrl: "",
        authServerUrl: "",
        authorizationEndpoint: "",
        wellKnownUrl: "",
        resourceMetadataUrl: "",
        tokenEndpoint: "",
      },
      enterpriseManagedConfig: null,
      localConfig: undefined,
      deploymentSpecYaml: "",
      originalDeploymentSpecYaml: "",
      oauthClientSecretVaultPath: "",
      oauthClientSecretVaultKey: "",
      localConfigVaultPath: "",
      localConfigVaultKey: "",
      labels: [],
      scope: "personal",
      teams: [],
    };

    expect(transformFormToApiData(values).oauthConfig).toMatchObject({
      scopes: ["read", "write"],
      default_scopes: ["read", "write"],
    });
  });

  it("hydrates explicit OAuth endpoints from internal catalog items", () => {
    const values = transformCatalogItemToFormValues({
      id: "catalog-1",
      name: "Direct OAuth MCP",
      description: "",
      icon: null,
      serverType: "remote",
      serverUrl: "https://mcp.example.com",
      oauthConfig: {
        client_id: "client-id",
        client_secret: "client-secret",
        redirect_uris: ["https://app.example.com/oauth-callback"],
        scopes: ["read"],
        default_scopes: ["read", "write"],
        supports_resource_metadata: false,
        server_url: "https://mcp.example.com",
        auth_server_url: "https://auth.example.com",
        authorization_endpoint:
          "https://legacy-idp.example.com/oauth/authorize",
        well_known_url:
          "https://auth.example.com/.well-known/openid-configuration",
        resource_metadata_url:
          "https://mcp.example.com/.well-known/oauth-protected-resource/mcp",
        token_endpoint: "https://legacy-idp.example.com/oauth/token",
        name: "Direct OAuth MCP",
      },
      enterpriseManagedConfig: null,
      localConfig: null,
      deploymentSpecYaml: null,
      userConfig: {},
      scope: "personal",
      teams: [],
      labels: [],
    } as never);

    expect(values.oauthConfig?.authorizationEndpoint).toBe(
      "https://legacy-idp.example.com/oauth/authorize",
    );
    expect(values.oauthConfig?.tokenEndpoint).toBe(
      "https://legacy-idp.example.com/oauth/token",
    );
  });

  it("hydrates explicit OAuth endpoints from external catalog manifests", () => {
    const values = transformExternalCatalogToFormValues({
      name: "direct-oauth-mcp",
      display_name: "Direct OAuth MCP",
      description: "",
      icon: null,
      server: {
        type: "remote",
        url: "https://mcp.example.com",
      },
      oauth_config: {
        client_id: "client-id",
        client_secret: "client-secret",
        redirect_uris: ["https://app.example.com/oauth-callback"],
        scopes: ["read"],
        default_scopes: ["read", "write"],
        supports_resource_metadata: false,
        server_url: "https://mcp.example.com",
        auth_server_url: "https://auth.example.com",
        authorization_endpoint:
          "https://legacy-idp.example.com/oauth/authorize",
        well_known_url:
          "https://auth.example.com/.well-known/openid-configuration",
        resource_metadata_url:
          "https://mcp.example.com/.well-known/oauth-protected-resource/mcp",
        token_endpoint: "https://legacy-idp.example.com/oauth/token",
        name: "Direct OAuth MCP",
      },
    } as never);

    expect(values.oauthConfig?.authorizationEndpoint).toBe(
      "https://legacy-idp.example.com/oauth/authorize",
    );
    expect(values.oauthConfig?.tokenEndpoint).toBe(
      "https://legacy-idp.example.com/oauth/token",
    );
  });
});
