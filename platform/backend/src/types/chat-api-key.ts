import {
  createInsertSchema,
  createSelectSchema,
  createUpdateSchema,
} from "drizzle-zod";
import { z } from "zod";
import { schema } from "@/database";

// Supported chat providers
export const SupportedChatProviderSchema = z.enum([
  "anthropic",
  "openai",
  "gemini",
]);
export type SupportedChatProvider = z.infer<typeof SupportedChatProviderSchema>;

// Chat API Key schemas
export const SelectChatApiKeySchema = createSelectSchema(
  schema.chatApiKeysTable,
).extend({
  provider: SupportedChatProviderSchema,
});

export const InsertChatApiKeySchema = createInsertSchema(
  schema.chatApiKeysTable,
)
  .omit({
    id: true,
    createdAt: true,
    updatedAt: true,
  })
  .extend({
    provider: SupportedChatProviderSchema,
  });

export const UpdateChatApiKeySchema = createUpdateSchema(
  schema.chatApiKeysTable,
)
  .omit({
    id: true,
    organizationId: true,
    createdAt: true,
    updatedAt: true,
  })
  .extend({
    provider: SupportedChatProviderSchema.optional(),
  });

export type ChatApiKey = z.infer<typeof SelectChatApiKeySchema>;
export type InsertChatApiKey = z.infer<typeof InsertChatApiKeySchema>;
export type UpdateChatApiKey = z.infer<typeof UpdateChatApiKeySchema>;

// Profile Chat API Key schemas (junction table)
export const SelectProfileChatApiKeySchema = createSelectSchema(
  schema.profileChatApiKeysTable,
);

export const InsertProfileChatApiKeySchema = createInsertSchema(
  schema.profileChatApiKeysTable,
).omit({
  id: true,
  createdAt: true,
});

export type ProfileChatApiKey = z.infer<typeof SelectProfileChatApiKeySchema>;
export type InsertProfileChatApiKey = z.infer<
  typeof InsertProfileChatApiKeySchema
>;

// Response schemas with relations
export const ChatApiKeyWithProfilesSchema = SelectChatApiKeySchema.extend({
  profiles: z.array(
    z.object({
      id: z.string().uuid(),
      name: z.string(),
    }),
  ),
});

export type ChatApiKeyWithProfiles = z.infer<
  typeof ChatApiKeyWithProfilesSchema
>;
