import { index, pgTable, text, timestamp } from "drizzle-orm/pg-core";
import oauthClient from "./oauth-client";
import session from "./session";
import usersTable from "./user";

const oauthRefreshToken = pgTable(
  "oauth_refresh_token",
  {
    id: text("id").primaryKey(),
    token: text("token").notNull(),
    clientId: text("client_id")
      .notNull()
      .references(() => oauthClient.clientId, { onDelete: "cascade" }),
    sessionId: text("session_id").references(() => session.id, {
      onDelete: "set null",
    }),
    userId: text("user_id")
      .notNull()
      .references(() => usersTable.id, { onDelete: "cascade" }),
    referenceId: text("reference_id"),
    authTime: timestamp("auth_time"),
    expiresAt: timestamp("expires_at").notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    revoked: timestamp("revoked"),
    scopes: text("scopes").array(),
  },
  (table) => [
    // The Connect page lists the clients a user holds tokens for.
    index("oauth_refresh_token_user_id_idx").on(table.userId),
  ],
);

export default oauthRefreshToken;
