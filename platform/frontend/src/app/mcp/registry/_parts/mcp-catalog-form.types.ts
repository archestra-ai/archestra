import { LocalConfigFormSchema } from "@shared";
import { z } from "zod";

const HEADER_NAME_REGEX = /^[A-Za-z0-9-]+$/;

const headerNameSchema = z
  .string()
  .trim()
  .min(1, "Header name is required")
  .max(128, "Header name is too long")
  .regex(
    HEADER_NAME_REGEX,
    "Header name must contain only alphanumeric characters and hyphens",
  );

const additionalHeaderSchema = z.object({
  fieldName: z.string().optional(),
  headerName: headerNameSchema,
  promptOnInstallation: z.boolean(),
  required: z.boolean(),
  value: z.string().optional(),
  description: z.string().optional().or(z.literal("")),
});

// Simplified OAuth config schema
export const oauthConfigSchema = z
  .object({
    client_id: z.string().optional().or(z.literal("")),
    client_secret: z.string().optional().or(z.literal("")),
    redirect_uris: z.string().min(1, "At least one redirect URI is required"),
    scopes: z.string().optional().or(z.literal("")),
    supports_resource_metadata: z.boolean(),
    authServerUrl: z
      .string()
      .url({ error: "Must be a valid URL" })
      .refine(
        (val) => val.startsWith("http://") || val.startsWith("https://"),
        {
          message: "Must be an HTTP or HTTPS URL",
        },
      )
      .optional()
      .or(z.literal("")),
    authorizationEndpoint: z
      .string()
      .url({ error: "Must be a valid URL" })
      .refine(
        (val) => val.startsWith("http://") || val.startsWith("https://"),
        {
          message: "Must be an HTTP or HTTPS URL",
        },
      )
      .optional()
      .or(z.literal("")),
    wellKnownUrl: z
      .string()
      .url({ error: "Must be a valid URL" })
      .refine(
        (val) => val.startsWith("http://") || val.startsWith("https://"),
        {
          message: "Must be an HTTP or HTTPS URL",
        },
      )
      .optional()
      .or(z.literal("")),
    resourceMetadataUrl: z
      .string()
      .url({ error: "Must be a valid URL" })
      .refine(
        (val) => val.startsWith("http://") || val.startsWith("https://"),
        {
          message: "Must be an HTTP or HTTPS URL",
        },
      )
      .optional()
      .or(z.literal("")),
    tokenEndpoint: z
      .string()
      .url({ error: "Must be a valid URL" })
      .refine(
        (val) => val.startsWith("http://") || val.startsWith("https://"),
        {
          message: "Must be an HTTP or HTTPS URL",
        },
      )
      .optional()
      .or(z.literal("")),
    // OAuth Server URL for local servers (since they don't have a serverUrl field)
    // Used for OAuth discovery/authorization, NOT for tool execution
    oauthServerUrl: z
      .string()
      .url({ error: "Must be a valid URL" })
      .refine(
        (val) => val.startsWith("http://") || val.startsWith("https://"),
        {
          message: "Must be an HTTP or HTTPS URL",
        },
      )
      .optional()
      .or(z.literal("")),
  })
  .superRefine((value, ctx) => {
    if (Boolean(value.authorizationEndpoint) !== Boolean(value.tokenEndpoint)) {
      const message = "Authorization and token endpoints must be set together";
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message,
        path: ["authorizationEndpoint"],
      });
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message,
        path: ["tokenEndpoint"],
      });
    }
  });

const enterpriseManagedConfigSchema = z.object({
  identityProviderId: z.string().optional(),
  assertionMode: z.enum(["exchange", "passthrough"]).optional(),
  resourceIdentifier: z.string().optional(),
  requestedIssuer: z.string().optional(),
  requestedCredentialType: z
    .enum([
      "bearer_token",
      "id_jag",
      "secret",
      "service_account",
      "opaque_json",
    ])
    .optional(),
  tokenInjectionMode: z
    .enum([
      "authorization_bearer",
      "raw_authorization",
      "header",
      "env",
      "body_field",
    ])
    .optional(),
  headerName: z.string().optional(),
  responseFieldPath: z.string().optional(),
});

