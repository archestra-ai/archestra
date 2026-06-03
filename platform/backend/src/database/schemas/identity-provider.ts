// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
import type {
  IdentityProviderOidcConfig,
  IdentityProviderSamlConfig,
  IdpRoleMappingConfig,
  IdpTeamSyncConfig,
} from "@archestra/shared";
import { sql } from "drizzle-orm";
import { boolean, text, uniqueIndex } from "drizzle-orm/pg-core";
import { softDeletablePgTable } from "./soft-deletable-table";
import usersTable from "./user";

const identityProvidersTable = softDeletablePgTable(
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
  },
  (table) => [
    uniqueIndex("identity_provider_provider_id_uidx")
      .on(table.providerId)
      .where(sql`${table.deletedAt} IS NULL`),
  ],
);

export default identityProvidersTable;
