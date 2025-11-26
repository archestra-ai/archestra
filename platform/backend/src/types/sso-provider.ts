import { createInsertSchema, createSelectSchema } from "drizzle-zod";
import { z } from "zod";
import { schema } from "@/database";

const AttributeMappingSchema = z.object({
  email: z.string().optional(),
  name: z.string().optional(),
  firstName: z.string().optional(),
  lastName: z.string().optional(),
  organizationId: z.string().optional(),
  organizationName: z.string().optional(),
});

export const SelectSsoProviderSchema = createSelectSchema(
  schema.ssoProviderTable,
  {
    type: z.enum(["oidc", "saml"]),
    attributeMapping: AttributeMappingSchema.optional(),
    advancedConfig: z.record(z.unknown()).optional(),
  },
);

export const InsertSsoProviderSchema = createInsertSchema(
  schema.ssoProviderTable,
  {
    type: z.enum(["oidc", "saml"]),
    attributeMapping: AttributeMappingSchema.optional(),
    advancedConfig: z.record(z.unknown()).optional(),
  },
);

export const UpdateSsoProviderSchema = InsertSsoProviderSchema.partial().extend({
  id: z.string().optional(),
});

export const CreateSsoProviderSchema = InsertSsoProviderSchema.omit({
  id: true,
  organizationId: true,
  createdAt: true,
  updatedAt: true,
});

export type SsoProvider = z.infer<typeof SelectSsoProviderSchema>;
export type InsertSsoProvider = z.infer<typeof InsertSsoProviderSchema>;
export type UpdateSsoProvider = z.infer<typeof UpdateSsoProviderSchema>;
export type CreateSsoProvider = z.infer<typeof CreateSsoProviderSchema>;
