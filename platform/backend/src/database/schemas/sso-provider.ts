import type { SsoProviderOidcConfig, SsoProviderSamlConfig } from "@shared";
import { boolean, pgTable, text } from "drizzle-orm/pg-core";
import usersTable from "./user";

const ssoProvidersTable = pgTable("sso_provider", {
  id: text("id").primaryKey(),
  issuer: text("issuer").notNull(),
  oidcConfig: text("oidc_config").$type<SsoProviderOidcConfig>(),
  samlConfig: text("saml_config").$type<SsoProviderSamlConfig>(),
  userId: text("user_id").references(() => usersTable.id, {
    onDelete: "cascade",
  }),
  providerId: text("provider_id").notNull().unique(),
  organizationId: text("organization_id"),
  domain: text("domain").notNull(),
  domainVerified: boolean("domain_verified"),
});

export default ssoProvidersTable;
