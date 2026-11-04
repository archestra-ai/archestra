import {
  CreatedByNullableSchema,
  SupportedProvidersSchema,
} from "@archestra/shared";
import { createInsertSchema, createSelectSchema } from "drizzle-zod";
import { z } from "zod";
import { schema } from "@/database/schema";
import { CredentialBillingSchema } from "./credential-billing";
import { LabelWithDetailsSchema } from "./label";
import { ResourceVisibilityScopeSchema } from "./visibility";

/**
 * Kind of virtual key.
 * - `standard`: maps to one or more provider API keys; used as a provider key
 *   replacement in the Authorization header.
 * - `passthrough`: carries no provider credential; sent in the
 *   `X-Archestra-Virtual-Key` header purely to authenticate the acting user.
 */
export const VirtualApiKeyTypeSchema = z.enum(["standard", "passthrough"]);
export type VirtualApiKeyType = z.infer<typeof VirtualApiKeyTypeSchema>;

const DAY_SECONDS = 24 * 60 * 60;

/**
 * How long a rotated-out value keeps working, in seconds. Zero revokes it at
 * once.
 */
export const VirtualApiKeyRotationGracePeriodSchema = z
  .number()
  .int()
  .min(0)
  .max(30 * DAY_SECONDS);

/** How often automatic rotation replaces a key's value, in seconds. */
export const VirtualApiKeyRotationIntervalSchema = z
  .number()
  .int()
  .min(DAY_SECONDS)
  .max(365 * DAY_SECONDS);

/** Grace period an automatic rotation uses when none is set. */
export const DEFAULT_VIRTUAL_API_KEY_ROTATION_GRACE_PERIOD_SECONDS =
  DAY_SECONDS;

const VirtualApiKeyTeamSchema = z.object({
  id: z.string(),
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

/** The token is withheld from team leads creating keys on behalf of a member. */
export const VirtualApiKeyWithValueSchema = SelectVirtualApiKeySchema.extend({
  value: z.string().optional(),
  teams: z.array(VirtualApiKeyTeamSchema),
  authorName: z.string().nullable(),
  createdBy: CreatedByNullableSchema,
  providerApiKeys: z.array(VirtualApiKeyProviderMappingSchema),
  labels: z.array(LabelWithDetailsSchema),
}).merge(CredentialBillingSchema);

/** Schema for virtual key listing responses. */
export const VirtualApiKeyWithParentInfoSchema =
  SelectVirtualApiKeySchema.extend({
    teams: z.array(VirtualApiKeyTeamSchema),
    authorName: z.string().nullable(),
    createdBy: CreatedByNullableSchema,
    providerApiKeys: z.array(VirtualApiKeyProviderMappingSchema),
    labels: z.array(LabelWithDetailsSchema),
  }).merge(CredentialBillingSchema);

export type SelectVirtualApiKey = z.infer<typeof SelectVirtualApiKeySchema>;
export type InsertVirtualApiKey = z.infer<typeof InsertVirtualApiKeySchema>;
export type VirtualApiKeyWithValue = z.infer<
  typeof VirtualApiKeyWithValueSchema
>;
export type VirtualApiKeyWithParentInfo = z.infer<
  typeof VirtualApiKeyWithParentInfoSchema
>;
