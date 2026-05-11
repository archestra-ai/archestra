import {
  EnvFromSchema,
  ImagePullSecretConfigSchema,
  LocalConfigEnvironmentDefaultSchema,
  LocalConfigSchema,
  OAuthConfigSchema,
} from "@shared";
import {
  createInsertSchema,
  createSelectSchema,
  createUpdateSchema,
} from "drizzle-zod";
import { z } from "zod";
import { schema } from "@/database";
import { EnterpriseManagedCredentialConfigSchema } from "./enterprise-managed-credentials";

export const InternalMcpCatalogServerTypeSchema = z.enum([
  "local",
  "remote",
  "builtin",
]);

// Define Zod schemas for complex JSONB fields
const AuthFieldSchema = z.object({
  name: z.string(),
  label: z.string(),
  type: z.string(),
  required: z.boolean().optional().default(false),
  description: z.string().optional(),
});

export const UserConfigFieldDefaultSchema = z.union([
  z.string(),
  z.number(),
  z.boolean(),
  z.array(z.string()),
]);

export const UserConfigFieldSchema = z.object({
  type: z.enum(["string", "number", "boolean", "directory", "file"]),
  title: z.string(),
  description: z.string(),
  promptOnInstallation: z.boolean().optional(),
  required: z.boolean().optional(),
  default: UserConfigFieldDefaultSchema.optional(),
  multiple: z.boolean().optional(),
  sensitive: z.boolean().optional(),
  min: z.number().optional(),
  max: z.number().optional(),
  headerName: z.string().optional(),
  valuePrefix: z.string().optional(),
});

// Define a version of LocalConfigSchema for SELECT operations
// where required and description fields are optional (database may not have them)
// Note: We can't use .extend() on LocalConfigSchema because it has .refine()
const LocalConfigSelectSchema = z.object({
  command: z.string().optional(),
  arguments: z.array(z.string()).optional(),
  environment: z
    .array(
      z.object({
        key: z.string(),
        type: z.enum(["plain_text", "secret", "boolean", "number"]),
        value: z.string().optional(),
        promptOnInstallation: z.boolean(),
        required: z.boolean().optional(), // Optional in database
        description: z.string().optional(), // Optional in database
        default: LocalConfigEnvironmentDefaultSchema.optional(), // Default value for installation dialog
        mounted: z.boolean().optional(), // When true for secret type, mount as file at /secrets/<key>
      }),
    )
    .optional(),
  envFrom: z.array(EnvFromSchema).optional(),
  dockerImage: z.string().optional(),
  serviceAccount: z.string().optional(),
  transportType: z.enum(["stdio", "streamable-http"]).optional(),
  httpPort: z.number().optional(),
  httpPath: z.string().optional(),
  nodePort: z.number().optional(),
  // Accept both legacy { name } format and new ImagePullSecretConfigSchema
  // Legacy entries are normalized to { source: "existing", name } on read
  imagePullSecrets: z
    .array(
      z.union([
        ImagePullSecretConfigSchema,
        // Legacy format: { name: string } → normalize to { source: "existing", name }
        z.object({ name: z.string() }).transform((val) => ({
          source: "existing" as const,
          name: val.name,
        })),
      ]),
    )
    .optional(),
});

const CatalogLabelSchema = z.object({
  key: z.string().min(1),
  value: z.string().min(1),
});

export const SelectInternalMcpCatalogSchema = createSelectSchema(
  schema.internalMcpCatalogTable,
).extend({
  serverType: InternalMcpCatalogServerTypeSchema,
  authFields: z.array(AuthFieldSchema).nullable(),
  userConfig: z.record(z.string(), UserConfigFieldSchema).nullable(),
  oauthConfig: OAuthConfigSchema.nullable(),
  enterpriseManagedConfig: EnterpriseManagedCredentialConfigSchema.nullable(),
  localConfig: LocalConfigSelectSchema.nullable(),
  // Labels are loaded from the junction table, not from the DB row
  labels: z.array(CatalogLabelSchema).default([]),
  // Teams are loaded from the junction table, not from the DB row
  teams: z.array(z.object({ id: z.string(), name: z.string() })).default([]),
  authorName: z.string().nullable().optional(),
});

const InsertInternalMcpCatalogSchemaBase = createInsertSchema(
  schema.internalMcpCatalogTable,
)
  .extend({
    // Allow explicit ID for builtin catalog items (e.g., Archestra)
    id: z.string().uuid().optional(),
    name: z.string().trim().min(1, "Name cannot be empty"),
    serverType: InternalMcpCatalogServerTypeSchema,
    authFields: z.array(AuthFieldSchema).nullable().optional(),
    userConfig: z
      .record(z.string(), UserConfigFieldSchema)
      .nullable()
      .optional(),
    oauthConfig: OAuthConfigSchema.nullable().optional(),
    enterpriseManagedConfig:
      EnterpriseManagedCredentialConfigSchema.nullable().optional(),
    localConfig: LocalConfigSchema.nullable().optional(),
    // Labels are synced separately via McpCatalogLabelModel
    labels: z.array(CatalogLabelSchema).optional(),
    // Team IDs for team scope (synced separately)
    teams: z.array(z.string()).optional(),
  })
  .omit({
    createdAt: true,
    updatedAt: true,
    organizationId: true,
    authorId: true,
  });

