import { SupportedProvidersSchema } from "@shared";
import {
  createInsertSchema,
  createSelectSchema,
  createUpdateSchema,
} from "drizzle-zod";
import { z } from "zod";
import { schema } from "@/database";
import { SecretStorageTypeSchema } from "./mcp-server";
import { ResourceVisibilityScopeSchema } from "./visibility";

export const SelectLlmProviderApiKeySchema = createSelectSchema(
  schema.llmProviderApiKeysTable,
).extend({
  provider: SupportedProvidersSchema,
  scope: ResourceVisibilityScopeSchema,
  // baseUrl is nullable in the DB schema (text without .notNull()) but
  // drizzle-zod's createSelectSchema defaults text columns to z.string().
  // Override to match the actual DB column nullability so Fastify response
  // serialization doesn't throw when baseUrl is null.
  baseUrl: z.string().nullable(),
  extraHeaders: z.record(z.string(), z.string()).nullable(),
});

export const InsertLlmProviderApiKeySchema = createInsertSchema(
  schema.llmProviderApiKeysTable,
)
  .omit({
    id: true,
    createdAt: true,
    updatedAt: true,
  })
  .extend({
    provider: SupportedProvidersSchema,
    scope: ResourceVisibilityScopeSchema,
    extraHeaders: z.record(z.string(), z.string()).nullable().optional(),
  });

export const UpdateLlmProviderApiKeySchema = createUpdateSchema(
  schema.llmProviderApiKeysTable,
)
  .omit({
    id: true,
    organizationId: true,
    createdAt: true,
    updatedAt: true,
  })
  .extend({
    provider: SupportedProvidersSchema.optional(),
    scope: ResourceVisibilityScopeSchema.optional(),
    isPrimary: z.boolean().optional(),
    extraHeaders: z.record(z.string(), z.string()).nullable().optional(),
  });

export type LlmProviderApiKey = z.infer<typeof SelectLlmProviderApiKeySchema>;
export type InsertLlmProviderApiKey = z.infer<
  typeof InsertLlmProviderApiKeySchema
>;
export type UpdateLlmProviderApiKey = z.infer<
  typeof UpdateLlmProviderApiKeySchema
>;

export const LlmProviderApiKeyWithScopeInfoSchema =
  SelectLlmProviderApiKeySchema.extend({
    teamName: z.string().nullable().optional(),
    userName: z.string().nullable().optional(),
    vaultSecretPath: z.string().nullable().optional(),
    vaultSecretKey: z.string().nullable().optional(),
    secretStorageType: SecretStorageTypeSchema.optional(),
    bestModelId: z.string().nullable().optional(),
    isAgentKey: z.boolean().optional(),
  });

export type LlmProviderApiKeyWithScopeInfo = z.infer<
  typeof LlmProviderApiKeyWithScopeInfoSchema
>;
