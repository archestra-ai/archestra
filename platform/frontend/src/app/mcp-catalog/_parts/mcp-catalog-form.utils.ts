import {
  type archestraApiTypes,
  isVaultReference,
  parseVaultReference,
} from "@shared";
import type { McpCatalogFormValues } from "./mcp-catalog-form.types";

type McpCatalogApiData =
  archestraApiTypes.CreateInternalMcpCatalogItemData["body"];

// Transform function to convert form values to API format
export function transformFormToApiData(
  values: McpCatalogFormValues,
): McpCatalogApiData {
  const data: McpCatalogApiData = {
    name: values.name,
    serverType: values.serverType,
  };

  if (values.serverUrl) {
    data.serverUrl = values.serverUrl;
  }

  // Handle local configuration
  if (values.serverType === "local" && values.localConfig) {
    // Parse arguments string into array
    const argumentsArray = values.localConfig.arguments
      ? values.localConfig.arguments
          .split("\n")
          .map((arg) => arg.trim())
          .filter((arg) => arg.length > 0)
      : [];

    // Build advanced K8s config if any fields are set
    const advancedK8sConfig = values.localConfig.advancedK8sConfig;
    const hasAdvancedConfig =
      advancedK8sConfig &&
      (advancedK8sConfig.replicas ||
        advancedK8sConfig.namespace ||
        advancedK8sConfig.annotations ||
        advancedK8sConfig.labels ||
        advancedK8sConfig.resourceRequestsMemory ||
        advancedK8sConfig.resourceRequestsCpu ||
        advancedK8sConfig.resourceLimitsMemory ||
        advancedK8sConfig.resourceLimitsCpu);

    data.localConfig = {
      command: values.localConfig.command || undefined,
      arguments: argumentsArray.length > 0 ? argumentsArray : undefined,
      environment: values.localConfig.environment,
      dockerImage: values.localConfig.dockerImage || undefined,
      transportType: values.localConfig.transportType || undefined,
      httpPort: values.localConfig.httpPort
        ? Number(values.localConfig.httpPort)
        : undefined,
      httpPath: values.localConfig.httpPath || undefined,
      serviceAccount: values.localConfig.serviceAccount || undefined,
      // Include advanced K8s config if any fields are set
      ...(hasAdvancedConfig
        ? {
            advancedK8sConfig: {
              replicas: advancedK8sConfig.replicas
                ? Number(advancedK8sConfig.replicas)
                : undefined,
              namespace: advancedK8sConfig.namespace || undefined,
              annotations: advancedK8sConfig.annotations
                ? parseJsonSafe(advancedK8sConfig.annotations)
                : undefined,
              labels: advancedK8sConfig.labels
                ? parseJsonSafe(advancedK8sConfig.labels)
                : undefined,
              resources: buildResources(advancedK8sConfig),
            },
          }
        : {}),
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

    // Default to ["read", "write"] if scopes not provided or empty
    const scopesList = values.oauthConfig.scopes?.trim()
      ? values.oauthConfig.scopes
          .split(",")
          .map((scope) => scope.trim())
          .filter((scope) => scope.length > 0)
      : ["read", "write"];

    data.oauthConfig = {
      name: values.name, // Use name as OAuth provider name
      server_url: values.serverUrl || "", // Use serverUrl as OAuth server URL
      client_id: values.oauthConfig.client_id || "",
      // Only include client_secret if no BYOS vault path is set
      client_secret: values.oauthClientSecretVaultPath
        ? undefined
        : values.oauthConfig.client_secret || undefined,
      redirect_uris: redirectUrisList,
      scopes: scopesList,
      default_scopes: ["read", "write"],
      supports_resource_metadata: values.oauthConfig.supports_resource_metadata,
    };

    // BYOS: Include OAuth client secret vault path and key if set
    if (values.oauthClientSecretVaultPath && values.oauthClientSecretVaultKey) {
      data.oauthClientSecretVaultPath = values.oauthClientSecretVaultPath;
      data.oauthClientSecretVaultKey = values.oauthClientSecretVaultKey;
    }

    // Clear userConfig when using OAuth
    data.userConfig = {};
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
  } else {
    // No authentication - clear both configs
    data.userConfig = {};
    data.oauthConfig = undefined;
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
  let authMethod: "none" | "bearer" | "raw_token" | "oauth" = "none";
  if (item.oauthConfig) {
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
        dockerImage?: string;
        transportType?: "stdio" | "streamable-http";
        httpPort?: string;
        httpPath?: string;
        serviceAccount?: string;
        advancedK8sConfig?: {
          replicas?: string;
          namespace?: string;
          annotations?: string;
          labels?: string;
          resourceRequestsMemory?: string;
          resourceRequestsCpu?: string;
          resourceLimitsMemory?: string;
          resourceLimitsCpu?: string;
        };
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

    // Extract advanced K8s config if present
    const advancedK8sConfig = config.advancedK8sConfig
      ? {
          replicas: config.advancedK8sConfig.replicas?.toString() || undefined,
          namespace: config.advancedK8sConfig.namespace || undefined,
          annotations: config.advancedK8sConfig.annotations
            ? JSON.stringify(config.advancedK8sConfig.annotations, null, 2)
            : undefined,
          labels: config.advancedK8sConfig.labels
            ? JSON.stringify(config.advancedK8sConfig.labels, null, 2)
            : undefined,
          resourceRequestsMemory:
            config.advancedK8sConfig.resources?.requests?.memory || undefined,
          resourceRequestsCpu:
            config.advancedK8sConfig.resources?.requests?.cpu || undefined,
          resourceLimitsMemory:
            config.advancedK8sConfig.resources?.limits?.memory || undefined,
          resourceLimitsCpu:
            config.advancedK8sConfig.resources?.limits?.cpu || undefined,
        }
      : undefined;

    localConfig = {
      command: item.localConfig.command || "",
      arguments: argumentsString,
      environment,
      dockerImage: item.localConfig.dockerImage || "",
      transportType: config.transportType || undefined,
      httpPort: config.httpPort?.toString() || undefined,
      httpPath: config.httpPath || undefined,
      serviceAccount: config.serviceAccount || undefined,
      advancedK8sConfig,
    };
  }

  return {
    name: item.name,
    serverType: item.serverType as "remote" | "local",
    serverUrl: item.serverUrl || "",
    authMethod,
    oauthConfig,
    localConfig,
    // BYOS: Include parsed vault path and key if OAuth secret is a vault reference
    oauthClientSecretVaultPath,
    oauthClientSecretVaultKey,
  } as McpCatalogFormValues;
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

/**
 * Safely parse a JSON string, returning undefined if parsing fails.
 */
export function parseJsonSafe(
  jsonString: string,
): Record<string, string> | undefined {
  if (!jsonString || !jsonString.trim()) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(jsonString);
    // Ensure it's a plain object with string values
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      !Array.isArray(parsed)
    ) {
      return parsed as Record<string, string>;
    }
    return undefined;
  } catch {
    return undefined;
  }
}

/**
 * Build resources object from advanced K8s config form values.
 */
export function buildResources(advancedConfig: {
  resourceRequestsMemory?: string;
  resourceRequestsCpu?: string;
  resourceLimitsMemory?: string;
  resourceLimitsCpu?: string;
}):
  | {
      requests?: { memory?: string; cpu?: string };
      limits?: { memory?: string; cpu?: string };
    }
  | undefined {
  const hasRequests =
    advancedConfig.resourceRequestsMemory || advancedConfig.resourceRequestsCpu;
  const hasLimits =
    advancedConfig.resourceLimitsMemory || advancedConfig.resourceLimitsCpu;

  if (!hasRequests && !hasLimits) {
    return undefined;
  }

  return {
    ...(hasRequests
      ? {
          requests: {
            ...(advancedConfig.resourceRequestsMemory
              ? { memory: advancedConfig.resourceRequestsMemory }
              : {}),
            ...(advancedConfig.resourceRequestsCpu
              ? { cpu: advancedConfig.resourceRequestsCpu }
              : {}),
          },
        }
      : {}),
    ...(hasLimits
      ? {
          limits: {
            ...(advancedConfig.resourceLimitsMemory
              ? { memory: advancedConfig.resourceLimitsMemory }
              : {}),
            ...(advancedConfig.resourceLimitsCpu
              ? { cpu: advancedConfig.resourceLimitsCpu }
              : {}),
          },
        }
      : {}),
  };
}
