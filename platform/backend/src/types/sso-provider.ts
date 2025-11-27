import {
  SsoProviderOidcConfigSchema,
  SsoProviderSamlConfigSchema,
} from "@shared";
import {
  createInsertSchema,
  createSelectSchema,
  createUpdateSchema,
} from "drizzle-zod";
import type { z } from "zod";
import { schema } from "@/database";

const extendedFields = {
  oidcConfig: SsoProviderOidcConfigSchema.optional(),
  samlConfig: SsoProviderSamlConfigSchema.optional(),
};

export const SelectSsoProviderSchema = createSelectSchema(
  schema.ssoProvidersTable,
  extendedFields,
);

export const InsertSsoProviderSchema = createInsertSchema(
  schema.ssoProvidersTable,
  extendedFields,
).omit({ id: true, organizationId: true });

export const UpdateSsoProviderSchema = createUpdateSchema(
  schema.ssoProvidersTable,
  extendedFields,
).omit({
  id: true,
  organizationId: true,
  userId: true,
});

export type SsoProvider = z.infer<typeof SelectSsoProviderSchema>;
export type InsertSsoProvider = z.infer<typeof InsertSsoProviderSchema>;
export type UpdateSsoProvider = z.infer<typeof UpdateSsoProviderSchema>;
