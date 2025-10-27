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

const OAuthConfigSchema = z.object({
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
