import type { McpCatalogFormValues } from "./mcp-catalog-form.types";
import {
  transformCatalogItemToFormValues,
  transformExternalCatalogToFormValues,
  transformFormToApiData,
} from "./mcp-catalog-form.utils";

describe("transformFormToApiData", () => {
  it("maps custom auth and additional headers into userConfig", () => {
    const values: McpCatalogFormValues = {
      name: "Header MCP",
      description: "",
      icon: null,
      serverType: "remote",
      serverUrl: "https://mcp.example.com",
      authMethod: "bearer",
      includeBearerPrefix: true,
      authHeaderName: "x-api-key",
      additionalHeaders: [
        {
          headerName: "x-tenant-id",
          promptOnInstallation: false,
          required: false,
          value: "tenant-42",
          description: "Tenant header",
        },
      ],
      oauthConfig: undefined,
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

    expect(transformFormToApiData(values).userConfig).toEqual({
      access_token: expect.objectContaining({
        headerName: "x-api-key",
      }),
      header_x_tenant_id: expect.objectContaining({
        headerName: "x-tenant-id",
        promptOnInstallation: false,
        required: false,
        default: "tenant-42",
        description: "Tenant header",
        sensitive: false,
      }),
    });
  });

  it("includes OAuth discovery overrides in the API payload", () => {
    const values: McpCatalogFormValues = {
      name: "Direct OAuth MCP",
      description: "",
      icon: null,
      serverType: "local",
      serverUrl: "",
      authMethod: "oauth",
      includeBearerPrefix: true,
      authHeaderName: "",
      additionalHeaders: [],
      oauthConfig: {
        client_id: "client-id",
        client_secret: "client-secret",
        audience: "",
        redirect_uris: "https://app.example.com/oauth-callback",
        scopes: "read:jira-work",
        supports_resource_metadata: true,
        grantType: "authorization_code",
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
      includeBearerPrefix: true,
      authHeaderName: "",
      additionalHeaders: [],
      oauthConfig: {
        client_id: "client-id",
        client_secret: "client-secret",
        audience: "",
        redirect_uris: "https://app.example.com/oauth-callback",
        scopes: "read:jira-work",
        supports_resource_metadata: true,
        grantType: "authorization_code",
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

  it("persists empty scopes when the scopes field is blank, but keeps ['read','write'] as default_scopes fallback", () => {
    const values: McpCatalogFormValues = {
      name: "Default Scope OAuth MCP",
      description: "",
      icon: null,
      serverType: "remote",
      serverUrl: "https://mcp.example.com",
      authMethod: "oauth",
      includeBearerPrefix: true,
      authHeaderName: "",
      additionalHeaders: [],
      oauthConfig: {
        client_id: "client-id",
        client_secret: "client-secret",
        audience: "",
        redirect_uris: "https://app.example.com/oauth-callback",
        scopes: "",
        supports_resource_metadata: false,
        grantType: "authorization_code",
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
      scopes: [],
      default_scopes: ["read", "write"],
    });
  });

  it("treats comma-only scopes input as blank (persists empty scopes with read/write fallback)", () => {
    const values: McpCatalogFormValues = {
      name: "Comma Scope OAuth MCP",
      description: "",
      icon: null,
      serverType: "remote",
      serverUrl: "https://mcp.example.com",
      authMethod: "oauth",
      includeBearerPrefix: true,
      authHeaderName: "",
      additionalHeaders: [],
      oauthConfig: {
        client_id: "client-id",
        client_secret: "client-secret",
        audience: "",
        redirect_uris: "https://app.example.com/oauth-callback",
        scopes: " , ",
        supports_resource_metadata: false,
        grantType: "authorization_code",
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
      scopes: [],
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
        audience: "",
        redirect_uris: ["https://app.example.com/oauth-callback"],
        scopes: ["read"],
        default_scopes: ["read", "write"],
        supports_resource_metadata: false,
        grant_type: "authorization_code",
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

  it("maps OAuth client credentials auth into install-time shared fields", () => {
    const values: McpCatalogFormValues = {
      name: "Shared OAuth MCP",
      description: "",
      icon: null,
      serverType: "remote",
      serverUrl: "https://mcp.example.com",
      authMethod: "oauth_client_credentials",
      includeBearerPrefix: true,
      authHeaderName: "",
      additionalHeaders: [],
      oauthConfig: {
        client_id: "",
        client_secret: "",
        audience: "https://api.example.com",
        redirect_uris: "",
        scopes: "read, write",
        supports_resource_metadata: false,
        grantType: "client_credentials",
        oauthServerUrl: "",
        authServerUrl: "",
        authorizationEndpoint: "",
        wellKnownUrl: "",
        resourceMetadataUrl: "",
        tokenEndpoint: "https://auth.example.com/oauth/token",
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
      scope: "team",
      teams: ["team-1"],
    };

    const result = transformFormToApiData(values);

    expect(result.oauthConfig).toMatchObject({
      grant_type: "client_credentials",
      token_endpoint: "https://auth.example.com/oauth/token",
      audience: "https://api.example.com",
      redirect_uris: [],
      scopes: ["read", "write"],
      default_scopes: ["read", "write"],
    });
    expect(result.userConfig).toMatchObject({
      client_id: expect.objectContaining({ required: true }),
      client_secret: expect.objectContaining({ sensitive: true }),
      audience: expect.objectContaining({
        required: false,
        default: "https://api.example.com",
      }),
    });
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
        grant_type: "authorization_code",
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

  it("hydrates custom auth and additional headers from internal catalog items", () => {
    const values = transformCatalogItemToFormValues({
      id: "catalog-headers",
      name: "Header MCP",
      description: "",
      icon: null,
      serverType: "remote",
      serverUrl: "https://mcp.example.com",
      oauthConfig: null,
      enterpriseManagedConfig: null,
      localConfig: null,
      deploymentSpecYaml: null,
      userConfig: {
        access_token: {
          type: "string",
          title: "Access Token",
          description: "Bearer token",
          required: true,
          sensitive: true,
          headerName: "x-api-key",
        },
        header_x_tenant_id: {
          type: "string",
          title: "x-tenant-id",
          description: "Tenant ID",
          promptOnInstallation: false,
          required: false,
          sensitive: false,
          headerName: "x-tenant-id",
          default: "tenant-42",
        },
      },
      scope: "personal",
      teams: [],
      labels: [],
    } as never);

    expect(values.authMethod).toBe("bearer");
    expect(values.includeBearerPrefix).toBe(true);
    expect(values.authHeaderName).toBe("x-api-key");
    expect(values.additionalHeaders).toEqual([
      {
        fieldName: "header_x_tenant_id",
        headerName: "x-tenant-id",
        promptOnInstallation: false,
        required: false,
        value: "tenant-42",
        description: "Tenant ID",
        includeBearerPrefix: false,
      },
    ]);
  });

  it("leaves the scopes field empty when external catalog oauth_config has no scopes", () => {
    const values = transformExternalCatalogToFormValues({
      name: "empty-scopes-server",
      display_name: "Empty Scopes Server",
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
        scopes: [],
        default_scopes: ["read", "write"],
        supports_resource_metadata: true,
        grant_type: "authorization_code",
        server_url: "https://mcp.example.com",
      },
    } as never);

    expect(values.oauthConfig?.scopes).toBe("");
  });

  it("detects default bearer auth from external catalog manifests without an explicit headerName", () => {
    const values = transformExternalCatalogToFormValues({
      name: "github",
      display_name: "GitHub",
      description: "",
      icon: null,
      server: {
        type: "remote",
        url: "https://api.githubcopilot.com/mcp",
      },
      user_config: {
        access_token: {
          type: "string",
          title: "Access Token",
          description: "GitHub personal access token",
          required: true,
          sensitive: true,
        },
      },
    } as never);

    expect(values.authMethod).toBe("bearer");
    expect(values.includeBearerPrefix).toBe(true);
    expect(values.authHeaderName).toBe("");
  });

  it("detects default raw token auth from external catalog manifests without an explicit headerName", () => {
    const values = transformExternalCatalogToFormValues({
      name: "raw-token-server",
      display_name: "Raw Token Server",
      description: "",
      icon: null,
      server: {
        type: "remote",
        url: "https://mcp.example.com",
      },
      user_config: {
        raw_access_token: {
          type: "string",
          title: "Raw Access Token",
          description: "Token sent without the Bearer prefix",
          required: true,
          sensitive: true,
        },
      },
    } as never);

    expect(values.authMethod).toBe("bearer");
    expect(values.includeBearerPrefix).toBe(false);
    expect(values.authHeaderName).toBe("");
  });

  it("persists IdP JWT / JWKS passthrough auth as enterprise-managed passthrough config", () => {
    const values: McpCatalogFormValues = {
      name: "JWT MCP",
      description: "",
      icon: null,
      serverType: "remote",
      serverUrl: "https://mcp.example.com",
      authMethod: "idp_jwt",
      includeBearerPrefix: true,
      authHeaderName: "",
      additionalHeaders: [],
      oauthConfig: undefined,
      enterpriseManagedConfig: {
        identityProviderId: "idp-1",
        assertionMode: "passthrough",
        requestedCredentialType: "bearer_token",
        tokenInjectionMode: "authorization_bearer",
      },
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

    expect(transformFormToApiData(values).enterpriseManagedConfig).toEqual({
      identityProviderId: "idp-1",
      assertionMode: "passthrough",
      requestedCredentialType: "bearer_token",
      tokenInjectionMode: "authorization_bearer",
      headerName: undefined,
    });
  });

  it("hydrates IdP JWT / JWKS passthrough auth from internal catalog items", () => {
    const values = transformCatalogItemToFormValues({
      id: "catalog-jwt",
      name: "JWT MCP",
      description: "",
      icon: null,
      serverType: "remote",
      serverUrl: "https://mcp.example.com",
      oauthConfig: null,
      enterpriseManagedConfig: {
        identityProviderId: "idp-1",
        assertionMode: "passthrough",
        requestedCredentialType: "bearer_token",
        tokenInjectionMode: "authorization_bearer",
      },
      localConfig: null,
      deploymentSpecYaml: null,
      userConfig: {},
      scope: "personal",
      teams: [],
      labels: [],
    } as never);

    expect(values.authMethod).toBe("idp_jwt");
    expect(values.includeBearerPrefix).toBe(true);
    expect(values.enterpriseManagedConfig?.identityProviderId).toBe("idp-1");
    expect(values.enterpriseManagedConfig?.assertionMode).toBe("passthrough");
  });

  it("treats authorization header names case-insensitively when hydrating form values", () => {
    const values = transformCatalogItemToFormValues({
      id: "catalog-auth-header",
      name: "Header MCP",
      description: "",
      icon: null,
      serverType: "remote",
      serverUrl: "https://mcp.example.com",
      oauthConfig: null,
      enterpriseManagedConfig: null,
      localConfig: null,
      deploymentSpecYaml: null,
      userConfig: {
        access_token: {
          type: "string",
          title: "Access Token",
          description: "Bearer token",
          required: true,
          sensitive: true,
          headerName: "authorization",
        },
      },
      scope: "personal",
      teams: [],
      labels: [],
    } as never);

    expect(values.authMethod).toBe("bearer");
    expect(values.includeBearerPrefix).toBe(true);
    expect(values.authHeaderName).toBe("");
  });

  it("hydrates legacy raw token auth into bearer mode without the bearer prefix", () => {
    const values = transformCatalogItemToFormValues({
      id: "catalog-raw-token",
      name: "Raw Token MCP",
      description: "",
      icon: null,
      serverType: "remote",
      serverUrl: "https://mcp.example.com",
      oauthConfig: null,
      enterpriseManagedConfig: null,
      localConfig: null,
      deploymentSpecYaml: null,
      userConfig: {
        raw_access_token: {
          type: "string",
          title: "Access Token",
          description: "Token without Bearer prefix",
          required: true,
          sensitive: true,
          headerName: "Authorization",
        },
      },
      scope: "personal",
      teams: [],
      labels: [],
    } as never);

    expect(values.authMethod).toBe("bearer");
    expect(values.includeBearerPrefix).toBe(false);
    expect(values.authHeaderName).toBe("");
  });
});
