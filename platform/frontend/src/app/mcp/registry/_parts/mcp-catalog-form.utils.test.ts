import type { McpCatalogFormValues } from "./mcp-catalog-form.types";
import {
  buildCloneFormValues,
  mergePastedMcpServerConfigValues,
  parsePastedMcpServerConfig,
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
        resource: "https://mcp.example.com",
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
      resource: "https://mcp.example.com",
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
        sensitive: false,
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

  describe("preserves additionalHeaders across all auth methods", () => {
    const additionalHeaders: McpCatalogFormValues["additionalHeaders"] = [
      {
        headerName: "x-api-key",
        promptOnInstallation: true,
        required: true,
        value: "",
        description: "",
        includeBearerPrefix: false,
      },
    ];

    const baseValues: McpCatalogFormValues = {
      name: "Headers MCP",
      description: "",
      icon: null,
      serverType: "remote",
      serverUrl: "https://mcp.example.com",
      authMethod: "none",
      includeBearerPrefix: true,
      authHeaderName: "",
      additionalHeaders,
      oauthConfig: {
        client_id: "id",
        client_secret: "secret",
        audience: "",
        resource: "",
        redirect_uris: "https://app.example.com/oauth-callback",
        scopes: "",
        supports_resource_metadata: true,
        grantType: "authorization_code",
        oauthServerUrl: "",
        authServerUrl: "",
        authorizationEndpoint: "https://auth.example.com/authorize",
        wellKnownUrl: "",
        resourceMetadataUrl: "",
        tokenEndpoint: "https://auth.example.com/token",
      },
      enterpriseManagedConfig: {
        identityProviderId: "idp-1",
        assertionMode: "exchange",
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

    const cases: McpCatalogFormValues["authMethod"][] = [
      "oauth",
      "oauth_client_credentials",
      "enterprise_managed",
      "idp_jwt",
    ];

    for (const authMethod of cases) {
      it(`keeps additional headers when authMethod is ${authMethod}`, () => {
        const result = transformFormToApiData({ ...baseValues, authMethod });
        expect(result.userConfig).toMatchObject({
          header_x_api_key: expect.objectContaining({
            headerName: "x-api-key",
            promptOnInstallation: true,
          }),
        });
      });
    }
  });

  describe("round-trips the `sensitive` flag on additional headers", () => {
    // form → API → form preserves the `sensitive` flag on installation-scoped
    // headers (where the flag controls input masking but doesn't change
    // storage).
    type AdditionalHeader = NonNullable<
      McpCatalogFormValues["additionalHeaders"]
    >[number];

    function makeBaseValues(header: AdditionalHeader): McpCatalogFormValues {
      return {
        name: "Sensitive Headers MCP",
        description: "",
        icon: null,
        serverType: "remote",
        serverUrl: "https://mcp.example.com",
        authMethod: "none",
        includeBearerPrefix: false,
        authHeaderName: "",
        additionalHeaders: [header],
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
    }

    function roundTrip(header: AdditionalHeader): AdditionalHeader {
      const values = makeBaseValues(header);
      const apiData = transformFormToApiData(values);
      const rehydrated = transformCatalogItemToFormValues({
        id: "round-trip",
        name: values.name,
        description: null,
        icon: null,
        serverType: "remote",
        serverUrl: values.serverUrl,
        oauthConfig: null,
        enterpriseManagedConfig: null,
        localConfig: null,
        deploymentSpecYaml: null,
        userConfig: apiData.userConfig ?? null,
        scope: "personal",
        teams: [],
        labels: [],
      } as never);
      expect(rehydrated.additionalHeaders).toHaveLength(1);
      const [first] = rehydrated.additionalHeaders ?? [];
      if (!first) {
        throw new Error("expected hydrated header row");
      }
      return first;
    }

    it("preserves sensitive=true on an installation-scoped header", () => {
      const result = roundTrip({
        headerName: "x-tenant-token",
        promptOnInstallation: true,
        required: true,
        value: "",
        description: "",
        includeBearerPrefix: false,
        sensitive: true,
      });
      expect(result).toMatchObject({
        headerName: "x-tenant-token",
        promptOnInstallation: true,
        sensitive: true,
      });
    });

    it("forces sensitive=false on a static header regardless of incoming flag", () => {
      // Server-side validator rejects sensitive + static; the form save
      // path mirrors that so the API never sees the illegal combination.
      const result = roundTrip({
        headerName: "x-static",
        promptOnInstallation: false,
        required: false,
        value: "fixed-value",
        description: "",
        includeBearerPrefix: false,
        sensitive: true, // ← should be coerced to false by the save path
      });
      expect(result).toMatchObject({
        headerName: "x-static",
        promptOnInstallation: false,
        value: "fixed-value",
        sensitive: false,
      });
    });
  });
});

describe("transformFormToApiData - secret env var preservation", () => {
  type LocalEnvironment = NonNullable<
    McpCatalogFormValues["localConfig"]
  >["environment"];

  function buildLocalFormValues(
    environment: LocalEnvironment,
  ): McpCatalogFormValues {
    return {
      name: "secret-preservation-mcp",
      description: "",
      icon: null,
      serverType: "local",
      serverUrl: "",
      authMethod: "none",
      includeBearerPrefix: true,
      authHeaderName: "",
      additionalHeaders: [],
      oauthConfig: undefined,
      enterpriseManagedConfig: null,
      localConfig: {
        command: "node",
        arguments: "server.js",
        environment,
        envFrom: [],
        dockerImage: "",
        transportType: "stdio",
        httpPort: "",
        httpPath: "",
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
  }

  it("emits empty value (not a mask sentinel) for an unedited secret row", () => {
    const result = transformFormToApiData(
      buildLocalFormValues([
        {
          key: "API_KEY",
          type: "secret",
          value: "",
          promptOnInstallation: false,
          required: false,
          description: "",
        },
      ]),
    );

    const envVar = result.localConfig?.environment?.[0];
    expect(envVar?.key).toBe("API_KEY");
    expect(envVar?.type).toBe("secret");
    // The form must NOT round-trip the masked placeholder back to the API.
    // Backend preserves stored value when value is empty/undefined.
    const value = envVar?.value ?? "";
    expect(value).toBe("");
    expect(value).not.toMatch(/[•*]/);
  });

  it("emits the typed value when the user edited the secret row", () => {
    const result = transformFormToApiData(
      buildLocalFormValues([
        {
          key: "API_KEY",
          type: "secret",
          value: "newly-typed-secret",
          promptOnInstallation: false,
          required: false,
          description: "",
        },
      ]),
    );

    expect(result.localConfig?.environment?.[0]?.value).toBe(
      "newly-typed-secret",
    );
  });

  it("preserves mixed edited / unedited secret rows independently", () => {
    const result = transformFormToApiData(
      buildLocalFormValues([
        {
          key: "EDITED",
          type: "secret",
          value: "fresh",
          promptOnInstallation: false,
          required: false,
          description: "",
        },
        {
          key: "UNTOUCHED",
          type: "secret",
          value: "",
          promptOnInstallation: false,
          required: false,
          description: "",
        },
      ]),
    );

    const env = result.localConfig?.environment ?? [];
    expect(env).toHaveLength(2);
    expect(env[0]).toMatchObject({ key: "EDITED", value: "fresh" });
    expect(env[1]?.key).toBe("UNTOUCHED");
    expect(env[1]?.value ?? "").toBe("");
  });
});

describe("parsePastedMcpServerConfig", () => {
  function buildLocalArgumentsFormValues(
    argumentsText: string,
  ): McpCatalogFormValues {
    return {
      name: "json-args",
      description: "",
      icon: null,
      serverType: "local",
      serverUrl: "",
      authMethod: "none",
      includeBearerPrefix: true,
      authHeaderName: "",
      additionalHeaders: [],
      oauthConfig: undefined,
      enterpriseManagedConfig: null,
      localConfig: {
        command: "node",
        arguments: argumentsText,
        environment: [],
        envFrom: [],
        dockerImage: "",
        transportType: "stdio",
        httpPort: "",
        httpPath: "",
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
  }

  it("imports servers plus inputs token placeholder as sensitive remote auth", () => {
    const result = parsePastedMcpServerConfig(
      JSON.stringify({
        servers: {
          github: {
            type: "http",
            url: "https://api.githubcopilot.com/mcp/",
            headers: {
              Authorization: `Bearer ${"$"}{input:github_mcp_pat}`,
            },
          },
        },
        inputs: [
          {
            type: "promptString",
            id: "github_mcp_pat",
            description: "GitHub Personal Access Token",
            password: true,
          },
        ],
      }),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.values).toMatchObject({
      name: "github",
      serverType: "remote",
      serverUrl: "https://api.githubcopilot.com/mcp/",
      authMethod: "bearer",
      includeBearerPrefix: true,
    });
  });

  it("imports Claude Desktop command args env placeholders without persisting placeholder values", () => {
    const result = parsePastedMcpServerConfig(
      JSON.stringify({
        mcpServers: {
          sonarqube: {
            command: "docker",
            args: [
              "run",
              "--init",
              "--pull=always",
              "-i",
              "--rm",
              "-e",
              "SONARQUBE_TOKEN",
              "-e",
              "SONARQUBE_ORG",
              "mcp/sonarqube",
            ],
            env: {
              SONARQUBE_TOKEN: "<token>",
              SONARQUBE_ORG: "<org>",
            },
          },
        },
      }),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.values.serverType).toBe("local");
    expect(result.values.localConfig).toMatchObject({
      command: "docker",
      arguments:
        "run\n--init\n--pull=always\n-i\n--rm\n-e\nSONARQUBE_TOKEN\n-e\nSONARQUBE_ORG\nmcp/sonarqube",
    });
    expect(result.values.localConfig?.environment).toEqual([
      expect.objectContaining({
        key: "SONARQUBE_TOKEN",
        type: "secret",
        value: "",
        promptOnInstallation: true,
        required: true,
      }),
      expect.objectContaining({
        key: "SONARQUBE_ORG",
        type: "plain_text",
        value: "",
        promptOnInstallation: true,
        required: true,
      }),
    ]);
  });

  it("imports top-level named server configs from documentation examples", () => {
    const result = parsePastedMcpServerConfig(
      JSON.stringify({
        sonarqube: {
          command: "docker",
          args: ["run", "--rm", "-e", "SONARQUBE_TOKEN", "mcp/sonarqube"],
          env: {
            SONARQUBE_TOKEN: "YOUR_TOKEN_HERE",
          },
        },
      }),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.values).toMatchObject({
      name: "sonarqube",
      serverType: "local",
      localConfig: {
        command: "docker",
        arguments: "run\n--rm\n-e\nSONARQUBE_TOKEN\nmcp/sonarqube",
      },
    });
    expect(result.values.localConfig?.environment).toEqual([
      expect.objectContaining({
        key: "SONARQUBE_TOKEN",
        type: "secret",
        value: "",
        promptOnInstallation: true,
      }),
    ]);
  });

  it("imports Archestra manifest-like objects without requiring a top-level name", () => {
    const result = parsePastedMcpServerConfig(
      JSON.stringify({
        user_config: {
          access_token: {
            sensitive: true,
            type: "string",
            title: "Access Token",
            description: "A GitHub Personal Access Token",
            required: true,
          },
        },
        oauth_config: {
          name: "GitHub Copilot MCP",
          server_url: "https://api.githubcopilot.com/mcp",
          client_id: "dummy-client-id",
          client_secret: "REDACTED",
          redirect_uris: ["http://localhost:8080/oauth/callback"],
          scopes: ["read", "write"],
          default_scopes: ["read", "write"],
          supports_resource_metadata: true,
          requires_proxy: true,
        },
        server: {
          type: "remote",
          url: "https://api.githubcopilot.com/mcp/",
          docs_url: "https://example.com/docs",
        },
      }),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.values).toMatchObject({
      name: "GitHub Copilot MCP",
      serverType: "remote",
      serverUrl: "https://api.githubcopilot.com/mcp/",
      authMethod: "bearer",
    });
  });

  it("imports official registry remote server details", () => {
    const result = parsePastedMcpServerConfig(
      JSON.stringify({
        $schema:
          "https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json",
        name: "ac.example/search",
        title: "Example Search",
        description: "Search example content",
        version: "1.0.0",
        remotes: [
          {
            type: "streamable-http",
            url: "https://api.example.com/mcp",
          },
        ],
      }),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.values).toMatchObject({
      name: "Example Search",
      description: "Search example content",
      serverType: "remote",
      serverUrl: "https://api.example.com/mcp",
      authMethod: "none",
    });
  });

  it("imports official registry API list wrappers", () => {
    const result = parsePastedMcpServerConfig(
      JSON.stringify({
        servers: [
          {
            server: {
              name: "io.example/browser",
              title: "Browser MCP",
              description: "Browser automation",
              version: "1.0.0",
              remotes: [
                {
                  type: "sse",
                  url: "https://browser.example.com/sse",
                },
              ],
            },
            _meta: {
              official: true,
            },
          },
        ],
      }),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.values).toMatchObject({
      name: "Browser MCP",
      description: "Browser automation",
      serverType: "remote",
      serverUrl: "https://browser.example.com/sse",
    });
  });

  it("imports official registry remote authorization headers as prompted bearer auth", () => {
    const result = parsePastedMcpServerConfig(
      JSON.stringify({
        name: "ai.example/ads",
        title: "Example Ads",
        description: "Ad reporting",
        version: "1.0.0",
        remotes: [
          {
            type: "streamable-http",
            url: "https://api.example.com/mcp",
            headers: [
              {
                name: "Authorization",
                description: "Bearer token for Example Ads",
                isRequired: true,
                isSecret: true,
              },
            ],
          },
        ],
      }),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.values).toMatchObject({
      authMethod: "bearer",
      includeBearerPrefix: true,
      authHeaderName: "",
    });
  });

  it("imports official registry npm packages as local stdio servers", () => {
    const result = parsePastedMcpServerConfig(
      JSON.stringify({
        name: "ai.example/search",
        title: "Example Search",
        description: "Search example content",
        version: "1.0.0",
        packages: [
          {
            registryType: "npm",
            identifier: "@example/search-mcp",
            version: "1.2.3",
            transport: {
              type: "stdio",
            },
            environmentVariables: [
              {
                name: "EXAMPLE_API_KEY",
                description: "Example API key",
                isRequired: true,
                isSecret: true,
              },
              {
                name: "EXAMPLE_BASE_URL",
                default: "https://api.example.com",
              },
              {
                name: "EXAMPLE_REGION",
                value: "us-east-1",
              },
            ],
          },
        ],
      }),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.values).toMatchObject({
      name: "Example Search",
      serverType: "local",
      localConfig: {
        command: "npx",
        arguments: "-y\n@example/search-mcp@1.2.3",
      },
    });
    expect(result.values.localConfig?.environment).toEqual([
      expect.objectContaining({
        key: "EXAMPLE_API_KEY",
        type: "secret",
        value: "",
        promptOnInstallation: true,
        required: true,
      }),
      expect.objectContaining({
        key: "EXAMPLE_BASE_URL",
        type: "plain_text",
        value: "https://api.example.com",
        promptOnInstallation: false,
      }),
      expect.objectContaining({
        key: "EXAMPLE_REGION",
        type: "plain_text",
        value: "us-east-1",
        promptOnInstallation: false,
      }),
    ]);
  });

  it("imports official registry static remote headers without prompting", () => {
    const result = parsePastedMcpServerConfig(
      JSON.stringify({
        name: "ai.example/static-header",
        title: "Static Header",
        description: "Static header example",
        version: "1.0.0",
        remotes: [
          {
            type: "streamable-http",
            url: "https://api.example.com/mcp",
            headers: [
              {
                name: "X-Client-Version",
                value: "2026-06",
              },
            ],
          },
        ],
      }),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.values.additionalHeaders).toEqual([
      expect.objectContaining({
        headerName: "X-Client-Version",
        promptOnInstallation: false,
        required: false,
        sensitive: false,
        value: "2026-06",
      }),
    ]);
  });

  it("treats official registry placeholder tokens as prompted sensitive values", () => {
    const result = parsePastedMcpServerConfig(
      JSON.stringify({
        name: "ai.example/placeholder-header",
        title: "Placeholder Header",
        description: "Placeholder token example",
        version: "1.0.0",
        remotes: [
          {
            type: "streamable-http",
            url: "https://api.example.com/mcp",
            headers: [
              {
                name: "X-Auth-Value",
                placeholder: "Bearer <token>",
              },
            ],
          },
        ],
      }),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.values.additionalHeaders).toEqual([
      expect.objectContaining({
        headerName: "X-Auth-Value",
        promptOnInstallation: true,
        required: false,
        sensitive: true,
      }),
    ]);
    expect(result.values.additionalHeaders?.[0]?.value).toBeUndefined();
  });

  it("imports official registry pypi packages as local stdio servers", () => {
    const result = parsePastedMcpServerConfig(
      JSON.stringify({
        name: "ai.example/python-search",
        title: "Python Search",
        description: "Python package example",
        version: "2.0.0",
        packages: [
          {
            registryType: "pypi",
            identifier: "example-search-mcp",
            version: "2.0.1",
            transport: {
              type: "stdio",
            },
            runtimeArguments: [
              {
                type: "named",
                name: "--verbose",
              },
            ],
          },
        ],
      }),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.values).toMatchObject({
      name: "Python Search",
      serverType: "local",
      localConfig: {
        command: "uvx",
        arguments: "--verbose\nexample-search-mcp==2.0.1",
      },
    });
  });

  it("prompts for sensitive remote headers instead of importing static values", () => {
    const result = parsePastedMcpServerConfig(
      JSON.stringify({
        mcpServers: {
          acme: {
            type: "http",
            url: "https://api.example.com/mcp",
            headers: {
              "X-API-Key": "dummy-api-key",
            },
          },
        },
      }),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.values.additionalHeaders?.[0]).toMatchObject({
      headerName: "X-API-Key",
      promptOnInstallation: true,
      required: true,
      sensitive: true,
    });
    expect(result.values.additionalHeaders?.[0]?.value).toBeUndefined();
  });

  it("rejects remote server urls with non-http protocols", () => {
    const result = parsePastedMcpServerConfig(
      JSON.stringify({
        mcpServers: {
          bad: {
            type: "http",
            url: "javascript:alert(1)",
          },
        },
      }),
    );

    expect(result).toEqual({
      ok: false,
      error:
        "Config must include an MCP server under mcpServers, servers, server, or a command/url object.",
    });
  });

  it("rejects oversized pasted configs before parsing", () => {
    const result = parsePastedMcpServerConfig(
      JSON.stringify({
        mcpServers: {
          huge: {
            command: "npx",
            args: ["x".repeat(70_000)],
          },
        },
      }),
    );

    expect(result).toEqual({
      ok: false,
      error: "Config is too large to import safely.",
    });
  });

  it("drops dangerous pasted env keys", () => {
    const result = parsePastedMcpServerConfig(
      '{"mcpServers":{"safe":{"command":"node","args":["server.js"],"env":{"__proto__":"x","constructor":"y","prototype":"z","OK_ENV":"safe"}}}}',
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.values.localConfig?.environment).toEqual([
      {
        key: "OK_ENV",
        type: "plain_text",
        value: "safe",
        promptOnInstallation: false,
        required: false,
        description: "",
      },
    ]);
    expect(({} as Record<string, unknown>).x).toBeUndefined();
  });

  it("does not use dangerous input references as user-config field names", () => {
    const result = parsePastedMcpServerConfig(
      // biome-ignore lint/suspicious/noTemplateCurlyInString: intentional ${input:...} placeholder fixture
      '{"mcpServers":{"safe":{"command":"node","args":["server.js"],"env":{"SAFE_TOKEN":"${input:__proto__}"}}},"inputs":[{"id":"__proto__","type":"promptString","password":true}]}',
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.values.localConfig?.environment).toEqual([
      expect.objectContaining({
        key: "SAFE_TOKEN",
        type: "secret",
        promptOnInstallation: true,
      }),
    ]);
    expect(({} as Record<string, unknown>).SAFE_TOKEN).toBeUndefined();
  });

  it("drops dangerous pasted remote header keys", () => {
    const result = parsePastedMcpServerConfig(
      '{"mcpServers":{"safe":{"type":"http","url":"https://api.example.com/mcp","headers":{"__proto__":"x","constructor":"y","prototype":"z","X-Trace":"safe"}}}}',
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.values.additionalHeaders).toEqual([
      expect.objectContaining({
        headerName: "X-Trace",
        value: "safe",
        promptOnInstallation: false,
        sensitive: false,
      }),
    ]);
  });

  it("returns a readable error for objects without a server config", () => {
    const result = parsePastedMcpServerConfig(
      JSON.stringify({
        metadata: {
          description: "not an MCP server config",
        },
      }),
    );

    expect(result).toEqual({
      ok: false,
      error:
        "Config must include an MCP server under mcpServers, servers, server, or a command/url object.",
    });
  });

  it("parses JSON array arguments while preserving newline fallback", () => {
    expect(
      transformFormToApiData(
        buildLocalArgumentsFormValues('["server.js","--verbose"]'),
      ).localConfig?.arguments,
    ).toEqual(["server.js", "--verbose"]);

    expect(
      transformFormToApiData(
        buildLocalArgumentsFormValues("server.js\n--verbose"),
      ).localConfig?.arguments,
    ).toEqual(["server.js", "--verbose"]);
  });

  it("returns a readable error for invalid JSON without producing form values", () => {
    const result = parsePastedMcpServerConfig("{ not-json");

    expect(result).toEqual({
      ok: false,
      error: "Config must be valid JSON.",
    });
  });

  it("merges pasted config without losing current visibility, environment, or label state", () => {
    const currentValues = buildLocalArgumentsFormValues("old.js");
    const importedValues = buildLocalArgumentsFormValues("new.js");
    currentValues.environmentId = "123e4567-e89b-12d3-a456-426614174000";
    currentValues.labels = [{ key: "stale", value: "form" }];
    currentValues.scope = "team";
    currentValues.teams = ["team-1"];
    importedValues.labels = [];
    importedValues.scope = "personal";
    importedValues.teams = [];

    const merged = mergePastedMcpServerConfigValues({
      currentValues,
      importedValues,
      currentLabels: [{ key: "draft", value: "label" }],
    });

    expect(merged.localConfig?.arguments).toBe("new.js");
    expect(merged.environmentId).toBe(currentValues.environmentId);
    expect(merged.labels).toEqual([{ key: "draft", value: "label" }]);
    expect(merged.scope).toBe("team");
    expect(merged.teams).toEqual(["team-1"]);
  });
});

describe("buildCloneFormValues", () => {
  it("suffixes the name with -copy", () => {
    const values = buildCloneFormValues({
      id: "catalog-1",
      name: "my-server",
      description: "desc",
      icon: null,
      serverType: "remote",
      serverUrl: "https://mcp.example.com",
      oauthConfig: null,
      enterpriseManagedConfig: null,
      localConfig: null,
      deploymentSpecYaml: null,
      userConfig: {},
      scope: "personal",
      teams: [],
      labels: [],
    } as never);

    expect(values.name).toBe("my-server-copy");
  });

  it("keeps secret values (clone is a full copy)", () => {
    const values = buildCloneFormValues({
      id: "catalog-1",
      name: "oauth-server",
      description: "",
      icon: null,
      serverType: "remote",
      serverUrl: "https://mcp.example.com",
      oauthConfig: {
        client_id: "client-id",
        client_secret: "keep-me",
        grant_type: "authorization_code",
        name: "oauth-server",
      },
      enterpriseManagedConfig: null,
      localConfig: null,
      deploymentSpecYaml: null,
      userConfig: {},
      scope: "personal",
      teams: [],
      labels: [],
    } as never);

    expect(values.oauthConfig?.client_secret).toBe("keep-me");
  });
});
