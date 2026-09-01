import {
  CreatedByNullableSchema,
  SubscriptionCredentialKindSchema,
  SupportedProvidersSchema,
} from "@archestra/shared";
import {
  createInsertSchema,
  createSelectSchema,
  createUpdateSchema,
} from "drizzle-zod";
import { z } from "zod";
import { schema } from "@/database";
import { LabelWithDetailsSchema } from "./label";
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
  SelectLlmProviderApiKeySchema.omit({ createdBy: true }).extend({
    /**
     * Who added the key, resolved. Distinct from `userName`, which names the
     * *audience* of a personal-scoped key and is null on org- and team-scoped
     * ones — the rows most likely to need an owner tracked down.
     */
    createdBy: CreatedByNullableSchema,
    teamName: z.string().nullable().optional(),
    userName: z.string().nullable().optional(),
    vaultSecretPath: z.string().nullable().optional(),
    vaultSecretKey: z.string().nullable().optional(),
    secretStorageType: SecretStorageTypeSchema.optional(),
    bestModelId: z.string().nullable().optional(),
    isAgentKey: z.boolean().optional(),
    /**
     * Which vendor subscription the stored credential encodes, or null for an
     * ordinary API key. Computed from the secret marker server-side (the secret
     * itself is never returned), so the edit form can open on the matching
     * auth-mode tab and the Model Providers page can pair a connected
     * subscription with its row.
     */
    subscriptionKind: SubscriptionCredentialKindSchema.nullable().optional(),
    labels: z.array(LabelWithDetailsSchema).optional(),
  });

export type LlmProviderApiKeyWithScopeInfo = z.infer<
  typeof LlmProviderApiKeyWithScopeInfoSchema
>;