export const formSchema = z
  .object({
    name: z.string().trim().min(1, "Name is required"),
    description: z.string().optional().or(z.literal("")),
    icon: z.string().nullable().optional(),
    serverType: z.enum(["remote", "local"]),
    serverUrl: z
      .string()
      .url({ error: "Must be a valid URL" })
      .optional()
      .or(z.literal("")),
    authMethod: z.enum([
      "none",
      "bearer",
      "oauth",
      "enterprise_managed",
      "idp_jwt",
    ]),
    includeBearerPrefix: z.boolean(),
    authHeaderName: headerNameSchema.optional().or(z.literal("")),
    additionalHeaders: z.array(additionalHeaderSchema).optional(),
    oauthConfig: oauthConfigSchema.optional(),
    enterpriseManagedConfig: enterpriseManagedConfigSchema
      .nullable()
      .optional(),
    localConfig: LocalConfigFormSchema.optional(),
    // Kubernetes Deployment spec YAML (for local servers)
    deploymentSpecYaml: z.string().optional(),
    // Original YAML from API (used to detect if user modified the YAML)
    originalDeploymentSpecYaml: z.string().optional(),
    // BYOS: External Vault path for OAuth client secret
    oauthClientSecretVaultPath: z.string().optional(),
    // BYOS: External Vault key for OAuth client secret
    oauthClientSecretVaultKey: z.string().optional(),
    // BYOS: External Vault path for local config secret env vars
    localConfigVaultPath: z.string().optional(),
    // BYOS: External Vault key for local config secret env vars
    localConfigVaultKey: z.string().optional(),
    // Labels for categorizing catalog items
    labels: z
      .array(z.object({ key: z.string(), value: z.string() }))
      .optional(),
    // Scope for catalog item visibility
    scope: z.enum(["personal", "team", "org"]).optional(),
    // Team IDs for team-scoped items
    teams: z.array(z.string()).optional(),
  })
  .superRefine((data, ctx) => {
    const normalizedHeaders = new Set<string>();
    const authHeaderName = data.authHeaderName?.trim();

    if (data.authMethod === "bearer" && authHeaderName) {
      normalizedHeaders.add(authHeaderName.toLowerCase());
    }

    for (const [index, header] of (data.additionalHeaders ?? []).entries()) {
      const normalizedHeaderName = header.headerName.toLowerCase();
      if (normalizedHeaders.has(normalizedHeaderName)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "Header names must be unique",
          path: ["additionalHeaders", index, "headerName"],
        });
        continue;
      }
      normalizedHeaders.add(normalizedHeaderName);
    }
  })
  .refine(
    (data) => {
      // For remote servers, serverUrl is required
      if (data.serverType === "remote") {
        return data.serverUrl && data.serverUrl.length > 0;
      }
      return true;
    },
    {
      message: "Server URL is required for remote servers.",
      path: ["serverUrl"],
    },
  )
  .refine(
    (data) => {
      // For local servers with OAuth, oauthServerUrl is required
      if (
        data.serverType === "local" &&
        data.authMethod === "oauth" &&
        data.oauthConfig
      ) {
        return (
          data.oauthConfig.oauthServerUrl &&
          data.oauthConfig.oauthServerUrl.length > 0
        );
      }
      return true;
    },
    {
      message:
        "OAuth Server URL is required for self-hosted servers with OAuth.",
      path: ["oauthConfig", "oauthServerUrl"],
    },
  )
  .refine(
    (data) => {
      // For local servers, at least command or dockerImage is required
      if (data.serverType === "local") {
        const hasCommand =
          data.localConfig?.command &&
          data.localConfig.command.trim().length > 0;
        const hasDockerImage =
          data.localConfig?.dockerImage &&
          data.localConfig.dockerImage.trim().length > 0;
        return hasCommand || hasDockerImage;
      }
      return true;
    },
    {
      message:
        "Either command or Docker image must be provided. If Docker image is set, command is optional.",
      path: ["localConfig", "command"],
    },
  )
  .refine(
    (data) => {
      if (
        data.serverType !== "local" ||
        (data.authMethod !== "enterprise_managed" &&
          data.authMethod !== "idp_jwt")
      ) {
        return true;
      }

      return data.localConfig?.transportType === "streamable-http";
    },
    {
      message:
        "Enterprise-managed credentials require streamable-http transport for self-hosted servers.",
      path: ["localConfig", "transportType"],
    },
  )
  .superRefine((data, ctx) => {
    if (
      (data.authMethod === "enterprise_managed" ||
        data.authMethod === "idp_jwt") &&
      !data.enterpriseManagedConfig?.identityProviderId
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Identity Provider is required for this authorization mode.",
        path: ["enterpriseManagedConfig", "identityProviderId"],
      });
    }
  });

export type McpCatalogFormValues = z.infer<typeof formSchema>;
