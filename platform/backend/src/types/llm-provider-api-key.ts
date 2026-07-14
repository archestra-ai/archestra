import { SupportedProvidersSchema } from "@archestra/shared";
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
  inferenceBaseUrl: z.string().nullable(),
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
    inferenceBaseUrl: z.string().nullable().optional(),
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
    inferenceBaseUrl: z.string().nullable().optional(),
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

/**
 * Response-only variant of {@link LlmProviderApiKeyWithScopeInfoSchema} for the
 * read endpoints (list / available / get), which serialize whatever is stored.
 *
 * The `provider` column is unconstrained `text` (only compile-time typed as
 * SupportedProvider), so a stored row can hold a value the running instance's
 * enum doesn't list — e.g. a key created on a newer pod during a rolling deploy,
 * read back by an older pod whose enum predates that provider. A strict enum in
 * the response schema would make Fastify serialization throw on that one row
 * and, because the list response is a `z.array(...)` (all-or-nothing), 500 the
 * entire endpoint. The union keeps the known providers declared while accepting
 * any other string.
 *
 * This tolerance lives ONLY on the wire schema so the domain types
 * (`LlmProviderApiKey`, `LlmProviderApiKeyWithScopeInfo`) stay strictly
 * `SupportedProvider` for backend logic; writes remain validated by the
 * Insert/Update schemas and the route request bodies.
 */
export const LlmProviderApiKeyWithScopeInfoResponseSchema =
  LlmProviderApiKeyWithScopeInfoSchema.extend({
    provider: SupportedProvidersSchema.or(z.string()),
  });
