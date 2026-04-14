import {
  type AgentScope,
  type archestraApiTypes,
  type archestraCatalogTypes,
  type ImagePullSecretConfig,
  isVaultReference,
  parseVaultReference,
} from "@shared";
import { parseDockerArgsToLocalConfig } from "./docker-args-parser";
import type { McpCatalogFormValues } from "./mcp-catalog-form.types";

type McpCatalogApiData =
  archestraApiTypes.CreateInternalMcpCatalogItemData["body"];

// Transform function to convert form values to API format
export function transformFormToApiData(
  values: McpCatalogFormValues,
): McpCatalogApiData {
  const data: McpCatalogApiData = {
    name: values.name,
    description: values.description || null,
    serverType: values.serverType,
    icon: values.icon ?? null,
  };

  if (values.serverUrl) {
    data.serverUrl = values.serverUrl;
  }

  // Note: deploymentSpecYaml is handled separately via the "Edit K8S Deployment Yaml" dialog
  // The main form does not touch the YAML - it's only stored when explicitly edited

  // Handle local configuration
  if (values.serverType === "local" && values.localConfig) {
    // Parse arguments string into array
    const argumentsArray = values.localConfig.arguments
      ? values.localConfig.arguments
          .split("\n")
          .map((arg) => arg.trim())
          .filter((arg) => arg.length > 0)
      : [];

    data.localConfig = {
      command: values.localConfig.command || undefined,
      arguments: argumentsArray.length > 0 ? argumentsArray : undefined,
      environment: values.localConfig.environment,
      envFrom:
        values.localConfig.envFrom?.filter((e) => e.name.trim().length > 0) ||
        undefined,
      dockerImage: values.localConfig.dockerImage || undefined,
      transportType: values.localConfig.transportType || undefined,
      httpPort: values.localConfig.httpPort
        ? Number(values.localConfig.httpPort)
        : undefined,
      httpPath: values.localConfig.httpPath || undefined,
      serviceAccount: values.localConfig.serviceAccount || undefined,
      imagePullSecrets:
        values.localConfig.imagePullSecrets?.filter((s) => {
          if (s.source === "existing") return s.name.trim().length > 0;
          if (s.source === "credentials") return s.server.trim().length > 0;
          return false;
        }) || undefined,
    };

    // BYOS: Include local config vault path and key if set
    if (values.localConfigVaultPath && values.localConfigVaultKey) {
      data.localConfigVaultPath = values.localConfigVaultPath;
      data.localConfigVaultKey = values.localConfigVaultKey;
    }
  }

  // Handle OAuth configuration
  if (values.authMethod === "oauth" && values.oauthConfig) {
    const redirectUrisList = values.oauthConfig.redirect_uris
      .split(",")
      .map((uri) => uri.trim())
      .filter((uri) => uri.length > 0);

    const explicitScopes = values.oauthConfig.scopes?.trim() ?? "";
    const parsedScopes = explicitScopes
      .split(",")
      .map((scope) => scope.trim())
      .filter((scope) => scope.length > 0);
    const hasExplicitScopes = parsedScopes.length > 0;
    const scopesList = hasExplicitScopes ? parsedScopes : ["read", "write"];

    // For local servers, use oauthServerUrl; for remote servers, use serverUrl
    const oauthServerUrl =
      values.serverType === "local"
        ? values.oauthConfig.oauthServerUrl || ""
        : values.serverUrl || "";

    data.oauthConfig = {
      name: values.name, // Use name as OAuth provider name
      server_url: oauthServerUrl, // OAuth server URL for discovery/authorization
      auth_server_url: values.oauthConfig.authServerUrl || undefined,
      authorization_endpoint:
        values.oauthConfig.authorizationEndpoint || undefined,
      well_known_url: values.oauthConfig.wellKnownUrl || undefined,
      resource_metadata_url:
        values.oauthConfig.resourceMetadataUrl || undefined,
      token_endpoint: values.oauthConfig.tokenEndpoint || undefined,
      client_id: values.oauthConfig.client_id || "",
      // Only include client_secret if no BYOS vault path is set
      client_secret: values.oauthClientSecretVaultPath
        ? undefined
        : values.oauthConfig.client_secret || undefined,
      redirect_uris: redirectUrisList,
      scopes: scopesList,
      // Keep fallback scopes aligned with explicit scopes because the backend
      // skips discovery entirely when scopes are configured.
      default_scopes: hasExplicitScopes ? scopesList : ["read", "write"],
      supports_resource_metadata: values.oauthConfig.supports_resource_metadata,
    };

    // BYOS: Include OAuth client secret vault path and key if set
    if (values.oauthClientSecretVaultPath && values.oauthClientSecretVaultKey) {
      data.oauthClientSecretVaultPath = values.oauthClientSecretVaultPath;
      data.oauthClientSecretVaultKey = values.oauthClientSecretVaultKey;
    }

    // Clear userConfig when using OAuth
    data.userConfig = {};
    data.enterpriseManagedConfig = undefined;
  } else if (values.authMethod === "enterprise_managed") {
    data.userConfig = {};
    data.oauthConfig = undefined;
    data.enterpriseManagedConfig = values.enterpriseManagedConfig ?? null;
  } else if (values.authMethod === "bearer") {
    // Handle Bearer Token configuration
    data.userConfig = {
      access_token: {
        type: "string" as const,
        title: "Access Token",
        description: "Bearer token for authentication",
        required: true,
        sensitive: true,
      },
    };
    // Clear oauthConfig when using Bearer Token
    data.oauthConfig = undefined;
    data.enterpriseManagedConfig = undefined;
  } else if (values.authMethod === "raw_token") {
    // Handle Token (no prefix) configuration
    data.userConfig = {
      raw_access_token: {
        type: "string" as const,
        title: "Access Token",
        description: "Token for authentication (sent without Bearer prefix)",
        required: true,
        sensitive: true,
      },
    };
    // Clear oauthConfig when using Token
    data.oauthConfig = undefined;
    data.enterpriseManagedConfig = undefined;
  } else {
    // No authentication - clear both configs
    data.userConfig = {};
    data.oauthConfig = undefined;
    data.enterpriseManagedConfig = undefined;
  }

  // Handle labels
  if (values.labels && values.labels.length > 0) {
    data.labels = values.labels;
  } else {
    data.labels = [];
  }

  // Handle scope
  if (values.scope) {
    data.scope = values.scope;
  }

  // Handle teams for team scope
  if (values.scope === "team" && values.teams) {
    data.teams = values.teams;
  }

  return data;
}

