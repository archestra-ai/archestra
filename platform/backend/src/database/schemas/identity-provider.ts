import type {
  IdentityProviderOidcConfig,
  IdentityProviderSamlConfig,
  IdpRoleMappingConfig,
  IdpTeamSyncConfig,
} from "@shared";
import { boolean, pgTable, text } from "drizzle-orm/pg-core";
import usersTable from "./user";

const identityProvidersTable = pgTable("identity_provider", {
  id: text("id").primaryKey(),
  issuer: text("issuer").notNull(),
  oidcConfig: text("oidc_config").$type<IdentityProviderOidcConfig>(),
  samlConfig: text("saml_config").$type<IdentityProviderSamlConfig>(),
  roleMapping: text("role_mapping").$type<IdpRoleMappingConfig>(),
  teamSyncConfig: text("team_sync_config").$type<IdpTeamSyncConfig>(),
  userId: text("user_id").references(() => usersTable.id, {
    onDelete: "cascade",
  }),
  providerId: text("provider_id").notNull().unique(),
  organizationId: text("organization_id"),
  domain: text("domain").notNull(),
  domainVerified: boolean("domain_verified"),
});

export default identityProvidersTable;
