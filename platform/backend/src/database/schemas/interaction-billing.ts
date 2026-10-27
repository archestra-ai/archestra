import {
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import type { AttributionLabels } from "@/types/attribution-label";
import type { PricedBillingUsage } from "@/utils/billable-usage";

/**
 * Content-free accounting receipts survive log retention. Removing an
 * interaction must not make an already-settled request chargeable again.
 */
export default pgTable(
  "interaction_billing",
  {
    interactionId: uuid("interaction_id").primaryKey(),
    fingerprint: varchar("fingerprint", { length: 64 }).notNull(),
    usage: jsonb("usage").$type<PricedBillingUsage>().notNull(),
    organizationId: text("organization_id"),
    userId: text("user_id"),
    environmentId: uuid("environment_id"),
    billingMode: text("billing_mode").notNull(),
    billingTeamId: text("billing_team_id"),
    attributionLabels: jsonb("attribution_labels").$type<AttributionLabels>(),
    createdAt: timestamp("created_at", { mode: "date" }).defaultNow().notNull(),
  },
  (table) => [
    index("interaction_billing_user_period_idx").on(
      table.organizationId,
      table.userId,
      table.createdAt,
    ),
  ],
);