// Transform catalog item to form values
export function transformCatalogItemToFormValues(
  item: archestraApiTypes.GetInternalMcpCatalogResponses["200"][number],
  localConfigSecret?: {
    secret: Record<string, unknown>;
  } | null,
): McpCatalogFormValues {
  // Determine auth method
  let authMethod:
    | "none"
    | "bearer"
    | "raw_token"
    | "oauth"
    | "enterprise_managed" = "none";
  if (item.enterpriseManagedConfig) {
    authMethod = "enterprise_managed";
  } else if (item.oauthConfig) {
    authMethod = "oauth";
  } else if (item.userConfig?.raw_access_token) {
    authMethod = "raw_token";
  } else if (item.userConfig?.access_token) {
    authMethod = "bearer";
  } else if (
    // Special case: GitHub server uses Bearer Token but external catalog doesn't define userConfig
    item.name.includes("githubcopilot") ||
    item.name.includes("github")
  ) {
    authMethod = "bearer";
  }

  // Check if OAuth client_secret is a BYOS vault reference
  let oauthClientSecretVaultPath: string | undefined;
  let oauthClientSecretVaultKey: string | undefined;
  const clientSecretValue = item.oauthConfig?.client_secret;
  if (isVaultReference(clientSecretValue)) {
    const parsed = parseVaultReference(clientSecretValue);
    oauthClientSecretVaultPath = parsed.path;
    oauthClientSecretVaultKey = parsed.key;
  }

  // Extract OAuth config if present
  let oauthConfig:
    | {
        client_id: string;
        client_secret: string;
        redirect_uris: string;
        scopes: string;
        supports_resource_metadata: boolean;
        authServerUrl?: string;
        authorizationEndpoint?: string;
        wellKnownUrl?: string;
        resourceMetadataUrl?: string;
        tokenEndpoint?: string;
        oauthServerUrl?: string;
      }
    | undefined;
  if (item.oauthConfig) {
    oauthConfig = {
      client_id: item.oauthConfig.client_id || "",
      // Don't include vault reference as client_secret - it will be handled via BYOS fields
      client_secret: oauthClientSecretVaultPath
        ? ""
        : item.oauthConfig.client_secret || "",
      redirect_uris: item.oauthConfig.redirect_uris?.join(", ") || "",
      scopes: item.oauthConfig.scopes?.join(", ") || "",
      supports_resource_metadata:
        item.oauthConfig.supports_resource_metadata ?? true,
      authServerUrl: item.oauthConfig.auth_server_url || "",
      authorizationEndpoint: item.oauthConfig.authorization_endpoint || "",
      wellKnownUrl: item.oauthConfig.well_known_url || "",
      resourceMetadataUrl: item.oauthConfig.resource_metadata_url || "",
      tokenEndpoint: item.oauthConfig.token_endpoint || "",
      // For local servers, populate oauthServerUrl from server_url
      oauthServerUrl:
        item.serverType === "local"
          ? item.oauthConfig.server_url || ""
          : undefined,
    };
  }

  // Extract local config if present
  let localConfig:
    | {
        command?: string;
        arguments: string;
        environment: Array<{
          key: string;
          type: "plain_text" | "secret" | "boolean" | "number";
          value?: string;
          promptOnInstallation: boolean;
          required?: boolean;
          description?: string;
        }>;
        envFrom?: Array<{
          type: "secret" | "configMap";
          name: string;
          prefix?: string;
        }>;
        dockerImage?: string;
        transportType?: "stdio" | "streamable-http";
        httpPort?: string;
        httpPath?: string;
        serviceAccount?: string;
        imagePullSecrets?: ImagePullSecretConfig[];
      }
    | undefined;
  if (item.localConfig) {
    // Convert arguments array back to string
    const argumentsString = item.localConfig.arguments?.join("\n") || "";

    const config = item.localConfig;

    // Map environment variables and populate values from secret if available
    const environment =
      item.localConfig.environment?.map((env) => {
        const envVar = {
          ...env,
          // Add promptOnInstallation with default value if missing
          promptOnInstallation: env.promptOnInstallation ?? false,
          // Preserve required and description fields
          required: env.required ?? false,
          description: env.description ?? "",
        };

        // If we have a secret and the secret contains a value for this env var key, use it
        if (localConfigSecret?.secret && env.key in localConfigSecret.secret) {
          const secretValue = localConfigSecret.secret[env.key];
          // Convert the value to string if it's not already
          envVar.value =
            secretValue !== null && secretValue !== undefined
              ? String(secretValue)
              : undefined;
        }

        return envVar;
      }) || [];

    localConfig = {
      command: item.localConfig.command || "",
      arguments: argumentsString,
      environment,
      envFrom: item.localConfig.envFrom || [],
      dockerImage: item.localConfig.dockerImage || "",
      transportType: config.transportType || undefined,
      httpPort: config.httpPort?.toString() || undefined,
      httpPath: config.httpPath || undefined,
      serviceAccount: config.serviceAccount || undefined,
      // Normalize imagePullSecrets: legacy { name } → { source: "existing", name }
      // Also hydrate passwords from localConfigSecret for credentials entries
      imagePullSecrets: (item.localConfig.imagePullSecrets || []).map(
        (s: ImagePullSecretConfig | { name: string }) => {
          if (!("source" in s)) {
            return { source: "existing" as const, name: s.name };
          }
          if (s.source === "credentials" && localConfigSecret?.secret) {
            const passwordKey = `__regcred_password:${s.server}:${s.username}`;
            const password = localConfigSecret.secret[passwordKey];
            return {
              ...s,
              password: password != null ? String(password) : undefined,
            };
          }
          return s;
        },
      ),
    };
  }

  return {
    name: item.name,
    description: item.description || "",
    icon: item.icon ?? null,
    serverType: item.serverType as "remote" | "local",
    serverUrl: item.serverUrl || "",
    authMethod,
    enterpriseManagedConfig: item.enterpriseManagedConfig ?? null,
    oauthConfig,
    localConfig,
    // Top-level deploymentSpecYaml from API (generated by backend if not saved)
    deploymentSpecYaml: item.deploymentSpecYaml || undefined,
    // Store original to detect user modifications
    originalDeploymentSpecYaml: item.deploymentSpecYaml || undefined,
    // BYOS: Include parsed vault path and key if OAuth secret is a vault reference
    oauthClientSecretVaultPath,
    oauthClientSecretVaultKey,
    // Labels
    labels: item.labels ?? [],
    // Scope
    scope: (item.scope as AgentScope) ?? "org",
    // Teams
    teams: item.teams?.map((t) => t.id) ?? [],
  } as McpCatalogFormValues;
}