export const InsertInternalMcpCatalogSchema =
  InsertInternalMcpCatalogSchemaBase.superRefine(validateInternalMcpCatalog);

const UpdateInternalMcpCatalogSchemaBase = createUpdateSchema(
  schema.internalMcpCatalogTable,
)
  .extend({
    name: z.string().trim().min(1, "Name cannot be empty"),
    serverType: InternalMcpCatalogServerTypeSchema,
    authFields: z.array(AuthFieldSchema).nullable().optional(),
    userConfig: z
      .record(z.string(), UserConfigFieldSchema)
      .nullable()
      .optional(),
    oauthConfig: OAuthConfigSchema.nullable().optional(),
    enterpriseManagedConfig:
      EnterpriseManagedCredentialConfigSchema.nullable().optional(),
    localConfig: LocalConfigSchema.nullable().optional(),
    // Labels are synced separately via McpCatalogLabelModel
    labels: z.array(CatalogLabelSchema).optional(),
    // Team IDs for team scope (synced separately)
    teams: z.array(z.string()).optional(),
  })
  .omit({
    id: true,
    createdAt: true,
    updatedAt: true,
    organizationId: true,
    authorId: true,
    // Tenancy is locked after creation
    multitenant: true,
  });

export const UpdateInternalMcpCatalogSchema =
  UpdateInternalMcpCatalogSchemaBase.superRefine(validateInternalMcpCatalog);

export const PartialUpdateInternalMcpCatalogSchema =
  UpdateInternalMcpCatalogSchemaBase.partial().superRefine(
    validateInternalMcpCatalog,
  );

export type InternalMcpCatalogServerType = z.infer<
  typeof InternalMcpCatalogServerTypeSchema
>;

export type AuthField = z.infer<typeof AuthFieldSchema>;
export type UserConfigField = z.infer<typeof UserConfigFieldSchema>;
export type UserConfig = Record<string, UserConfigField>;
export type OAuthConfig = z.infer<typeof OAuthConfigSchema>;

// Export LocalConfig type for reuse in database schema
export type LocalConfig = z.infer<typeof LocalConfigSelectSchema>;

export type InternalMcpCatalog = z.infer<typeof SelectInternalMcpCatalogSchema>;
export type InsertInternalMcpCatalog = z.infer<
  typeof InsertInternalMcpCatalogSchema
>;
export type UpdateInternalMcpCatalog = z.infer<
  typeof UpdateInternalMcpCatalogSchema
>;

function validateEnterpriseManagedTransportConfig(
  value: {
    serverType?: InternalMcpCatalogServerType;
    enterpriseManagedConfig?: unknown;
    localConfig?: { transportType?: "stdio" | "streamable-http" } | null;
  },
  ctx: z.RefinementCtx,
): void {
  if (!value.enterpriseManagedConfig || value.serverType !== "local") {
    return;
  }

  if (value.localConfig?.transportType === "streamable-http") {
    return;
  }

  ctx.addIssue({
    code: z.ZodIssueCode.custom,
    path: ["localConfig", "transportType"],
    message:
      "Enterprise-managed credentials require streamable-http transport for local MCP servers.",
  });
}

function validateInternalMcpCatalog(
  value: {
    serverType?: InternalMcpCatalogServerType;
    enterpriseManagedConfig?: unknown;
    localConfig?: { transportType?: "stdio" | "streamable-http" } | null;
    userConfig?: Record<string, UserConfigField> | null;
  },
  ctx: z.RefinementCtx,
): void {
  validateEnterpriseManagedTransportConfig(value, ctx);
  validateHeaderMappedUserConfig(value.userConfig, ctx);
}

function validateHeaderMappedUserConfig(
  userConfig: Record<string, UserConfigField> | null | undefined,
  ctx: z.RefinementCtx,
): void {
  const normalizedHeaderNames = new Map<string, string>();

  for (const [fieldName, fieldConfig] of Object.entries(userConfig ?? {})) {
    if (!fieldConfig.headerName) {
      continue;
    }

    const normalizedHeaderName = fieldConfig.headerName.toLowerCase();
    const existingFieldName = normalizedHeaderNames.get(normalizedHeaderName);
    if (existingFieldName) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["userConfig", fieldName, "headerName"],
        message: `Header name duplicates field "${existingFieldName}"`,
      });
      continue;
    }
    normalizedHeaderNames.set(normalizedHeaderName, fieldName);

    if (
      fieldConfig.sensitive === true &&
      fieldConfig.promptOnInstallation === false
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["userConfig", fieldName, "sensitive"],
        message:
          "Static header-mapped userConfig fields cannot be marked sensitive.",
      });
    }
  }
}
