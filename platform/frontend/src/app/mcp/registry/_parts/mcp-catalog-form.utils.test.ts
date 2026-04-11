import type { McpCatalogFormValues } from "./mcp-catalog-form.types";
import { transformFormToApiData } from "./mcp-catalog-form.utils";

describe("transformFormToApiData", () => {
  it("includes OAuth discovery overrides in the API payload", () => {
    const values: McpCatalogFormValues = {
      name: "Jira MCP",
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
        wellKnownUrl:
          "https://auth.example.com/.well-known/openid-configuration",
        resourceMetadataUrl:
          "https://mcp.example.com/.well-known/oauth-protected-resource/mcp",
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
      well_known_url:
        "https://auth.example.com/.well-known/openid-configuration",
      resource_metadata_url:
        "https://mcp.example.com/.well-known/oauth-protected-resource/mcp",
    });
  });

  it("uses the remote server URL as the OAuth server URL for remote servers", () => {
    const values: McpCatalogFormValues = {
      name: "Remote Jira MCP",
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
        wellKnownUrl:
          "https://auth.example.com/.well-known/openid-configuration",
        resourceMetadataUrl:
          "https://mcp.example.com/.well-known/oauth-protected-resource/mcp",
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
      well_known_url:
        "https://auth.example.com/.well-known/openid-configuration",
      resource_metadata_url:
        "https://mcp.example.com/.well-known/oauth-protected-resource/mcp",
    });
  });
});