// Transform an external catalog server manifest into form values for pre-filling
export function transformExternalCatalogToFormValues(
  server: archestraCatalogTypes.ArchestraMcpServerManifest,
): McpCatalogFormValues {
  const getValue = (
    config: NonNullable<
      archestraCatalogTypes.ArchestraMcpServerManifest["user_config"]
    >[string],
  ) => {
    if (config.type === "boolean") {
      return typeof config.default === "boolean"
        ? String(config.default)
        : "false";
    }
    if (config.type === "number" && typeof config.default === "number") {
      return String(config.default);
    }
    return undefined;
  };

  const getEnvVarType = (
    userConfigEntry: NonNullable<
      archestraCatalogTypes.ArchestraMcpServerManifest["user_config"]
    >[string],
  ) => {
    if (userConfigEntry.sensitive) return "secret" as const;
    if (userConfigEntry.type === "boolean") return "boolean" as const;
    if (userConfigEntry.type === "number") return "number" as const;
    return "plain_text" as const;
  };

  // Determine auth method
  let authMethod: "none" | "bearer" | "raw_token" | "oauth" = "none";

  // Detect bearer/raw_token auth from user_config (e.g. GitHub with requires_proxy: true)
  if (server.user_config?.raw_access_token) {
    authMethod = "raw_token";
  } else if (server.user_config?.access_token) {
    authMethod = "bearer";
  }

  // Rewrite redirect URIs to prefer platform callback
  let oauthConfig: McpCatalogFormValues["oauthConfig"] | undefined;
  if (server.oauth_config && !server.oauth_config.requires_proxy) {
    authMethod = "oauth";
    const redirectUris =
      server.oauth_config.redirect_uris
        ?.map((u) =>
          u === "http://localhost:8080/oauth/callback"
            ? `${window.location.origin}/oauth-callback`
            : u,
        )
        .join(", ") || "";
    oauthConfig = {
      client_id: server.oauth_config.client_id || "",
      client_secret: server.oauth_config.client_secret || "",
      redirect_uris:
        redirectUris ||
        (typeof window !== "undefined"
          ? `${window.location.origin}/oauth-callback`
          : ""),
      scopes: server.oauth_config.scopes?.join(", ") || "read, write",
      supports_resource_metadata:
        server.oauth_config.supports_resource_metadata ?? true,
      authServerUrl: server.oauth_config.auth_server_url || "",
      authorizationEndpoint:
        getOptionalStringProperty(
          server.oauth_config,
          "authorization_endpoint",
        ) || "",
      wellKnownUrl: server.oauth_config.well_known_url || "",
      resourceMetadataUrl: server.oauth_config.resource_metadata_url || "",
      tokenEndpoint: server.oauth_config.token_endpoint || "",
      oauthServerUrl:
        server.server.type === "local"
          ? server.oauth_config.server_url || ""
          : undefined,
    };
  }

  // Build local config for local servers
  let localConfig: McpCatalogFormValues["localConfig"];
  if (server.server.type === "local") {
    // Track which user_config keys are referenced in server.env
    const referencedUserConfigKeys = new Set<string>();

    // Parse server.env entries
    const envFromServerEnv = server.server.env
      ? Object.entries(server.server.env).map(([envKey, envValue]) => {
          const match = envValue.match(/^\$\{user_config\.(.+)\}$/);
          if (match && server.user_config) {
            const userConfigKey = match[1];
            const userConfigEntry = server.user_config[userConfigKey];
            referencedUserConfigKeys.add(userConfigKey);
            if (userConfigEntry) {
              return {
                key: envKey,
                type: getEnvVarType(userConfigEntry),
                value: "" as string | undefined,
                promptOnInstallation: true,
                required: userConfigEntry.required ?? false,
                description: [
                  userConfigEntry.title,
                  userConfigEntry.description,
                ]
                  .filter(Boolean)
                  .join(": "),
                default: Array.isArray(userConfigEntry.default)
                  ? undefined
                  : userConfigEntry.default,
                mounted: (
                  userConfigEntry as typeof userConfigEntry & {
                    mounted?: boolean;
                  }
                ).mounted,
              };
            }
          }
          return {
            key: envKey,
            type: "plain_text" as const,
            value: envValue as string | undefined,
            promptOnInstallation: false,
            required: false,
            description: "",
            default: undefined,
          };
        })
      : [];

    // Add user_config entries NOT referenced in server.env
    const envFromUnreferencedUserConfig = server.user_config
      ? Object.entries(server.user_config)
          .filter(([key]) => !referencedUserConfigKeys.has(key))
          .map(([key, config]) => ({
            key,
            type: getEnvVarType(config),
            value: getValue(config),
            promptOnInstallation: true,
            required: config.required ?? false,
            description: [config.title, config.description]
              .filter(Boolean)
              .join(": "),
            default: Array.isArray(config.default) ? undefined : config.default,
            mounted: (config as typeof config & { mounted?: boolean }).mounted,
          }))
      : [];

    const environment = [...envFromServerEnv, ...envFromUnreferencedUserConfig];

    // Parse docker args
    const dockerConfig = parseDockerArgsToLocalConfig(
      server.server.command,
      server.server.args,
      server.server.docker_image,
    );

    const serviceAccount = (
      server.server as typeof server.server & { service_account?: string }
    ).service_account;
    const normalizedServiceAccount = serviceAccount
      ? serviceAccount.replace(
          /\{\{ARCHESTRA_RELEASE_NAME\}\}/g,
          "{{HELM_RELEASE_NAME}}",
        )
      : "";

    if (dockerConfig) {
      localConfig = {
        command: dockerConfig.command || "",
        arguments: dockerConfig.arguments?.join("\n") || "",
        dockerImage: dockerConfig.dockerImage || "",
        transportType: dockerConfig.transportType || "stdio",
        httpPort: dockerConfig.httpPort?.toString() || "",
        httpPath: "/mcp",
        serviceAccount: normalizedServiceAccount,
        imagePullSecrets: [],
        envFrom: [],
        environment,
      };
    } else {
      localConfig = {
        command: server.server.command || "",
        arguments: server.server.args?.join("\n") || "",
        dockerImage: server.server.docker_image || "",
        transportType: "stdio",
        httpPort: "",
        httpPath: "/mcp",
        serviceAccount: normalizedServiceAccount,
        imagePullSecrets: [],
        envFrom: [],
        environment,
      };
    }
  }

  return {
    name: server.display_name || server.name,
    description: server.description || "",
    icon: server.icon ?? null,
    serverType: server.server.type as "remote" | "local",
    serverUrl: server.server.type === "remote" ? server.server.url : "",
    authMethod,
    oauthConfig: oauthConfig ?? {
      client_id: "",
      client_secret: "",
      redirect_uris:
        typeof window !== "undefined"
          ? `${window.location.origin}/oauth-callback`
          : "",
      scopes: "read, write",
      supports_resource_metadata: true,
      authServerUrl: "",
      authorizationEndpoint: "",
      wellKnownUrl: "",
      resourceMetadataUrl: "",
      tokenEndpoint: "",
    },
    localConfig: localConfig ?? {
      command: "",
      arguments: "",
      environment: [],
      envFrom: [],
      dockerImage: "",
      transportType: "stdio",
      httpPort: "",
      httpPath: "/mcp",
      serviceAccount: "",
      imagePullSecrets: [],
    },
    scope: "personal",
    teams: [],
  } as McpCatalogFormValues;
}

