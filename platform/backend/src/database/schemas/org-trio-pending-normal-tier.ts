import { boolean, pgTable, text } from "drizzle-orm/pg-core";
import organizationsTable from "./organization";

/**
 * Auto-routing normal tiers the org-trio migration could not move into the
 * organization's default model because Agent Runtime agents inherit it. The
 * backend checks those agents against the tier once at startup and consumes
 * each row.
 */
const orgTrioPendingNormalTierTable = pgTable("org_trio_pending_normal_tier", {
  organizationId: text("organization_id")
    .primaryKey()
    .references(() => organizationsTable.id, { onDelete: "cascade" }),
  normalModelId: text("normal_model_id").notNull(),
  apiKeyId: text("api_key_id").notNull(),
  autoRoutingWasEnabled: boolean("auto_routing_was_enabled").notNull(),
});

export default orgTrioPendingNormalTierTable;
