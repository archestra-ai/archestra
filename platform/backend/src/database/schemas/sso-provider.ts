import { boolean, jsonb, pgTable, text, timestamp } from "drizzle-orm/pg-core";
import organizationsTable from "./organization";

const ssoProviderTable = pgTable("sso_provider", {
  id: text("id").primaryKey(),
  organizationId: text("organization_id")
    .notNull()
    .references(() => organizationsTable.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  type: text("type").notNull().$type<"oidc" | "saml">(),
  enabled: boolean("enabled").notNull().default(true),
  // OIDC configuration
  clientId: text("client_id"),
  clientSecret: text("client_secret"),
  issuer: text("issuer"),
  authorizationEndpoint: text("authorization_endpoint"),
  tokenEndpoint: text("token_endpoint"),
  userInfoEndpoint: text("user_info_endpoint"),
  // SAML configuration
  entryPoint: text("entry_point"),
  cert: text("cert"),
  // Common configuration
  scopes: text("scopes"), // Space-separated scopes
  callbackUrl: text("callback_url"),
  // Advanced configuration stored as JSON
  advancedConfig: jsonb("advanced_config").$type<Record<string, unknown>>(),
  // Attribute mapping for user provisioning
  attributeMapping: jsonb("attribute_mapping").$type<{
    email?: string;
    name?: string;
    firstName?: string;
    lastName?: string;
    organizationId?: string;
    organizationName?: string;
  }>(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at")
    .defaultNow()
    .$onUpdate(() => new Date())
    .notNull(),
});

export default ssoProviderTable;
