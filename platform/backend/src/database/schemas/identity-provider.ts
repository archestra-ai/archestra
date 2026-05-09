import type {
  IdentityProviderOidcConfig,
  IdentityProviderSamlConfig,
  IdpRoleMappingConfig,
  IdpTeamSyncConfig,
} from "@shared";
import { sql } from "drizzle-orm";
import { boolean, pgTable, text, uniqueIndex } from "drizzle-orm/pg-core";
import { softDeleteColumns } from "./_soft-delete";
import usersTable from "./user";

const identityProvidersTable = pgTable(
  "identity_provider",
  {
    id: text("id").primaryKey(),
    issuer: text("issuer").notNull(),
    oidcConfig: text("oidc_config").$type<IdentityProviderOidcConfig>(),
    samlConfig: text("saml_config").$type<IdentityProviderSamlConfig>(),
    roleMapping: text("role_mapping").$type<IdpRoleMappingConfig>(),
    teamSyncConfig: text("team_sync_config").$type<IdpTeamSyncConfig>(),
    userId: text("user_id").references(() => usersTable.id, {
      onDelete: "cascade",
    }),
    providerId: text("provider_id").notNull(),
    organizationId: text("organization_id"),
    domain: text("domain").notNull(),
    domainVerified: boolean("domain_verified"),
    ssoLoginEnabled: boolean("sso_login_enabled").notNull().default(true),
    ...softDeleteColumns,
  },
  (table) => [
    uniqueIndex("identity_provider_provider_id_uidx")
      .on(table.providerId)
      .where(sql`${table.deletedAt} IS NULL`),
  ],
);

export default identityProvidersTable;
