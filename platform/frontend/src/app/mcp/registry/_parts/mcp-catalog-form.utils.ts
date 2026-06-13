import {
  type AgentScope,
  type archestraApiTypes,
  type archestraCatalogTypes,
  type ImagePullSecretConfig,
  isVaultReference,
  parseVaultReference,
} from "@archestra/shared";
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
    multitenant:
      values.serverType === "local" ? Boolean(values.multitenant) : false,
    icon: values.icon ?? null,
  };

  if (values.serverUrl) {
    data.serverUrl = values.serverUrl;
  }

  // Note: deploymentSpecYaml is handled separately via the "Edit K8S Deployment Yaml" dialog
  // The main form does not touch the YAML - it's only stored when explicitly edited

  // Handle local configuration
  if (values.serverType === "local" && values.localConfig) {
    const argumentsArray = parseArgumentsField(values.localConfig.arguments);

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
  if (
    (values.authMethod === "oauth" ||
      values.authMethod === "oauth_client_credentials") &&
    values.oauthConfig
  ) {
    const isClientCredentials =
      values.authMethod === "oauth_client_credentials";
    const redirectUrisList = isClientCredentials
      ? []
      : (values.oauthConfig.redirect_uris ?? "")
          .split(",")
          .map((uri) => uri.trim())
          .filter((uri) => uri.length > 0);
    const explicitScopes = values.oauthConfig.scopes?.trim() ?? "";
    const parsedScopes = explicitScopes
      .split(",")
      .map((scope) => scope.trim())
      .filter((scope) => scope.length > 0);
    const scopesList = parsedScopes;

    // For local servers, use oauthServerUrl; for remote servers, use serverUrl
    const oauthServerUrl =
      values.serverType === "local"
        ? values.oauthConfig.oauthServerUrl || ""
        : values.serverUrl || "";

    data.oauthConfig = {
      name: values.name, // Use name as OAuth provider name
      server_url: oauthServerUrl, // OAuth server URL for discovery/authorization
      grant_type: isClientCredentials
        ? "client_credentials"
        : "authorization_code",
      auth_server_url: values.oauthConfig.authServerUrl || undefined,
      authorization_endpoint: isClientCredentials
        ? undefined
        : values.oauthConfig.authorizationEndpoint || undefined,
      well_known_url: values.oauthConfig.wellKnownUrl || undefined,
      resource_metadata_url:
        values.oauthConfig.resourceMetadataUrl || undefined,
      token_endpoint: values.oauthConfig.tokenEndpoint || undefined,
      client_id: isClientCredentials ? "" : values.oauthConfig.client_id || "",
      // Only include client_secret if no BYOS vault path is set
      client_secret: values.oauthClientSecretVaultPath
        ? undefined
        : isClientCredentials
          ? undefined
          : values.oauthConfig.client_secret || undefined,
      audience: values.oauthConfig.audience || undefined,
      resource: isClientCredentials
        ? undefined
        : values.oauthConfig.resource || undefined,
      redirect_uris: redirectUrisList,
      scopes: scopesList,
      // default_scopes is the fallback used by the backend's scope resolution:
      //   1. If `scopes` is non-empty, discovery is skipped and `scopes` is sent verbatim.
      //   2. If `scopes` is empty, backend tries .well-known discovery
      //      (oauth-protected-resource, then oauth-authorization-server).
      //   3. If discovery yields nothing, backend falls back to `default_scopes`.
      // When the user configures explicit scopes, mirror them into default_scopes so
      // the fallback matches intent. When the field is blank, keep the generic
      // ["read","write"] fallback — some proxy MCP servers (e.g. Atlassian) accept
      // those literal values and translate them to real provider scopes.
      default_scopes:
        scopesList.length > 0
          ? scopesList
          : isClientCredentials
            ? []
            : ["read", "write"],
      supports_resource_metadata: values.oauthConfig.supports_resource_metadata,
    };

    // BYOS: Include OAuth client secret vault path and key if set
    if (values.oauthClientSecretVaultPath && values.oauthClientSecretVaultKey) {
      data.oauthClientSecretVaultPath = values.oauthClientSecretVaultPath;
      data.oauthClientSecretVaultKey = values.oauthClientSecretVaultKey;
    }

    data.userConfig = isClientCredentials
      ? {
          ...buildStaticHeaderUserConfig(values),
          client_id: {
            type: "string",
            title: "Client ID",
            description:
              "OAuth client ID used to fetch a client-credentials token for this remote MCP server.",
            promptOnInstallation: true,
            required: true,
            default: values.oauthConfig.client_id || undefined,
            sensitive: false,
          },
          client_secret: {
            type: "string",
            title: "Client Secret",
            description:
              "OAuth client secret used to fetch a client-credentials token for this remote MCP server.",
            promptOnInstallation: true,
            required: true,
            sensitive: true,
          },
          audience: {
            type: "string",
            title: "Audience",
            description:
              "Audience included when requesting the client-credentials token.",
            promptOnInstallation: true,
            required: false,
            default: values.oauthConfig.audience || undefined,
            sensitive: false,
          },
        }
      : buildStaticHeaderUserConfig(values);
    data.enterpriseManagedConfig = null;
  } else if (values.authMethod === "enterprise_managed") {
    data.userConfig = buildStaticHeaderUserConfig(values);
    data.oauthConfig = null;
    data.enterpriseManagedConfig = values.enterpriseManagedConfig
      ? {
          ...values.enterpriseManagedConfig,
          assertionMode: "exchange",
        }
      : null;
  } else if (values.authMethod === "idp_jwt") {
    data.userConfig = buildStaticHeaderUserConfig(values);
    data.oauthConfig = null;
    data.enterpriseManagedConfig = values.enterpriseManagedConfig
      ? {
          identityProviderId: values.enterpriseManagedConfig.identityProviderId,
          assertionMode: "passthrough",
          requestedCredentialType: "bearer_token",
          tokenInjectionMode:
            values.enterpriseManagedConfig.tokenInjectionMode ??
            "authorization_bearer",
          headerName: values.enterpriseManagedConfig.headerName,
        }
      : null;
  } else if (values.authMethod === "bearer") {
    data.userConfig = buildStaticHeaderUserConfig(values, {
      authFieldName: values.includeBearerPrefix
        ? "access_token"
        : "raw_access_token",
      authDescription: values.includeBearerPrefix
        ? "Bearer token for authentication"
        : "Token for authentication (sent without Bearer prefix)",
    });
    data.oauthConfig = null;
    data.enterpriseManagedConfig = null;
  } else {
    data.userConfig = buildStaticHeaderUserConfig(values);
    data.oauthConfig = null;
    data.enterpriseManagedConfig = null;
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

  // Deployment environment assignment (null = the default environment)
  data.environmentId = values.environmentId ?? null;

  return data;
}

export function parseArgumentsField(argumentsText?: string): string[] {
  const text = argumentsText?.trim() ?? "";
  if (!text) {
    return [];
  }

  if (text.startsWith("[")) {
    try {
      const parsed = JSON.parse(text);
      if (Array.isArray(parsed)) {
        return parsed
          .map((arg) => (typeof arg === "string" ? arg : String(arg)))
          .map((arg) => arg.trim())
          .filter((arg) => arg.length > 0);
      }
    } catch {
      // Fall back to the existing one-argument-per-line behavior below.
    }
  }

  return text
    .split("\n")
    .map((arg) => arg.trim())
    .filter((arg) => arg.length > 0);
}

export type ParsePastedMcpServerConfigResult =
  | { ok: true; values: McpCatalogFormValues }
  | { ok: false; error: string };

const MAX_PASTED_CONFIG_LENGTH = 64_000;
const MAX_PASTED_NAME_LENGTH = 256;
const DANGEROUS_CONFIG_KEYS = new Set([
  "__proto__",
  "constructor",
  "prototype",
]);

export function mergePastedMcpServerConfigValues(params: {
  currentValues: McpCatalogFormValues;
  importedValues: McpCatalogFormValues;
  currentLabels: NonNullable<McpCatalogFormValues["labels"]>;
}): McpCatalogFormValues {
  const { currentValues, importedValues, currentLabels } = params;
  return {
    ...currentValues,
    ...importedValues,
    environmentId: currentValues.environmentId,
    labels: currentLabels,
    scope: currentValues.scope,
    teams: currentValues.teams,
  };
}

export function parsePastedMcpServerConfig(
  configText: string,
): ParsePastedMcpServerConfigResult {
  if (configText.length > MAX_PASTED_CONFIG_LENGTH) {
    return {
      ok: false,
      error: "Config is too large to import safely.",
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(configText);
  } catch {
    return { ok: false, error: "Config must be valid JSON." };
  }

  const manifest = normalizePastedMcpConfigToManifest(parsed);
  if (!manifest) {
    return {
      ok: false,
      error:
        "Config must include an MCP server under mcpServers, servers, server, or a command/url object.",
    };
  }

  return {
    ok: true,
    values: transformExternalCatalogToFormValues(manifest),
  };
}

function normalizePastedMcpConfigToManifest(
  parsed: unknown,
): archestraCatalogTypes.ArchestraMcpServerManifest | null {
  if (!isRecord(parsed)) {
    return null;
  }

  const manifest = normalizeManifestLikeConfig(parsed);
  if (manifest) {
    return manifest;
  }

  const officialManifest = normalizeOfficialRegistryConfig(parsed);
  if (officialManifest) {
    return officialManifest;
  }

  const inputs = readInputs(parsed.inputs);
  const serverEntry =
    getFirstNamedServer(parsed.mcpServers) ??
    getFirstNamedServer(parsed.servers) ??
    (isMcpServerConfig(parsed) ? ["custom-mcp-server", parsed] : null) ??
    getFirstNamedServer(parsed);

  if (!serverEntry) {
    return null;
  }

  const [serverName, serverConfig] = serverEntry;
  return buildManifestFromServerConfig(serverName, serverConfig, inputs);
}

function createImportedManifestBase(params: {
  name: string;
  displayName?: string;
  description?: string;
}): Omit<archestraCatalogTypes.ArchestraMcpServerManifest, "server"> {
  return {
    name: params.name,
    display_name: params.displayName ?? params.name,
    description: params.description ?? "",
    author: { name: "Imported MCP config" },
    readme: null,
    category: null,
    quality_score: null,
    github_info: null,
    programming_language: null,
    framework: null,
    last_scraped_at: null,
    evaluation_model: null,
    raw_dependencies: null,
  };
}

function normalizeManifestLikeConfig(
  parsed: Record<string, unknown>,
): archestraCatalogTypes.ArchestraMcpServerManifest | null {
  if (!isRecord(parsed.server)) {
    return null;
  }

  const serverType = parsed.server.type;
  if (serverType !== "remote" && serverType !== "local") {
    return null;
  }
  if (serverType === "remote" && !readHttpUrl(parsed.server.url)) {
    return null;
  }

  const explicitName = getOptionalStringProperty(parsed, "name");
  const displayName =
    getOptionalStringProperty(parsed, "display_name") ??
    getOptionalStringProperty(parsed.oauth_config, "name") ??
    explicitName ??
    "Imported MCP Server";

  return {
    ...createImportedManifestBase({
      name: explicitName ?? displayName,
      displayName,
      description: getOptionalStringProperty(parsed, "description"),
    }),
    user_config: isRecord(parsed.user_config)
      ? (parsed.user_config as never)
      : undefined,
    oauth_config: isRecord(parsed.oauth_config)
      ? (parsed.oauth_config as never)
      : undefined,
    server: parsed.server as never,
  };
}

function normalizeOfficialRegistryConfig(
  parsed: Record<string, unknown>,
): archestraCatalogTypes.ArchestraMcpServerManifest | null {
  const serverDetail = getOfficialServerDetail(parsed);
  if (!serverDetail) {
    return null;
  }

  const remote = Array.isArray(serverDetail.remotes)
    ? serverDetail.remotes.find(isOfficialRemoteTransport)
    : undefined;

  const name = getOfficialDisplayName(serverDetail);
  const base = createImportedManifestBase({
    name,
    displayName: name,
    description: getOptionalStringProperty(serverDetail, "description"),
  });

  if (remote) {
    const userConfig = buildOfficialHeaderUserConfig(remote.headers);
    return {
      ...base,
      user_config: Object.keys(userConfig).length > 0 ? userConfig : undefined,
      server: {
        type: "remote",
        url: remote.url,
        docs_url: getOptionalStringProperty(serverDetail, "websiteUrl") ?? null,
      },
    };
  }

  const officialPackage = Array.isArray(serverDetail.packages)
    ? serverDetail.packages.find(isOfficialStdioPackage)
    : undefined;
  if (!officialPackage) {
    return null;
  }

  return buildOfficialPackageManifest(base, officialPackage);
}

function buildOfficialPackageManifest(
  manifestBase: Omit<
    archestraCatalogTypes.ArchestraMcpServerManifest,
    "server"
  >,
  officialPackage: Record<string, unknown>,
): archestraCatalogTypes.ArchestraMcpServerManifest | null {
  const command = getOfficialPackageCommand(officialPackage);
  const packageSpec = getOfficialPackageSpecifier(officialPackage);
  if (!command || !packageSpec) {
    return null;
  }

  const officialEnv = buildOfficialEnvironmentConfig(
    officialPackage.environmentVariables,
  );
  const args = [
    ...readOfficialArguments(officialPackage.runtimeArguments),
    ...getOfficialPackageRuntimeArgs(officialPackage, packageSpec),
    ...readOfficialArguments(officialPackage.packageArguments),
  ];

  return {
    ...manifestBase,
    user_config:
      Object.keys(officialEnv.userConfig).length > 0
        ? officialEnv.userConfig
        : undefined,
    server: {
      type: "local",
      command,
      args,
      env:
        Object.keys(officialEnv.env).length > 0 ? officialEnv.env : undefined,
    },
  };
}

function buildManifestFromServerConfig(
  serverName: string,
  serverConfig: Record<string, unknown>,
  inputs: Map<string, PastedInputDefinition>,
): archestraCatalogTypes.ArchestraMcpServerManifest {
  const manifestBase = createImportedManifestBase({ name: serverName });

  const userConfig: NonNullable<
    archestraCatalogTypes.ArchestraMcpServerManifest["user_config"]
  > = {};

  if (isRemoteServerConfig(serverConfig)) {
    const headers = isRecord(serverConfig.headers) ? serverConfig.headers : {};
    const staticHeaders: Record<string, string> = {};

    for (const [headerName, headerValue] of Object.entries(headers)) {
      if (
        !isSafePastedConfigName(headerName) ||
        typeof headerValue !== "string"
      ) {
        continue;
      }
      const headerConfig = buildHeaderUserConfig(
        headerName,
        headerValue,
        inputs,
      );
      if (headerConfig) {
        userConfig[headerConfig.fieldName] = headerConfig.config as never;
      } else {
        staticHeaders[headerName] = headerValue;
      }
    }

    for (const [index, [headerName, headerValue]] of Object.entries(
      staticHeaders,
    ).entries()) {
      const fieldName = getAdditionalHeaderFieldName({
        headerName,
        fieldName: undefined,
        index,
        usedFieldNames: new Set(Object.keys(userConfig)),
      });
      userConfig[fieldName] = {
        type: "string",
        title: headerName,
        description: `Sent as ${headerName}`,
        required: false,
        default: headerValue,
        headerName,
        promptOnInstallation: false,
        sensitive: false,
      } as never;
    }

    return {
      ...manifestBase,
      user_config: Object.keys(userConfig).length > 0 ? userConfig : undefined,
      server: {
        type: "remote",
        url: readHttpUrl(serverConfig.url) ?? "",
        docs_url:
          typeof serverConfig.docs_url === "string"
            ? serverConfig.docs_url
            : null,
      },
    } as archestraCatalogTypes.ArchestraMcpServerManifest;
  }

  const env = isRecord(serverConfig.env) ? serverConfig.env : {};
  const normalizedEnv: Record<string, string> = {};

  for (const [envKey, envValue] of Object.entries(env)) {
    if (!isSafePastedConfigName(envKey) || typeof envValue !== "string") {
      continue;
    }
    const envConfig = buildEnvUserConfig(envKey, envValue, inputs);
    if (envConfig) {
      userConfig[envConfig.fieldName] = envConfig.config;
      normalizedEnv[envKey] = `\${user_config.${envConfig.fieldName}}`;
    } else {
      normalizedEnv[envKey] = envValue;
    }
  }

  return {
    ...manifestBase,
    user_config: Object.keys(userConfig).length > 0 ? userConfig : undefined,
    server: {
      type: "local",
      command:
        typeof serverConfig.command === "string" ? serverConfig.command : "",
      args: readStringArray(serverConfig.args),
      env: Object.keys(normalizedEnv).length > 0 ? normalizedEnv : undefined,
      docker_image: readDockerImage(serverConfig),
    },
  } as archestraCatalogTypes.ArchestraMcpServerManifest;
}

// Build create-form values from an existing catalog item for cloning. A clone
// is a full copy of the source's configuration (secrets included); only the
// name is suffixed with "-copy" so the create form is valid out of the box and
// catalog name-uniqueness validation handles collisions on submit.
export function buildCloneFormValues(
  item: archestraApiTypes.GetInternalMcpCatalogResponses["200"][number],
): McpCatalogFormValues {
  const values = transformCatalogItemToFormValues(item);
  return { ...values, name: `${values.name}-copy` };
}

// Transform catalog item to form values
export function transformCatalogItemToFormValues(
  item: archestraApiTypes.GetInternalMcpCatalogResponses["200"][number],
  localConfigSecret?: {
    secret: Record<string, unknown>;
  } | null,
): McpCatalogFormValues {
  // Determine auth method
  let authMethod: McpCatalogFormValues["authMethod"] = "none";
  let includeBearerPrefix = true;
  if (item.enterpriseManagedConfig) {
    authMethod =
      item.enterpriseManagedConfig.assertionMode === "passthrough"
        ? "idp_jwt"
        : "enterprise_managed";
  } else if (item.oauthConfig) {
    authMethod =
      item.oauthConfig.grant_type === "client_credentials"
        ? "oauth_client_credentials"
        : "oauth";
  } else if (item.userConfig?.raw_access_token) {
    authMethod = "bearer";
    includeBearerPrefix = false;
  } else if (item.userConfig?.access_token) {
    authMethod = "bearer";
  } else if (
    // Special case: GitHub server uses Bearer Token but external catalog doesn't define userConfig
    item.name.includes("githubcopilot") ||
    item.name.includes("github")
  ) {
    authMethod = "bearer";
  } else if (
    Object.entries(item.userConfig ?? {}).some(
      ([fieldName, config]) =>
        fieldName !== "access_token" &&
        fieldName !== "raw_access_token" &&
        (config as { valuePrefix?: string } | undefined)?.valuePrefix ===
          "Bearer ",
    )
  ) {
    authMethod = "auth_header";
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
        audience: string;
        resource: string;
        redirect_uris: string;
        scopes: string;
        supports_resource_metadata: boolean;
        grantType: "authorization_code" | "client_credentials";
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
      audience:
        typeof item.userConfig?.audience?.default === "string"
          ? item.userConfig.audience.default
          : item.oauthConfig.audience || "",
      resource: item.oauthConfig.resource || "",
      redirect_uris: item.oauthConfig.redirect_uris?.join(", ") || "",
      scopes: item.oauthConfig.scopes?.join(", ") || "",
      supports_resource_metadata:
        item.oauthConfig.supports_resource_metadata ?? true,
      grantType: item.oauthConfig.grant_type ?? "authorization_code",
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

  const staticHeaderFields = getHeaderMappedUserConfigEntries(item.userConfig);
  const authHeaderConfig =
    staticHeaderFields.access_token ?? staticHeaderFields.raw_access_token;
  const additionalHeaders = Object.entries(staticHeaderFields)
    .filter(([fieldName]) => {
      return fieldName !== "access_token" && fieldName !== "raw_access_token";
    })
    .map(([fieldName, config]) => ({
      fieldName,
      headerName: config.headerName,
      promptOnInstallation: config.promptOnInstallation ?? true,
      required: config.required ?? false,
      value: typeof config.default === "string" ? config.default : undefined,
      description: config.description ?? "",
      includeBearerPrefix: config.valuePrefix === "Bearer ",
      sensitive: config.sensitive ?? false,
    }));

  return {
    name: item.name,
    description: item.description || "",
    icon: item.icon ?? null,
    serverType: item.serverType as "remote" | "local",
    multitenant: item.serverType === "local" && Boolean(item.multitenant),
    serverUrl: item.serverUrl || "",
    authMethod,
    includeBearerPrefix,
    authHeaderName:
      authHeaderConfig?.headerName &&
      !isDefaultAuthorizationHeader(authHeaderConfig.headerName)
        ? authHeaderConfig.headerName
        : "",
    additionalHeaders,
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
    // Deployment environment (null = the default environment)
    environmentId: item.environmentId ?? null,
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
  let authMethod: McpCatalogFormValues["authMethod"] = "none";
  let includeBearerPrefix = true;
  const staticHeaderFields = getHeaderMappedUserConfigEntries(
    server.user_config,
  );
  const authHeaderConfig =
    staticHeaderFields.access_token ?? staticHeaderFields.raw_access_token;
  const implicitAccessTokenConfig = server.user_config?.access_token;
  const implicitRawAccessTokenConfig = server.user_config?.raw_access_token;

  // Detect bearer/raw_token auth from header-mapped user_config entries.
  if (authHeaderConfig?.fieldName === "raw_access_token") {
    authMethod = "bearer";
    includeBearerPrefix = false;
  } else if (authHeaderConfig?.fieldName === "access_token") {
    authMethod = "bearer";
  } else if (implicitRawAccessTokenConfig) {
    authMethod = "bearer";
    includeBearerPrefix = false;
  } else if (implicitAccessTokenConfig) {
    authMethod = "bearer";
  }

  // Rewrite redirect URIs to prefer platform callback
  let oauthConfig: McpCatalogFormValues["oauthConfig"] | undefined;
  if (server.oauth_config && !server.oauth_config.requires_proxy) {
    const oauthGrantType = getOAuthGrantType(server.oauth_config);
    authMethod =
      oauthGrantType === "client_credentials"
        ? "oauth_client_credentials"
        : "oauth";
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
      audience: "",
      resource:
        getOptionalStringProperty(server.oauth_config, "resource") || "",
      redirect_uris:
        redirectUris ||
        (typeof window !== "undefined"
          ? `${window.location.origin}/oauth-callback`
          : ""),
      scopes: server.oauth_config.scopes?.join(", ") ?? "",
      supports_resource_metadata:
        server.oauth_config.supports_resource_metadata ?? true,
      grantType:
        oauthGrantType === "client_credentials"
          ? "client_credentials"
          : "authorization_code",
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
    multitenant: server.server.type === "local" && authMethod !== "none",
    serverUrl: server.server.type === "remote" ? server.server.url : "",
    authMethod,
    includeBearerPrefix,
    authHeaderName:
      authHeaderConfig?.headerName &&
      !isDefaultAuthorizationHeader(authHeaderConfig.headerName)
        ? authHeaderConfig.headerName
        : "",
    additionalHeaders: Object.entries(staticHeaderFields)
      .filter(([fieldName]) => {
        return fieldName !== "access_token" && fieldName !== "raw_access_token";
      })
      .map(([fieldName, config]) => ({
        fieldName,
        headerName: config.headerName,
        promptOnInstallation: config.promptOnInstallation ?? true,
        required: config.required ?? false,
        value: typeof config.default === "string" ? config.default : undefined,
        description: config.description ?? "",
        includeBearerPrefix: config.valuePrefix === "Bearer ",
        sensitive: config.sensitive ?? false,
      })),
    oauthConfig: oauthConfig ?? {
      client_id: "",
      client_secret: "",
      audience: "",
      resource: "",
      redirect_uris:
        typeof window !== "undefined"
          ? `${window.location.origin}/oauth-callback`
          : "",
      scopes: "read, write",
      supports_resource_metadata: true,
      grantType: "authorization_code",
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

type PastedInputDefinition = {
  id: string;
  title?: string;
  description?: string;
  password?: boolean;
  required?: boolean;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readInputs(value: unknown): Map<string, PastedInputDefinition> {
  const inputs = new Map<string, PastedInputDefinition>();
  if (!Array.isArray(value)) {
    return inputs;
  }

  for (const input of value) {
    if (!isRecord(input) || typeof input.id !== "string") {
      continue;
    }
    if (!isSafePastedConfigName(input.id)) {
      continue;
    }
    inputs.set(input.id, {
      id: input.id,
      title: typeof input.title === "string" ? input.title : undefined,
      description:
        typeof input.description === "string" ? input.description : undefined,
      password: input.password === true,
      required: input.required !== false,
    });
  }

  return inputs;
}

function getFirstNamedServer(
  value: unknown,
): [string, Record<string, unknown>] | null {
  if (!isRecord(value)) {
    return null;
  }

  for (const [serverName, serverConfig] of Object.entries(value)) {
    if (isRecord(serverConfig) && isMcpServerConfig(serverConfig)) {
      return [serverName, serverConfig];
    }
  }

  return null;
}

function isMcpServerConfig(value: Record<string, unknown>): boolean {
  return typeof value.command === "string" || readHttpUrl(value.url) !== null;
}

function isOfficialServerDetail(
  value: unknown,
): value is Record<string, unknown> {
  return (
    isRecord(value) &&
    typeof value.name === "string" &&
    (Array.isArray(value.remotes) || Array.isArray(value.packages))
  );
}

function getOfficialServerDetail(
  parsed: Record<string, unknown>,
): Record<string, unknown> | null {
  if (isOfficialServerDetail(parsed)) {
    return parsed;
  }

  if (isRecord(parsed.server) && isOfficialServerDetail(parsed.server)) {
    return parsed.server;
  }

  if (!Array.isArray(parsed.servers)) {
    return null;
  }

  for (const entry of parsed.servers) {
    if (isOfficialServerDetail(entry)) {
      return entry;
    }
    if (isRecord(entry) && isOfficialServerDetail(entry.server)) {
      return entry.server;
    }
  }

  return null;
}

function isOfficialRemoteTransport(
  value: unknown,
): value is { type?: string; url: string; headers?: unknown } {
  return isRecord(value) && typeof readHttpUrl(value.url) === "string";
}

function isOfficialStdioPackage(
  value: unknown,
): value is Record<string, unknown> {
  return (
    isRecord(value) &&
    isRecord(value.transport) &&
    value.transport.type === "stdio" &&
    typeof value.identifier === "string" &&
    typeof value.registryType === "string"
  );
}

function getOfficialDisplayName(serverDetail: Record<string, unknown>): string {
  const title = getOptionalStringProperty(serverDetail, "title");
  if (title) {
    return title;
  }

  const name =
    getOptionalStringProperty(serverDetail, "name") ?? "Imported MCP";
  return name.split("/").at(-1) ?? name;
}

function getOfficialPackageCommand(
  officialPackage: Record<string, unknown>,
): string | null {
  if (typeof officialPackage.runtimeHint === "string") {
    return officialPackage.runtimeHint;
  }

  switch (officialPackage.registryType) {
    case "npm":
      return "npx";
    case "pypi":
      return "uvx";
    default:
      return null;
  }
}

function getOfficialPackageSpecifier(
  officialPackage: Record<string, unknown>,
): string | null {
  const identifier = getOptionalStringProperty(officialPackage, "identifier");
  if (!identifier) {
    return null;
  }

  const version = getOptionalStringProperty(officialPackage, "version");
  if (!version) {
    return identifier;
  }

  switch (officialPackage.registryType) {
    case "npm":
      return `${identifier}@${version}`;
    case "pypi":
      return `${identifier}==${version}`;
    default:
      return identifier;
  }
}

function getOfficialPackageRuntimeArgs(
  officialPackage: Record<string, unknown>,
  packageSpec: string,
): string[] {
  return officialPackage.registryType === "npm"
    ? ["-y", packageSpec]
    : [packageSpec];
}

function readOfficialArguments(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.flatMap((argument) => {
    if (!isRecord(argument)) {
      return [];
    }
    const argumentValue = getOptionalStringProperty(argument, "value");
    if (argument.type === "positional" && argumentValue) {
      return [argumentValue];
    }
    if (argument.type === "named") {
      const name = getOptionalStringProperty(argument, "name");
      if (!name) {
        return [];
      }
      return argumentValue ? [`${name}=${argumentValue}`] : [name];
    }
    return [];
  });
}

function buildOfficialEnvironmentConfig(value: unknown): {
  env: Record<string, string>;
  userConfig: NonNullable<
    archestraCatalogTypes.ArchestraMcpServerManifest["user_config"]
  >;
} {
  const env: Record<string, string> = {};
  const userConfig: NonNullable<
    archestraCatalogTypes.ArchestraMcpServerManifest["user_config"]
  > = {};

  for (const envVar of readOfficialKeyValueInputs(value)) {
    const staticValue = getOfficialStaticConfigValue(envVar);
    if (staticValue !== undefined) {
      env[envVar.name] = staticValue;
      continue;
    }

    userConfig[envVar.name] = buildOfficialUserConfig(envVar);
    env[envVar.name] = `\${user_config.${envVar.name}}`;
  }

  return { env, userConfig };
}

function buildOfficialHeaderUserConfig(
  value: unknown,
): NonNullable<
  archestraCatalogTypes.ArchestraMcpServerManifest["user_config"]
> {
  const userConfig: NonNullable<
    archestraCatalogTypes.ArchestraMcpServerManifest["user_config"]
  > = {};
  const usedFieldNames = new Set<string>();

  for (const [index, header] of readOfficialKeyValueInputs(value).entries()) {
    const staticValue = getOfficialStaticConfigValue(header);
    if (isDefaultAuthorizationHeader(header.name)) {
      const description = getOptionalStringProperty(header, "description");
      userConfig.access_token = {
        ...buildOfficialUserConfig(header),
        description: description ?? "Bearer token for authentication",
        headerName: header.name,
        valuePrefix: "Bearer ",
      } as never;
      continue;
    }

    const fieldName = getAdditionalHeaderFieldName({
      headerName: header.name,
      index,
      usedFieldNames,
    });
    usedFieldNames.add(fieldName);
    if (staticValue !== undefined) {
      userConfig[fieldName] = {
        type: "string",
        title: header.name,
        description:
          getOptionalStringProperty(header, "description") ??
          `Sent as ${header.name}`,
        required: false,
        default: staticValue,
        headerName: header.name,
        promptOnInstallation: false,
        sensitive: false,
      } as never;
      continue;
    }

    userConfig[fieldName] = {
      ...buildOfficialUserConfig(header),
      headerName: header.name,
      promptOnInstallation: true,
    } as never;
  }

  return userConfig;
}

function readOfficialKeyValueInputs(
  value: unknown,
): Array<Record<string, unknown> & { name: string }> {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter(
    (entry): entry is Record<string, unknown> & { name: string } =>
      isRecord(entry) &&
      typeof entry.name === "string" &&
      isSafePastedConfigName(entry.name),
  );
}

function buildOfficialUserConfig(
  input: Record<string, unknown> & { name: string },
): NonNullable<
  archestraCatalogTypes.ArchestraMcpServerManifest["user_config"]
>[string] {
  const format = getOptionalStringProperty(input, "format");
  const configuredValue =
    getOptionalStringProperty(input, "value") ??
    getOptionalStringProperty(input, "default");
  const placeholder = getOptionalStringProperty(input, "placeholder");
  return {
    type:
      format === "number"
        ? "number"
        : format === "boolean"
          ? "boolean"
          : "string",
    title: input.name,
    description: getOptionalStringProperty(input, "description") ?? input.name,
    required: input.isRequired === true,
    sensitive:
      input.isSecret === true ||
      isSensitiveConfigName(input.name) ||
      isSensitivePlaceholder(configuredValue) ||
      isSensitivePlaceholder(placeholder),
  };
}

function getOfficialStaticConfigValue(
  input: Record<string, unknown> & { name: string },
): string | undefined {
  const configuredValue =
    getOptionalStringProperty(input, "value") ??
    getOptionalStringProperty(input, "default");
  if (configuredValue === undefined) {
    return undefined;
  }
  if (input.isSecret === true || isSensitiveConfigName(input.name)) {
    return undefined;
  }
  if (configuredValue.trim() && isSensitivePlaceholder(configuredValue)) {
    return undefined;
  }
  return configuredValue;
}

function isRemoteServerConfig(value: Record<string, unknown>): boolean {
  return readHttpUrl(value.url) !== null;
}

function readHttpUrl(value: unknown): string | null {
  if (typeof value !== "string" || !value.trim()) {
    return null;
  }

  try {
    const parsed = new URL(value);
    return parsed.protocol === "http:" || parsed.protocol === "https:"
      ? value
      : null;
  } catch {
    return null;
  }
}

function isSafePastedConfigName(name: string): boolean {
  const trimmed = name.trim();
  return (
    trimmed.length > 0 &&
    trimmed.length <= MAX_PASTED_NAME_LENGTH &&
    !DANGEROUS_CONFIG_KEYS.has(trimmed)
  );
}

function readStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }

  const args = value
    .map((entry) => (typeof entry === "string" ? entry : String(entry)))
    .filter((entry) => entry.length > 0);

  return args.length > 0 ? args : undefined;
}

function readDockerImage(
  serverConfig: Record<string, unknown>,
): string | undefined {
  if (typeof serverConfig.docker_image === "string") {
    return serverConfig.docker_image;
  }
  if (typeof serverConfig.dockerImage === "string") {
    return serverConfig.dockerImage;
  }
  return undefined;
}

function buildHeaderUserConfig(
  headerName: string,
  headerValue: string,
  inputs: Map<string, PastedInputDefinition>,
): {
  fieldName: string;
  config: Record<string, unknown>;
} | null {
  const trimmedHeaderName = headerName.trim();
  const bearerMatch = headerValue.match(/^Bearer\s+(.+)$/i);
  const isAuthorization = isDefaultAuthorizationHeader(trimmedHeaderName);
  const inputRef = extractSafeInputReference(headerValue);
  const input = inputRef ? inputs.get(inputRef) : undefined;
  const isSensitiveHeader = isSensitiveConfigName(trimmedHeaderName);

  if (isAuthorization && bearerMatch) {
    return {
      fieldName: "access_token",
      config: {
        type: "string",
        title: input?.title ?? "Access Token",
        description: input?.description ?? "Bearer token for authentication",
        required: input?.required ?? true,
        sensitive: true,
        headerName: trimmedHeaderName,
        valuePrefix: "Bearer ",
      },
    };
  }

  if (isAuthorization && (inputRef || isSensitivePlaceholder(headerValue))) {
    return {
      fieldName: "raw_access_token",
      config: {
        type: "string",
        title: input?.title ?? "Access Token",
        description: input?.description ?? "Token for authentication",
        required: input?.required ?? true,
        sensitive: true,
        headerName: trimmedHeaderName,
      },
    };
  }

  if (!inputRef && !isSensitivePlaceholder(headerValue) && !isSensitiveHeader) {
    return null;
  }

  const usedFieldNames = new Set<string>();
  const fieldName = getAdditionalHeaderFieldName({
    headerName: trimmedHeaderName,
    index: 0,
    usedFieldNames,
  });

  return {
    fieldName,
    config: {
      type: "string",
      title: input?.title ?? trimmedHeaderName,
      description: input?.description ?? `Sent as ${trimmedHeaderName}`,
      required: input?.required ?? true,
      sensitive:
        input?.password === true ||
        isSensitiveHeader ||
        isSensitivePlaceholder(headerValue),
      headerName: trimmedHeaderName,
      promptOnInstallation: true,
    },
  };
}

function buildEnvUserConfig(
  envKey: string,
  envValue: string,
  inputs: Map<string, PastedInputDefinition>,
): {
  fieldName: string;
  config: NonNullable<
    archestraCatalogTypes.ArchestraMcpServerManifest["user_config"]
  >[string];
} | null {
  const inputRef = extractSafeInputReference(envValue);
  const input = inputRef ? inputs.get(inputRef) : undefined;
  const shouldPrompt =
    Boolean(inputRef) ||
    isSensitivePlaceholder(envValue) ||
    isSensitiveConfigName(envKey);

  if (!shouldPrompt) {
    return null;
  }

  return {
    fieldName: inputRef ?? envKey,
    config: {
      type: "string",
      title: input?.title ?? envKey,
      description: input?.description ?? `${envKey} value`,
      required: input?.required ?? true,
      sensitive: input?.password === true || isSensitiveConfigName(envKey),
    },
  };
}

function extractInputReference(value: string): string | null {
  return value.match(/\$\{input:([^}]+)\}/)?.[1] ?? null;
}

function extractSafeInputReference(value: string): string | null {
  const inputRef = extractInputReference(value);
  return inputRef && isSafePastedConfigName(inputRef) ? inputRef : null;
}

export function isSensitivePlaceholder(value: unknown): boolean {
  if (typeof value !== "string") {
    return false;
  }

  const normalized = value.trim().toLowerCase();
  if (!normalized) {
    return true;
  }

  return (
    /^<[^>]+>$/.test(normalized) ||
    /<[^>]*(token|secret|password|api[_ -]?key)[^>]*>/.test(normalized) ||
    /\byour[_ -]?[a-z0-9_ -]*(token|secret|password|api[_ -]?key)\b/.test(
      normalized,
    ) ||
    normalized.includes("${input:")
  );
}

function isSensitiveConfigName(name: string): boolean {
  return /(token|secret|password|api[_-]?key|authorization)/i.test(name);
}

function buildStaticHeaderUserConfig(
  values: McpCatalogFormValues,
  params?: {
    authFieldName?: "access_token" | "raw_access_token";
    authDescription?: string;
  },
): NonNullable<McpCatalogApiData["userConfig"]> {
  const userConfig: NonNullable<McpCatalogApiData["userConfig"]> = {};

  if (params?.authFieldName) {
    userConfig[params.authFieldName] = {
      type: "string",
      title: "Access Token",
      description: params.authDescription ?? "Token for authentication",
      required: true,
      sensitive: true,
      headerName: values.authHeaderName?.trim() || undefined,
    };
  }

  const usedFieldNames = new Set(Object.keys(userConfig));
  for (const [index, header] of (values.additionalHeaders ?? []).entries()) {
    const fieldName = getAdditionalHeaderFieldName({
      fieldName: header.fieldName,
      headerName: header.headerName,
      index,
      usedFieldNames,
    });

    usedFieldNames.add(fieldName);
    // Static header fields cannot be sensitive (server validator rejects
    // the combination, because `default` lives in plaintext jsonb on the
    // catalog row). Fall back to non-sensitive for static regardless of
    // what the form carries.
    const isStaticHeader = !header.promptOnInstallation;
    userConfig[fieldName] = {
      type: "string",
      title: header.headerName,
      promptOnInstallation: header.promptOnInstallation,
      required: header.promptOnInstallation ? header.required : false,
      default:
        !header.promptOnInstallation && header.value ? header.value : undefined,
      description:
        header.description ||
        (header.includeBearerPrefix
          ? `Sent as ${header.headerName} with a "Bearer " prefix`
          : `Sent as ${header.headerName}`),
      sensitive: isStaticHeader ? false : (header.sensitive ?? false),
      headerName: header.headerName,
      valuePrefix: header.includeBearerPrefix ? "Bearer " : undefined,
    };
  }

  return userConfig;
}

function getAdditionalHeaderFieldName(params: {
  fieldName?: string;
  headerName: string;
  index: number;
  usedFieldNames: Set<string>;
}): string {
  const { fieldName, headerName, index, usedFieldNames } = params;
  if (fieldName?.trim()) {
    return fieldName;
  }

  const normalizedHeaderName = headerName
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  const baseFieldName = `header_${normalizedHeaderName || "value"}`;

  if (!usedFieldNames.has(baseFieldName)) {
    return baseFieldName;
  }

  return `${baseFieldName}_${index + 1}`;
}

function getHeaderMappedUserConfigEntries(
  userConfig:
    | archestraApiTypes.GetInternalMcpCatalogResponses["200"][number]["userConfig"]
    | archestraCatalogTypes.ArchestraMcpServerManifest["user_config"]
    | null
    | undefined,
): Record<
  string,
  {
    fieldName: string;
    headerName: string;
    promptOnInstallation?: boolean;
    required?: boolean;
    default?: string | number | boolean | Array<string>;
    description?: string;
    valuePrefix?: string;
    sensitive?: boolean;
  }
> {
  return Object.fromEntries(
    Object.entries(userConfig ?? {})
      .filter((entry) => {
        const config = entry[1] as { headerName?: string } | undefined;
        return (
          typeof config?.headerName === "string" && config.headerName.length > 0
        );
      })
      .map(([fieldName, config]) => {
        const userConfigField = config as {
          headerName: string;
          promptOnInstallation?: boolean;
          required?: boolean;
          default?: string | number | boolean | Array<string>;
          description?: string;
          valuePrefix?: string;
          sensitive?: boolean;
        };
        return [
          fieldName,
          {
            fieldName,
            headerName: userConfigField.headerName,
            promptOnInstallation: userConfigField.promptOnInstallation,
            required: userConfigField.required,
            default: userConfigField.default,
            description: userConfigField.description,
            valuePrefix: userConfigField.valuePrefix,
            sensitive: userConfigField.sensitive,
          },
        ];
      }),
  );
}

function isDefaultAuthorizationHeader(headerName: string): boolean {
  return headerName.toLowerCase() === "authorization";
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

function getOAuthGrantType(
  oauthConfig: unknown,
): "authorization_code" | "client_credentials" {
  return getOptionalStringProperty(oauthConfig, "grant_type") ===
    "client_credentials"
    ? "client_credentials"
    : "authorization_code";
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
