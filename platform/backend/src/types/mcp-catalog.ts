import { OAuthConfigSchema } from "@shared";
import {
  createInsertSchema,
  createSelectSchema,
  createUpdateSchema,
} from "drizzle-zod";
import { z } from "zod";
import { schema } from "@/database";

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

export const SelectInternalMcpCatalogSchema = createSelectSchema(
  schema.internalMcpCatalogTable,
).extend({
  authFields: z.array(AuthFieldSchema).nullable(),
  userConfig: z.record(z.string(), UserConfigFieldSchema).nullable(),
  oauthConfig: OAuthConfigSchema.nullable(),
});

export const InsertInternalMcpCatalogSchema = createInsertSchema(
  schema.internalMcpCatalogTable,
).extend({
  serverType: z.enum(["local", "remote"]).nullable().optional(),
  authFields: z.array(AuthFieldSchema).nullable().optional(),
  userConfig: z.record(z.string(), UserConfigFieldSchema).nullable().optional(),
  oauthConfig: OAuthConfigSchema.nullable().optional(),
});

export const UpdateInternalMcpCatalogSchema = createUpdateSchema(
  schema.internalMcpCatalogTable,
).extend({
  serverType: z.enum(["local", "remote"]).nullable().optional(),
  authFields: z.array(AuthFieldSchema).nullable().optional(),
  userConfig: z.record(z.string(), UserConfigFieldSchema).nullable().optional(),
  oauthConfig: OAuthConfigSchema.nullable().optional(),
});

export type InternalMcpCatalog = z.infer<typeof SelectInternalMcpCatalogSchema>;
export type InsertInternalMcpCatalog = z.infer<
  typeof InsertInternalMcpCatalogSchema
>;
export type UpdateInternalMcpCatalog = z.infer<
  typeof UpdateInternalMcpCatalogSchema
>;
