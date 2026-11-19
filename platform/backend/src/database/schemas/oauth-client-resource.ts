import { index, jsonb, pgTable, text, timestamp } from "drizzle-orm/pg-core";
import oauthClient from "./oauth-client";
import oauthResource from "./oauth-resource";

/**
 * Better Auth OAuth provider: which protected resources a client may request
 * tokens for. Library-owned.
 */
const oauthClientResource = pgTable(
  "oauth_client_resource",
  {
    id: text("id").primaryKey(),
    clientId: text("client_id")
      .notNull()
      .references(() => oauthClient.clientId, { onDelete: "cascade" }),
    resourceId: text("resource_id")
      .notNull()
      .references(() => oauthResource.identifier, { onDelete: "cascade" }),
    metadata: jsonb("metadata"),
    createdAt: timestamp("created_at").defaultNow(),
  },
  (table) => [
    index("oauth_client_resource_client_id_idx").on(table.clientId),
    index("oauth_client_resource_resource_id_idx").on(table.resourceId),
  ],
);

export default oauthClientResource;
