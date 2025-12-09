import type {
  SsoProviderOidcConfig,
  SsoProviderSamlConfig,
  SsoRoleMappingConfig,
  SsoTeamSyncConfig,
} from "@shared";
import { boolean, pgTable, text } from "drizzle-orm/pg-core";
import usersTable from "./user";

const ssoProvidersTable = pgTable("sso_provider", {
  id: text("id").primaryKey(),
  issuer: text("issuer").notNull(),
  oidcConfig: text("oidc_config").$type<SsoProviderOidcConfig>(),
  samlConfig: text("saml_config").$type<SsoProviderSamlConfig>(),
  roleMapping: text("role_mapping").$type<SsoRoleMappingConfig>(),
  teamSyncConfig: text("team_sync_config").$type<SsoTeamSyncConfig>(),
  userId: text("user_id").references(() => usersTable.id, {
    onDelete: "cascade",
  }),
  providerId: text("provider_id").notNull().unique(),
  organizationId: text("organization_id"),
  domain: text("domain").notNull(),
  domainVerified: boolean("domain_verified"),
});

export default ssoProvidersTable;
