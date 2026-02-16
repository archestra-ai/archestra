import {
  IdentityProviderOidcConfigSchema,
  IdentityProviderSamlConfigSchema,
  IdpRoleMappingConfigSchema,
  IdpTeamSyncConfigSchema,
} from "@shared";
import {
  createInsertSchema,
  createSelectSchema,
  createUpdateSchema,
} from "drizzle-zod";
import type { z } from "zod";
import { schema } from "@/database";

const extendedFields = {
  oidcConfig: IdentityProviderOidcConfigSchema.optional(),
  samlConfig: IdentityProviderSamlConfigSchema.optional(),
  roleMapping: IdpRoleMappingConfigSchema.optional(),
  teamSyncConfig: IdpTeamSyncConfigSchema.optional(),
};

export const SelectIdentityProviderSchema = createSelectSchema(
  schema.identityProvidersTable,
  extendedFields,
);

/**
 * Minimal identity provider info for public/unauthenticated endpoints (e.g., login page).
 * Contains only non-sensitive fields needed to display SSO login buttons.
 */
export const PublicIdentityProviderSchema = SelectIdentityProviderSchema.pick({
  id: true,
  providerId: true,
});

export const InsertIdentityProviderSchema = createInsertSchema(
  schema.identityProvidersTable,
  extendedFields,
).omit({ id: true, organizationId: true });

export const UpdateIdentityProviderSchema = createUpdateSchema(
  schema.identityProvidersTable,
  extendedFields,
).omit({
  id: true,
  organizationId: true,
  userId: true,
});

export type IdentityProvider = z.infer<typeof SelectIdentityProviderSchema>;
export type PublicIdentityProvider = z.infer<
  typeof PublicIdentityProviderSchema
>;
export type InsertIdentityProvider = z.infer<
  typeof InsertIdentityProviderSchema
>;
export type UpdateIdentityProvider = z.infer<
  typeof UpdateIdentityProviderSchema
>;
