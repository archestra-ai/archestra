import {
  EnvFromSchema,
  ImagePullSecretConfigSchema,
  LocalConfigEnvironmentDefaultSchema,
  LocalConfigSchema,
  OAuthConfigSchema,
} from "@archestra/shared";
import {
  createInsertSchema,
  createSelectSchema,
  createUpdateSchema,
} from "drizzle-zod";
import { z } from "zod";
import { schema } from "@/database";
import {
  CatalogTeamAccessLevelSchema,
  CatalogTeamInputSchema,
} from "./catalog-team-level";
import { EnterpriseManagedCredentialConfigSchema } from "./enterprise-managed-credentials";

export const InternalMcpCatalogServerTypeSchema = z.enum([
  "local",
  "remote",
  "builtin",
  // Platform-authored MCP App: in-process, HTML-backed, viewer-scoped. Backs a
  // real mcp_server exposing an `open` launch tool, but opts out of K8s deploy /
  // install / cascade / discovery. Served in-process via the owned-app builder.
  "app",
]);

/**
 * Image-approval state for a personal local catalog item gated by an
 * environment's trusted image registries. `pending` = blocked, awaiting an
 * admin; `approved` = installs proceed. NULL on the row = no decision recorded.
 */
export const CatalogItemApprovalStatusSchema = z.enum(["pending", "approved"]);

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

// The preset feature is removed. Its columns remain on the Drizzle table
// (non-destructive — see database/schemas/internal-mcp-catalog.ts) but are no
// longer exposed by the API, so they are omitted from the derived schemas.
const PRESET_COLUMNS_OMIT = {
  parentCatalogItemId: true,
  childName: true,
  presetEntryId: true,
  presetFieldValues: true,
  presetSecretId: true,
} as const;

// The catalog-item image-approval flag is system/admin-managed: set by the
// install gate (services/mcp-install-policy.ts) and the approve/decline
// endpoints, never writable through the catalog create/edit API — otherwise a
// `mcpRegistry:update` holder could self-approve. Omitted from the derived
// insert/update schemas (but kept on the select schema).
const CATALOG_ITEM_APPROVAL_COLUMNS_OMIT = {
  catalogItemApprovalStatus: true,
  catalogItemApprovalReason: true,
  catalogItemApprovalReviewedBy: true,
  catalogItemApprovalReviewedAt: true,
} as const;

export const SelectInternalMcpCatalogSchema = createSelectSchema(
  schema.internalMcpCatalogTable,
)
  .omit(PRESET_COLUMNS_OMIT)
  .extend({
    serverType: InternalMcpCatalogServerTypeSchema,
    authFields: z.array(AuthFieldSchema).nullable(),
    userConfig: z.record(z.string(), UserConfigFieldSchema).nullable(),
    oauthConfig: OAuthConfigSchema.nullable(),
    enterpriseManagedConfig: EnterpriseManagedCredentialConfigSchema.nullable(),
    localConfig: LocalConfigSelectSchema.nullable(),
    clonedFrom: z.string().uuid().nullable(),
    // Serialized as a nullable string (not the enum) because the OpenAPI client
    // generator drops `null` from a `nullable` enum; the column keeps its
    // `$type<CatalogItemApprovalStatus>` and the model methods stay typed.
    catalogItemApprovalStatus: z.string().nullable(),
    // Labels are loaded from the junction table, not from the DB row
    labels: z.array(CatalogLabelSchema).default([]),
    // Teams are loaded from the junction table, not from the DB row. A stored
    // NULL level is resolved to `write` on read, so this never serializes null.
    teams: z
      .array(
        z.object({
          id: z.string(),
          name: z.string(),
          level: CatalogTeamAccessLevelSchema,
        }),
      )
      .default([]),
    authorName: z.string().nullable().optional(),
  });

