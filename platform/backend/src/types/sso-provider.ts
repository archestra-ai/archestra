import {
  SsoProviderOidcConfigSchema,
  SsoProviderSamlConfigSchema,
  SsoRoleMappingConfigSchema,
  SsoTeamSyncConfigSchema,
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
  roleMapping: SsoRoleMappingConfigSchema.optional(),
  teamSyncConfig: SsoTeamSyncConfigSchema.optional(),
};

export const SelectSsoProviderSchema = createSelectSchema(
  schema.ssoProvidersTable,
  extendedFields,
);

/**
 * Minimal SSO provider info for public/unauthenticated endpoints (e.g., login page).
 * Contains only non-sensitive fields needed to display SSO login buttons.
 */
export const PublicSsoProviderSchema = SelectSsoProviderSchema.pick({
  id: true,
  providerId: true,
});

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
export type PublicSsoProvider = z.infer<typeof PublicSsoProviderSchema>;
export type InsertSsoProvider = z.infer<typeof InsertSsoProviderSchema>;
export type UpdateSsoProvider = z.infer<typeof UpdateSsoProviderSchema>;
