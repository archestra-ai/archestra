import { z } from "zod";
import {
  isValidJsonKeyValueString,
  isValidK8sCpuQuantity,
  isValidK8sMemoryQuantity,
} from "./mcp-orchestrator";
import { SUPPORTED_THEMES } from "./themes/theme-config";

export const OAuthConfigSchema = z.object({
  name: z.string(),
  server_url: z.string(),
  auth_server_url: z.string().optional(),
  resource_metadata_url: z.string().optional(),
  client_id: z.string(),
  client_secret: z.string().optional(),
  redirect_uris: z.array(z.string()),
  scopes: z.array(z.string()),
  description: z.string().optional(),
  well_known_url: z.string().optional(),
  default_scopes: z.array(z.string()),
  supports_resource_metadata: z.boolean(),
  generic_oauth: z.boolean().optional(),
  token_endpoint: z.string().optional(),
  access_token_env_var: z.string().optional(),
  requires_proxy: z.boolean().optional(),
  provider_name: z.string().optional(),
  browser_auth: z.boolean().optional(),
  streamable_http_url: z.string().optional(),
  streamable_http_port: z.number().optional(),
});

// Environment variable schema for UI forms
export const EnvironmentVariableSchema = z.object({
  key: z.string().min(1, "Key is required"),
  type: z.enum(["plain_text", "secret", "boolean", "number"]),
  value: z.string().optional(), // Optional static value (when not prompted). Boolean type uses "true"/"false" strings, number type uses numeric strings
  promptOnInstallation: z.boolean(), // Whether to prompt user during installation
  required: z.boolean().optional(), // Whether this env var is required during installation (only applies when promptOnInstallation is true, defaults to false)
  description: z.string().optional(), // Optional description to show in installation dialog
  default: z.union([z.string(), z.number(), z.boolean()]).optional(), // Default value to pre-populate in installation dialog
  mounted: z.boolean().optional(), // When true for secret type, mount as file at /secrets/<key> instead of env var
});

// Resource requests/limits schema for K8s containers
export const K8sResourcesSchema = z.object({
  requests: z
    .object({
      memory: z.string().optional(), // e.g., "128Mi", "1Gi"
      cpu: z.string().optional(), // e.g., "50m", "1"
    })
    .optional(),
  limits: z
    .object({
      memory: z.string().optional(),
      cpu: z.string().optional(),
    })
    .optional(),
});

// Advanced Kubernetes configuration for MCP server deployments
export const AdvancedK8sConfigSchema = z.object({
  // Number of pod replicas (default: 1)
  replicas: z.number().int().min(1).max(10).optional(),
  // Custom namespace override (defaults to configured orchestrator namespace)
  namespace: z.string().optional(),
  // Custom annotations to add to the pod
  annotations: z.record(z.string(), z.string()).optional(),
  // Custom labels to add to the pod (merged with required labels)
  labels: z.record(z.string(), z.string()).optional(),
  // Resource requests and limits for the container
  resources: K8sResourcesSchema.optional(),
});

export const LocalConfigSchema = z
  .object({
    command: z.string().optional(),
    arguments: z.array(z.string()).optional(),
    environment: z.array(EnvironmentVariableSchema).optional(),
    dockerImage: z.string().optional(),
    transportType: z.enum(["stdio", "streamable-http"]).optional(),
    httpPort: z.number().optional(),
    httpPath: z.string().optional(),
    // Kubernetes service account role for MCP server pods that need K8s API access
    // If not specified, uses the default service account (no K8s permissions)
    // Specify just the role (e.g., "operator") - the platform automatically constructs the full name:
    // {releaseName}-mcp-k8s-{role} (e.g., "archestra-platform-mcp-k8s-operator")
    serviceAccount: z.string().optional(),
    // Advanced Kubernetes configuration
    advancedK8sConfig: AdvancedK8sConfigSchema.optional(),
  })
  .refine(
    (data) => {
      // At least one of command or dockerImage must be provided
      return data.command || data.dockerImage;
    },
    {
      message:
        "Either command or dockerImage must be provided. If dockerImage is set, command is optional (Docker image's default CMD will be used).",
      path: ["command"],
    },
  );

/**
 * Zod schema that validates JSON key-value strings.
 * Uses the shared isValidJsonKeyValueString function.
 */
const jsonKeyValueStringSchema = z
  .string()
  .optional()
  .refine((val) => isValidJsonKeyValueString(val), {
    message: 'Must be valid JSON with string values, e.g. { "key": "value" }',
  });

const k8sMemoryQuantitySchema = z
  .string()
  .optional()
  .refine((val) => !val || !val.trim() || isValidK8sMemoryQuantity(val), {
    message: "Invalid memory format. Use K8s format like 128Mi, 1Gi, 256M",
  });

const k8sCpuQuantitySchema = z
  .string()
  .optional()
  .refine((val) => !val || !val.trim() || isValidK8sCpuQuantity(val), {
    message: "Invalid CPU format. Use K8s format like 100m, 0.5, 1",
  });

