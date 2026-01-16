import { pgTable, timestamp, uuid, varchar } from "drizzle-orm/pg-core";
import type { EmailProviderType } from "@/types/incoming-email";

const incomingEmailSubscriptionsTable = pgTable("incoming_email_subscription", {
  id: uuid("id").primaryKey().defaultRandom(),
  /** Microsoft Graph subscription ID */
  subscriptionId: varchar("subscription_id", { length: 256 }).notNull(),
  /** Email provider type (e.g., "outlook") */
  provider: varchar("provider", { length: 64 })
    .$type<EmailProviderType>()
    .notNull(),
  /** Webhook URL that receives notifications */
  webhookUrl: varchar("webhook_url", { length: 1024 }).notNull(),
  /** Cryptographically secure client state for webhook validation */
  clientState: varchar("client_state", { length: 256 }).notNull(),
  /** When the subscription expires (Graph subscriptions max 3 days) */
  expiresAt: timestamp("expires_at", { mode: "date" }).notNull(),
  createdAt: timestamp("created_at", { mode: "date" }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { mode: "date" })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});

export default incomingEmailSubscriptionsTable;
