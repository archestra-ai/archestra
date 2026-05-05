import { SupportedProvidersSchema } from "@shared";
import { createInsertSchema, createSelectSchema } from "drizzle-zod";
import { z } from "zod";
import { schema } from "@/database";
import { ResourceVisibilityScopeSchema } from "./visibility";

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
});

/** Schema for virtual key listing responses. */
export const VirtualApiKeyWithParentInfoSchema =
  SelectVirtualApiKeySchema.extend({
    teams: z.array(VirtualApiKeyTeamSchema),
    authorName: z.string().nullable(),
    providerApiKeys: z.array(VirtualApiKeyProviderMappingSchema),
  });

export type SelectVirtualApiKey = z.infer<typeof SelectVirtualApiKeySchema>;
export type InsertVirtualApiKey = z.infer<typeof InsertVirtualApiKeySchema>;
export type VirtualApiKeyWithValue = z.infer<
  typeof VirtualApiKeyWithValueSchema
>;
export type VirtualApiKeyWithParentInfo = z.infer<
  typeof VirtualApiKeyWithParentInfoSchema
>;
