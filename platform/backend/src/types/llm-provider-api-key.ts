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

/**
 * What kind of credential a key stores: an ordinary API key, or one of the
 * subscription credentials. Recorded when the value is written so reads can
 * tell per-user credentials apart without resolving the secret.
 */
export const LlmProviderCredentialKindSchema = z.enum([
  "api_key",
  // A GitHub App credential on `github-copilot`: organization-owned, so
  // shareable even though personal Copilot sign-ins are not.
  "github_app",
  ...SubscriptionCredentialKindSchema.options,
]);
export type LlmProviderCredentialKind = z.infer<
  typeof LlmProviderCredentialKindSchema
>;

export const SelectLlmProviderApiKeySchema = createSelectSchema(
  schema.llmProviderApiKeysTable,
)
  // Server-side bookkeeping; clients get the derived `subscriptionKind`.
  .omit({ credentialKind: true })
  .extend({
    provider: SupportedProvidersSchema,
    scope: ResourceVisibilityScopeSchema,
    // baseUrl is nullable in the DB schema (text without .notNull()) but
    // drizzle-zod's createSelectSchema defaults text columns to z.string().
    // Override to match the actual DB column nullability so Fastify response
    // serialization doesn't throw when baseUrl is null.
    baseUrl: z.string().nullable(),
    inferenceBaseUrl: z.string().nullable(),
    extraHeaders: z.record(z.string(), z.string()).nullable(),
    requiresReauthentication: z.boolean().optional(),
  });

export const InsertLlmProviderApiKeySchema = createInsertSchema(
  schema.llmProviderApiKeysTable,
)
  .omit({
    id: true,
    createdAt: true,
    updatedAt: true,
    createdByServiceAccountId: true,
    requiresReauthentication: true,
    credentialKind: true,
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
    createdByServiceAccountId: true,
    requiresReauthentication: true,
    credentialKind: true,
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
/** What the scheduled model sync reads off a key. */
export type LlmProviderApiKeyForModelSync = Pick<
  LlmProviderApiKey,
  | "id"
  | "organizationId"
  | "name"
  | "provider"
  | "secretId"
  | "baseUrl"
  | "extraHeaders"
  | "isSystem"
>;
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
    /**
     * True for a GitHub Copilot key that stores an organization's GitHub App
     * credential: shareable, unlike a personal Copilot sign-in. Derived from
     * the recorded credential kind; no secret is read or returned.
     */
    isGithubAppKey: z.boolean().optional(),
    /** The GitHub organization a GitHub App key is installed on, and billed to. */
    githubOrganization: z.string().nullable().optional(),
    labels: z.array(LabelWithDetailsSchema).optional(),
  });

export type LlmProviderApiKeyWithScopeInfo = z.infer<
  typeof LlmProviderApiKeyWithScopeInfoSchema
>;
