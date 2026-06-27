import { SupportedProvidersSchema } from "@archestra/shared";
import { createInsertSchema, createSelectSchema } from "drizzle-zod";
import { z } from "zod";
import { schema } from "@/database";
import { ResourceVisibilityScopeSchema } from "./visibility";

/**
 * Kind of virtual key.
 * - `standard`: maps to one or more provider API keys; used as a provider key
 *   replacement in the Authorization header.
 * - `passthrough`: carries no provider credential; sent in the
 *   `X-Archestra-Virtual-Key` header purely to authenticate the acting user and
 *   gate access to selected LLM proxies.
 */
export const VirtualApiKeyTypeSchema = z.enum(["standard", "passthrough"]);
export type VirtualApiKeyType = z.infer<typeof VirtualApiKeyTypeSchema>;

const VirtualApiKeyTeamSchema = z.object({
  id: z.string(),
  name: z.string(),
});

/** An LLM proxy a passthrough virtual key is allowed to use. */
const VirtualApiKeyLlmProxySchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
});

export const VirtualApiKeyProviderMappingSchema = z.object({
  provider: SupportedProvidersSchema,
  providerApiKeyId: z.string().uuid(),
  providerApiKeyName: z.string(),
});

export const SelectVirtualApiKeySchema = createSelectSchema(
  schema.virtualApiKeysTable,
).extend({
  scope: ResourceVisibilityScopeSchema,
  keyType: VirtualApiKeyTypeSchema,
});

export const InsertVirtualApiKeySchema = createInsertSchema(
  schema.virtualApiKeysTable,
)
  .omit({
    id: true,
    createdAt: true,
    lastUsedAt: true,
  })
  .extend({
    scope: ResourceVisibilityScopeSchema.optional(),
  });

/** Schema for virtual key response at creation time (includes full token value) */
export const VirtualApiKeyWithValueSchema = SelectVirtualApiKeySchema.extend({
  value: z.string(),
  teams: z.array(VirtualApiKeyTeamSchema),
  authorName: z.string().nullable(),
  providerApiKeys: z.array(VirtualApiKeyProviderMappingSchema),
  /** Allowed LLM proxies for passthrough keys (empty for standard keys). */
  allowedLlmProxies: z.array(VirtualApiKeyLlmProxySchema),
});

/** Schema for virtual key listing responses. */
export const VirtualApiKeyWithParentInfoSchema =
  SelectVirtualApiKeySchema.extend({
    teams: z.array(VirtualApiKeyTeamSchema),
    authorName: z.string().nullable(),
    providerApiKeys: z.array(VirtualApiKeyProviderMappingSchema),
    /** Allowed LLM proxies for passthrough keys (empty for standard keys). */
    allowedLlmProxies: z.array(VirtualApiKeyLlmProxySchema),
  });

export type SelectVirtualApiKey = z.infer<typeof SelectVirtualApiKeySchema>;
export type InsertVirtualApiKey = z.infer<typeof InsertVirtualApiKeySchema>;
export type VirtualApiKeyWithValue = z.infer<
  typeof VirtualApiKeyWithValueSchema
>;
export type VirtualApiKeyWithParentInfo = z.infer<
  typeof VirtualApiKeyWithParentInfoSchema
>;