// Form version of advanced K8s config for UI (using strings that get parsed)
export const AdvancedK8sConfigFormSchema = z.object({
  replicas: z.string().optional(), // UI uses string, gets parsed to number
  namespace: z.string().optional(), // Custom namespace override
  annotations: jsonKeyValueStringSchema, // UI uses JSON string, gets parsed to object
  labels: jsonKeyValueStringSchema, // UI uses JSON string, gets parsed to object
  resourceRequestsMemory: k8sMemoryQuantitySchema,
  resourceRequestsCpu: k8sCpuQuantitySchema,
  resourceLimitsMemory: k8sMemoryQuantitySchema,
  resourceLimitsCpu: k8sCpuQuantitySchema,
});

// Form version of LocalConfigSchema for UI forms (using strings that get parsed)
export const LocalConfigFormSchema = z.object({
  command: z.string().optional(),
  arguments: z.string(), // UI uses string, gets parsed to array
  environment: z.array(EnvironmentVariableSchema), // Structured environment variables
  dockerImage: z.string().optional(), // Custom Docker image URL
  transportType: z.enum(["stdio", "streamable-http"]).optional(),
  httpPort: z.string().optional(), // UI uses string, gets parsed to number
  httpPath: z.string().optional(), // HTTP endpoint path (e.g., /mcp)
  serviceAccount: z.string().optional(), // K8s service account for the MCP server pod
  advancedK8sConfig: AdvancedK8sConfigFormSchema.optional(), // Advanced K8s configuration
});

/**
 * Organization Appearance Schemas
 * All themes from https://github.com/jnsahaj/tweakcn
 * Theme IDs are generated from shared/themes/theme-config.ts
 */
export const OrganizationThemeSchema = z.enum(SUPPORTED_THEMES);
export const OrganizationCustomFontSchema = z.enum([
  "lato",
  "inter",
  "open-sans",
  "roboto",
  "source-sans-pro",
  "jetbrains-mono",
]);

export type OrganizationTheme = z.infer<typeof OrganizationThemeSchema>;
export type OrganizationCustomFont = z.infer<
  typeof OrganizationCustomFontSchema
>;

export const StatisticsTimeFrameSchema = z.union([
  z.enum(["5m", "15m", "30m", "1h", "24h", "7d", "30d", "90d", "12m", "all"]),
  z
    .templateLiteral(["custom:", z.string(), "_", z.string()])
    .describe("Custom timeframe must be in format 'custom:startTime_endTime'"),
]);

export type StatisticsTimeFrame = z.infer<typeof StatisticsTimeFrameSchema>;

/**
 * SSO Provider Schemas
 * NOTE: better-auth doesn't export zod schemas for these types, so to make
 * form generation + request validation easier, we're defining them here.
 */
export const SsoProviderOidcConfigSchema = z
  .object({
    issuer: z.string(),
    pkce: z.boolean(),
    clientId: z.string(),
    clientSecret: z.string(),
    authorizationEndpoint: z.string().optional(),
    discoveryEndpoint: z.string(),
    userInfoEndpoint: z.string().optional(),
    scopes: z.array(z.string()).optional(),
    overrideUserInfo: z.boolean().optional(),
    tokenEndpoint: z.string().optional(),
    tokenEndpointAuthentication: z
      .enum(["client_secret_post", "client_secret_basic"])
      .optional(),
    jwksEndpoint: z.string().optional(),
    mapping: z
      .object({
        id: z.string().optional(),
        email: z.string().optional(),
        emailVerified: z.string().optional(),
        name: z.string().optional(),
        image: z.string().optional(),
        extraFields: z.record(z.string(), z.string()).optional(),
      })
      .optional()
      .describe(
        "https://github.com/better-auth/better-auth/blob/v1.4.0/packages/sso/src/types.ts#L3",
      ),
  })
  .describe(
    "https://github.com/better-auth/better-auth/blob/v1.4.0/packages/sso/src/types.ts#L22",
  );

