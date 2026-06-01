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

export const UserConfigFieldSchema = z
  .object({
    type: z.enum(["string", "number", "boolean", "directory", "file"]),
    title: z.string(),
    description: z.string(),
    promptOnInstallation: z.boolean().optional(),
    /**
     * When true, the value is set per preset (catalog row's
     * preset_field_values: parent row carries default-preset values, child
     * rows carry their own overlay). Mutually exclusive with
     * promptOnInstallation.
     */
    promptOnPreset: z.boolean().optional(),
    required: z.boolean().optional(),
    default: UserConfigFieldDefaultSchema.optional(),
    multiple: z.boolean().optional(),
    sensitive: z.boolean().optional(),
    min: z.number().optional(),
    max: z.number().optional(),
    headerName: z.string().optional(),
    valuePrefix: z.string().optional(),
  })
  .superRefine((value, ctx) => {
    if (value.promptOnInstallation && value.promptOnPreset) {
      ctx.addIssue({
        code: "custom",
        path: ["promptOnPreset"],
        message:
          "promptOnInstallation and promptOnPreset are mutually exclusive",
      });
    }
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
        promptOnPreset: z.boolean().optional(),
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

export const PresetFieldValuesSchema = z.record(
  z.string(),
  UserConfigFieldDefaultSchema,
);

export const SelectInternalMcpCatalogSchema = createSelectSchema(
  schema.internalMcpCatalogTable,
).extend({
  serverType: InternalMcpCatalogServerTypeSchema,
  authFields: z.array(AuthFieldSchema).nullable(),
  userConfig: z.record(z.string(), UserConfigFieldSchema).nullable(),
  oauthConfig: OAuthConfigSchema.nullable(),
  enterpriseManagedConfig: EnterpriseManagedCredentialConfigSchema.nullable(),
  localConfig: LocalConfigSelectSchema.nullable(),
  parentCatalogItemId: z.string().uuid().nullable(),
  clonedFrom: z.string().uuid().nullable(),
  presetFieldValues: PresetFieldValuesSchema.default({}),
  // Labels are loaded from the junction table, not from the DB row
  labels: z.array(CatalogLabelSchema).default([]),
  // Teams are loaded from the junction table, not from the DB row
  teams: z.array(z.object({ id: z.string(), name: z.string() })).default([]),
  authorName: z.string().nullable().optional(),
});

export const ListInternalMcpCatalogSchema =
  SelectInternalMcpCatalogSchema.extend({
    toolCount: z.number().int().default(0),
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
    presetFieldValues: PresetFieldValuesSchema.optional(),
    parentCatalogItemId: z.string().uuid().nullable().optional(),
    clonedFrom: z.string().uuid().nullable().optional(),
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
    presetFieldValues: PresetFieldValuesSchema.optional(),
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
    // Parent link is locked after creation
    parentCatalogItemId: true,
    // Clone lineage is locked after creation
    clonedFrom: true,
  });

export const UpdateInternalMcpCatalogSchema =
  UpdateInternalMcpCatalogSchemaBase.superRefine(validateInternalMcpCatalog);

export const PartialUpdateInternalMcpCatalogSchema =
  UpdateInternalMcpCatalogSchemaBase.partial().superRefine(
    validateInternalMcpCatalog,
  );

export const CreateChildCatalogSchema = z.object({
  /**
   * The org-level preset entry (from /mcp/registry/org-structure) being
   * configured for this catalog. The server derives the child's name from
   * the entry.
   */
  presetEntryId: z.string().uuid(),
  presetFieldValues: PresetFieldValuesSchema.optional(),
});

export const UpdateChildCatalogSchema = z.object({
  presetFieldValues: PresetFieldValuesSchema.optional(),
});

export type InternalMcpCatalogServerType = z.infer<
  typeof InternalMcpCatalogServerTypeSchema
>;

export type AuthField = z.infer<typeof AuthFieldSchema>;
export type UserConfigField = z.infer<typeof UserConfigFieldSchema>;
export type UserConfigFieldDefault = z.infer<
  typeof UserConfigFieldDefaultSchema
>;
export type UserConfig = Record<string, UserConfigField>;
export type OAuthConfig = z.infer<typeof OAuthConfigSchema>;

// Export LocalConfig type for reuse in database schema
export type LocalConfig = z.infer<typeof LocalConfigSelectSchema>;

export type InternalMcpCatalog = z.infer<typeof SelectInternalMcpCatalogSchema>;
export type ListInternalMcpCatalog = z.infer<
  typeof ListInternalMcpCatalogSchema
>;
export type InsertInternalMcpCatalog = z.infer<
  typeof InsertInternalMcpCatalogSchema
>;
export type UpdateInternalMcpCatalog = z.infer<
  typeof UpdateInternalMcpCatalogSchema
>;
export type PresetFieldValues = z.infer<typeof PresetFieldValuesSchema>;
export type CreateChildCatalog = z.infer<typeof CreateChildCatalogSchema>;
export type UpdateChildCatalog = z.infer<typeof UpdateChildCatalogSchema>;

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
    localConfig?: {
      transportType?: "stdio" | "streamable-http";
      environment?: Array<{ key: string }>;
    } | null;
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

    // A header value is "static" (= persisted in plaintext at
    // `userConfig[field].default` on the catalog row) only when neither
    // prompt flag is set. Preset-scoped fields (`promptOnPreset: true`)
    // route sensitive values to `preset_secret_id`'s bag, so they're
    // allowed to be sensitive even though `promptOnInstallation` is false.
    const isStaticHeader =
      fieldConfig.promptOnInstallation === false &&
      fieldConfig.promptOnPreset !== true;
    if (fieldConfig.sensitive === true && isStaticHeader) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["userConfig", fieldName, "sensitive"],
        message:
          "Static header-mapped userConfig fields cannot be marked sensitive.",
      });
    }

    // Sensitive header-mapped fields must not carry a plaintext `default`.
    // `default` is persisted as-is in the catalog row's userConfig jsonb;
    // applyPresetHeaderMappings falls back to it whenever a preset row's
    // overlay lacks the key, so a sensitive default would land in plaintext
    // on the row AND be sent verbatim on every empty-overlay request.
    if (
      fieldConfig.sensitive === true &&
      fieldConfig.default !== undefined &&
      !isStaticHeader
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["userConfig", fieldName, "default"],
        message:
          "Sensitive header-mapped userConfig fields cannot carry a plaintext default. Supply the value via preset_secret_id (for preset scope) or the per-install Secret bag (for installation scope) instead.",
      });
    }
  }
}
