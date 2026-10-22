import { index, pgTable, text, timestamp } from "drizzle-orm/pg-core";
import oauthClient from "./oauth-client";
import oauthRefreshToken from "./oauth-refresh-token";
import session from "./session";
import usersTable from "./user";

const oauthAccessToken = pgTable(
  "oauth_access_token",
  {
    id: text("id").primaryKey(),
    token: text("token").notNull().unique(),
    clientId: text("client_id")
      .notNull()
      .references(() => oauthClient.clientId, { onDelete: "cascade" }),
    sessionId: text("session_id").references(() => session.id, {
      onDelete: "set null",
    }),
    userId: text("user_id").references(() => usersTable.id, {
      onDelete: "cascade",
    }),
    referenceId: text("reference_id"),
    refreshId: text("refresh_id").references(() => oauthRefreshToken.id, {
      onDelete: "set null",
    }),
    expiresAt: timestamp("expires_at").notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    scopes: text("scopes").array(),
  },
  (table) => [
    // The Connect page lists the clients a user holds tokens for.
    index("oauth_access_token_user_id_idx").on(table.userId),
  ],
);

export default oauthAccessToken;