export const SsoProviderSamlConfigSchema = z
  .object({
    issuer: z.string(),
    entryPoint: z.string(),
    cert: z.string(),
    callbackUrl: z.string(),
    audience: z.string().optional(),
    idpMetadata: z
      .object({
        metadata: z.string().optional(),
        entityID: z.string().optional(),
        entityURL: z.string().optional(),
        redirectURL: z.string().optional(),
        cert: z.string().optional(),
        privateKey: z.string().optional(),
        privateKeyPass: z.string().optional(),
        isAssertionEncrypted: z.boolean().optional(),
        encPrivateKey: z.string().optional(),
        encPrivateKeyPass: z.string().optional(),
        singleSignOnService: z
          .array(
            z.object({
              Binding: z.string(),
              Location: z.string(),
            }),
          )
          .optional(),
      })
      .optional(),
    spMetadata: z.object({
      metadata: z.string().optional(),
      entityID: z.string().optional(),
      binding: z.string().optional(),
      privateKey: z.string().optional(),
      privateKeyPass: z.string().optional(),
      isAssertionEncrypted: z.boolean().optional(),
      encPrivateKey: z.string().optional(),
      encPrivateKeyPass: z.string().optional(),
    }),
    wantAssertionsSigned: z.boolean().optional(),
    signatureAlgorithm: z.string().optional(),
    digestAlgorithm: z.string().optional(),
    identifierFormat: z.string().optional(),
    privateKey: z.string().optional(),
    decryptionPvk: z.string().optional(),
    additionalParams: z.record(z.string(), z.any()).optional(),
    mapping: z
      .object({
        id: z.string().optional(),
        email: z.string().optional(),
        emailVerified: z.string().optional(),
        name: z.string().optional(),
        firstName: z.string().optional(),
        lastName: z.string().optional(),
        extraFields: z.record(z.string(), z.string()).optional(),
      })
      .optional()
      .describe(
        "https://github.com/better-auth/better-auth/blob/v1.4.0/packages/sso/src/types.ts#L12C30-L20C2",
      ),
  })
  .describe(
    "https://github.com/better-auth/better-auth/blob/v1.4.0/packages/sso/src/types.ts#L40",
  );

/**
 * Role Mapping Configuration Schema
 * Supports Handlebars expressions for mapping SSO attributes to Archestra roles
 */
export const SsoRoleMappingRuleSchema = z.object({
  /** Handlebars expression to evaluate against userInfo/token claims */
  expression: z.string().min(1, "Expression is required"),
  /** Archestra role to assign when expression evaluates to true */
  role: z.string().min(1, "Role is required"),
});

export const SsoRoleMappingConfigSchema = z.object({
  /**
   * Ordered list of role mapping rules.
   * First matching rule wins. If no rules match, defaultRole is used.
   */
  rules: z.array(SsoRoleMappingRuleSchema).optional(),
  /**
   * Default role when no mapping rules match.
   * If not specified, falls back to organization default (usually "member")
   */
  defaultRole: z.string().optional(),
  /**
   * Strict mode: If enabled, denies user login when no role mapping rule matches.
   * Without strict mode, users who don't match any rule are assigned the default role.
   * Default: false
   */
  strictMode: z.boolean().optional(),
  /**
   * Skip role sync: If enabled, the user's role is only set on their first login.
   * Subsequent logins will not update their role, allowing manual role management.
   * Default: false (role is synced on every login)
   */
  skipRoleSync: z.boolean().optional(),
});

export type SsoRoleMappingRule = z.infer<typeof SsoRoleMappingRuleSchema>;
export type SsoRoleMappingConfig = z.infer<typeof SsoRoleMappingConfigSchema>;

/**
 * Team Sync Configuration Schema
 * Supports Handlebars expressions for extracting group identifiers from SSO claims
 * for automatic team membership synchronization.
 *
 * This allows flexibility in how groups are extracted from different IdP token formats.
 */
export const SsoTeamSyncConfigSchema = z.object({
  /**
   * Handlebars expression to extract group identifiers from ID token claims.
   * The expression should evaluate to an array of strings (group identifiers).
   *
   * Examples:
   * - `{{#each groups}}{{this}},{{/each}}` - Simple array claim: ["admin", "users"]
   * - `{{#each roles}}{{this.name}},{{/each}}` - Extract names from array of objects
   * - `{{{json (pluck (json roles) "name")}}}` - Parse JSON string and extract names
   *
   * If not configured, falls back to checking common claim names:
   * groups, group, memberOf, member_of, roles, role, teams, team
   */
  groupsExpression: z.string().optional(),
  /**
   * Whether team sync is enabled for this provider.
   * Default: true (team sync is enabled)
   */
  enabled: z.boolean().optional(),
});

export type SsoTeamSyncConfig = z.infer<typeof SsoTeamSyncConfigSchema>;

// Form schemas for UI
export const SsoProviderFormSchema = z
  .object({
    providerId: z.string().min(1, "Provider ID is required"),
    issuer: z.string().min(1, "Issuer is required"),
    domain: z.string().min(1, "Domain is required"),
    providerType: z.enum(["oidc", "saml"]),
    oidcConfig: SsoProviderOidcConfigSchema.optional(),
    samlConfig: SsoProviderSamlConfigSchema.optional(),
    roleMapping: SsoRoleMappingConfigSchema.optional(),
    teamSyncConfig: SsoTeamSyncConfigSchema.optional(),
  })
  .refine(
    (data) => {
      if (data.providerType === "oidc") {
        return !!data.oidcConfig;
      }
      if (data.providerType === "saml") {
        return !!data.samlConfig;
      }
      return false;
    },
    {
      message: "Configuration is required for the selected provider type",
      path: ["oidcConfig"],
    },
  );

export type SsoProviderOidcConfig = z.infer<typeof SsoProviderOidcConfigSchema>;
export type SsoProviderSamlConfig = z.infer<typeof SsoProviderSamlConfigSchema>;
export type SsoProviderFormValues = z.infer<typeof SsoProviderFormSchema>;
