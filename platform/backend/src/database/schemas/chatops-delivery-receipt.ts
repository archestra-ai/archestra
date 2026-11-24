import {
  jsonb,
  pgTable,
  timestamp,
  unique,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import type { ChatOpsProviderType } from "@/types/chatops";
import type { ReleaseReceipt } from "@/types/openappa-release-receipt";

/**
 * One message the platform posted to a chat, written as soon as the provider
 * acknowledges it: the digest of the delivered content and the OpenAPPA
 * release receipts of what it contains. Replaying thread history trusts a
 * message only while its replayed content still has that digest.
 *
 * `nullsNotDistinct` keeps the key unique for providers without a workspace
 * dimension.
 */
const chatopsDeliveryReceiptsTable = pgTable(
  "chatops_delivery_receipts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    provider: varchar("provider", { length: 32 })
      .$type<ChatOpsProviderType>()
      .notNull(),
    workspaceId: varchar("workspace_id", { length: 256 }),
    channelId: varchar("channel_id", { length: 256 }).notNull(),
    messageId: varchar("message_id", { length: 512 }).notNull(),
    contentDigest: varchar("content_digest", { length: 64 }).notNull(),
    receipts: jsonb("receipts").$type<ReleaseReceipt[]>().notNull(),
    createdAt: timestamp("created_at", { mode: "date" }).notNull().defaultNow(),
  },
  (table) => [
    unique("chatops_delivery_receipts_message_key_uq")
      .on(table.provider, table.workspaceId, table.channelId, table.messageId)
      .nullsNotDistinct(),
  ],
);

export default chatopsDeliveryReceiptsTable;