function getOptionalStringProperty(
  value: unknown,
  key: string,
): string | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }

  const propertyValue = (value as Record<string, unknown>)[key];
  return typeof propertyValue === "string" ? propertyValue : undefined;
}

/**
 * Strips surrounding quotes from an environment variable value.
 * Handles both double quotes (") and single quotes (').
 * Only strips quotes if they match at both the beginning and end.
 *
 * @param value - The raw environment variable value that may contain quotes
 * @returns The value with surrounding quotes removed if present
 *
 * @example
 * stripEnvVarQuotes('"http://grafana:80"') // returns 'http://grafana:80'
 * stripEnvVarQuotes("'value'") // returns 'value'
 * stripEnvVarQuotes('no-quotes') // returns 'no-quotes'
 * stripEnvVarQuotes('"mismatched\'') // returns '"mismatched\''
 * stripEnvVarQuotes('') // returns ''
 */
export function stripEnvVarQuotes(value: string): string {
  if (!value || value.length < 2) {
    return value;
  }

  const firstChar = value[0];
  const lastChar = value[value.length - 1];

  // Only strip if first and last chars are matching quotes
  if (
    (firstChar === '"' && lastChar === '"') ||
    (firstChar === "'" && lastChar === "'")
  ) {
    return value.slice(1, -1);
  }

  return value;
}
