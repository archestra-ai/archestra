import {
  AdvancedK8sConfigSchema,
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
  required: z.boolean(),
  description: z.string().optional(),
});

const UserConfigFieldSchema = z.object({
  type: z.enum(["string", "number", "boolean", "directory", "file"]),
  title: z.string(),
  description: z.string(),
  required: z.boolean().optional(),
  default: z
    .union([z.string(), z.number(), z.boolean(), z.array(z.string())])
    .optional(),
  multiple: z.boolean().optional(),
  sensitive: z.boolean().optional(),
  min: z.number().optional(),
  max: z.number().optional(),
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
        default: z.union([z.string(), z.number(), z.boolean()]).optional(), // Default value for installation dialog
        mounted: z.boolean().optional(), // When true for secret type, mount as file at /secrets/<key>
      }),
    )
    .optional(),
  dockerImage: z.string().optional(),
  serviceAccount: z.string().optional(),
  transportType: z.enum(["stdio", "streamable-http"]).optional(),
  httpPort: z.number().optional(),
  httpPath: z.string().optional(),
  // Advanced Kubernetes configuration
  advancedK8sConfig: AdvancedK8sConfigSchema.optional(),
});

export const SelectInternalMcpCatalogSchema = createSelectSchema(
  schema.internalMcpCatalogTable,
).extend({
  serverType: InternalMcpCatalogServerTypeSchema,
  authFields: z.array(AuthFieldSchema).nullable(),
  userConfig: z.record(z.string(), UserConfigFieldSchema).nullable(),
  oauthConfig: OAuthConfigSchema.nullable(),
  localConfig: LocalConfigSelectSchema.nullable(),
});

export const InsertInternalMcpCatalogSchema = createInsertSchema(
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
    localConfig: LocalConfigSchema.nullable().optional(),
  })
  .omit({
    createdAt: true,
    updatedAt: true,
  });

export const UpdateInternalMcpCatalogSchema = createUpdateSchema(
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
    localConfig: LocalConfigSchema.nullable().optional(),
  })
  .omit({
    id: true,
    createdAt: true,
    updatedAt: true,
  });

export type InternalMcpCatalogServerType = z.infer<
  typeof InternalMcpCatalogServerTypeSchema
>;

// Export LocalConfig type for reuse in database schema
export type LocalConfig = z.infer<typeof LocalConfigSelectSchema>;

export type InternalMcpCatalog = z.infer<typeof SelectInternalMcpCatalogSchema>;
export type InsertInternalMcpCatalog = z.infer<
  typeof InsertInternalMcpCatalogSchema
>;
export type UpdateInternalMcpCatalog = z.infer<
  typeof UpdateInternalMcpCatalogSchema
>;
