import { pgTable, text, timestamp } from "drizzle-orm/pg-core";

/**
 * Better Auth OAuth provider: replay cache for `private_key_jwt` client
 * assertions, keyed by the assertion's `jti` until it expires. Library-owned.
 */
const oauthClientAssertion = pgTable("oauth_client_assertion", {
  id: text("id").primaryKey(),
  expiresAt: timestamp("expires_at").notNull(),
});

export default oauthClientAssertion;
