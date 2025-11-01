import type { archestraApiTypes } from "@shared";
import type {
  McpCatalogApiData,
  McpCatalogFormValues,
} from "./mcp-catalog-form.types";

// Transform function to convert form values to API format
export function transformFormToApiData(
  values: McpCatalogFormValues,
): McpCatalogApiData {
  const data: McpCatalogApiData = {
    name: values.name,
    serverType: values.serverType,
  };

  if (values.label) {
    data.label = values.label;
  }

  if (values.serverUrl) {
    data.serverUrl = values.serverUrl;
  }

  // Handle local configuration
  if (values.serverType === "local" && values.localConfig) {
    // Parse arguments string into array
    const argumentsArray = values.localConfig.arguments
      .split("\n")
      .map((arg) => arg.trim())
      .filter((arg) => arg.length > 0);

    // Parse environment string into key-value pairs
    let environment: Record<string, string> | undefined;
    if (values.localConfig.environment.trim()) {
      environment = {};
      values.localConfig.environment
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line.length > 0 && line.includes("="))
        .forEach((line) => {
          const [key, ...valueParts] = line.split("=");
          if (key && environment) {
            // Strip surrounding quotes from the value to prevent double-quoting
            const rawValue = valueParts.join("=");
            environment[key] = stripEnvVarQuotes(rawValue);
          }
        });
    }

    data.localConfig = {
      command: values.localConfig.command,
      arguments: argumentsArray,
      environment,
      dockerImage: values.localConfig.dockerImage || undefined,
      transportType: values.localConfig.transportType || undefined,
      httpPort: values.localConfig.httpPort
        ? Number(values.localConfig.httpPort)
        : undefined,
      httpPath: values.localConfig.httpPath || undefined,
    };
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
      name: values.label, // Use label as OAuth provider name
      server_url: values.serverUrl || "", // Use serverUrl as OAuth server URL
      client_id: values.oauthConfig.client_id || "",
      client_secret: values.oauthConfig.client_secret || undefined,
      redirect_uris: redirectUrisList,
      scopes: scopesList,
      default_scopes: ["read", "write"],
      supports_resource_metadata: values.oauthConfig.supports_resource_metadata,
    };
    // Clear userConfig when using OAuth
    data.userConfig = {};
  } else if (values.authMethod === "pat") {
    // Handle PAT configuration
    data.userConfig = {
      access_token: {
        type: "string" as const,
        title: "Access Token",
        description: "Personal access token for authentication",
        required: true,
        sensitive: true,
      },
    };
    // Clear oauthConfig when using PAT
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
): McpCatalogFormValues {
  // Determine auth method
  let authMethod: "none" | "pat" | "oauth" = "none";
  if (item.oauthConfig) {
    authMethod = "oauth";
  } else if (item.userConfig?.access_token) {
    authMethod = "pat";
  } else if (
    // Special case: GitHub server uses PAT but external catalog doesn't define userConfig
    item.name.includes("githubcopilot") ||
    item.name.includes("github")
  ) {
    authMethod = "pat";
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
      client_secret: item.oauthConfig.client_secret || "",
      redirect_uris: item.oauthConfig.redirect_uris?.join(", ") || "",
      scopes: item.oauthConfig.scopes?.join(", ") || "",
      supports_resource_metadata:
        item.oauthConfig.supports_resource_metadata ?? true,
    };
  }

  // Extract local config if present
  let localConfig:
    | {
        command: string;
        arguments: string;
        environment: string;
        dockerImage?: string;
        transportType?: "stdio" | "streamable-http";
        httpPort?: string;
        httpPath?: string;
      }
    | undefined;
  if (item.localConfig) {
    // Convert arguments array back to string
    const argumentsString = item.localConfig.arguments?.join("\n") || "";

    // Convert environment object back to string
    const environmentString = item.localConfig.environment
      ? Object.entries(item.localConfig.environment)
          .map(([key, value]) => `${key}=${value}`)
          .join("\n")
      : "";

    // biome-ignore lint/suspicious/noExplicitAny: LocalConfig type doesn't have new fields yet
    const config = item.localConfig as any;

    localConfig = {
      command: item.localConfig.command,
      arguments: argumentsString,
      environment: environmentString,
      dockerImage: item.localConfig.dockerImage || "",
      transportType: config.transportType || undefined,
      httpPort: config.httpPort?.toString() || undefined,
      httpPath: config.httpPath || undefined,
    };
  }

  return {
    name: item.name,
    label: item.label || item.name,
    serverType: item.serverType as "remote" | "local",
    serverUrl: item.serverUrl || "",
    authMethod,
    oauthConfig,
    localConfig,
  };
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
