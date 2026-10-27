import { SupportedProvidersSchema } from "@archestra/shared";
import { createSelectSchema } from "drizzle-zod";
import { z } from "zod";
import { schema } from "@/database";

export const SelectModelPoolMemberSchema = createSelectSchema(
  schema.modelPoolMembersTable,
).extend({
  providerApiKeyName: z.string(),
  /** The member key's provider, which decides how a request reaches it. */
  provider: SupportedProvidersSchema,
});

export const SelectModelPoolSchema = createSelectSchema(
  schema.modelPoolsTable,
).extend({
  members: z.array(SelectModelPoolMemberSchema),
  /** Virtual keys that may call the pool by its name. */
  virtualApiKeyIds: z.array(z.string()),
});

/** A pool as the admin page lists it: each member with whether it is benched. */
export const ModelPoolWithHealthSchema = SelectModelPoolSchema.extend({
  members: z.array(
    SelectModelPoolMemberSchema.extend({
      benchedUntil: z.string().datetime().nullable(),
      benchReason: z.string().nullable(),
    }),
  ),
});

export const ModelPoolMemberInputSchema = z.object({
  providerApiKeyId: z.string().uuid(),
  modelId: z.string().trim().min(1).max(512),
  priority: z.number().int().min(1).max(100).default(1),
  weight: z.number().int().min(1).max(1000).default(1),
  enabled: z.boolean().default(true),
});

export const ModelPoolInputSchema = z.object({
  name: z.string().trim().min(1).max(512),
  members: z.array(ModelPoolMemberInputSchema).min(1).max(50),
  virtualApiKeyIds: z.array(z.string().uuid()).max(500).default([]),
});

export type ModelPoolMember = z.infer<typeof SelectModelPoolMemberSchema>;
export type ModelPool = z.infer<typeof SelectModelPoolSchema>;
export type ModelPoolWithHealth = z.infer<typeof ModelPoolWithHealthSchema>;
export type ModelPoolInput = z.infer<typeof ModelPoolInputSchema>;