export const ListInternalMcpCatalogSchema =
  SelectInternalMcpCatalogSchema.extend({
    toolCount: z.number().int().default(0),
    // True when the catalog exposes a tool with a `ui://` MCP App resource —
    // an external UI-providing server or an owned-app backing. Derived from the
    // catalog's tools (see InternalMcpCatalogModel.getToolStats). Optional so
    // callers constructing catalog items (e.g. the legacy registry) need not set
    // it; the model always populates it on list reads.
    providesUi: z.boolean().optional(),
    // For `serverType:"app"` backings only, the id of the app they back, so the
    // registry can link to / manage the app. Populated only on the includeApps
    // path; null for everything else.
    appId: z.string().nullable().optional(),
    // True when installing this item right now would be blocked by the trusted-
    // image-registry gate (gated + not approved), so the registry can prevent the
    // install up front. Populated on the list route only.
    imageApprovalRequired: z.boolean().optional(),
  });

const InsertInternalMcpCatalogSchemaBase = createInsertSchema(
  schema.internalMcpCatalogTable,
)
  .extend({
    // Allow explicit ID for builtin catalog items (e.g., Archestra)
    id: z.string().uuid().optional(),
    name: z.string().trim().min(1, "Name cannot be empty"),
    serverType: InternalMcpCatalogServerTypeSchema,
    dynamicConnectionMcpServerId: z.string().uuid().nullable().optional(),
    authFields: z.array(AuthFieldSchema).nullable().optional(),
    userConfig: z
      .record(z.string(), UserConfigFieldSchema)
      .nullable()
      .optional(),
    oauthConfig: OAuthConfigSchema.nullable().optional(),
    enterpriseManagedConfig:
      EnterpriseManagedCredentialConfigSchema.nullable().optional(),
    localConfig: LocalConfigSchema.nullable().optional(),
    clonedFrom: z.string().uuid().nullable().optional(),
    // Labels are synced separately via McpCatalogLabelModel
    labels: z.array(CatalogLabelSchema).optional(),
    // Teams for team scope (synced separately). A bare id keeps whatever level
    // is already stored for that team; an object sets it explicitly.
    teams: z.array(CatalogTeamInputSchema).optional(),
  })
  .omit({
    createdAt: true,
    updatedAt: true,
    organizationId: true,
    authorId: true,
    ...PRESET_COLUMNS_OMIT,
    ...CATALOG_ITEM_APPROVAL_COLUMNS_OMIT,
  });

export const InsertInternalMcpCatalogSchema =
  InsertInternalMcpCatalogSchemaBase.superRefine(validateInternalMcpCatalog);

const UpdateInternalMcpCatalogSchemaBase = createUpdateSchema(
  schema.internalMcpCatalogTable,
)
  .extend({
    name: z.string().trim().min(1, "Name cannot be empty"),
    serverType: InternalMcpCatalogServerTypeSchema,
    dynamicConnectionMcpServerId: z.string().uuid().nullable().optional(),
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
    // Teams for team scope (synced separately). A bare id keeps whatever level
    // is already stored for that team; an object sets it explicitly.
    teams: z.array(CatalogTeamInputSchema).optional(),
  })
  .omit({
    id: true,
    createdAt: true,
    updatedAt: true,
    organizationId: true,
    authorId: true,
    // Tenancy is locked after creation
    multitenant: true,
    // Clone lineage is locked after creation
    clonedFrom: true,
    ...PRESET_COLUMNS_OMIT,
    ...CATALOG_ITEM_APPROVAL_COLUMNS_OMIT,
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

export type CatalogItemApprovalStatus = z.infer<
  typeof CatalogItemApprovalStatusSchema
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
    // `userConfig[field].default` on the catalog row) when it is not
    // install-prompted.
    const isStaticHeader = fieldConfig.promptOnInstallation === false;
    if (fieldConfig.sensitive === true && isStaticHeader) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["userConfig", fieldName, "sensitive"],
        message:
          "Static header-mapped userConfig fields cannot be marked sensitive.",
      });
    }

    // Sensitive header-mapped fields must not carry a plaintext `default`.
    // `default` is persisted as-is in the catalog row's userConfig jsonb, so
    // a sensitive default would land in plaintext on the row.
    if (
      fieldConfig.sensitive === true &&
      fieldConfig.default !== undefined &&
      !isStaticHeader
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["userConfig", fieldName, "default"],
        message:
          "Sensitive header-mapped userConfig fields cannot carry a plaintext default. Supply the value via the per-install Secret bag (installation scope) instead.",
      });
    }
  }
}
